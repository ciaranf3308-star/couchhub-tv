// RedSilk Couch — Channel Browser (0.11.7 W2 rebuild).
//
// The virtualised long list used from Live TV Home, from playback
// (Quick Surf's "all channels" view via mountChannelBrowser /
// mountCachedChannelBrowser — same module, same contract) and as the
// dedicated Channel Browser utility screen (TvChannelBrowser with
// screenMode; the shell mounts it as the "browser" mode and enters it
// via `livetv:mode` {mode:"browser", browserFilter?, openSearch?}).
//
// 0.11.7 rules (Live TV 2.0, §1C/E, §3–§5):
//   - VIRTUALISED, INCREMENTALLY. Visible rows + overscan only,
//     in stable KEYED DOM nodes that are reused across paints —
//     never rebuilt. Scroll paints are coalesced through
//     requestAnimationFrame; one controller input performs at most
//     one paint; a paint whose window, derived list and highlight
//     are unchanged is a no-op. Row heights are fixed
//     (BROWSER_ROW_HEIGHT); no per-row layout measurement. Moving
//     focus NEVER destroys the focused element: the highlighted
//     row's node survives every paint while it is in the window,
//     and evicting a focused row first moves focus to the list.
//   - ONE DERIVED LIST. Scrolling and focus reuse the cached
//     derived list; the catalogue is re-derived only when the
//     selection, search, sort or catalogue itself changes. All
//     category-index consumption sits behind ONE adapter function
//     (getBrowserCategoryData) over W1's shared index
//     (livetv-category-index.ts).
//   - ONE CATEGORY CONTROL. The horizontal pills and category
//     <select> elements are gone. A single prominent category
//     button opens the category drawer (livetv-category-drawer.ts
//     / TvCategoryDrawer.astro): vertical groups, real provider
//     subcategories, "All <Group>" first. A breadcrumb always
//     shows the applied group + subcategory. D-pad Left from the
//     list opens the drawer; Right from the drawer returns.
//   - SEARCH / SORT ARE OVERLAYS (W4). The inline search box and
//     sort <select> are gone. Y dispatches `livetv:open-search`
//     and Menu dispatches `livetv:open-sort` (detail carries the
//     current group/subcategory context); W4's overlays answer
//     with `livetv:search-submit` {query, scope} and
//     `livetv:sort-submit` {sort}. This module never imports them.
//   - Highlight NEVER starts playback. Highlighting (arrows,
//     click, drawer selection) only highlights (aria-selected +
//     onHighlight). A tune happens only through the explicit Watch
//     action (Watch Live, Enter, double-click) via onSelect.
//   - BACK IS ONE LAYER PER PRESS (see the marked LAYER section):
//     drawer subcategories → drawer top level → drawer closed →
//     clear search filter → onClose (exit to landing). B never
//     closes two layers. A 250ms coalescing window guards against
//     the gamepad layer dispatching both `livetv:back` and Escape
//     for one press.
//   - CONTROLLER: this module reuses the shared mapping
//     (livetv-keys.ts resolvers) and the gamepad layer's
//     synthesised keys — there is no second controller system.
//     D-pad Up/Down move; Left opens categories; Right returns
//     from the drawer; A watches; B is contextual back; X
//     favourite; Y search; LB/RB prev/next category; LT/RT
//     prev/next page; Menu opens sort/options.
//   - FOCUS MEMORY: the last highlighted channel per selection is
//     remembered; returning to a selection restores it where
//     possible, else the first visible channel. Focus returns to
//     the previously highlighted channel on drawer close.
//   - EPG: cached lookups only, for visible rows only. The detail
//     panel enriches ONLY the highlighted channel's current
//     programme (livetv-enrichment); category changes trigger no
//     mass enrichment or image requests.
//   - Search normalisation is unchanged: redundant provider
//     prefixes are ignored (normalizeBrowserQuery), surviving
//     tokens must all match the cached haystack.
//   - No rectangles-in-rectangles: hierarchy comes from spacing,
//     typography and hairline separators, never nested boxes.
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
  loadLivetvHomeData,
  nowNextForChannel,
  readActivePlaylistId,
  requestLivetvMode,
  type LivetvChannel,
  type LivetvNowNext,
} from "./livetv-data";
import {
  buildCategoryIndex,
  getCategoryIndex,
  getDerivedChannels,
  invalidateDerivedChannels,
  type CategoryIndex,
  type DerivedChannelsOptions,
} from "./livetv-category-index";
import { livetvNav } from "./livetv-nav";
import {
  LIVETV_CLOSE_OVERLAY_EVENT,
  applyCategoryChangeToSearch,
  readPersistedLivetvSort,
  writePersistedLivetvSort,
  type LivetvSearchState,
} from "./livetv-search-sort";
import {
  mountCategoryDrawer,
  type CategoryDrawerHandle,
  type DrawerGroup,
} from "./livetv-category-drawer";
import { livetvKeyActionForKey } from "./livetv-keys";

/** One browser row is always this tall — the virtual list depends on it. */
export const BROWSER_ROW_HEIGHT = 76;
/** Overscan rows mounted above/below the visible window. */
export const BROWSER_OVERSCAN_ROWS = 3;
/**
 * Search debounce (ms). Retained as the contract value: W4's
 * search overlay debounces its input by this long before
 * dispatching `livetv:search-submit`; the browser applies a
 * submitted query immediately.
 */
export const BROWSER_SEARCH_DEBOUNCE_MS = 150;
/** Back actions closer together than this are one press (the gamepad
 *  layer may dispatch both `livetv:back` and Escape for a single B). */
export const BROWSER_BACK_COALESCE_MS = 250;
/** Cap on detached row shells kept for reuse (window + headroom). */
const ROW_POOL_MAX = 40;

export type BrowserSort = "source" | "az" | "za" | "category";

/** Search scope carried on `livetv:search-submit`. */
export type BrowserSearchScope = "category" | "all";

export interface BrowserFilter {
  query?: string;
  /** "all" | "favourites" | "recents" | a group id from the shared category index. */
  categoryId?: string | null;
  /**
   * Subcategory id within the group: a W1 subcategory id
   * (`sub:<slug>`), or — for entry filters that still carry the
   * verbatim provider category — the raw category string, which
   * resolves to the W1 id (null = whole group).
   */
  subcategoryId?: string | null;
  sort?: BrowserSort;
  /** Most-recent-first ids, for the "recents" pseudo-category order. */
  recentIds?: ReadonlyArray<string | number> | null;
}

export const BROWSER_CATEGORY_ALL = "all";
export const BROWSER_CATEGORY_FAVOURITES = "favourites";
export const BROWSER_CATEGORY_RECENTS = "recents";

/**
 * A browser selection: a top-level group, optionally narrowed to
 * one provider subcategory. subcategoryId null = "All <Group>".
 */
export interface BrowserSelection {
  groupId: string;
  subcategoryId: string | null;
}

/**
 * Entry filter carried on `livetv:mode` {mode:"browser",
 * browserFilter} (and on the mount's data attributes — see
 * TvChannelBrowser). "category" names a provider group id
 * (the shared category index), e.g. "irish-uk" / "sports";
 * `subcategory` optionally names a subcategory within it — a W1
 * subcategory id, or the verbatim provider category (resolved
 * to the W1 id on apply).
 */
export interface BrowserEntryFilter {
  kind: "all" | "favourites" | "recents" | "category";
  value?: string;
  subcategory?: string;
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

/** Pure: map an entry filter onto a full BrowserSelection. */
export function browserSelectionFromEntry(
  entry: BrowserEntryFilter | null | undefined,
): BrowserSelection {
  return {
    groupId: browserFilterFromEntry(entry),
    subcategoryId:
      entry?.kind === "category" && entry.subcategory
        ? entry.subcategory
        : null,
  };
}

// ── W4 overlay event contract (0.11.7 §5b) ───────────────────────
// The browser dispatches open-* events; W4's overlays listen and
// answer with submit events. Neither side imports the other.

/** Y / Search button: ask W4's overlay to open (detail: context). */
export const LIVETV_OPEN_SEARCH_EVENT = "livetv:open-search";
/** Menu / Sort button: ask W4's overlay to open (detail: context). */
export const LIVETV_OPEN_SORT_EVENT = "livetv:open-sort";
/** W4 search overlay answer: apply this query. */
export const LIVETV_SEARCH_SUBMIT_EVENT = "livetv:search-submit";
/** W4 sort overlay answer: apply this sort. */
export const LIVETV_SORT_SUBMIT_EVENT = "livetv:sort-submit";

export interface LivetvOpenSearchDetail extends BrowserSelection {
  query: string;
  scope: BrowserSearchScope;
}

export interface LivetvOpenSortDetail extends BrowserSelection {
  sort: BrowserSort;
}

export interface LivetvSearchSubmitDetail {
  query: string;
  /** "all" searches the whole catalogue; anything else searches the current selection. */
  scope?: BrowserSearchScope;
  /** Category the search was scoped to (W4 submit detail). Accepted; the browser applies the search to its current selection, which the overlay captured at open. */
  categoryId?: string | null;
}

export interface LivetvSortSubmitDetail {
  sort: BrowserSort;
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
 * at catalogue load), keyed by channel id. Re-derives call the
 * search over this index, so the per-query work stays a Map
 * lookup, never a re-normalise of 15,000 names.
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
 * Pure: resolve a subcategory reference to its canonical W1 id.
 * Accepts a W1 subcategory id (`sub:<slug>`) directly, or the
 * verbatim raw provider category (the pre-0.11.7 entry-filter
 * spelling), resolved through the subcategory's raw name.
 * Returns null when the reference names no subcategory of this
 * group — a stale/foreign reference never silently selects a
 * different subcategory. `subs` may be index subcategories
 * (rawName always present) or drawer subcategories (rawName
 * carried by the adapter).
 */
export function resolveBrowserSubcategoryId(
  subs: ReadonlyArray<{ id: string; rawName?: string }>,
  rawOrId: string,
): string | null {
  const direct = subs.find((sub) => sub.id === rawOrId);
  if (direct) return direct.id;
  const byRaw = subs.find((sub) => sub.rawName === rawOrId);
  return byRaw ? byRaw.id : null;
}

/** Pure: recents-ordered channels (most-recent-first ids). */
export function recentOrderedChannels(
  channels: readonly LivetvChannel[],
  recentIds: ReadonlyArray<string | number> | null | undefined,
): LivetvChannel[] {
  const order = new Map<string, number>();
  for (const [index, id] of (recentIds ?? []).entries()) {
    if (!order.has(String(id))) order.set(String(id), index);
  }
  return channels
    .filter((channel) => order.has(String(channel.id)))
    .sort(
      (a, b) =>
        (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
    );
}

/** Pure: sort a list without mutating it. */
export function sortBrowserChannels(
  channels: readonly LivetvChannel[],
  sort: BrowserSort = "source",
): LivetvChannel[] {
  switch (sort) {
    case "az":
      return [...channels].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );
    case "za":
      return [...channels].sort((a, b) =>
        b.displayName.localeCompare(a.displayName),
      );
    case "category":
      return [...channels].sort(
        (a, b) =>
          a.categoryLabel.localeCompare(b.categoryLabel) ||
          a.displayName.localeCompare(b.displayName),
      );
    case "source":
    default:
      return [...channels];
  }
}

/**
 * Pure: filter + sort one browser view, through the shared
 * category index (never the legacy groupChannels compatibility
 * export: this
 * builds a fresh index for the given array, so it stays pure
 * and never serves another catalogue's cached index).
 * Category "favourites" keeps favourite-flagged channels;
 * "recents" keeps the given recent ids in recents order; a
 * group id keeps that group's channels in subcategory order,
 * optionally narrowed to one subcategory (a W1 subcategory id
 * or the verbatim provider category — see
 * resolveBrowserSubcategoryId); "all" / null keeps everything.
 * An unknown group or subcategory yields []. Sort is applied
 * last. Search uses the browser's cleaned query
 * (normalizeBrowserQuery) over the cached haystacks.
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
    list = recentOrderedChannels(channels, filter.recentIds);
  } else if (categoryId !== BROWSER_CATEGORY_ALL) {
    const index = buildCategoryIndex(
      channels,
      "livetv-browser:applyBrowserFilter",
    );
    const opts: DerivedChannelsOptions = { groupId: categoryId };
    if (filter.subcategoryId) {
      const group = index.groups.find((g) => g.id === categoryId);
      const resolved = group
        ? resolveBrowserSubcategoryId(group.subcategories, filter.subcategoryId)
        : null;
      if (!resolved) return sortBrowserChannels([], filter.sort ?? "source");
      opts.subcategoryId = resolved;
    }
    list = [...getDerivedChannels(index, opts)];
  } else {
    list = [...channels];
  }
  if (filter.query) list = searchBrowserChannels(list, filter.query);
  return sortBrowserChannels(list, filter.sort ?? "source");
}

export interface BrowserCategory {
  id: string;
  label: string;
  count: number;
  /** Small text glyph for the row (mockup 1: one icon per entry). */
  icon: string;
}

/** Glyph per category id (text glyphs only — no emoji). */
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
 * Top-level categories for a channel set, in the mockup order:
 * Favourites, provider groups (Irish & UK first, the shared
 * index's order), Recents, All Channels last. Favourites /
 * Recents / All are ALWAYS present, even at count 0, so they
 * stay immediately reachable as entry points; selecting an
 * empty one shows the empty state instead of hiding the
 * destination. This order is the drawer's top-level order and
 * the LB/RB cycle order. Built from a fresh index for the given
 * array (pure; the mounted browser's adapter caches its own
 * index and does not call this per render).
 */
export function browserCategories(
  channels: readonly LivetvChannel[],
  recentIds?: ReadonlyArray<string | number> | null,
): BrowserCategory[] {
  const index = buildCategoryIndex(
    channels,
    "livetv-browser:browserCategories",
  );
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
  // Mockup order for the headline groups (Favourites, Irish &
  // UK, Sports, Movies, News, Kids); every other genuine provider
  // group follows in index order, then Recents, All last.
  const headlineOrder = ["irish-uk", "sports", "movies", "news", "kids"];
  const orderedGroups = index.groups
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
      count: group.channelCount,
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

/**
 * Pure: the breadcrumb label for a selection — the group label,
 * or "Group / Subcategory" when narrowed. Unknown ids fall back
 * to the raw id (never an invented label).
 */
export function browserSelectionLabel(
  selection: BrowserSelection,
  groups: ReadonlyArray<{
    id: string;
    label: string;
    subcategories: ReadonlyArray<{ id: string; label: string }>;
  }>,
): string {
  const group = groups.find((g) => g.id === selection.groupId);
  if (!group) return selection.groupId;
  if (selection.subcategoryId == null) return group.label;
  const sub = group.subcategories.find((s) => s.id === selection.subcategoryId);
  return sub ? `${group.label} / ${sub.label}` : group.label;
}

/** Human label for a sort value (sort button + W4 overlay context). */
export function browserSortLabel(sort: BrowserSort): string {
  switch (sort) {
    case "az":
      return "A–Z";
    case "za":
      return "Z–A";
    case "category":
      return "Category, A–Z";
    case "source":
    default:
      return "Source order";
  }
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
  /** Verbatim provider subcategory id within the initial category. */
  initialSubcategoryId?: string | null;
  initialFocusId?: string | number | null;
  sort?: BrowserSort;
  /** Explicit Watch action — the ONLY path that may tune. */
  onSelect?: (channel: LivetvChannel) => void;
  /** Highlight moved (click / arrows). Never a tune. */
  onHighlight?: (channel: LivetvChannel) => void;
  onClose?: () => void;
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
  /** Ask W4's search overlay to open (dispatches `livetv:open-search`). */
  openSearch(): void;
  /** Ask W4's sort overlay to open (dispatches `livetv:open-sort`). */
  openSort(): void;
  /** Clear the applied search filter. Returns true when a filter was active. */
  closeSearch(): boolean;
  /** True when a search filter is currently applied. */
  isSearchOpen(): boolean;
  getCategoryId(): string;
  getSubcategoryId(): string | null;
  getSelection(): BrowserSelection;
  setSelection(groupId: string, subcategoryId?: string | null): void;
  getVisibleChannels(): LivetvChannel[];
  cycleCategory(delta: number): void;
  jumpPage(delta: number): void;
  toggleFavouriteHighlighted(): Promise<boolean | null>;
  /** Open the category drawer. */
  openCategories(): void;
  /** Close the category drawer without changing the selection. */
  closeCategories(): void;
  isDrawerOpen(): boolean;
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

function isEditableTarget(target: EventTarget | null): boolean {  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Cached child refs for one reusable row shell. */
interface RowRefs {
  row: HTMLElement;
  /** Content key last painted into this shell. */
  key: string;
  /** Logo URL last painted ("" = fallback mark). */
  logoKey: string;
  num: HTMLElement;
  logoWrap: HTMLElement;
  name: HTMLElement;
  fav: HTMLElement;
  nowTime: HTMLElement;
  nowTitle: HTMLElement;
  progress: HTMLElement;
  progressFill: HTMLElement;
  nextTime: HTMLElement;
  nextTitle: HTMLElement;
}

/** Monotonic browser-instance ids: index revisions and nav-layer keys are instance-scoped. */
let nextBrowserInstanceId = 1;

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
  const browserInstanceId = nextBrowserInstanceId++;
  /** Nav-layer key for this instance's category drawer. */
  const drawerNavKey = `browser-drawer:${browserInstanceId}`;
  let channels: LivetvChannel[] = [...opts.channels];
  let groupId = opts.initialCategoryId ?? BROWSER_CATEGORY_ALL;
  let subcategoryId: string | null = opts.initialSubcategoryId ?? null;
  // Explicit sort wins; otherwise the persisted sort (W4: the
  // user picked an order last time and reopening keeps it).
  let sort: BrowserSort = opts.sort ?? readPersistedLivetvSort();
  let query = "";
  let queryScope: BrowserSearchScope = "category";
  /**
   * Category the applied search was scoped to (subcategory id
   * wins over group id; null for scope "all"). The
   * category-change clearing rule (W4) compares against this.
   */
  let searchCategoryId: string | null = null;
  let highlightedId: string | number | null =
    opts.initialFocusId ?? null;
  let destroyed = false;
  let lastBackAt = 0;
  // Detail-panel enrichment: only the highlighted channel's current
  // programme is ever enriched. detailArtSeq guards the async art
  // against a highlight that moved on; lastDetailKey keeps the
  // panel from rebuilding (and re-enriching) on every scroll paint.
  const enrichProgramme = opts.enrichProgramme ?? defaultEnrichProgramme;
  let detailArtSeq = 0;
  let lastDetailKey = "__unrendered__";
  let lastEnrichedKey = "";

  // ── Derived-list + index-adapter caches ──────────────────────
  // catalogueStateRevision rises whenever the catalogue array is
  // replaced OR a channel is mutated in place (favourite toggle),
  // so the adapter and the derived list never serve stale slices.
  let catalogueStateRevision = 0;
  let derivedRevision = 0;
  let derivedCache: { key: string; list: LivetvChannel[] } | null = null;
  let categoryDataCache: {
    channels: readonly LivetvChannel[];
    revision: number;
    groups: DrawerGroup[];
    channelsFor: (selection: BrowserSelection) => readonly LivetvChannel[];
    index: CategoryIndex;
  } | null = null;

  /**
   * THE ONE category-index adapter (0.11.7). Every call to
   * getCategoryIndex / getDerivedChannels in this module happens
   * here and nowhere else. The adapter returns the drawer's
   * display-ordered groups (browserCategories order: Favourites,
   * headline groups, Recents, All Channels) enriched with the
   * real provider subcategories from W1's shared index, plus a
   * channelsFor() slice lookup. Pseudo-entries (Favourites /
   * Recents / All) are resolved here from the catalogue — they
   * are not provider structure and never belong in the index.
   *
   * Revision discipline: the shared index cache is keyed by
   * revision alone, so the revision is instance-scoped AND
   * epoch-scoped (`browser:<instance>:<catalogueStateRevision>`).
   * Two browser instances never share a revision, and every
   * catalogue replacement / in-place favourite mutation bumps
   * the epoch — a stale index for a different catalogue is
   * impossible. The adapter itself is cached on (channels
   * identity, epoch), so scroll/focus/render paths never
   * rebuild or regroup.
   *
   * Subcategory ids are W1's canonical ids (`sub:<slug>`);
   * each drawer subcategory also carries its verbatim rawName
   * so legacy verbatim references resolve (see
   * resolveBrowserSubcategoryId). Group "all" is NOT an index
   * group: it maps to the whole catalogue (no groupId).
   */
  function getBrowserCategoryData(): {
    groups: DrawerGroup[];
    channelsFor: (selection: BrowserSelection) => readonly LivetvChannel[];
    index: CategoryIndex;
  } {
    if (
      categoryDataCache &&
      categoryDataCache.channels === channels &&
      categoryDataCache.revision === catalogueStateRevision
    ) {
      return categoryDataCache;
    }
    const index = getCategoryIndex(
      channels,
      `browser:${browserInstanceId}:${catalogueStateRevision}`,
    );
    const favCount = channels.filter((c) => c.favourite).length;
    const recentCount = (opts.recentIds ?? []).filter((id) =>
      channels.some((c) => String(c.id) === String(id)),
    ).length;
    const headlineOrder = ["irish-uk", "sports", "movies", "news", "kids"];
    const orderedGroups = [...index.groups].sort((a, b) => {
      const ai = headlineOrder.indexOf(a.id);
      const bi = headlineOrder.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    });
    const groups: DrawerGroup[] = [
      {
        id: BROWSER_CATEGORY_FAVOURITES,
        label: "Favourites",
        count: favCount,
        icon: browserCategoryIcon(BROWSER_CATEGORY_FAVOURITES),
        opensSubcategories: false,
        subcategories: [],
      },
      ...orderedGroups.map((group) => ({
        id: group.id,
        label: group.label,
        count: group.channelCount,
        icon: browserCategoryIcon(group.id),
        opensSubcategories: true,
        subcategories: group.subcategories.map((sub) => ({
          id: sub.id,
          label: sub.label,
          count: sub.channelCount,
          rawName: sub.rawName,
        })),
      })),
      {
        id: BROWSER_CATEGORY_RECENTS,
        label: "Recents",
        count: recentCount,
        icon: browserCategoryIcon(BROWSER_CATEGORY_RECENTS),
        opensSubcategories: false,
        subcategories: [],
      },
      {
        id: BROWSER_CATEGORY_ALL,
        label: "All Channels",
        count: channels.length,
        icon: browserCategoryIcon(BROWSER_CATEGORY_ALL),
        opensSubcategories: false,
        subcategories: [],
      },
    ];
    const channelsFor = (
      selection: BrowserSelection,
    ): readonly LivetvChannel[] => {
      if (selection.groupId === BROWSER_CATEGORY_FAVOURITES) {
        return channels.filter((channel) => channel.favourite);
      }
      if (selection.groupId === BROWSER_CATEGORY_RECENTS) {
        return recentOrderedChannels(channels, opts.recentIds ?? null);
      }
      if (selection.groupId === BROWSER_CATEGORY_ALL) {
        return getDerivedChannels(index, {});
      }
      const derivedOpts: DerivedChannelsOptions = {
        groupId: selection.groupId,
      };
      if (selection.subcategoryId != null) {
        derivedOpts.subcategoryId = selection.subcategoryId;
      }
      return getDerivedChannels(index, derivedOpts);
    };
    categoryDataCache = {
      channels,
      revision: catalogueStateRevision,
      groups,
      channelsFor,
      index,
    };
    return categoryDataCache;
  }

  function invalidateDerived(): void {
    derivedCache = null;
    derivedRevision += 1;
  }

  /**
   * The cached derived list: category slice (via the adapter),
   * then search, then sort. Recomputed ONLY when the selection,
   * query, scope, sort or catalogue changes — scrolling and
   * focus reuse this array and never refilter the catalogue.
   */
  function deriveVisibleChannels(): LivetvChannel[] {
    const key = [
      catalogueStateRevision,
      groupId,
      subcategoryId ?? "",
      query,
      queryScope,
      sort,
    ].join("\u0000");
    if (derivedCache && derivedCache.key === key) return derivedCache.list;
    const data = getBrowserCategoryData();
    // Scope "all" searches the whole catalogue, ignoring the
    // current selection; any other scope searches the selection.
    const base =
      query && queryScope === "all"
        ? channels
        : data.channelsFor({ groupId, subcategoryId });
    let list = [...base];
    if (query) list = searchBrowserChannels(list, query);
    list = sortBrowserChannels(list, sort);
    derivedCache = { key, list };
    return list;
  }

  // Last highlighted channel per selection, for focus memory.
  const selectionMemory = new Map<string, string | number>();
  function selectionKey(sel: BrowserSelection): string {
    return `${sel.groupId}\u0000${sel.subcategoryId ?? ""}`;
  }

  // Validate the initial selection against the real groups (an
  // unknown entry falls back to All Channels, never an empty
  // list). A verbatim initial subcategory resolves to its
  // canonical W1 id; an unknown one falls back to the whole group.
  {
    const data = getBrowserCategoryData();
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) {
      groupId = BROWSER_CATEGORY_ALL;
      subcategoryId = null;
    } else if (subcategoryId != null) {
      subcategoryId = resolveBrowserSubcategoryId(
        group.subcategories,
        subcategoryId,
      );
    }
  }

  /**
   * W4 category-change rule, applied on EVERY selection change:
   * a category-scoped search clears when the category changed;
   * a scope-"all" search survives; an unchanged category keeps
   * its search. Call with the NEW selection already assigned.
   */
  function syncSearchForSelection(): void {
    const next: LivetvSearchState = applyCategoryChangeToSearch(
      { query, scope: queryScope, categoryId: searchCategoryId },
      { groupId, subcategoryId },
    );
    query = next.query;
    queryScope = next.scope;
    searchCategoryId = next.categoryId;
  }

  root.replaceChildren();
  root.classList.add("rs-livetv-browser");
  root.setAttribute("data-livetv-browser", "");
  if (opts.acceptModeEntry) root.setAttribute("data-browser-screen", "");

  // ── Layout: main column (header / toolbar / breadcrumb / head /
  //    list / status) + compact contextual panel on the right ──
  const layout = el("div", "rs-livetv-browser__layout");
  root.appendChild(layout);
  const main = el("div", "rs-livetv-browser__main");
  layout.appendChild(main);
  const detail = el("aside", "rs-livetv-browser__detail");
  detail.setAttribute("data-browser-detail", "");
  detail.setAttribute("aria-label", "Selected channel");
  layout.appendChild(detail);

  // ── Screen header (screen mode only): title + live channel
  //    count. The shell's generic "Live TV" head is hidden in
  //    browser mode, so the browser carries its own title. The
  //    toolbar is a separate row below (see below).
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

  // ── Toolbar: ONE prominent category control + Search / Sort
  //    buttons (W4 overlays) + Close. No pills, no selects, no
  //    inline search box.
  const toolbar = el("div", "rs-livetv-browser__toolbar");
  const categoryButton = el("button", "rs-livetv-browser__category-button") as HTMLButtonElement;
  categoryButton.type = "button";
  categoryButton.setAttribute("data-browser-category-button", "");
  categoryButton.setAttribute("aria-haspopup", "dialog");
  categoryButton.setAttribute("aria-expanded", "false");
  const categoryIcon = el("span", "rs-livetv-browser__category-button-icon");
  categoryIcon.setAttribute("aria-hidden", "true");
  categoryButton.appendChild(categoryIcon);
  const categoryLabel = el("span", "rs-livetv-browser__category-button-label");
  categoryButton.appendChild(categoryLabel);
  const categoryCount = el("span", "rs-livetv-browser__category-button-count");
  categoryButton.appendChild(categoryCount);
  const categoryChevron = el("span", "rs-livetv-browser__category-button-chevron");
  categoryChevron.setAttribute("aria-hidden", "true");
  categoryChevron.textContent = "▾";
  categoryButton.appendChild(categoryChevron);
  toolbar.appendChild(categoryButton);

  const toolbarActions = el("div", "rs-livetv-browser__toolbar-actions");
  const searchButton = el("button", "rs-livetv-browser__toolbar-button") as HTMLButtonElement;
  searchButton.type = "button";
  searchButton.setAttribute("data-browser-search-button", "");
  const searchButtonLabel = el("span");
  searchButton.appendChild(searchButtonLabel);
  toolbarActions.appendChild(searchButton);
  const sortButton = el("button", "rs-livetv-browser__toolbar-button") as HTMLButtonElement;
  sortButton.type = "button";
  sortButton.setAttribute("data-browser-sort-button", "");
  const sortButtonLabel = el("span");
  sortButton.appendChild(sortButtonLabel);
  toolbarActions.appendChild(sortButton);
  const clearSearchButton = el("button", "rs-livetv-browser__toolbar-button") as HTMLButtonElement;
  clearSearchButton.type = "button";
  clearSearchButton.setAttribute("data-browser-clear-search", "");
  clearSearchButton.textContent = "Clear search";
  clearSearchButton.hidden = true;
  toolbarActions.appendChild(clearSearchButton);
  if (opts.onClose) {
    const close = el("button", "rs-livetv-browser__close") as HTMLButtonElement;
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("data-browser-close", "");
    close.addEventListener("click", () => opts.onClose?.());
    toolbarActions.appendChild(close);
  }
  toolbar.appendChild(toolbarActions);
  // The toolbar is its own row below the header (screen mode) or
  // the first row (inline mode): the category control + Search /
  // Sort / Clear / Close do not fit beside the title inside the
  // main column, and the category control earns its own row.
  main.appendChild(toolbar);

  // ── Breadcrumb: always shows the applied group + subcategory
  //    (and the active search, when one filters the list).
  //    Markup follows W4's `.lv2-breadcrumb` contract
  //    (livetv-nav-chrome.css header): group / sep / sub /
  //    count spans inside a <nav>. The browser's own class
  //    keeps its layout slot; lv2 owns the breadcrumb shape.
  const breadcrumbEl = el("nav", "rs-livetv-browser__breadcrumb lv2-breadcrumb");
  breadcrumbEl.setAttribute("data-browser-breadcrumb", "");
  breadcrumbEl.setAttribute("aria-label", "Channel location");
  main.appendChild(breadcrumbEl);
  let lastBreadcrumbSignature = "";

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

  // ── Category drawer overlay root (the drawer module renders
  //    scrim + panel into this container while open).
  const drawerContainer = el("div", "rs-livetv-browser__drawer-root");
  drawerContainer.setAttribute("data-browser-drawer-root", "");
  drawerContainer.hidden = true;
  root.appendChild(drawerContainer);
  let drawerHandle: CategoryDrawerHandle | null = null;
  let lastDrawerSyncRevision = -1;
  /** Last group focused in the drawer, for reopen focus memory. */
  let lastDrawerFocusGroupId: string | null = null;

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

  // ── Keyed row pool ────────────────────────────────────────────
  // Row shells are created once and reused across paints: a shell
  // is keyed by channel id while mounted, and returns to a capped
  // freelist when it scrolls out of the window. paintRow updates
  // text/classes in place and skips shells whose content key is
  // unchanged — a scroll paint touches only rows that entered the
  // window or whose content changed. The row node itself is never
  // replaced while mounted, so the focused row survives paints.

  const mountedRows = new Map<string, RowRefs>();
  const rowFreelist: RowRefs[] = [];

  function createRowShell(): RowRefs {
    const row = el("div", "rs-livetv-browser__row");
    row.setAttribute("data-browser-row", "");
    row.setAttribute("role", "option");
    // Focusable programmatically (highlightChannel({focus:true})
    // and drawer-close restore) but never in the Tab order.
    row.tabIndex = -1;

    const num = el("span", "rs-livetv-browser__num");
    row.appendChild(num);

    const channelCell = el("span", "rs-livetv-browser__channel");
    const logoWrap = el("span", "rs-livetv-browser__logo");
    channelCell.appendChild(logoWrap);
    const name = el("span", "rs-livetv-browser__name");
    channelCell.appendChild(name);
    const fav = el("span", "rs-livetv-browser__fav");
    fav.setAttribute("aria-label", "Favourite");
    fav.textContent = "♥";
    channelCell.appendChild(fav);
    row.appendChild(channelCell);

    const nowCell = el("span", "rs-livetv-browser__now-cell");
    const nowTime = el("span", "rs-livetv-browser__time");
    nowCell.appendChild(nowTime);
    const nowTitle = el("span", "rs-livetv-browser__now");
    nowCell.appendChild(nowTitle);
    const progress = el("span", "rs-livetv-browser__progress");
    progress.setAttribute("aria-hidden", "true");
    const progressFill = el("span");
    progress.appendChild(progressFill);
    nowCell.appendChild(progress);
    row.appendChild(nowCell);

    const nextCell = el("span", "rs-livetv-browser__next-cell");
    const nextTime = el("span", "rs-livetv-browser__time");
    nextCell.appendChild(nextTime);
    const nextTitle = el("span", "rs-livetv-browser__next");
    nextCell.appendChild(nextTitle);
    row.appendChild(nextCell);

    return {
      row,
      key: "",
      logoKey: "\u0000unpainted\u0000",
      num,
      logoWrap,
      name,
      fav,
      nowTime,
      nowTitle,
      progress,
      progressFill,
      nextTime,
      nextTitle,
    };
  }

  function paintRow(
    refs: RowRefs,
    channel: LivetvChannel,
    nn: LivetvNowNext | null,
    isHighlighted: boolean,
  ): void {
    const progressPct = nn?.current
      ? Math.round(programmeProgress(nn.current.start, nn.current.stop) * 100)
      : -1;
    const key = [
      String(channel.id),
      channel.favourite ? "fav" : "",
      channel.chno ?? "",
      channel.displayName || channel.name,
      channel.logo ?? "",
      nn?.current?.title ?? "",
      nn?.current?.start ?? "",
      nn?.next?.title ?? "",
      nn?.next?.start ?? "",
      progressPct,
      isHighlighted ? "hl" : "",
    ].join("\u0000");
    if (key === refs.key) return;
    refs.key = key;

    setText(refs.num, channel.chno != null ? String(channel.chno) : "");
    setText(refs.name, channel.displayName || channel.name);
    refs.fav.hidden = !channel.favourite;

    const logoKey = channel.logo ?? "";
    if (logoKey !== refs.logoKey) {
      refs.logoKey = logoKey;
      refs.logoWrap.replaceChildren(logoContent(channel));
    }

    if (nn?.current) {
      setText(refs.nowTime, formatTimeRange(nn.current.start, nn.current.stop));
      setText(refs.nowTitle, nn.current.title);
      refs.nowTitle.classList.remove("rs-livetv-browser__now--muted");
      refs.progress.hidden = false;
      const width = `${progressPct}%`;
      if (refs.progressFill.style.width !== width) refs.progressFill.style.width = width;
    } else if (nn?.next) {
      setText(refs.nowTime, `Next ${formatTimeRange(nn.next.start, nn.next.stop)}`);
      setText(refs.nowTitle, nn.next.title);
      refs.nowTitle.classList.add("rs-livetv-browser__now--muted");
      refs.progress.hidden = true;
    } else {
      setText(refs.nowTime, "");
      setText(refs.nowTitle, "—");
      refs.nowTitle.classList.add("rs-livetv-browser__now--muted");
      refs.progress.hidden = true;
    }

    if (nn?.next) {
      setText(refs.nextTime, formatTimeRange(nn.next.start, nn.next.stop));
      setText(refs.nextTitle, nn.next.title);
      refs.nextTitle.classList.remove("rs-livetv-browser__next--muted");
    } else {
      setText(refs.nextTime, "");
      setText(refs.nextTitle, "—");
      refs.nextTitle.classList.add("rs-livetv-browser__next--muted");
    }

    refs.row.classList.toggle("is-highlighted", isHighlighted);
    refs.row.setAttribute("aria-selected", String(isHighlighted));
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
    // flight: scroll paints re-enter here constantly, and must
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
    // Keyed re-render: scroll paints call renderDetail on every
    // frame, but the panel only rebuilds when its content actually
    // changes (channel, programmes, favourite, catch-up). That
    // also keeps a pending enrichment from being discarded
    // mid-flight.
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

  /** Refresh the open drawer's groups/counts when the catalogue changed. */
  function syncDrawerGroups(): void {
    if (!drawerHandle || lastDrawerSyncRevision === catalogueStateRevision) return;
    lastDrawerSyncRevision = catalogueStateRevision;
    drawerHandle.updateGroups(getBrowserCategoryData().groups);
  }

  /**
   * Breadcrumb per the lv2 contract: group, separator,
   * subcategory (omitted for a whole group), count. While a
   * search filters the list, the sub slot names the search and
   * the count is the filtered total; the group slot names the
   * search scope. Children rebuild only when the signature
   * changes, so scroll paints never churn this DOM.
   */
  function renderBreadcrumb(
    list: LivetvChannel[],
    label: string,
    group: DrawerGroup | undefined,
    unfilteredCount: number,
  ): void {
    const subLabel =
      subcategoryId != null
        ? (group?.subcategories.find((s) => s.id === subcategoryId)?.label ?? null)
        : null;
    const groupText = query && queryScope === "all" ? "All channels" : (group?.label ?? label);
    const subText = query
      ? `Search “${query}”`
      : subLabel;
    const countValue = query ? list.length : unfilteredCount;
    const countText = `${countValue.toLocaleString()} channel${countValue === 1 ? "" : "s"}`;
    const signature = [groupText, subText ?? "", countText].join("\u0000");
    if (signature === lastBreadcrumbSignature) return;
    lastBreadcrumbSignature = signature;
    const groupSpan = el("span", "lv2-breadcrumb__group");
    groupSpan.textContent = groupText;
    const nodes: HTMLElement[] = [groupSpan];
    if (subText != null) {
      const sep = el("span", "lv2-breadcrumb__sep");
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "›";
      const sub = el("span", "lv2-breadcrumb__sub");
      sub.setAttribute("aria-current", "location");
      sub.textContent = subText;
      nodes.push(sep, sub);
    }
    const count = el("span", "lv2-breadcrumb__count");
    count.textContent = countText;
    nodes.push(count);
    breadcrumbEl.replaceChildren(...nodes);
  }

  /** Category button, breadcrumb, search/sort buttons, status. Text is only touched when it changed. */
  function renderChrome(list: LivetvChannel[]): void {
    const data = getBrowserCategoryData();
    const selection: BrowserSelection = { groupId, subcategoryId };
    const label = browserSelectionLabel(selection, data.groups);
    const group = data.groups.find((g) => g.id === groupId);
    setText(categoryIcon, group?.icon ?? browserCategoryIcon(groupId));
    setText(categoryLabel, label);
    const unfilteredCount =
      query && queryScope === "all"
        ? channels.length
        : group
          ? subcategoryId
            ? (group.subcategories.find((s) => s.id === subcategoryId)?.count ?? 0)
            : group.count
          : 0;
    setText(categoryCount, unfilteredCount.toLocaleString());
    categoryButton.setAttribute(
      "aria-label",
      `Category: ${label}, ${unfilteredCount.toLocaleString()} channels. Open category drawer.`,
    );

    renderBreadcrumb(list, label, group, unfilteredCount);
    setText(searchButtonLabel, query ? `Search: “${query}”` : "⌕ Search");
    setText(sortButtonLabel, `Sort: ${browserSortLabel(sort)}`);
    clearSearchButton.hidden = query === "";

    const statusText =
      list.length === 0
        ? query
          ? `No channels match “${query}”.`
          : groupId === BROWSER_CATEGORY_FAVOURITES
            ? "No favourite channels yet — press X on a channel to add one."
            : groupId === BROWSER_CATEGORY_RECENTS
              ? "Nothing watched yet — channels you watch will appear here."
              : "No channels in this category."
        : `${list.length.toLocaleString()} channel${list.length === 1 ? "" : "s"}`;
    setText(statusEl, statusText);
    emptyEl.hidden = list.length !== 0;
    setText(emptyEl, statusText);
    if (subtitleEl) {
      const total = channels.length;
      setText(
        subtitleEl,
        total > 0
          ? `Browse and watch live TV • ${total.toLocaleString()} channel${total === 1 ? "" : "s"}`
          : "Browse and watch live TV",
      );
    }
  }

  // ── Incremental paint ─────────────────────────────────────────
  // paintNow() is the ONLY function that touches the row DOM. It is
  // idempotent: a signature over (derived revision, catalogue
  // revision, window, highlight, list length) makes repeat paints
  // with nothing changed a no-op, so a scroll event arriving after
  // a synchronous paint costs nothing. Discrete actions call
  // paintNow() directly (exactly one paint per input); scroll
  // events go through schedulePaint() (rAF-coalesced).

  let lastPaintSignature = "";
  let paintQueued = false;

  function paintNow(): void {
    if (destroyed) return;
    const list = deriveVisibleChannels();
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
    const win = computeVisibleWindow({
      total: list.length,
      columns: 1,
      rowHeight,
      scrollTop: listEl.scrollTop,
      viewportHeight: listEl.clientHeight || 600,
      overscanRows: BROWSER_OVERSCAN_ROWS,
    });
    const signature = [
      derivedRevision,
      catalogueStateRevision,
      win.startIndex,
      win.endIndex,
      String(highlightedId),
      list.length,
    ].join("|");
    if (signature === lastPaintSignature) {
      // Nothing the rows or chrome depend on changed. The detail
      // panel is self-keyed and cheap, so it still runs (it owns
      // the enrichment lifecycle).
      renderDetail();
      syncDrawerGroups();
      return;
    }
    lastPaintSignature = signature;

    const spacerHeight = `${list.length * rowHeight}px`;
    if (spacer.style.height !== spacerHeight) spacer.style.height = spacerHeight;

    // Reconcile the keyed row pool against the desired window.
    const desired = list.slice(win.startIndex, win.endIndex);
    const desiredIds = new Set(desired.map((c) => String(c.id)));
    for (const [id, refs] of mountedRows) {
      if (desiredIds.has(id)) continue;
      // Never destroy the focused element: if the evicted row
      // holds DOM focus, focus lands on the list first.
      if (refs.row.contains(document.activeElement)) {
        listEl.focus({ preventScroll: true });
      }
      refs.row.remove();
      mountedRows.delete(id);
      if (rowFreelist.length < ROW_POOL_MAX) rowFreelist.push(refs);
    }
    for (let i = 0; i < desired.length; i++) {
      const channel = desired[i]!;
      const id = String(channel.id);
      let refs = mountedRows.get(id);
      if (!refs) {
        refs = rowFreelist.pop() ?? createRowShell();
        refs.row.setAttribute("data-channel-id", id);
        refs.row.setAttribute("data-focus-key", `livetv-browser-${id}`);
        mountedRows.set(id, refs);
      }
      // Cached EPG lookups only, visible rows only.
      const nn = opts.nowNextFor?.(channel) ?? null;
      paintRow(refs, channel, nn, String(channel.id) === String(highlightedId));
      // Move the node into place ONLY when it is not already
      // there: an in-window paint must not churn the DOM at all.
      if (viewport.children[i] !== refs.row) {
        viewport.insertBefore(refs.row, viewport.children[i] ?? null);
      }
    }
    const transform = `translateY(${win.topSpacer}px)`;
    if (viewport.style.transform !== transform) viewport.style.transform = transform;

    renderChrome(list);
    renderDetail();
    syncDrawerGroups();
  }

  function schedulePaint(): void {
    if (paintQueued) return;
    paintQueued = true;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === "function") {
      raf(() => {
        paintQueued = false;
        paintNow();
      });
    } else {
      paintQueued = false;
      paintNow();
    }
  }

  function ensureIndexVisible(index: number): void {
    const top = index * BROWSER_ROW_HEIGHT;
    const bottom = top + BROWSER_ROW_HEIGHT;
    const height = listEl.clientHeight || 600;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (bottom > listEl.scrollTop + height) listEl.scrollTop = bottom - height;
  }

  function scrollToIndex(index: number): void {
    listEl.scrollTop = Math.max(
      0,
      index * BROWSER_ROW_HEIGHT - (listEl.clientHeight || 600) / 2,
    );
  }

  function highlight(id: string | number | null, focusRow = false): void {
    highlightedId = id;
    const channel = channelById(id);
    if (channel) opts.onHighlight?.(channel);
    if (id != null) {
      const list = deriveVisibleChannels();
      const index = list.findIndex((c) => String(c.id) === String(id));
      if (index >= 0) ensureIndexVisible(index);
    }
    paintNow();
    if (focusRow && id != null) {
      mountedRows.get(String(id))?.row.focus({ preventScroll: true });
    }
  }

  /** Focus the highlighted row where mounted, else the list itself. Never leaves focus on <body>. */
  function focusListOrRow(): void {
    const row = highlightedId != null ? mountedRows.get(String(highlightedId)) : undefined;
    if (row) row.row.focus({ preventScroll: true });
    else listEl.focus({ preventScroll: true });
  }

  function setSelection(nextGroupId: string, nextSubcategoryId: string | null = null): void {
    const data = getBrowserCategoryData();
    const group = data.groups.find((g) => g.id === nextGroupId);
    const validGroupId = group ? nextGroupId : BROWSER_CATEGORY_ALL;
    const validSubcategoryId =
      group && nextSubcategoryId != null
        ? resolveBrowserSubcategoryId(group.subcategories, nextSubcategoryId)
        : null;
    // Remember the outgoing highlight under its selection.
    if (highlightedId != null) {
      selectionMemory.set(selectionKey({ groupId, subcategoryId }), highlightedId);
    }
    groupId = validGroupId;
    subcategoryId = validSubcategoryId;
    // A category change clears a category-scoped search (W4
    // rule); a global search survives. Every category-change
    // path funnels through here (drawer, LB/RB, collection
    // cards, mode entries).
    syncSearchForSelection();
    invalidateDerived();
    // Restore the remembered highlight for the incoming selection
    // where it is still in the list — and scroll it into view:
    // resetting scrollTop to 0 with a deep remembered highlight
    // left the highlight off-screen (detail panel showing a
    // channel the list did not show) until the next arrow move.
    const remembered = selectionMemory.get(selectionKey({ groupId, subcategoryId }));
    let restoredIndex = -1;
    if (remembered != null) {
      const list = deriveVisibleChannels();
      const index = list.findIndex((c) => String(c.id) === String(remembered));
      if (index >= 0) {
        highlightedId = remembered;
        restoredIndex = index;
      }
    }
    if (restoredIndex >= 0) {
      ensureIndexVisible(restoredIndex);
    } else {
      listEl.scrollTop = 0;
    }
    paintNow();
  }

  function cycleCategory(delta: number): void {
    const groups = getBrowserCategoryData().groups;
    if (groups.length === 0) return;
    const current = groups.findIndex((g) => g.id === groupId);
    const next = groups[(current < 0 ? 0 : current + delta + groups.length) % groups.length];
    if (next) setSelection(next.id, null);
  }

  function jumpPage(delta: number): void {
    const list = deriveVisibleChannels();
    if (!list.length) return;
    const pageSize = Math.max(
      1,
      Math.floor((listEl.clientHeight || 600) / BROWSER_ROW_HEIGHT),
    );
    const currentIndex = list.findIndex((c) => String(c.id) === String(highlightedId));
    const base = currentIndex < 0 ? (delta > 0 ? -pageSize : pageSize) : currentIndex;
    const nextIndex = Math.max(0, Math.min(list.length - 1, base + delta * pageSize));
    const channel = list[nextIndex];
    if (channel) highlight(channel.id);
  }

  // ══════════════════════════════════════════════════════════════
  // LAYER / BACK STACK (0.11.7 — unified with W4's livetv-nav)
  // ──────────────────────────────────────────────────────────────
  // ALL back-layer decisions in the browser live in this one
  // section: handleBack(), openCategories(), closeCategories(),
  // clearQuery(), openSearch() and openSort(). Nothing outside
  // this section closes a layer or exits the browser.
  //
  // Layer order, innermost first — B closes EXACTLY ONE per press:
  //   1. drawer subcategories → drawer top level
  //   2. drawer top level → drawer closed (focus returns to list)
  //   3. applied search filter → cleared (list restored)
  //   4. nothing left → onClose (exit to landing / close overlay)
  //
  // Nav-stack wiring (livetv-nav.ts): the shell owns the mode
  // markers (landing/browser/guide/playback); this browser owns
  // ONE overlay layer, "drawer", pushed on open and popped on
  // close. The drawer layer carries an onBack veto: at the
  // subcategory level B steps back to the groups level WITHOUT
  // popping (veto); at the top level B pops the layer and the
  // layer's onExit closes the drawer UI. The search-filter step
  // has no layer — it is an internal filter step, handled
  // locally after the drawer checks. handleBack() routes the
  // drawer step through livetvNav.back() so one B press can
  // never pop two layers, and gates every step on the nav stack:
  // while a search/sort overlay, the Guide, playback, or another
  // instance's drawer is on top, this browser's B is a no-op
  // (hidden modes cannot steal input). The 250ms coalescing
  // window keeps a gamepad B that arrives as both `livetv:back`
  // and Escape to a single step.
  //
  // The keyboard path with the drawer open does not go through
  // handleBack(): the drawer's own handleKey owns those keys
  // (see onKeyDown) and reaches the same one-step outcomes
  // through pressBack / onBack below.
  // ══════════════════════════════════════════════════════════════

  /** True when no other surface demonstrably owns B over this browser's drawer. */
  function drawerOwnsBack(): boolean {
    const top = livetvNav.top();
    if (!top) return true;
    if (top.id === "drawer") return (top.key ?? top.id) === drawerNavKey;
    return (
      top.id !== "search" &&
      top.id !== "sort" &&
      top.id !== "guide" &&
      top.id !== "playback" &&
      top.id !== "subcategory"
    );
  }

  /** True when no overlay / mode above the browser owns B. */
  function browserOwnsBack(): boolean {
    const top = livetvNav.top();
    if (!top) return true;
    return (
      top.id !== "drawer" &&
      top.id !== "subcategory" &&
      top.id !== "search" &&
      top.id !== "sort" &&
      top.id !== "guide" &&
      top.id !== "playback"
    );
  }

  /** Close the drawer DOM without touching the nav stack. Runs from the layer's onExit. */
  function closeDrawerUI(): void {
    if (!drawerHandle) return;
    // Remember the focused group before destroying the drawer, so
    // reopening returns to it.
    lastDrawerFocusGroupId = drawerHandle.getFocusedGroupId();
    drawerHandle.destroy();
    drawerHandle = null;
    drawerContainer.hidden = true;
    categoryButton.setAttribute("aria-expanded", "false");
  }

  function openCategories(): void {
    if (drawerHandle) {
      drawerHandle.focusCurrent();
      return;
    }
    drawerContainer.hidden = false;
    drawerHandle = mountCategoryDrawer(drawerContainer, {
      groups: getBrowserCategoryData().groups,
      selectedGroupId: groupId,
      selectedSubcategoryId: subcategoryId,
      initialFocusGroupId: lastDrawerFocusGroupId,
      onSelect: (selection) => {
        closeCategories();
        setSelection(selection.groupId, selection.subcategoryId);
        focusListOrRow();
      },
      onBack: () => {
        closeCategories();
        focusListOrRow();
      },
    });
    lastDrawerSyncRevision = catalogueStateRevision;
    categoryButton.setAttribute("aria-expanded", "true");
    // Own the drawer layer: B at the subcategory level vetoes
    // (steps to groups, stays open); B at the top level pops
    // and onExit closes the drawer UI.
    livetvNav.push({
      id: "drawer",
      key: drawerNavKey,
      onBack: () => {
        if (!drawerHandle) return true;
        if (drawerHandle.getLevel() === "subcategories") {
          drawerHandle.pressBack();
          return false;
        }
        return true;
      },
      onExit: () => {
        closeDrawerUI();
      },
    });
    drawerHandle.focusCurrent();
  }

  function closeCategories(): void {
    if (!drawerHandle) return;
    if (livetvNav.isTop("drawer", drawerNavKey)) {
      // onExit closes the drawer UI.
      livetvNav.pop();
    } else {
      // The layer is missing or buried (shell reset, stale
      // stack): close the UI directly so the drawer never sticks.
      closeDrawerUI();
    }
  }

  function clearQuery(): boolean {
    const hadQuery = query !== "";
    query = "";
    queryScope = "category";
    searchCategoryId = null;
    invalidateDerived();
    listEl.scrollTop = 0;
    paintNow();
    return hadQuery;
  }

  function openSearch(): void {
    window.dispatchEvent(
      new CustomEvent<LivetvOpenSearchDetail>(LIVETV_OPEN_SEARCH_EVENT, {
        detail: { groupId, subcategoryId, query, scope: queryScope },
      }),
    );
  }

  function openSort(): void {
    window.dispatchEvent(
      new CustomEvent<LivetvOpenSortDetail>(LIVETV_OPEN_SORT_EVENT, {
        detail: { groupId, subcategoryId, sort },
      }),
    );
  }

  /**
   * Back (B / Escape), in layer order: drawer → search → exit.
   * Exactly one layer per press. Returns true when a step was
   * taken (the `livetv:back` listener stops propagation then);
   * false when gated, coalesced, or nothing was left to close
   * beyond onClose (onClose itself counts as handled).
   */
  function handleBack(): boolean {
    if (drawerHandle) {
      if (!drawerOwnsBack()) return false;
      const now = Date.now();
      if (now - lastBackAt < BROWSER_BACK_COALESCE_MS) return false;
      lastBackAt = now;
      if (livetvNav.isTop("drawer", drawerNavKey)) {
        // Veto at the subcategory level, pop+close at the top.
        livetvNav.back();
      } else {
        // The stack lost the drawer layer: step locally so B
        // never dead-ends (pressBack closes via onBack at the
        // top level).
        drawerHandle.pressBack();
      }
      return true;
    }
    if (!browserOwnsBack()) return false;
    const now = Date.now();
    if (now - lastBackAt < BROWSER_BACK_COALESCE_MS) return false;
    lastBackAt = now;
    if (query !== "") {
      clearQuery();
      focusListOrRow();
      return true;
    }
    opts.onClose?.();
    return true;
  }

  // ── End of LAYER / BACK STACK section ─────────────────────────

  function applySearchSubmit(detail: LivetvSearchSubmitDetail): void {
    query = (detail.query ?? "").trim();
    queryScope = detail.scope === "all" ? "all" : "category";
    // The search applies to the CURRENT selection (the overlay
    // captured it at open and owns input until submit), so the
    // clearing rule tracks the current selection, not a stale
    // context id. Scope "all" has no category.
    searchCategoryId =
      queryScope === "all" ? null : (subcategoryId ?? groupId);
    invalidateDerived();
    listEl.scrollTop = 0;
    if (query) {
      const first = deriveVisibleChannels()[0];
      if (first) {
        highlight(first.id);
        return;
      }
    }
    paintNow();
  }

  function applySortSubmit(detail: LivetvSortSubmitDetail): void {
    const next = detail.sort;
    if (next !== "source" && next !== "az" && next !== "za" && next !== "category") return;
    sort = next;
    // Persist so reopening the browser keeps the order (the W4
    // overlay also persists on dispatch; same value, idempotent).
    writePersistedLivetvSort(next);
    invalidateDerived();
    paintNow();
  }

  function applyEntry(
    entry: BrowserEntryFilter | null | undefined,
    entryOpts?: { openSearch?: boolean },
  ): void {
    // 0.11.10 W4: an entry WITHOUT a filter keeps the current
    // selection — it is a return (Guide / playback B-exit), not a
    // fresh navigation. Resetting to "all" here silently dropped
    // the user's category on every filter-less return. Callers
    // that mean "all" pass { kind: "all" } explicitly.
    if (entry) {
      const selection = browserSelectionFromEntry(entry);
      setSelection(selection.groupId, selection.subcategoryId);
    }
    if (entryOpts?.openSearch) openSearch();
  }

  async function toggleFavourite(channel: LivetvChannel): Promise<boolean | null> {
    let next: boolean | null;
    if (opts.onToggleFavourite) {
      next = await opts.onToggleFavourite(channel);
    } else if (opts.playlistId) {
      try {
        const { toggleFavorite } = await import("./preferences.js");
        next = toggleFavorite(opts.playlistId, "live", channel.id as number, {
          name: channel.displayName || channel.name || "",
          logo: channel.logo ?? null,
        }) as boolean | null;
        if (next != null) {
          // Update in place now; the `xt:favorites-changed`
          // refresh re-loads the catalogue and confirms it.
          channel.favourite = next;
        }
      } catch {
        return null;
      }
    } else {
      return null;
    }
    if (next != null) {
      // The mutation may be in place on the cached array: bump
      // the catalogue revision so the adapter, derived list and
      // row content keys all see the new favourite state, and
      // invalidate memoised derived lists (W1 seam 3: in-place
      // flag mutation does not invalidate the memo on its own).
      catalogueStateRevision += 1;
      invalidateDerivedChannels();
      invalidateDerived();
      paintNow();
    }
    return next;
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
  categoryButton.addEventListener("click", () => {
    if (drawerHandle) {
      closeCategories();
      focusListOrRow();
    } else {
      openCategories();
    }
  });
  searchButton.addEventListener("click", () => openSearch());
  sortButton.addEventListener("click", () => openSort());
  clearSearchButton.addEventListener("click", () => {
    clearQuery();
    focusListOrRow();
  });
  listEl.addEventListener("scroll", () => schedulePaint(), { passive: true });
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => schedulePaint());
    resizeObserver.observe(listEl);
  }
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
  // Keys resolve through the SHARED table (livetv-keys.ts) — the
  // browser interprets actions, it does not own a second mapping.
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
    // The open drawer owns every key: unconsumed keys are still
    // swallowed so no action fires behind the overlay. Claimed
    // (preventDefault + stopPropagation): the app-wide
    // SpatialNavigation handler sits on window and ignores
    // defaultPrevented, so without stopPropagation every handled
    // arrow would move focus twice — once in the drawer, once
    // geometrically (the Guide's claim() fix, same cause).
    if (drawerHandle) {
      const consumed = drawerHandle.handleKey(event);
      if (consumed || livetvKeyActionForKey("browser", event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const action = livetvKeyActionForKey("browser", event.key);
    if (!action) return;
    switch (action) {
      case "move-up":
        event.preventDefault();
        moveHighlight(-1);
        return;
      case "move-down":
        event.preventDefault();
        moveHighlight(1);
        return;
      case "move-left":
        event.preventDefault();
        openCategories();
        return;
      case "move-right":
        // Nothing to the right of the channel list.
        return;
      case "select": {
        // A focused button keeps its native activation (Enter /
        // Space on the category, search, sort or panel buttons
        // must click the button, never tune a channel).
        if (target && (target as HTMLElement).tagName === "BUTTON") return;
        const channel = channelById(highlightedId);
        if (channel) {
          event.preventDefault();
          opts.onSelect?.(channel);
        }
        return;
      }
      case "back":
        // Claim the key: without preventDefault the playback
        // shell's window-level Escape handler also fires after
        // onClose hides the browser — B would close the browser
        // AND drop a mode in one press.
        event.preventDefault();
        handleBack();
        return;
      case "page-prev":
        event.preventDefault();
        jumpPage(-1);
        return;
      case "page-next":
        event.preventDefault();
        jumpPage(1);
        return;
      case "category-prev":
        event.preventDefault();
        cycleCategory(-1);
        return;
      case "category-next":
        event.preventDefault();
        cycleCategory(1);
        return;
      case "toggle-favourite":
        event.preventDefault();
        void toggleFavouriteHighlighted();
        return;
      case "open-search":
        event.preventDefault();
        openSearch();
        return;
      case "open-options":
        event.preventDefault();
        openSort();
        return;
      default:
        return;
    }
  };

  function moveHighlight(delta: number): void {
    const list = deriveVisibleChannels();
    if (!list.length) return;
    const currentIndex = list.findIndex((c) => String(c.id) === String(highlightedId));
    const next =
      currentIndex < 0
        ? delta > 0
          ? 0
          : list.length - 1
        : (currentIndex + delta + list.length) % list.length;
    const channel = list[next];
    if (channel) highlight(channel.id);
  }

  window.addEventListener("keydown", onKeyDown);

  // Collection cards (Home) switch this browser's category:
  // `livetv:browser-category` {browserId?, categoryId,
  // subcategoryId?}. An event naming another browser id is
  // ignored, so the playback instance never follows a Home tap.
  const onBrowserCategory = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { browserId?: string; categoryId?: string; subcategoryId?: string | null }
      | undefined;
    if (!detail?.categoryId) return;
    if (detail.browserId && opts.browserId && detail.browserId !== opts.browserId) return;
    setSelection(detail.categoryId, detail.subcategoryId ?? null);
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
    // 0.11.10 W4: entering the browser focuses its list (or the
    // highlighted row) — without this, focus stays on the
    // now-hidden invoker and the browser's key gate (target must
    // be inside the browser or <body>) ignores controller keys.
    // A requested search overlay focuses its own input after
    // this, so the order is harmless there.
    if (!detail.openSearch) focusListOrRow();
  };
  if (opts.acceptModeEntry) window.addEventListener("livetv:mode", onMode);

  // B / Escape resolved to "back" by the gamepad layer (W5):
  // `livetv:back` {context:"browser"}. A handled press stops
  // propagation so no other surface pops a second layer for the
  // same B (the overlay guards and the Guide do the same).
  const onBack = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { context?: string }
      | undefined;
    if (detail?.context && detail.context !== "browser") return;
    if (!root.isConnected || root.closest("[hidden]")) return;
    if (handleBack()) {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      } else {
        event.stopPropagation();
      }
    }
  };
  window.addEventListener("livetv:back", onBack);

  // Guide → Browser seam (W3): the Guide announces its channel
  // selection as `livetv:guide-channel` {channelId, ...}.
  // Highlight-only — never a tune, never a selection change: when
  // the announced channel is in the current list it becomes the
  // highlighted channel (visible on return to the browser); when
  // it is not in the current selection it is ignored, so the
  // browser never jumps categories behind the user's back.
  const onGuideChannel = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { channelId?: string | number; source?: string }
      | undefined;
    if (!detail || detail.channelId == null) return;
    if (detail.source && detail.source !== "guide") return;
    const list = deriveVisibleChannels();
    if (!list.some((c) => String(c.id) === String(detail.channelId))) return;
    highlight(detail.channelId, false);
  };
  window.addEventListener("livetv:guide-channel", onGuideChannel);

  // W4 overlay answers (see the event contract above).
  const onSearchSubmit = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as LivetvSearchSubmitDetail | undefined;
    if (!detail || typeof detail.query !== "string") return;
    applySearchSubmit(detail);
  };
  window.addEventListener(LIVETV_SEARCH_SUBMIT_EVENT, onSearchSubmit);
  const onSortSubmit = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as LivetvSortSubmitDetail | undefined;
    if (!detail || typeof detail.sort !== "string") return;
    applySortSubmit(detail);
  };
  window.addEventListener(LIVETV_SORT_SUBMIT_EVENT, onSortSubmit);

  // 0.11.10 W4 (§10): a search/sort overlay closed WITHOUT a
  // submit (B / Cancel) reports `livetv:close-overlay` — nobody
  // consumed it before, so focus after a cancel relied solely
  // on the nav stack's push-time restore. When that element was
  // recycled out of the row pool, focus stranded on <body>.
  // Refocus the list / highlighted row here (the nav restore
  // runs after this dispatch and wins when its target is still
  // connected, so the two never fight). Gated on visibility:
  // only the browser instance on screen answers.
  const onCloseOverlay = (event: Event) => {
    if (destroyed) return;
    const detail = (event as CustomEvent).detail as
      | { overlay?: string }
      | undefined;
    if (detail?.overlay !== "search" && detail?.overlay !== "sort") return;
    if (!root.isConnected || root.closest("[hidden]")) return;
    focusListOrRow();
  };
  window.addEventListener(LIVETV_CLOSE_OVERLAY_EVENT, onCloseOverlay);

  // Initial paint. The initial highlight scrolls into view first
  // so the first paint already shows the right window (one paint,
  // not paint-then-scroll-then-paint).
  if (highlightedId != null) {
    const list = deriveVisibleChannels();
    const index = list.findIndex((c) => String(c.id) === String(highlightedId));
    if (index >= 0) scrollToIndex(index);
  }
  paintNow();

  return {
    root,
    setChannels(next: LivetvChannel[]): void {
      // Preserve selection + scroll position across a data
      // refresh: never reset focus when new data lands.
      const savedScrollTop = listEl.scrollTop;
      channels = [...next];
      catalogueStateRevision += 1;
      invalidateDerived();
      if (highlightedId != null && !channelById(highlightedId)) highlightedId = null;
      // A refresh may remove the selected group/subcategory.
      const data = getBrowserCategoryData();
      const group = data.groups.find((g) => g.id === groupId);
      if (!group) {
        groupId = BROWSER_CATEGORY_ALL;
        subcategoryId = null;
      } else if (
        subcategoryId != null &&
        !group.subcategories.some((sub) => sub.id === subcategoryId)
      ) {
        subcategoryId = null;
      }
      // A repaired selection is a category change: re-apply the
      // search-clearing rule (unchanged selections keep a search).
      syncSearchForSelection();
      listEl.scrollTop = savedScrollTop;
      paintNow();
    },
    getHighlightedId(): string | number | null {
      return highlightedId;
    },
    highlightChannel(id: string | number | null, highlightOpts?: { focus?: boolean }): void {
      if (id != null) {
        const list = deriveVisibleChannels();
        const index = list.findIndex((c) => String(c.id) === String(id));
        if (index >= 0) scrollToIndex(index);
      }
      highlight(id, !!highlightOpts?.focus);
    },
    focusChannel(id: string | number): void {
      const list = deriveVisibleChannels();
      const index = list.findIndex((c) => String(c.id) === String(id));
      if (index >= 0) scrollToIndex(index);
      highlight(id, true);
    },
    applyEntry,
    openSearch,
    openSort,
    closeSearch(): boolean {
      return clearQuery();
    },
    isSearchOpen(): boolean {
      return query !== "";
    },
    getCategoryId(): string {
      return groupId;
    },
    getSubcategoryId(): string | null {
      return subcategoryId;
    },
    getSelection(): BrowserSelection {
      return { groupId, subcategoryId };
    },
    setSelection(nextGroupId: string, nextSubcategoryId: string | null = null): void {
      setSelection(nextGroupId, nextSubcategoryId);
    },
    getVisibleChannels(): LivetvChannel[] {
      return deriveVisibleChannels();
    },
    cycleCategory,
    jumpPage,
    toggleFavouriteHighlighted,
    openCategories,
    closeCategories,
    isDrawerOpen(): boolean {
      return drawerHandle != null;
    },
    destroy(): void {
      destroyed = true;
      resizeObserver?.disconnect();
      closeCategories();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("livetv:browser-category", onBrowserCategory);
      window.removeEventListener("livetv:mode", onMode);
      window.removeEventListener("livetv:back", onBack);
      window.removeEventListener("livetv:guide-channel", onGuideChannel);
      window.removeEventListener(LIVETV_SEARCH_SUBMIT_EVENT, onSearchSubmit);
      window.removeEventListener(LIVETV_SORT_SUBMIT_EVENT, onSortSubmit);
      window.removeEventListener(LIVETV_CLOSE_OVERLAY_EVENT, onCloseOverlay);
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
  initialSubcategoryId?: string | null;
  initialFocusId?: string | number | null;
  sort?: BrowserSort;
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
    initialSubcategoryId: opts.initialSubcategoryId ?? undefined,
    initialFocusId: opts.initialFocusId ?? undefined,
    sort: opts.sort,
    onSelect: opts.onSelect ?? ((channel) => dispatchLivetvTune(channel.id)),
    onHighlight: opts.onHighlight,
    onClose: opts.onClose,
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
