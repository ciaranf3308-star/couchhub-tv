// RedSilk Couch — Channel Browser (0.11.0 W4 reassessment).
//
// The virtualised long list used from Live TV Home, from playback
// (Quick Surf's "all channels" view via mountChannelBrowser /
// mountCachedChannelBrowser — same module, same contract) and as the
// dedicated Channel Browser utility screen (TvChannelBrowser with
// screenMode; the shell mounts it as the "browser" mode and enters it
// via `livetv:mode` {mode:"browser", browserFilter?, openSearch?}).
//
// Rules:
//   - Virtualised with computeVisibleWindow: a 15,000-channel list
//     only ever builds the visible window + overscan rows, never
//     15,000 DOM nodes. One row is BROWSER_ROW_HEIGHT px, always.
//   - Highlight NEVER starts playback. Clicking / arrowing onto a
//     row only highlights it (aria-selected + onHighlight). A tune
//     happens only through the explicit Watch action (Watch Live in
//     the contextual panel, Enter, double-click) via onSelect.
//   - Search is debounced (150ms) and matches the channels' cached
//     normalised names — no re-normalising per keystroke. The query
//     itself is normalised too (normalizeBrowserQuery): redundant
//     provider prefixes (country/region tokens, quality tags, bare
//     "tv"/"channel") are ignored, so "BBC One HD" and "UK BBC"
//     still find BBC One; tokens that survive are matched exactly,
//     never invented.
//   - Category switching is instant (pure filter, no fetch). Pills
//     follow the mockup order: Favourites, provider groups (Irish &
//     UK first), Recents, All Channels last.
//   - Focus returns to the last highlighted channel: pass
//     initialFocusId, or keep the handle and call highlightChannel.
//     Selection + scroll survive data refreshes; in screen mode the
//     highlight follows the visible list when a category/search
//     change drops the highlighted channel out of view.
//   - The row is a 4-column table row (Ch. / Channel / Now / Next,
//     mockup 1000017108_0_mo5o.png) with a compact contextual panel
//     on the right (≤30% width) for the highlighted channel. The
//     panel earns its space with programme art for the selected
//     channel's current programme only (livetv-enrichment, selected
//     channel only — never the whole list); with no programme data
//     it stays compact instead of leaving a giant empty panel.
//   - No rectangles-in-rectangles: hierarchy comes from spacing,
//     typography and hairline separators, never nested boxes.
//   - B / Escape ("back") is owned here through two paths that
//     converge on handleBack(): the `livetv:back` window event
//     {context:"browser"} (W5's gamepad contract — B/Escape resolve
//     to "back" and dispatch it) and the Escape key itself. In
//     order: search open → close search; else onClose (the screen
//     instance exits to landing; the playback instance closes its
//     overlay). A 250ms coalescing window guards against the
//     gamepad layer dispatching both paths for one press.
//   - Keyboard seam for the gamepad layer (W5 owns gamepad.ts /
//     livetv-keys.ts): LB/RB prev/next category = "[" / "]",
//     LT/RT page jump = PageUp / PageDown, X favourite = "x",
//     Y search = "y". This module handles those keys; the gamepad
//     layer synthesises them when the browser is the active
//     context.
import { computeVisibleWindow } from "./couch-grid";
import { programmeProgress } from "./couch-livetv-epg";
import { formatTimeRange } from "./now-next";
import { fallbackMarkFor } from "./couch-image";
import { normalize } from "./text";
import { CACHE_REVALIDATED_EVENT } from "./cache.js";
import { EPG_LOADED_EVENT, getProgrammesSync } from "./epg-data.js";
import {
  enrichProgramme as defaultEnrichProgramme,
  getProgrammeArtworkSync,
  type EnrichProgrammeRequest,
  type ProgrammeArtwork,
} from "./livetv-enrichment";
import {
  dispatchLivetvTune,
  groupChannels,
  loadLivetvHomeData,
  nowNextForChannel,
  readActivePlaylistId,
  requestLivetvMode,
  type LivetvChannel,
  type LivetvNowNext,
} from "./livetv-data";

/** One browser row is always this tall — the virtual list depends on it. */
export const BROWSER_ROW_HEIGHT = 76;
/** Search debounce (ms). */
export const BROWSER_SEARCH_DEBOUNCE_MS = 150;
/** Back actions closer together than this are one press (the gamepad
 *  layer may dispatch both `livetv:back` and Escape for a single B). */
export const BROWSER_BACK_COALESCE_MS = 250;

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
 * Entry filter carried on `livetv:mode` {mode:"browser",
 * browserFilter} (and on the mount's data attributes — see
 * TvChannelBrowser). "category" names a provider group id
 * (groupChannels), e.g. "irish-uk" / "sports".
 */
export interface BrowserEntryFilter {
  kind: "all" | "favourites" | "recents" | "category";
  value?: string;
}

/** Pure: map an entry filter onto a BrowserFilter category id. */
export function browserFilterFromEntry(
  entry: BrowserEntryFilter | null | undefined,
): string {
  if (!entry) return BROWSER_CATEGORY_ALL;
  switch (entry.kind) {
    case "favourites":
      return BROWSER_CATEGORY_FAVOURITES;
    case "recents":
      return BROWSER_CATEGORY_RECENTS;
    case "category":
      return entry.value ? entry.value : BROWSER_CATEGORY_ALL;
    case "all":
    default:
      return BROWSER_CATEGORY_ALL;
  }
}

// ── Search normalisation + cached searchable labels ───────────────

/**
 * Query tokens that carry no information about which channel the
 * user wants — provider/country prefixes, quality tags and bare
 * generic words. Stripping them can only widen a query to what the
 * surviving tokens already name; it never invents a match for a
 * token the user did not type. Brand names are NOT stripped:
 * "sky" stays, because Sky Sports and Sky News are different
 * channels. "itv" stays too (normalize keeps it one token).
 */
export const BROWSER_QUERY_REDUNDANT_TOKENS: ReadonlySet<string> = new Set([
  "uk",
  "gb",
  "ireland",
  "irish",
  "ie",
  "eire",
  "english",
  "british",
  "hd",
  "fhd",
  "uhd",
  "4k",
  "sd",
  "hevc",
  "h265",
  "h264",
  "1080p",
  "720p",
  "2160p",
  "1080i",
  "tv",
  "channel",
  "channels",
  "live",
]);

/**
 * Pure: normalise a search query the way the channel haystacks are
 * normalised (shared `normalize`: case-insensitive, diacritics
 * stripped, punctuation → spaces), then drop redundant provider
 * prefixes. "BBC One HD" → "bbc one"; "UK BBC" → "bbc"; "F1" stays
 * "f1". An all-redundant query ("HD", "UK") normalises to "" —
 * i.e. no filter — rather than matching nothing.
 */
export function normalizeBrowserQuery(query: string | null | undefined): string {
  const tokens = normalize(query ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !BROWSER_QUERY_REDUNDANT_TOKENS.has(token));
  return tokens.join(" ");
}

/**
 * Searchable labels, cached per channel array: the channel's
 * precomputed `norm` haystack (name + category + tvgId, built once
 * at catalogue load), keyed by channel id. applyBrowserFilter is
 * called on every render/scroll, so the per-keystroke work stays a
 * Map lookup, never a re-normalise of 15,000 names.
 */
const searchIndexCache = new WeakMap<
  readonly LivetvChannel[],
  Map<string, string>
>();

export function buildBrowserSearchIndex(
  channels: readonly LivetvChannel[],
): Map<string, string> {
  let index = searchIndexCache.get(channels);
  if (!index) {
    index = new Map();
    for (const channel of channels) {
      index.set(String(channel.id), channel.norm ?? "");
    }
    searchIndexCache.set(channels, index);
  }
  return index;
}

function browserNumericTokenMatches(channel: LivetvChannel, token: string): boolean {
  const idText = String(channel.id);
  if (idText === token || idText.startsWith(token)) return true;
  if (channel.chno != null) {
    const chnoText = String(channel.chno);
    if (chnoText === token || chnoText.startsWith(token)) return true;
  }
  return false;
}

/**
 * Pure: search by name over the cached index. Every surviving
 * token must match the channel's haystack; a digits-only token
 * also matches channel number / id exactly or by prefix.
 * Identical in result to the shared searchChannels for surviving
 * tokens; the difference is the query normalisation (redundant
 * prefixes dropped) and the cached index.
 */
export function searchBrowserChannels(
  channels: readonly LivetvChannel[],
  query: string,
): LivetvChannel[] {
  const q = normalizeBrowserQuery(query);
  if (!q) return [...channels];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...channels];
  const index = buildBrowserSearchIndex(channels);
  return channels.filter((channel) =>
    tokens.every((token) =>
      /^\d+$/.test(token)
        ? browserNumericTokenMatches(channel, token) ||
          (index.get(String(channel.id)) ?? "").includes(token)
        : (index.get(String(channel.id)) ?? "").includes(token),
    ),
  );
}

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
  if (filter.query) list = searchBrowserChannels(list, filter.query);
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
  /** Small text glyph for the pill (mockup 1: one icon per pill). */
  icon: string;
}

/** Pill glyph per category id (text glyphs only — no emoji). */
export function browserCategoryIcon(id: string): string {
  switch (id) {
    case BROWSER_CATEGORY_FAVOURITES:
      return "★";
    case BROWSER_CATEGORY_RECENTS:
      return "↻";
    case "irish-uk":
      return "◎";
    case "sports":
      return "◉";
    case "movies":
      return "▣";
    case "news":
      return "▤";
    case "kids":
      return "✿";
    case "entertainment":
      return "✦";
    case "documentaries":
      return "▧";
    case "music":
      return "♪";
    case BROWSER_CATEGORY_ALL:
      return "▦";
    default:
      return "▦";
  }
}

/**
 * Category pills for a channel set, in the mockup order:
 * Favourites, provider groups (Irish & UK first, groupChannels'
 * order), Recents, All Channels last. Favourites / Recents / All
 * are ALWAYS present, even at count 0, so they stay immediately
 * reachable as entry points; selecting an empty one shows the
 * empty state instead of hiding the destination.
 */
export function browserCategories(
  channels: readonly LivetvChannel[],
  recentIds?: ReadonlyArray<string | number> | null,
): BrowserCategory[] {
  const groups = groupChannels(channels);
  const favCount = channels.filter((c) => c.favourite).length;
  const recentCount = (recentIds ?? []).filter((id) =>
    channels.some((c) => String(c.id) === String(id)),
  ).length;
  const cats: BrowserCategory[] = [
    {
      id: BROWSER_CATEGORY_FAVOURITES,
      label: "Favourites",
      count: favCount,
      icon: browserCategoryIcon(BROWSER_CATEGORY_FAVOURITES),
    },
  ];
  // Mockup pill order for the headline groups (Favourites, Irish &
  // UK, Sports, Movies, News, Kids); every other genuine provider
  // group follows in groupChannels order, then Recents, All last.
  const headlineOrder = ["irish-uk", "sports", "movies", "news", "kids"];
  const orderedGroups = groups
    .filter((group) => group.id !== "all")
    .sort((a, b) => {
      const ai = headlineOrder.indexOf(a.id);
      const bi = headlineOrder.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    });
  for (const group of orderedGroups) {
    cats.push({
      id: group.id,
      label: group.label,
      count: group.channels.length,
      icon: browserCategoryIcon(group.id),
    });
  }
  cats.push({
    id: BROWSER_CATEGORY_RECENTS,
    label: "Recents",
    count: recentCount,
    icon: browserCategoryIcon(BROWSER_CATEGORY_RECENTS),
  });
  cats.push({
    id: BROWSER_CATEGORY_ALL,
    label: "All Channels",
    count: channels.length,
    icon: browserCategoryIcon(BROWSER_CATEGORY_ALL),
  });
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
  /**
   * 0.9.0 screen instance: listen for `livetv:mode`
   * {mode:"browser", browserFilter?, openSearch?} and apply the
   * entry. Only the dedicated Channel Browser screen sets this —
   * the Home inline browser and the playback overlay must NOT
   * follow mode entries.
   */
  acceptModeEntry?: boolean;
  /**
   * Highlight the first visible channel on mount (and whenever the
   * list becomes non-empty with nothing highlighted), so the
   * contextual panel is populated from the first paint. Screen
   * instances set this; Home / playback keep the old behaviour
   * (no highlight until the user moves).
   */
  autoHighlightFirst?: boolean;
  /**
   * Favourite toggle for the highlighted channel (X). Defaults to
   * persisting through preferences.js for opts.playlistId and
   * updating the row in place. Receives the channel and returns
   * the new favourite state (null when there is nothing to
   * persist against).
   */
  onToggleFavourite?: (
    channel: LivetvChannel,
  ) => boolean | null | Promise<boolean | null>;
  /** View Guide action from the contextual panel. Defaults to `livetv:mode` {mode:"guide"}. */
  onViewGuide?: (channel: LivetvChannel) => void;
  /**
   * Programme artwork for the selected channel only (detail panel).
   * Defaults to the shared livetv-enrichment API (TMDB, cached,
   * never throws). Inject a stub in tests; never called for the
   * whole list — only the highlighted channel's current programme.
   */
  enrichProgramme?: (req: EnrichProgrammeRequest) => Promise<ProgrammeArtwork>;
}

export interface ChannelBrowserHandle {
  root: HTMLElement;
  setChannels(channels: LivetvChannel[]): void;
  getHighlightedId(): string | number | null;
  highlightChannel(id: string | number | null, opts?: { focus?: boolean }): void;
  focusChannel(id: string | number): void;
  /** Apply a `livetv:mode` browser entry (filter + optional search open). */
  applyEntry(entry: BrowserEntryFilter | null | undefined, opts?: { openSearch?: boolean }): void;
  openSearch(): void;
  /** Close search (clear + blur). Returns true when search was open. */
  closeSearch(): boolean;
  isSearchOpen(): boolean;
  getCategoryId(): string;
  getVisibleChannels(): LivetvChannel[];
  cycleCategory(delta: number): void;
  jumpPage(delta: number): void;
  toggleFavouriteHighlighted(): Promise<boolean | null>;
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

function isEditableTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true;
}

/**
 * Mount the Channel Browser into `root`. The root is owned by the
 * browser until destroy() — it replaces the root's children.
 * W2 mounts this inside playback via the same call; Home mounts it
 * in its "All Channels" section; the 0.9.0 screen mounts it via
 * TvChannelBrowser with acceptModeEntry + autoHighlightFirst.
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
  let lastBackAt = 0;
  // Detail-panel enrichment: only the highlighted channel's current
  // programme is ever enriched. detailArtSeq guards the async art
  // against a highlight that moved on; lastDetailKey keeps the
  // panel from rebuilding (and re-enriching) on every scroll render.
  const enrichProgramme = opts.enrichProgramme ?? defaultEnrichProgramme;
  let detailArtSeq = 0;
  let lastDetailKey = "__unrendered__";
  let lastEnrichedKey = "";

  root.replaceChildren();
  root.classList.add("rs-livetv-browser");
  root.setAttribute("data-livetv-browser", "");
  if (opts.acceptModeEntry) root.setAttribute("data-browser-screen", "");

  // ── Layout: main column (toolbar / categories / head / list /
  //    status) + compact contextual panel on the right ──
  const layout = el("div", "rs-livetv-browser__layout");
  root.appendChild(layout);
  const main = el("div", "rs-livetv-browser__main");
  layout.appendChild(main);
  const detail = el("aside", "rs-livetv-browser__detail");
  detail.setAttribute("data-browser-detail", "");
  detail.setAttribute("aria-label", "Selected channel");
  layout.appendChild(detail);

  // ── Screen header (screen mode only — mockup 1): title + live
  //    channel count on the left, search top-right on the same row.
  //    The shell's generic "Live TV" head is hidden in browser mode,
  //    so the browser carries its own title.
  let subtitleEl: HTMLElement | null = null;
  let headerEl: HTMLElement | null = null;
  if (opts.acceptModeEntry) {
    headerEl = el("div", "rs-livetv-browser__header");
    const titleBlock = el("div", "rs-livetv-browser__title");
    const titleText = el("h2", "rs-livetv-browser__title-text");
    titleText.textContent = "Channel Browser";
    titleBlock.appendChild(titleText);
    subtitleEl = el("p", "rs-livetv-browser__subtitle");
    subtitleEl.setAttribute("data-browser-subtitle", "");
    subtitleEl.textContent = "Browse and watch live TV";
    titleBlock.appendChild(subtitleEl);
    headerEl.appendChild(titleBlock);
    main.appendChild(headerEl);
  }

  // ── Toolbar: search (top-right) + sort + close ──
  const toolbar = el("div", "rs-livetv-browser__toolbar");
  const search = el("input", "rs-livetv-browser__search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search channels or programmes";
  search.setAttribute("aria-label", opts.searchLabel ?? "Search channels or programmes");
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
  if (headerEl) headerEl.appendChild(toolbar);
  else main.appendChild(toolbar);

  // ── Categories: one clean selector row, horizontally scrollable ──
  const categoriesEl = el("div", "rs-livetv-browser__categories");
  categoriesEl.setAttribute("data-browser-categories", "");
  categoriesEl.setAttribute("role", "tablist");
  categoriesEl.setAttribute("aria-label", "Channel categories");
  main.appendChild(categoriesEl);

  // ── Column header (shares the row grid) ──
  const head = el("div", "rs-livetv-browser__head");
  head.setAttribute("aria-hidden", "true");
  for (const label of ["Ch.", "Channel", "Now", "Next"]) {
    const cell = el("span", "rs-livetv-browser__head-cell");
    cell.textContent = label;
    head.appendChild(cell);
  }
  main.appendChild(head);

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
  main.appendChild(listEl);

  const statusEl = el("p", "rs-livetv-browser__status");
  statusEl.setAttribute("data-browser-status", "");
  statusEl.setAttribute("aria-live", "polite");
  main.appendChild(statusEl);

  // Empty state, rendered INSIDE the list viewport: the status line
  // sits below the list (and below the fold on a 1080p screen), so
  // a no-match search would otherwise show a bare empty list with
  // no explanation. This is the visible feedback; statusEl stays
  // as the polite live region.
  const emptyEl = el("p", "rs-livetv-browser__empty");
  emptyEl.setAttribute("data-browser-empty", "");
  emptyEl.hidden = true;
  listEl.appendChild(emptyEl);

  const visible = (): LivetvChannel[] =>
    applyBrowserFilter(channels, {
      query,
      categoryId,
      sort,
      recentIds: opts.recentIds ?? null,
    });

  const channelById = (id: string | number | null | undefined): LivetvChannel | undefined =>
    id == null ? undefined : channels.find((c) => String(c.id) === String(id));

  /** Logo image or branded initial fallback (shared by rows + panel). */
  function logoContent(channel: LivetvChannel): HTMLElement {
    const wrap = el("span", "rs-livetv-browser__logo-inner");
    if (channel.logo) {
      const img = el("img") as HTMLImageElement;
      img.src = channel.logo;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        wrap.appendChild(logoFallback(channel));
      });
      wrap.appendChild(img);
    } else {
      wrap.appendChild(logoFallback(channel));
    }
    return wrap;
  }

  function logoFallback(channel: LivetvChannel): HTMLElement {
    const mark = el("span", "rs-livetv-browser__initial");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = fallbackMarkFor("logo", channel.displayName || channel.name);
    return mark;
  }

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

    const num = el("span", "rs-livetv-browser__num");
    num.textContent = channel.chno != null ? String(channel.chno) : "";
    row.appendChild(num);

    const channelCell = el("span", "rs-livetv-browser__channel");
    const logo = el("span", "rs-livetv-browser__logo");
    logo.appendChild(logoContent(channel));
    channelCell.appendChild(logo);
    const name = el("span", "rs-livetv-browser__name");
    name.textContent = channel.displayName || channel.name;
    channelCell.appendChild(name);
    if (channel.favourite) {
      const fav = el("span", "rs-livetv-browser__fav");
      fav.setAttribute("aria-label", "Favourite");
      fav.textContent = "♥";
      channelCell.appendChild(fav);
    }
    row.appendChild(channelCell);

    const nn = opts.nowNextFor?.(channel) ?? null;
    const nowCell = el("span", "rs-livetv-browser__now-cell");
    if (nn?.current) {
      const time = el("span", "rs-livetv-browser__time");
      time.textContent = formatTimeRange(nn.current.start, nn.current.stop);
      nowCell.appendChild(time);
      const now = el("span", "rs-livetv-browser__now");
      now.textContent = nn.current.title;
      nowCell.appendChild(now);
      const bar = el("span", "rs-livetv-browser__progress");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("span");
      fill.style.width = `${Math.round(programmeProgress(nn.current.start, nn.current.stop) * 100)}%`;
      bar.appendChild(fill);
      nowCell.appendChild(bar);
    } else if (nn?.next) {
      const time = el("span", "rs-livetv-browser__time");
      time.textContent = `Next ${formatTimeRange(nn.next.start, nn.next.stop)}`;
      nowCell.appendChild(time);
      const next = el("span", "rs-livetv-browser__now rs-livetv-browser__now--muted");
      next.textContent = nn.next.title;
      nowCell.appendChild(next);
    } else {
      const none = el("span", "rs-livetv-browser__now rs-livetv-browser__now--muted");
      none.textContent = "—";
      nowCell.appendChild(none);
    }
    row.appendChild(nowCell);

    const nextCell = el("span", "rs-livetv-browser__next-cell");
    if (nn?.next) {
      const time = el("span", "rs-livetv-browser__time");
      time.textContent = formatTimeRange(nn.next.start, nn.next.stop);
      nextCell.appendChild(time);
      const next = el("span", "rs-livetv-browser__next");
      next.textContent = nn.next.title;
      nextCell.appendChild(next);
    } else {
      const none = el("span", "rs-livetv-browser__next rs-livetv-browser__next--muted");
      none.textContent = "—";
      nextCell.appendChild(none);
    }
    row.appendChild(nextCell);

    return row;
  }

  /**
   * Paint the detail art area in place (never a full panel rebuild):
   * real artwork only when enrichment found some; otherwise the
   * branded placeholder (channel logo on a burgundy gradient — never
   * a giant initial, never an empty rectangle). Only ever called for
   * the highlighted channel's current programme.
   */
  function updateDetailArt(
    channel: LivetvChannel,
    nn: LivetvNowNext | null,
  ): void {
    const artEl = detail.querySelector<HTMLElement>("[data-browser-detail-art]");
    if (!artEl || !nn?.current) return;
    const seq = ++detailArtSeq;
    const paint = (art: ProgrammeArtwork | null): void => {
      if (seq !== detailArtSeq || destroyed) return;
      const url = art?.backdropUrl ?? art?.stillUrl ?? art?.posterUrl ?? null;
      // Same artwork already painted: leave the <img> alone (a
      // rebuild per scroll frame would re-fetch and flicker).
      if (artEl.dataset.artUrl !== (url ?? "")) {
        artEl.dataset.artUrl = url ?? "";
        artEl.replaceChildren();
        if (url) {
          const img = el("img") as HTMLImageElement;
          img.src = url;
          img.alt = "";
          img.loading = "lazy";
          img.decoding = "async";
          img.setAttribute("data-browser-detail-art-img", "");
          img.addEventListener("error", () => {
            // A dead artwork URL falls back to the branded placeholder.
            if (seq === detailArtSeq) {
              artEl.dataset.artUrl = "";
              paint(null);
            }
          });
          artEl.appendChild(img);
          artEl.classList.add("has-art");
        } else {
          artEl.classList.remove("has-art");
          const logo = el("span", "rs-livetv-browser__detail-art-logo");
          logo.appendChild(logoContent(channel));
          artEl.appendChild(logo);
        }
      }
      // TMDB synopsis only fills the slot when the EPG itself
      // carries no description — never two competing descriptions,
      // and never invented text (only enrichment output is shown).
      const syn = detail.querySelector<HTMLElement>("[data-browser-detail-synopsis]");
      if (syn) {
        const text = art?.synopsis && !nn.current?.desc ? art.synopsis : "";
        syn.textContent = text;
        syn.hidden = !text;
      }
    };
    const cached = getProgrammeArtworkSync(nn.current.title);
    if (cached) {
      paint(cached);
      return;
    }
    paint(null);
    // One enrichment per (channel, programme) while it is in
    // flight: scroll renders re-enter here constantly, and must
    // never spawn a second request for the same programme.
    const enrichKey = `${channel.id}|${nn.current.title}`;
    if (enrichKey === lastEnrichedKey) return;
    lastEnrichedKey = enrichKey;
    void enrichProgramme({
      title: nn.current.title,
      channelName: channel.displayName || channel.name,
      startMs: nn.current.start,
      endMs: nn.current.stop,
    })
      .then(paint)
      .catch(() => undefined);
  }

  /** Compact contextual panel for the highlighted channel. */
  function renderDetail(): void {
    const channel = channelById(highlightedId);
    const nn = channel ? (opts.nowNextFor?.(channel) ?? null) : null;
    // Keyed re-render: scroll renders call render() on every frame,
    // but the panel only rebuilds when its content actually changes
    // (channel, programmes, favourite, catch-up). That also keeps a
    // pending enrichment from being discarded mid-flight.
    const detailKey = channel
      ? [
          String(channel.id),
          nn?.current?.title ?? "",
          nn?.next?.title ?? "",
          channel.favourite ? "fav" : "",
          channel.catchup ? "catchup" : "",
        ].join("|")
      : "";
    if (detailKey === lastDetailKey) {
      if (channel) updateDetailArt(channel, nn);
      return;
    }
    lastDetailKey = detailKey;
    detailArtSeq += 1;
    detail.replaceChildren();
    if (!channel) {
      const empty = el("p", "rs-livetv-browser__detail-empty");
      empty.textContent = "Select a channel to see what's on.";
      detail.appendChild(empty);
      return;
    }
    const brand = el("div", "rs-livetv-browser__detail-brand");
    const logo = el("span", "rs-livetv-browser__detail-logo");
    logo.appendChild(logoContent(channel));
    brand.appendChild(logo);
    const titles = el("div", "rs-livetv-browser__detail-titles");
    const name = el("span", "rs-livetv-browser__detail-name");
    name.textContent = channel.displayName || channel.name;
    titles.appendChild(name);
    if (channel.chno != null) {
      const chno = el("span", "rs-livetv-browser__detail-chno");
      chno.textContent = `Ch. ${channel.chno}`;
      titles.appendChild(chno);
    }
    brand.appendChild(titles);
    detail.appendChild(brand);

    // Programme art earns its space only when there is a current
    // programme to illustrate. With no EPG the panel stays compact
    // (brand + note + actions) instead of holding a giant empty
    // panel for art that does not exist.
    if (nn?.current) {
      const art = el("div", "rs-livetv-browser__detail-art");
      art.setAttribute("data-browser-detail-art", "");
      art.setAttribute("aria-hidden", "true");
      detail.appendChild(art);
    }

    if (nn?.current) {
      const nowBlock = el("div", "rs-livetv-browser__detail-now");
      const label = el("span", "rs-livetv-browser__detail-label");
      label.textContent = `● Now (${formatTimeRange(nn.current.start, nn.current.stop)})`;
      nowBlock.appendChild(label);
      const title = el("span", "rs-livetv-browser__detail-title");
      title.textContent = nn.current.title;
      nowBlock.appendChild(title);
      if (nn.current.desc) {
        const desc = el("span", "rs-livetv-browser__detail-desc");
        desc.textContent = nn.current.desc;
        nowBlock.appendChild(desc);
      } else {
        // Filled in place by updateDetailArt when enrichment has a
        // synopsis; hidden until then.
        const syn = el("span", "rs-livetv-browser__detail-desc");
        syn.setAttribute("data-browser-detail-synopsis", "");
        syn.hidden = true;
        nowBlock.appendChild(syn);
      }
      const bar = el("span", "rs-livetv-browser__progress");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("span");
      fill.style.width = `${Math.round(programmeProgress(nn.current.start, nn.current.stop) * 100)}%`;
      bar.appendChild(fill);
      nowBlock.appendChild(bar);
      detail.appendChild(nowBlock);
    }
    if (nn?.next) {
      const nextBlock = el("div", "rs-livetv-browser__detail-next");
      const label = el("span", "rs-livetv-browser__detail-label");
      label.textContent = `Next (${formatTimeRange(nn.next.start, nn.next.stop)})`;
      nextBlock.appendChild(label);
      const title = el("span", "rs-livetv-browser__detail-title");
      title.textContent = nn.next.title;
      nextBlock.appendChild(title);
      detail.appendChild(nextBlock);
    }
    if (!nn?.current && !nn?.next) {
      const none = el("p", "rs-livetv-browser__detail-empty");
      none.textContent = "No programme information for this channel yet.";
      detail.appendChild(none);
    }
    if (channel.catchup) {
      const catchup = el("span", "rs-livetv-browser__detail-catchup");
      catchup.textContent = "Catch-up available";
      detail.appendChild(catchup);
    }

    const actions = el("div", "rs-livetv-browser__detail-actions");
    const watch = el("button", "rs-livetv-browser__watch-live") as HTMLButtonElement;
    watch.type = "button";
    watch.setAttribute("data-browser-watch-live", "");
    watch.setAttribute("data-channel-id", String(channel.id));
    watch.textContent = "▶ Watch Live";
    actions.appendChild(watch);
    const favBtn = el("button", "rs-livetv-browser__favourite") as HTMLButtonElement;
    favBtn.type = "button";
    favBtn.setAttribute("data-browser-favourite", "");
    favBtn.setAttribute("data-channel-id", String(channel.id));
    favBtn.setAttribute("aria-pressed", String(!!channel.favourite));
    favBtn.textContent = channel.favourite ? "♥ Favourited" : "♡ Favourite";
    actions.appendChild(favBtn);
    const guide = el("button", "rs-livetv-browser__guide") as HTMLButtonElement;
    guide.type = "button";
    guide.setAttribute("data-browser-guide", "");
    guide.setAttribute("data-channel-id", String(channel.id));
    guide.textContent = "View Guide";
    actions.appendChild(guide);
    detail.appendChild(actions);

    updateDetailArt(channel, nn);
  }

  function render(): void {
    if (destroyed) return;
    const list = visible();
    if (opts.autoHighlightFirst && list.length > 0) {
      // Screen mode: the highlight always names a visible channel.
      // A category/search change that drops the highlighted channel
      // out of view moves the highlight to the first visible row
      // (and its detail panel) instead of showing a channel that is
      // no longer in the list.
      const stillVisible =
        highlightedId != null &&
        list.some((c) => String(c.id) === String(highlightedId));
      if (!stillVisible) {
        highlightedId = list[0]!.id;
        opts.onHighlight?.(list[0]!);
      }
    }
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
    const statusText =
      list.length === 0
        ? query
          ? `No channels match “${query}”.`
          : categoryId === BROWSER_CATEGORY_FAVOURITES
            ? "No favourite channels yet — press X on a channel to add one."
            : categoryId === BROWSER_CATEGORY_RECENTS
              ? "Nothing watched yet — channels you watch will appear here."
              : "No channels in this category."
        : `${list.length.toLocaleString()} channel${list.length === 1 ? "" : "s"}`;
    statusEl.textContent = statusText;
    emptyEl.hidden = list.length !== 0;
    emptyEl.textContent = statusText;
    if (subtitleEl) {
      const total = channels.length;
      subtitleEl.textContent =
        total > 0
          ? `Browse and watch live TV • ${total.toLocaleString()} channel${total === 1 ? "" : "s"}`
          : "Browse and watch live TV";
    }
    renderDetail();
  }

  function renderCategories(): void {
    const activeCategory = document.activeElement as HTMLElement | null;
    const focusedCategoryId = activeCategory?.closest?.("[data-browser-category]")?.getAttribute("data-browser-category");
    const cats = browserCategories(channels, opts.recentIds ?? null);
    categoriesEl.replaceChildren();
    for (const cat of cats) {
      const btn = el("button", "rs-livetv-browser__category") as HTMLButtonElement;
      btn.type = "button";
      btn.setAttribute("data-browser-category", cat.id);
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(cat.id === categoryId));
      btn.setAttribute("aria-label", `${cat.label}, ${cat.count} channel${cat.count === 1 ? "" : "s"}`);
      btn.title = `${cat.label} (${cat.count})`;
      if (cat.id === categoryId) btn.classList.add("is-active");
      const icon = el("span", "rs-livetv-browser__category-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = cat.icon;
      btn.appendChild(icon);
      const label = el("span", "rs-livetv-browser__category-label");
      label.textContent = cat.label;
      btn.appendChild(label);
      btn.addEventListener("click", () => {
        categoryId = cat.id;
        renderCategories();
        listEl.scrollTop = 0;
        render();
      });
      categoriesEl.appendChild(btn);
    }
    // Focus never resets on a data refresh: if focus was on a
    // category button, return it to the same category.
    if (focusedCategoryId) {
      const next = categoriesEl.querySelector<HTMLElement>(
        `[data-browser-category="${CSS.escape(focusedCategoryId)}"]`,
      );
      next?.focus({ preventScroll: true });
    }
  }

  function setCategory(next: string): void {
    const known = browserCategories(channels, opts.recentIds ?? null).some(
      (cat) => cat.id === next,
    );
    categoryId = known ? next : BROWSER_CATEGORY_ALL;
    renderCategories();
    listEl.scrollTop = 0;
    render();
  }

  function cycleCategory(delta: number): void {
    const cats = browserCategories(channels, opts.recentIds ?? null);
    if (cats.length === 0) return;
    const current = cats.findIndex((cat) => cat.id === categoryId);
    const next = cats[(current < 0 ? 0 : current + delta + cats.length) % cats.length];
    if (next) setCategory(next.id);
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

  function jumpPage(delta: number): void {
    const list = visible();
    if (!list.length) return;
    const pageSize = Math.max(
      1,
      Math.floor((listEl.clientHeight || 600) / BROWSER_ROW_HEIGHT),
    );
    const currentIndex = list.findIndex((c) => String(c.id) === String(highlightedId));
    const base = currentIndex < 0 ? (delta > 0 ? -pageSize : pageSize) : currentIndex;
    const nextIndex = Math.max(0, Math.min(list.length - 1, base + delta * pageSize));
    const channel = list[nextIndex];
    if (!channel) return;
    highlight(channel.id);
    scrollToId(channel.id);
  }

  function isSearchOpen(): boolean {
    return document.activeElement === search || query !== "";
  }

  function openSearch(): void {
    search.focus({ preventScroll: true });
    root.classList.add("is-search-open");
  }

  function closeSearch(): boolean {
    const wasOpen = isSearchOpen();
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    query = "";
    search.value = "";
    search.blur();
    root.classList.remove("is-search-open");
    listEl.scrollTop = 0;
    render();
    return wasOpen;
  }

  function applyEntry(
    entry: BrowserEntryFilter | null | undefined,
    entryOpts?: { openSearch?: boolean },
  ): void {
    setCategory(browserFilterFromEntry(entry));
    if (entryOpts?.openSearch) openSearch();
  }

  /** Back (B / Escape), in directive order: close search, else exit. */
  function handleBack(): void {
    const now = Date.now();
    if (now - lastBackAt < BROWSER_BACK_COALESCE_MS) return;
    lastBackAt = now;
    if (isSearchOpen()) {
      closeSearch();
      return;
    }
    opts.onClose?.();
  }

  async function toggleFavourite(channel: LivetvChannel): Promise<boolean | null> {
    if (opts.onToggleFavourite) return opts.onToggleFavourite(channel);
    if (!opts.playlistId) return null;
    try {
      const { toggleFavorite } = await import("./preferences.js");
      const next = toggleFavorite(opts.playlistId, "live", channel.id as number, {
        name: channel.displayName || channel.name || "",
        logo: channel.logo ?? null,
      }) as boolean | null;
      if (next != null) {
        // Update the row in place now; the
        // `xt:favorites-changed` refresh re-loads the catalogue
        // and confirms it.
        channel.favourite = next;
        render();
      }
      return next;
    } catch {
      return null;
    }
  }

  async function toggleFavouriteHighlighted(): Promise<boolean | null> {
    const channel = channelById(highlightedId);
    if (!channel) return null;
    return toggleFavourite(channel);
  }

  function viewGuide(channel: LivetvChannel): void {
    if (opts.onViewGuide) {
      opts.onViewGuide(channel);
      return;
    }
    // Unified on the shared helper (integration): same event + shape.
    requestLivetvMode("guide");
  }

  // ── Events ──
  function applyQueryNow(): void {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    query = search.value.trim();
    listEl.scrollTop = 0;
    render();
  }
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(applyQueryNow, BROWSER_SEARCH_DEBOUNCE_MS);
  });
  search.addEventListener("focus", () => root.classList.add("is-search-open"));
  search.addEventListener("blur", () => {
    if (query === "") root.classList.remove("is-search-open");
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // Typing in search: B / Esc closes search, never exits.
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
      return;
    }
    if (event.key === "Enter") {
      // Apply the query immediately and move to the first match:
      // the list, not the keyboard, is where the user goes next.
      event.preventDefault();
      event.stopPropagation();
      applyQueryNow();
      const first = visible()[0];
      if (first) {
        highlight(first.id);
        scrollToId(first.id);
        listEl.focus({ preventScroll: true });
      }
    }
  });
  sortSelect.addEventListener("change", () => {
    sort = sortSelect.value as BrowserSort;
    listEl.scrollTop = 0;
    render();
  });
  listEl.addEventListener("scroll", () => render(), { passive: true });
  viewport.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest?.("[data-browser-row]") as HTMLElement | null;
    if (!row) return;
    const channel = channelById(row.getAttribute("data-channel-id"));
    if (!channel) return;
    // Any click on a row only highlights. Never tunes.
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
  detail.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const channel = channelById(highlightedId);
    if (!channel) return;
    if (target?.closest?.("[data-browser-watch-live]")) {
      // Explicit Watch action — the only click path that may tune.
      opts.onSelect?.(channel);
      return;
    }
    if (target?.closest?.("[data-browser-favourite]")) {
      void toggleFavourite(channel);
      return;
    }
    if (target?.closest?.("[data-browser-guide]")) {
      viewGuide(channel);
    }
  });

  // One keyboard handler for the whole browser, on window: the
  // gamepad layer dispatches synthesised keys to
  // document.activeElement, which is usually <body> when nothing
  // holds focus — a list-level listener would never see them.
  // Gated on visibility (a hidden ancestor means another mode owns
  // input) and on the target being inside this browser or <body>.
  const onKeyDown = (event: KeyboardEvent) => {
    if (destroyed || !root.isConnected || root.closest("[hidden]")) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      target !== document.body &&
      !(target instanceof Node && root.contains(target))
    ) {
      return;
    }
    if (isEditableTarget(target)) return;
    const list = visible();
    const currentIndex = list.findIndex((c) => String(c.id) === String(highlightedId));
    const move = (delta: number) => {
      if (!list.length) return;
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
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Enter":
      case " ": {
        const channel = channelById(highlightedId);
        if (channel) {
          event.preventDefault();
          opts.onSelect?.(channel);
        }
        return;
      }
      case "Escape":
        // Claim the key: without preventDefault the playback
        // shell's window-level Escape handler also fires after
        // onClose hides the browser — B would close the browser
        // AND drop a mode in one press.
        event.preventDefault();
        handleBack();
        return;
      case "PageDown":
        event.preventDefault();
        jumpPage(1);
        return;
      case "PageUp":
        event.preventDefault();
        jumpPage(-1);
        return;
      case "[":
        event.preventDefault();
        cycleCategory(-1);
        return;
      case "]":
        event.preventDefault();
        cycleCategory(1);
        return;
      default:
        break;
    }
    const lower = event.key.toLowerCase();
    if (lower === "x") {
      event.preventDefault();
      void toggleFavouriteHighlighted();
    } else if (lower === "y") {
      event.preventDefault();
      openSearch();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  // Collection cards (Home) switch this browser's category:
  // `livetv:browser-category` {browserId?, categoryId}. An event
  // naming another browser id is ignored, so the playback instance
  // never follows a Home tap.
  const onBrowserCategory = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { browserId?: string; categoryId?: string }
      | undefined;
    if (!detail?.categoryId) return;
    if (detail.browserId && opts.browserId && detail.browserId !== opts.browserId) return;
    setCategory(detail.categoryId);
  };
  window.addEventListener("livetv:browser-category", onBrowserCategory);

  // 0.9.0 screen entry: `livetv:mode` {mode:"browser",
  // browserFilter?, openSearch?}. Only the screen instance listens
  // (acceptModeEntry) — the Home inline browser and the playback
  // overlay never follow mode entries.
  const onMode = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { mode?: string; browserFilter?: BrowserEntryFilter; openSearch?: boolean }
      | undefined;
    if (!detail || detail.mode !== "browser") return;
    applyEntry(detail.browserFilter, { openSearch: detail.openSearch });
  };
  if (opts.acceptModeEntry) window.addEventListener("livetv:mode", onMode);

  // B / Escape resolved to "back" by the gamepad layer (W5):
  // `livetv:back` {context:"browser"}.
  const onBack = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { context?: string }
      | undefined;
    if (detail?.context && detail.context !== "browser") return;
    if (!root.isConnected || root.closest("[hidden]")) return;
    handleBack();
  };
  window.addEventListener("livetv:back", onBack);

  renderCategories();
  render();
  if (highlightedId != null) scrollToId(highlightedId);

  return {
    root,
    setChannels(next: LivetvChannel[]): void {
      // Preserve selection + scroll position across a data
      // refresh: never reset focus when new data lands.
      const savedScrollTop = listEl.scrollTop;
      channels = [...next];
      if (highlightedId != null && !channelById(highlightedId)) highlightedId = null;
      renderCategories();
      render();
      listEl.scrollTop = savedScrollTop;
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
    applyEntry,
    openSearch,
    closeSearch,
    isSearchOpen,
    getCategoryId(): string {
      return categoryId;
    },
    getVisibleChannels(): LivetvChannel[] {
      return visible();
    },
    cycleCategory,
    jumpPage,
    toggleFavouriteHighlighted,
    destroy(): void {
      destroyed = true;
      if (searchTimer) clearTimeout(searchTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("livetv:browser-category", onBrowserCategory);
      window.removeEventListener("livetv:mode", onMode);
      window.removeEventListener("livetv:back", onBack);
      root.replaceChildren();
      root.classList.remove("rs-livetv-browser");
      root.removeAttribute("data-livetv-browser");
      root.removeAttribute("data-browser-screen");
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
  /** 0.9.0 screen instance: follow `livetv:mode` browser entries. */
  acceptModeEntry?: boolean;
  /** Highlight the first visible channel on mount. */
  autoHighlightFirst?: boolean;
  onToggleFavourite?: ChannelBrowserOptions["onToggleFavourite"];
  onViewGuide?: (channel: LivetvChannel) => void;
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
    acceptModeEntry: opts.acceptModeEntry,
    autoHighlightFirst: opts.autoHighlightFirst,
    onToggleFavourite: opts.onToggleFavourite,
    onViewGuide: opts.onViewGuide,
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
