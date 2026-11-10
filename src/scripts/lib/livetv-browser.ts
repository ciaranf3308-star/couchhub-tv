// RedSilk Couch — Channel Browser (W1, canonical owner).
//
// The virtualised long list used from Live TV Home AND from
// playback (W2 mounts it inside the playback shell as Quick Surf's
// "all channels" view via mountChannelBrowser /
// mountCachedChannelBrowser — same module, same contract).
//
// Rules:
//   - Virtualised with computeVisibleWindow: a 15,000-channel list
//     only ever builds the visible window + overscan rows, never
//     15,000 DOM nodes. One row is BROWSER_ROW_HEIGHT px, always.
//   - Highlight NEVER starts playback. Clicking / arrowing onto a
//     row only highlights it (aria-selected + onHighlight). A tune
//     happens only through the explicit Watch action (Watch button,
//     Enter, double-click) via onSelect.
//   - Search is debounced (150ms) and matches the channels' cached
//     normalised names — no re-normalising per keystroke.
//   - Category switching is instant (pure filter, no fetch).
//   - Focus returns to the last highlighted channel: pass
//     initialFocusId, or keep the handle and call highlightChannel.
import { computeVisibleWindow } from "./couch-grid";
import { programmeProgress } from "./couch-livetv-epg";
import { fallbackMarkFor } from "./couch-image";
import { CACHE_REVALIDATED_EVENT } from "./cache.js";
import { EPG_LOADED_EVENT, getProgrammesSync } from "./epg-data.js";
import {
  dispatchLivetvTune,
  groupChannels,
  loadLivetvHomeData,
  nowNextForChannel,
  readActivePlaylistId,
  searchChannels,
  type LivetvChannel,
  type LivetvNowNext,
} from "./livetv-data";

/** One browser row is always this tall — the virtual list depends on it. */
export const BROWSER_ROW_HEIGHT = 76;
/** Search debounce (ms). */
export const BROWSER_SEARCH_DEBOUNCE_MS = 150;

export type BrowserSort = "source" | "az" | "za" | "category";

export interface BrowserFilter {
  query?: string;
  /** "all" | "favourites" | "recents" | a group id from groupChannels. */
  categoryId?: string | null;
  sort?: BrowserSort;
  /** Most-recent-first ids, for the "recents" pseudo-category order. */
  recentIds?: ReadonlyArray<string | number> | null;
}

export const BROWSER_CATEGORY_ALL = "all";
export const BROWSER_CATEGORY_FAVOURITES = "favourites";
export const BROWSER_CATEGORY_RECENTS = "recents";

/**
 * Pure: filter + sort one browser view. Category "favourites"
 * keeps favourite-flagged channels; "recents" keeps the given
 * recent ids in recents order; a group id keeps that group's
 * channels; "all" / null keeps everything. Sort is applied last.
 */
export function applyBrowserFilter(
  channels: readonly LivetvChannel[],
  filter: BrowserFilter = {},
): LivetvChannel[] {
  const categoryId = filter.categoryId ?? BROWSER_CATEGORY_ALL;
  let list: LivetvChannel[];
  if (categoryId === BROWSER_CATEGORY_FAVOURITES) {
    list = channels.filter((channel) => channel.favourite);
  } else if (categoryId === BROWSER_CATEGORY_RECENTS) {
    const order = new Map<string, number>();
    for (const [index, id] of (filter.recentIds ?? []).entries()) {
      if (!order.has(String(id))) order.set(String(id), index);
    }
    list = channels
      .filter((channel) => order.has(String(channel.id)))
      .sort(
        (a, b) =>
          (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
      );
  } else if (categoryId !== BROWSER_CATEGORY_ALL) {
    const groups = groupChannels(channels);
    const group = groups.find((g) => g.id === categoryId);
    list = group ? [...group.channels] : [];
  } else {
    list = [...channels];
  }
  if (filter.query) list = searchChannels(list, filter.query);
  switch (filter.sort ?? "source") {
    case "az":
      return list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    case "za":
      return list.sort((a, b) => b.displayName.localeCompare(a.displayName));
    case "category":
      return list.sort(
        (a, b) =>
          a.categoryLabel.localeCompare(b.categoryLabel) ||
          a.displayName.localeCompare(b.displayName),
      );
    case "source":
    default:
      return list;
  }
}

export interface BrowserCategory {
  id: string;
  label: string;
  count: number;
}

/** Category buttons for a channel set: All, Favourites, Recently watched, then groups. */
export function browserCategories(
  channels: readonly LivetvChannel[],
  recentIds?: ReadonlyArray<string | number> | null,
): BrowserCategory[] {
  const groups = groupChannels(channels);
  const cats: BrowserCategory[] = [
    { id: BROWSER_CATEGORY_ALL, label: "All Channels", count: channels.length },
  ];
  const favCount = channels.filter((c) => c.favourite).length;
  if (favCount > 0) {
    cats.push({ id: BROWSER_CATEGORY_FAVOURITES, label: "Favourites", count: favCount });
  }
  const recentCount = (recentIds ?? []).filter((id) =>
    channels.some((c) => String(c.id) === String(id)),
  ).length;
  if (recentCount > 0) {
    cats.push({ id: BROWSER_CATEGORY_RECENTS, label: "Recently watched", count: recentCount });
  }
  for (const group of groups) {
    if (group.id === BROWSER_CATEGORY_ALL) continue;
    cats.push({ id: group.id, label: group.label, count: group.channels.length });
  }
  return cats;
}

export interface ChannelBrowserOptions {
  channels: LivetvChannel[];
  /** Id this instance answers to for `livetv:browser-category` events (Home uses "home"). */
  browserId?: string;
  /** Most-recent-first ids for the "Recently watched" category. */
  recentIds?: ReadonlyArray<string | number> | null;
  playlistId?: string;
  /** Now/Next per channel (cached EPG). Omitted → rows show no programme lines. */
  nowNextFor?: (channel: LivetvChannel) => LivetvNowNext | null;
  initialCategoryId?: string | null;
  initialFocusId?: string | number | null;
  sort?: BrowserSort;
  /** Explicit Watch action — the ONLY path that may tune. */
  onSelect?: (channel: LivetvChannel) => void;
  /** Highlight moved (click / arrows). Never a tune. */
  onHighlight?: (channel: LivetvChannel) => void;
  onClose?: () => void;
  /** Label for the search field. */
  searchLabel?: string;
}

export interface ChannelBrowserHandle {
  root: HTMLElement;
  setChannels(channels: LivetvChannel[]): void;
  getHighlightedId(): string | number | null;
  highlightChannel(id: string | number | null, opts?: { focus?: boolean }): void;
  focusChannel(id: string | number): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Mount the Channel Browser into `root`. The root is owned by the
 * browser until destroy() — it replaces the root's children.
 * W2 mounts this inside playback via the same call; Home mounts it
 * in its "All Channels" section.
 */
export function mountChannelBrowser(
  root: HTMLElement,
  opts: ChannelBrowserOptions,
): ChannelBrowserHandle {
  let channels: LivetvChannel[] = [...opts.channels];
  let categoryId = opts.initialCategoryId ?? BROWSER_CATEGORY_ALL;
  let sort: BrowserSort = opts.sort ?? "source";
  let query = "";
  let highlightedId: string | number | null =
    opts.initialFocusId ?? null;
  let destroyed = false;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  root.replaceChildren();
  root.classList.add("rs-livetv-browser");
  root.setAttribute("data-livetv-browser", "");

  // ── Toolbar: search + sort + close ──
  const toolbar = el("div", "rs-livetv-browser__toolbar");
  const search = el("input", "rs-livetv-browser__search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search channels…";
  search.setAttribute("aria-label", opts.searchLabel ?? "Search channels");
  search.setAttribute("data-browser-search", "");
  toolbar.appendChild(search);
  const sortSelect = el("select", "rs-livetv-browser__sort") as HTMLSelectElement;
  sortSelect.setAttribute("aria-label", "Sort channels");
  sortSelect.setAttribute("data-browser-sort", "");
  for (const [value, label] of [
    ["source", "Source order"],
    ["az", "A–Z"],
    ["za", "Z–A"],
    ["category", "Category, A–Z"],
  ] as const) {
    const option = el("option") as HTMLOptionElement;
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  sortSelect.value = sort;
  toolbar.appendChild(sortSelect);
  if (opts.onClose) {
    const close = el("button", "rs-livetv-browser__close") as HTMLButtonElement;
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("data-browser-close", "");
    close.addEventListener("click", () => opts.onClose?.());
    toolbar.appendChild(close);
  }
  root.appendChild(toolbar);

  // ── Categories ──
  const categoriesEl = el("div", "rs-livetv-browser__categories");
  categoriesEl.setAttribute("data-browser-categories", "");
  categoriesEl.setAttribute("role", "tablist");
  categoriesEl.setAttribute("aria-label", "Channel categories");
  root.appendChild(categoriesEl);

  // ── Virtual list ──
  const listEl = el("div", "rs-livetv-browser__list");
  listEl.setAttribute("data-browser-list", "");
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "Channels");
  listEl.tabIndex = 0;
  const spacer = el("div", "rs-livetv-browser__spacer");
  spacer.setAttribute("data-browser-spacer", "");
  const viewport = el("div", "rs-livetv-browser__viewport");
  viewport.setAttribute("data-browser-viewport", "");
  listEl.appendChild(spacer);
  listEl.appendChild(viewport);
  root.appendChild(listEl);

  const statusEl = el("p", "rs-livetv-browser__status");
  statusEl.setAttribute("data-browser-status", "");
  statusEl.setAttribute("aria-live", "polite");
  root.appendChild(statusEl);

  const visible = (): LivetvChannel[] =>
    applyBrowserFilter(channels, {
      query,
      categoryId,
      sort,
      recentIds: opts.recentIds ?? null,
    });

  const channelById = (id: string | number | null | undefined): LivetvChannel | undefined =>
    id == null ? undefined : channels.find((c) => String(c.id) === String(id));

  function rowElement(channel: LivetvChannel): HTMLElement {
    const row = el("div", "rs-livetv-browser__row");
    row.setAttribute("data-browser-row", "");
    row.setAttribute("data-channel-id", String(channel.id));
    row.setAttribute("data-focus-key", `livetv-browser-${channel.id}`);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(String(channel.id) === String(highlightedId)));
    if (String(channel.id) === String(highlightedId)) {
      row.classList.add("is-highlighted");
    }
    const logo = el("span", "rs-livetv-browser__logo");
    const logoFallback = () => {
      // Branded fallback from the shared couch-image helper (W7
      // consumes it — the "N" brand mark for logos; the channel
      // name sits beside the logo in every row).
      const mark = el("span", "rs-livetv-browser__initial");
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = fallbackMarkFor("logo", channel.displayName || channel.name);
      return mark;
    };
    if (channel.logo) {
      const img = el("img") as HTMLImageElement;
      img.src = channel.logo;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        logo.appendChild(logoFallback());
      });
      logo.appendChild(img);
    } else {
      logo.appendChild(logoFallback());
    }
    row.appendChild(logo);

    const body = el("div", "rs-livetv-browser__body");
    const name = el("span", "rs-livetv-browser__name");
    if (channel.chno != null) {
      const num = el("span", "rs-livetv-browser__num");
      num.textContent = String(channel.chno);
      name.appendChild(num);
    }
    name.appendChild(document.createTextNode(channel.displayName || channel.name));
    body.appendChild(name);
    const nn = opts.nowNextFor?.(channel) ?? null;
    if (nn?.current) {
      const now = el("span", "rs-livetv-browser__now");
      now.textContent = nn.current.title;
      body.appendChild(now);
      const bar = el("span", "rs-livetv-browser__progress");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("span");
      fill.style.width = `${Math.round(programmeProgress(nn.current.start, nn.current.stop) * 100)}%`;
      bar.appendChild(fill);
      body.appendChild(bar);
    } else if (nn?.next) {
      const next = el("span", "rs-livetv-browser__next");
      next.textContent = `Next: ${nn.next.title}`;
      body.appendChild(next);
    }
    row.appendChild(body);

    if (channel.favourite) {
      const fav = el("span", "rs-livetv-browser__fav");
      fav.setAttribute("aria-label", "Favourite");
      fav.textContent = "♥";
      row.appendChild(fav);
    }
    if (channel.catchup) {
      const badge = el("span", "rs-livetv-browser__catchup");
      badge.textContent = "Catch-up";
      row.appendChild(badge);
    }
    const watch = el("button", "rs-livetv-browser__watch") as HTMLButtonElement;
    watch.type = "button";
    watch.textContent = "Watch";
    watch.setAttribute("data-browser-watch", "");
    watch.setAttribute("data-channel-id", String(channel.id));
    row.appendChild(watch);
    return row;
  }

  function render(): void {
    if (destroyed) return;
    const list = visible();
    const rowHeight = BROWSER_ROW_HEIGHT;
    spacer.style.height = `${list.length * rowHeight}px`;
    const win = computeVisibleWindow({
      total: list.length,
      columns: 1,
      rowHeight,
      scrollTop: listEl.scrollTop,
      viewportHeight: listEl.clientHeight || 600,
      overscanRows: 3,
    });
    viewport.replaceChildren();
    viewport.style.transform = `translateY(${win.topSpacer}px)`;
    for (let i = win.startIndex; i < win.endIndex; i++) {
      const channel = list[i];
      if (channel) viewport.appendChild(rowElement(channel));
    }
    statusEl.textContent =
      list.length === 0
        ? query
          ? `No channels match “${query}”.`
          : "No channels in this category."
        : `${list.length.toLocaleString()} channel${list.length === 1 ? "" : "s"}`;
  }

  function renderCategories(): void {
    const cats = browserCategories(channels, opts.recentIds ?? null);
    categoriesEl.replaceChildren();
    for (const cat of cats) {
      const btn = el("button", "rs-livetv-browser__category") as HTMLButtonElement;
      btn.type = "button";
      btn.setAttribute("data-browser-category", cat.id);
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(cat.id === categoryId));
      if (cat.id === categoryId) btn.classList.add("is-active");
      btn.textContent = `${cat.label} (${cat.count})`;
      btn.addEventListener("click", () => {
        categoryId = cat.id;
        renderCategories();
        listEl.scrollTop = 0;
        render();
      });
      categoriesEl.appendChild(btn);
    }
  }

  function highlight(id: string | number | null, focusRow = false): void {
    highlightedId = id;
    const channel = channelById(id);
    if (channel) opts.onHighlight?.(channel);
    // Re-render only the selection state: cheapest correct path at
    // this size is a full window re-render (visible rows only).
    render();
    if (focusRow && id != null) {
      const row = viewport.querySelector<HTMLElement>(
        `[data-browser-row][data-channel-id="${CSS.escape(String(id))}"]`,
      );
      row?.focus();
    }
  }

  function scrollToId(id: string | number): void {
    const list = visible();
    const index = list.findIndex((c) => String(c.id) === String(id));
    if (index < 0) return;
    listEl.scrollTop = Math.max(0, index * BROWSER_ROW_HEIGHT - listEl.clientHeight / 2);
    render();
  }

  // ── Events ──
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = search.value.trim();
      listEl.scrollTop = 0;
      render();
    }, BROWSER_SEARCH_DEBOUNCE_MS);
  });
  sortSelect.addEventListener("change", () => {
    sort = sortSelect.value as BrowserSort;
    listEl.scrollTop = 0;
    render();
  });
  listEl.addEventListener("scroll", () => render(), { passive: true });
  viewport.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const watchBtn = target?.closest?.("[data-browser-watch]") as HTMLElement | null;
    const row = target?.closest?.("[data-browser-row]") as HTMLElement | null;
    if (!row) return;
    const id = row.getAttribute("data-channel-id");
    const channel = id == null ? undefined : channelById(id);
    if (!channel) return;
    if (watchBtn) {
      // Explicit Watch action — the only click path that may tune.
      highlight(channel.id);
      opts.onSelect?.(channel);
      return;
    }
    // Any other click on the row only highlights. Never tunes.
    highlight(channel.id);
  });
  viewport.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest?.("[data-browser-row]") as HTMLElement | null;
    if (!row) return;
    const channel = channelById(row.getAttribute("data-channel-id"));
    if (channel) {
      highlight(channel.id);
      opts.onSelect?.(channel);
    }
  });
  listEl.addEventListener("keydown", (event) => {
    const list = visible();
    if (!list.length) return;
    const currentIndex = list.findIndex((c) => String(c.id) === String(highlightedId));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        currentIndex < 0
          ? delta > 0
            ? 0
            : list.length - 1
          : (currentIndex + delta + list.length) % list.length;
      const channel = list[next];
      if (!channel) return;
      highlight(channel.id);
      scrollToId(channel.id);
    } else if (event.key === "Enter") {
      const channel = channelById(highlightedId);
      if (channel) {
        event.preventDefault();
        opts.onSelect?.(channel);
      }
    } else if (event.key === "Escape") {
      // Integration 0.7.0: claim the key. Without preventDefault the
      // playback shell's window-level Escape handler also fires after
      // onClose hides the browser — B would close the browser AND
      // drop to Live TV Home in one press.
      event.preventDefault();
      opts.onClose?.();
    }
  });

  // Collection cards (Home) switch this browser's category:
  // `livetv:browser-category` {browserId?, categoryId}. An event
  // naming another browser id is ignored, so the playback instance
  // never follows a Home tap.
  const onBrowserCategory = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { browserId?: string; categoryId?: string }
      | undefined;
    if (!detail?.categoryId) return;
    if (detail.browserId && opts.browserId && detail.browserId !== opts.browserId) return;
    categoryId = detail.categoryId;
    renderCategories();
    listEl.scrollTop = 0;
    render();
  };
  window.addEventListener("livetv:browser-category", onBrowserCategory);

  renderCategories();
  render();
  if (highlightedId != null) scrollToId(highlightedId);

  return {
    root,
    setChannels(next: LivetvChannel[]): void {
      channels = [...next];
      if (highlightedId != null && !channelById(highlightedId)) highlightedId = null;
      renderCategories();
      render();
    },
    getHighlightedId(): string | number | null {
      return highlightedId;
    },
    highlightChannel(id: string | number | null, highlightOpts?: { focus?: boolean }): void {
      if (id != null) scrollToId(id);
      highlight(id, !!highlightOpts?.focus);
    },
    focusChannel(id: string | number): void {
      scrollToId(id);
      highlight(id, true);
    },
    destroy(): void {
      destroyed = true;
      if (searchTimer) clearTimeout(searchTimer);
      window.removeEventListener("livetv:browser-category", onBrowserCategory);
      root.replaceChildren();
      root.classList.remove("rs-livetv-browser");
      root.removeAttribute("data-livetv-browser");
    },
  };
}

export interface CachedBrowserOptions {
  /** Id this instance answers to for `livetv:browser-category` events. */
  browserId?: string;
  /** Explicit Watch action. Defaults to the livetv:tune handoff. */
  onSelect?: (channel: LivetvChannel) => void;
  onHighlight?: (channel: LivetvChannel) => void;
  onClose?: () => void;
  initialCategoryId?: string | null;
  initialFocusId?: string | number | null;
  sort?: BrowserSort;
  searchLabel?: string;
}

/**
 * Mount the browser from the cached playlist (no fetch): loads
 * channels + recents + cached EPG once, wires Watch to the
 * livetv:tune handoff by default, and re-renders when favourites /
 * recents change. Returns the handle, or null when no playlist is
 * active (the caller shows the provider-lost state instead).
 */
export async function mountCachedChannelBrowser(
  root: HTMLElement,
  opts: CachedBrowserOptions = {},
): Promise<ChannelBrowserHandle | null> {
  const playlistId = readActivePlaylistId();
  if (!playlistId) return null;
  const data = await loadLivetvHomeData(playlistId);
  const recentIds = data.recents.map((r) => r.id);
  // W7: read the EPG fresh on every row render instead of closing
  // over the programmes snapshot from mount time — the guide loads
  // after Home mounts, and rows must gain their now/next lines
  // when it lands rather than staying blank until a favourites /
  // recents change happens to re-render.
  const freshProgrammes = () => {
    try {
      return getProgrammesSync(playlistId)?.programmes ?? null;
    } catch {
      return null;
    }
  };
  const handle = mountChannelBrowser(root, {
    channels: data.channels,
    browserId: opts.browserId,
    recentIds,
    playlistId,
    nowNextFor: (channel) =>
      nowNextForChannel(channel, freshProgrammes(), playlistId),
    initialCategoryId: opts.initialCategoryId ?? undefined,
    initialFocusId: opts.initialFocusId ?? undefined,
    sort: opts.sort,
    onSelect: opts.onSelect ?? ((channel) => dispatchLivetvTune(channel.id)),
    onHighlight: opts.onHighlight,
    onClose: opts.onClose,
    searchLabel: opts.searchLabel,
  });
  const refresh = async () => {
    const next = await loadLivetvHomeData(playlistId);
    handle.setChannels(next.channels);
  };
  const onFavs = () => void refresh();
  const onRecents = () => void refresh();
  // W7: a late EPG load or a background cache refresh re-renders
  // the browser (rows gain now/next; new channels appear) instead
  // of leaving the cold-load snapshot on screen. Guarded to this
  // playlist.
  const onEpg = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { playlistId?: string }
      | undefined;
    if (detail?.playlistId && detail.playlistId !== playlistId) return;
    void refresh();
  };
  const onCache = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { entryId?: string; kind?: string }
      | undefined;
    if (detail?.entryId && detail.entryId !== playlistId) return;
    if (detail?.kind && detail.kind !== "live" && detail.kind !== "m3u") return;
    void refresh();
  };
  document.addEventListener("xt:favorites-changed", onFavs);
  document.addEventListener("xt:recents-changed", onRecents);
  document.addEventListener(EPG_LOADED_EVENT, onEpg);
  document.addEventListener(CACHE_REVALIDATED_EVENT, onCache);
  const baseDestroy = handle.destroy.bind(handle);
  handle.destroy = () => {
    document.removeEventListener("xt:favorites-changed", onFavs);
    document.removeEventListener("xt:recents-changed", onRecents);
    document.removeEventListener(EPG_LOADED_EVENT, onEpg);
    document.removeEventListener(CACHE_REVALIDATED_EVENT, onCache);
    baseDestroy();
  };
  return handle;
}
