// RedSilk Couch — Live TV Landing (0.11.0, W3).
//
// The cinematic Live TV landing: a full-width Now Watching hero, a
// quick-access row, and fixed-size Browse by Category tiles. This
// module is the landing's whole behaviour — pure model builders
// plus the DOM mount — so the Astro components (TvLiveLanding /
// TvLiveHero / TvCategoryTile) stay thin shells and the behaviour
// is unit-testable in jsdom.
//
// Contracts (shared with W5's shell — this module never imports
// W5-owned code, it dispatches the same window events):
//   - `livetv:tune` {channelId} + `livetv:mode` {mode:"playback"}
//     via dispatchLivetvTune — explicit Watch only, never on open,
//     never on highlight/focus. Opening the landing starts NO stream.
//   - `livetv:mode` {mode, ...detail} where mode is "browser" |
//     "guide" | "playback" | "home" and detail is
//     {browserFilter?, guideMode?, openSearch?} — via W5's
//     requestLivetvMode(mode, detail?) (integration unified the
//     landing's dispatchLandingMode onto that helper; the emitted
//     event + shape are identical).
//   - `livetv:back` {context:"landing"} (W5: gamepad resolves
//     B/Escape to "back" and the shell dispatches it) — the landing
//     answers by navigating to the app Home ("/"), the same
//     window.location.assign("/") gamepad.ts uses for navigation.
//   - Focus memory: the couch-focus.ts sessionStorage record
//     (rs_couch_focus_memory, {route, rail, index, key}) plus a
//     dedicated landing key (LANDING_FOCUS_STORAGE_KEY) holding the
//     last landing card's data-focus-key. W5's shared state gains
//     `lastLandingCard`; this module does NOT depend on it — the
//     seam is the focus-key string, so either side can read it.
//
// Artwork (0.11.0): the hero and the category tiles are
// programme-led via the enrichment layer
// (src/scripts/lib/livetv-enrichment.ts — W2's module, contract
// in couchhub-tv-011-contracts.md). fillLandingHero fills text
// synchronously from real EPG; upgradeLandingHeroArt then enriches
// the current programme title and swaps the hero art layer to the
// matched backdrop, and enrichCategoryTiles does the same for each
// tile's now-playing programme. Artwork is matched to the programme
// actually showing — never unrelated art, never fabricated. When
// no artwork resolves, the branded fallback stands (channel logo /
// gradient + small glyph). Enrichment runs only for visible
// titles, never on focus/scroll, and never starts a stream.
import {
  enrichProgramme,
  getProgrammeArtworkSync,
  prefetchProgrammes,
  type ProgrammeArtwork,
} from "./livetv-enrichment";
import {
  collectionNowPlaying,
  dispatchLivetvTune,
  favouriteChannels,
  isLocalChannel,
  loadLivetvHomeData,
  nowNextForChannel,
  pickResumeHero,
  readActivePlaylistId,
  recentlyWatchedChannels,
  requestLivetvMode,
  type LivetvChannel,
  type LivetvGroup,
  type LivetvHomeData,
} from "./livetv-data";
import { buildCategoryIndex } from "./livetv-category-index";
import type { GuideMode } from "./livetv-state";
import { LIVETV_BACK_EVENT } from "./livetv-keys";
import { livetvNav } from "./livetv-nav";
import { formatTimeRange, type Programme } from "./now-next";
import { fallbackMarkFor } from "./couch-image";
import { readCouchFocusMemory } from "./couch-focus";
import { EPG_LOADED_EVENT } from "./epg-data.js";

// ── Events / mode contract ──────────────────────────────────────

/** W5 contract: gamepad resolves B/Escape to "back"; the shell dispatches this.
 *  Single definition lives in livetv-keys.ts (0.11.0 integration R7) —
 *  imported above for local use and re-exported so existing import
 *  sites keep working. */
export { LIVETV_BACK_EVENT };

/** Dedicated sessionStorage key: last landing card's data-focus-key. */
export const LANDING_FOCUS_STORAGE_KEY = "redsilk:livetv:landing-card";

/** Rails the landing registers with the couch-focus layer. */
export const LANDING_RAIL_HERO = "livetv-landing-hero";
export const LANDING_RAIL_QUICK = "livetv-landing-quick";
export const LANDING_RAIL_CATEGORIES = "livetv-landing-categories";

export type LandingMode = "home" | "playback" | "guide" | "browser";

export type LandingBrowserFilter =
  | { kind: "favourites" }
  | { kind: "recents" }
  | { kind: "all" }
  | { kind: "category"; value: string };

export interface LandingModeDetail {
  browserFilter?: LandingBrowserFilter;
  guideMode?: string;
  openSearch?: boolean;
}

/**
 * Ask the shell to show a mode, with the contracted detail shape.
 * Delegates to W5's requestLivetvMode(mode, detail?) — one helper
 * for every mode request in the app. Only ever called with
 * "browser" / "guide" (never "home"), so the helper's home→landing
 * alias never changes a landing request. An unknown guideMode
 * string is dropped rather than forwarded.
 */
export function dispatchLandingMode(
  mode: LandingMode,
  detail: LandingModeDetail = {},
): void {
  if (typeof window === "undefined") return;
  const guideMode: GuideMode | undefined =
    detail.guideMode === "now" ||
    detail.guideMode === "tonight" ||
    detail.guideMode === "channel" ||
    detail.guideMode === "grid"
      ? detail.guideMode
      : undefined;
  // Only defined keys are forwarded — the shell tests presence.
  requestLivetvMode(mode, {
    ...(detail.browserFilter !== undefined
      ? { browserFilter: detail.browserFilter }
      : {}),
    ...(guideMode !== undefined ? { guideMode } : {}),
    ...(detail.openSearch !== undefined
      ? { openSearch: detail.openSearch }
      : {}),
  });
}

// ── Quick access ────────────────────────────────────────────────

export type LandingQuickAction =
  | "continue"
  | "favourites"
  | "recent"
  | "all"
  | "guide"
  | "search";

export interface LandingQuickContext {
  /** Last-watched channel id (the resume hero's channel). Null when there is none. */
  lastWatchedChannelId?: string | number | null;
}

/**
 * One quick-access action → its event(s). Returns true when an
 * event was dispatched, false when there was nothing to do
 * (Continue Watching with no last-watched channel dispatches
 * nothing — the button is hidden in that case, never a dead tune).
 */
export function performLandingQuickAction(
  action: LandingQuickAction,
  ctx: LandingQuickContext = {},
): boolean {
  switch (action) {
    case "continue": {
      const id = ctx.lastWatchedChannelId;
      if (id == null || id === "") return false;
      dispatchLivetvTune(id);
      return true;
    }
    case "favourites":
      dispatchLandingMode("browser", { browserFilter: { kind: "favourites" } });
      return true;
    case "recent":
      dispatchLandingMode("browser", { browserFilter: { kind: "recents" } });
      return true;
    case "all":
      dispatchLandingMode("browser", { browserFilter: { kind: "all" } });
      return true;
    case "guide":
      dispatchLandingMode("guide");
      return true;
    case "search":
      dispatchLandingMode("browser", {
        browserFilter: { kind: "all" },
        openSearch: true,
      });
      return true;
  }
}

/** A category tile → the browser, filtered to that provider group. */
export function openLandingCategory(groupId: string): boolean {
  if (!groupId) return false;
  dispatchLandingMode("browser", {
    browserFilter: { kind: "category", value: groupId },
  });
  return true;
}

// ── Hero model (pure) ───────────────────────────────────────────

export interface LandingHeroProgramme {
  title: string;
  start: number;
  stop: number;
  /** Elapsed fraction 0..1. */
  progress: number;
  timeRange: string;
  /** Real EPG synopsis (Programme.desc), or null when the guide carries none. */
  description?: string | null;
}

export interface LandingHeroModel {
  channel: LivetvChannel;
  eyebrow: string;
  /** Current programme, or null when the EPG covers nothing now. */
  current: LandingHeroProgramme | null;
  next: { title: string; start: number; stop: number; timeRange: string } | null;
  /** True when the hero channel is the last-watched one (Continue Watching applies). */
  isResume: boolean;
}

/**
 * Hero pick + now/next, pure so the landing and its tests agree.
 * pickResumeHero already guarantees a non-null pick whenever any
 * channel exists (featured fallback); null only with no channels.
 * Programme lines are real EPG only — never invented.
 *
 * 0.11.4: the pick is EPG-aware. pickResumeHero returns the
 * last-watched channel unconditionally, so a resume channel the
 * guide does not cover (a prefixed name the EPG cannot match,
 * an uncovered provider channel) used to win the hero and then
 * render the "Live TV" no-programme band — while dozens of
 * covered channels sat one row below with real now-playing
 * lines. When the resume pick has no current programme but
 * another channel does, the hero shows that live channel
 * ("On Now") instead: a programme-led hero whenever the guide
 * covers anything. The resume channel is never lost — it stays
 * one tap away on the Continue Watching pill and Watch Live
 * still tunes it. Only when NO channel has a live programme
 * does the hero keep the resume pick with its honest
 * no-programme state. The eyebrow stays the pick's own
 * ("Resume Watching" for the last-watched channel — the
 * mockup's "Now Watching" is the same idea; the resume
 * wording is the established contract, tested in
 * livetv-landing-090).
 */
export function buildLandingHeroModel(
  data: LivetvHomeData,
  atMs: number = Date.now(),
): LandingHeroModel | null {
  const pick = pickResumeHero(
    data.channels,
    data.recents,
    data.programmes,
    data.playlistId,
    atMs,
  );
  if (!pick) return null;
  let channel = pick.channel;
  let eyebrow = pick.eyebrow;
  let isResume = pick.eyebrow === "Resume Watching";
  let nn = nowNextForChannel(channel, data.programmes, data.playlistId, atMs);
  if (!nn.current) {
    const live = pickLiveHeroChannel(data, atMs);
    if (live) {
      channel = live;
      eyebrow = "On Now";
      isResume = false;
      nn = nowNextForChannel(channel, data.programmes, data.playlistId, atMs);
    }
  }
  return {
    channel,
    eyebrow,
    current: nn.current
      ? {
          title: nn.current.title,
          start: nn.current.start,
          stop: nn.current.stop,
          progress: nn.current.progress ?? 0,
          timeRange: formatTimeRange(nn.current.start, nn.current.stop),
          description: nn.current.desc?.trim() ? nn.current.desc.trim() : null,
        }
      : null,
    next: nn.next
      ? {
          title: nn.next.title,
          start: nn.next.start,
          stop: nn.next.stop,
          timeRange: formatTimeRange(nn.next.start, nn.next.stop),
        }
      : null,
    isResume,
  };
}

/**
 * First channel with a real current programme, in hero order:
 * a favourite with a live programme, then a local (Irish & UK)
 * channel with one, then any channel with one. Null when the
 * guide covers nothing live right now (or is not loaded at all).
 * Pure; the caller re-derives now/next for the returned channel.
 */
export function pickLiveHeroChannel(
  data: LivetvHomeData,
  atMs: number = Date.now(),
): LivetvChannel | null {
  const hasLive = (c: LivetvChannel): boolean =>
    nowNextForChannel(c, data.programmes, data.playlistId, atMs).current != null;
  return (
    favouriteChannels(data.channels).find(hasLive) ??
    data.channels.find((c) => isLocalChannel(c) && hasLive(c)) ??
    data.channels.find(hasLive) ??
    null
  );
}

// ── Categories (pure) ───────────────────────────────────────────

export interface LandingCategory {
  id: string;
  label: string;
  count: number;
  /** First live programme in the group, real EPG only (null when uncovered). */
  nowPlaying: { channelName: string; programmeTitle: string } | null;
  /** Deterministic gradient variant 0..5 (hash of the group id). */
  variant: number;
  /**
   * Enrichment backdrop for the now-playing programme, or null.
   * The pure builder always leaves this null; the mount fills it
   * in via enrichCategoryTiles (same title the nowPlaying line
   * names — never unrelated art).
   */
  artworkUrl?: string | null;
}

/**
 * Small, deliberate category glyph — a texture accent in the tile
 * corner, never a giant motif. Keyed on the normalised label so
 * provider naming variations ("UK Sports", "Sports (HD)") still
 * land on the same glyph. Unknown labels get a neutral spark.
 */
const CATEGORY_GLYPHS: Array<[RegExp, string]> = [
  [/sport/i, "⚽"],
  [/movie|film|cinema/i, "🎬"],
  [/series|drama|tv show/i, "📺"],
  [/entertain/i, "★"],
  [/documentar|nature|factual/i, "🏔"],
  [/kid|cartoon|family/i, "🧸"],
  [/news/i, "📰"],
  [/music/i, "♪"],
  [/comedy/i, "😄"],
];

export function categoryGlyphFor(label: string): string {
  const text = (label ?? "").trim();
  for (const [pattern, glyph] of CATEGORY_GLYPHS) {
    if (pattern.test(text)) return glyph;
  }
  return "✦";
}

export const LANDING_CATEGORY_TILE_VARIANTS = 6;

/** Deterministic variant for a group id (stable across renders). Pure. */
export function categoryTileVariant(groupId: string): number {
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) {
    hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0;
  }
  return hash % LANDING_CATEGORY_TILE_VARIANTS;
}

/** Max tiles on the landing row (mockup shows six). */
export const LANDING_MAX_CATEGORIES = 6;

/**
 * Browse-by-Category tiles from genuine provider groups
 * (the shared category index — never hardcoded provider
 * naming), capped at LANDING_MAX_CATEGORIES. Empty groups never
 * appear; the row hides entirely when there are no groups.
 * Built from a fresh index for this render (the landing
 * renders on data load / mode entry, never per scroll), with
 * each group's channels in catalogue order — the same order
 * the legacy grouping produced, so now-playing picks are
 * unchanged.
 */
export function landingCategories(
  data: LivetvHomeData,
  max: number = LANDING_MAX_CATEGORIES,
  atMs: number = Date.now(),
): LandingCategory[] {
  const index = buildCategoryIndex(
    data.channels,
    "livetv-landing:landingCategories",
  );
  const groupOf = new Map<string, string>();
  for (const group of index.groups) {
    for (const sub of group.subcategories) {
      for (const id of sub.channelIds) {
        if (!groupOf.has(id)) groupOf.set(id, group.id);
      }
    }
  }
  const buckets = new Map<string, LivetvChannel[]>();
  for (const group of index.groups) buckets.set(group.id, []);
  for (const channel of data.channels) {
    const bucket = buckets.get(groupOf.get(String(channel.id)) ?? "");
    if (bucket) bucket.push(channel);
  }
  const groups: LivetvGroup[] = index.groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      channels: buckets.get(group.id) ?? [],
    }))
    .filter((g) => g.channels.length > 0);
  return groups.slice(0, Math.max(0, max)).map((group: LivetvGroup) => ({
    id: group.id,
    label: group.label,
    count: group.channels.length,
    nowPlaying: collectionNowPlaying(group, data.programmes, data.playlistId, atMs),
    variant: categoryTileVariant(group.id),
    artworkUrl: null,
  }));
}

// ── Focus memory ────────────────────────────────────────────────

/** Record the last landing card's data-focus-key (sessionStorage). Pure-ish. */
export function recordLandingFocus(focusKey: string): void {
  if (!focusKey) return;
  try {
    sessionStorage.setItem(LANDING_FOCUS_STORAGE_KEY, focusKey);
  } catch {
    // Storage unavailable: focus memory is a nicety, never fatal.
  }
}

/** Read the recorded landing card key, or null. Pure. */
export function readLandingFocusKey(): string | null {
  try {
    const raw = sessionStorage.getItem(LANDING_FOCUS_STORAGE_KEY);
    return raw ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Restore the last selected landing card: the dedicated landing
 * key first, else the couch-focus memory record when it points at
 * a landing rail on this route. Only acts when nothing is focused
 * yet (body / null) and the target is in the DOM. Returns the
 * focused element, or null when there was nothing to restore.
 * The dedicated key is the seam W5's `lastLandingCard` can write
 * to / read from without this module depending on W5's state.
 */
export function restoreLandingFocus(
  root: ParentNode = document,
): HTMLElement | null {
  const doc =
    root instanceof Document
      ? root
      : ((root as DocumentFragment).ownerDocument ?? document);
  const active = doc.activeElement as HTMLElement | null;
  if (active && active !== doc.body) return null;
  let key = readLandingFocusKey();
  if (!key) {
    const memory = readCouchFocusMemory();
    if (memory) {
      let route = "";
      try {
        route = doc.defaultView?.location.pathname ?? "";
      } catch {
        route = "";
      }
      const landingRails = [LANDING_RAIL_HERO, LANDING_RAIL_QUICK, LANDING_RAIL_CATEGORIES];
      if (route === memory.route && landingRails.includes(memory.rail) && memory.key) {
        key = memory.key;
      }
    }
  }
  if (!key) return null;
  const target = (root as ParentNode).querySelector?.(
    `[data-focus-key="${key.replace(/["\\]/g, "\\$&")}"]`,
  ) as HTMLElement | null;
  if (!target) return null;
  target.focus({ preventScroll: true });
  try {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    // Very old webviews: focus still lands, scroll just doesn't follow.
  }
  return target;
}

/**
 * Record landing focus on focusin / click of any element carrying
 * a data-focus-key inside the landing root. Returns an unmount
 * function. (couch-focus.ts also records focusin for any
 * data-nylah-rail item; this is the landing's own record, keyed by
 * the stable focus key rather than rail + index, so it survives
 * re-renders that rebuild the rails.)
 */
export function mountLandingFocusMemory(
  root: ParentNode,
): () => void {
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target as HTMLElement | null;
    const key = target?.closest?.("[data-focus-key]")?.getAttribute("data-focus-key");
    if (key) recordLandingFocus(key);
  };
  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const key = target?.closest?.("[data-focus-key]")?.getAttribute("data-focus-key");
    if (key) recordLandingFocus(key);
  };
  root.addEventListener("focusin", onFocusIn as EventListener);
  root.addEventListener("click", onClick as EventListener);
  return () => {
    root.removeEventListener("focusin", onFocusIn as EventListener);
    root.removeEventListener("click", onClick as EventListener);
  };
}

// ── Back (B / Escape → app Home) ────────────────────────────────

/** App Home URL (gamepad.ts navigates with window.location.assign). */
export const LANDING_BACK_TARGET = "/";

/**
 * Handle a `livetv:back` event on the landing: B/Escape goes to
 * the app Home. Events for another context are ignored, and so
 * are events while another Live TV layer is on top of the nav
 * stack (a hidden landing must never steal B from the browser,
 * Guide, playback, or an overlay). `navigate`
 * defaults to window.location.assign (the gamepad.ts pattern);
 * tests inject a stub. Returns true when navigation happened.
 */
export function handleLandingBack(
  event?: { detail?: { context?: string } | null } | null,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): boolean {
  const context = event?.detail?.context;
  if (context != null && context !== "landing") return false;
  const top = livetvNav.topId();
  if (top != null && top !== "landing") return false;
  navigate(LANDING_BACK_TARGET);
  return true;
}

/** Listen for `livetv:back` on window; returns an unmount function. */
export function mountLandingBack(
  navigate?: (url: string) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onBack = (event: Event): void => {
    handleLandingBack(
      event as CustomEvent<{ context?: string }>,
      navigate,
    );
  };
  window.addEventListener(LIVETV_BACK_EVENT, onBack);
  return () => window.removeEventListener(LIVETV_BACK_EVENT, onBack);
}

// ── DOM builders ────────────────────────────────────────────────

/**
 * Category tile element — the runtime twin of TvCategoryTile.astro
 * (same classes, same structure). Fixed dimensions come from CSS
 * (.rs-livetv-landing-category-tile: 18.75rem × 10.625rem, never
 * auto height). The art layer is either the contextual enrichment
 * backdrop for the tile's now-playing programme
 * (category.artworkUrl — same title the "now playing" line names,
 * never unrelated art) or the gradient variant + one small glyph.
 * Contains NO channel logos and NO giant initial. The "now
 * playing" line is real EPG only, omitted when uncovered.
 */
export function buildCategoryTileElement(
  category: LandingCategory,
): HTMLButtonElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = `rs-livetv-landing-category-tile rs-livetv-landing-category-tile--v${category.variant}`;
  tile.setAttribute("data-category-id", category.id);
  tile.setAttribute("data-nylah-item", "");
  const focusKey = `landing-category-${category.id}`;
  tile.setAttribute("data-couch-key", focusKey);
  tile.setAttribute("data-focus-key", focusKey);
  tile.setAttribute(
    "aria-label",
    `${category.label}, ${category.count} channel${category.count === 1 ? "" : "s"}`,
  );

  const art = document.createElement("span");
  art.className = "rs-livetv-landing-category-tile__art";
  art.setAttribute("aria-hidden", "true");
  if (category.artworkUrl) {
    const img = document.createElement("img");
    img.className = "rs-livetv-landing-category-tile__art-img";
    img.src = category.artworkUrl;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    art.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "rs-livetv-landing-category-tile__glyph";
    glyph.textContent = categoryGlyphFor(category.label);
    art.appendChild(glyph);
  }
  tile.appendChild(art);

  const label = document.createElement("span");
  label.className = "rs-livetv-landing-category-tile__label";
  label.textContent = category.label;
  tile.appendChild(label);

  const count = document.createElement("span");
  count.className = "rs-livetv-landing-category-tile__count";
  count.textContent = `${category.count} channel${category.count === 1 ? "" : "s"}`;
  tile.appendChild(count);

  if (category.nowPlaying) {
    const now = document.createElement("span");
    now.className = "rs-livetv-landing-category-tile__now";
    now.appendChild(document.createTextNode("Now on "));
    const channel = document.createElement("strong");
    channel.textContent = category.nowPlaying.channelName;
    now.appendChild(channel);
    now.appendChild(
      document.createTextNode(`: ${category.nowPlaying.programmeTitle}`),
    );
    tile.appendChild(now);
  }
  return tile;
}

/**
 * Swap a tile's art layer to an enrichment backdrop. The glyph
 * layer is replaced by the image; a failed image load restores
 * the glyph so a tile never shows a broken-image box. Only ever
 * called with artwork matched to the tile's own now-playing
 * programme. Returns false when the tile has no art layer.
 */
export function applyCategoryTileArtwork(
  tile: HTMLElement,
  artworkUrl: string | null,
): boolean {
  const art = tile.querySelector(".rs-livetv-landing-category-tile__art");
  if (!art) return false;
  if (!artworkUrl) return false;
  art.replaceChildren();
  const img = document.createElement("img");
  img.className = "rs-livetv-landing-category-tile__art-img";
  img.src = artworkUrl;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => {
    const glyph = document.createElement("span");
    glyph.className = "rs-livetv-landing-category-tile__glyph";
    const label =
      tile.querySelector(".rs-livetv-landing-category-tile__label")?.textContent ?? "";
    glyph.textContent = categoryGlyphFor(label);
    art.replaceChildren(glyph);
  });
  art.appendChild(img);
  return true;
}

/**
 * Fill a TvLiveHero skeleton (the [data-hero-*] mounts) from a
 * hero model. The logo mount gets the real channel logo <img> when
 * one exists, else the branded fallback mark (fallbackMarkFor —
 * the 0.8.0 TvImage fallback system). Programme artwork is never
 * fabricated: with no current programme the title line reads
 * "Live TV" and the progress bar stays hidden. Artwork is NOT
 * filled here — upgradeLandingHeroArt does that asynchronously
 * after this synchronous text fill, so the hero is never blocked
 * on a network call. Returns false when there is no model (caller
 * hides the hero).
 */
export function fillLandingHero(
  heroEl: HTMLElement,
  model: LandingHeroModel | null,
): boolean {
  if (!model) return false;
  const setText = (selector: string, text: string): void => {
    const el = heroEl.querySelector(selector);
    if (el) el.textContent = text;
  };
  setText("[data-hero-eyebrow]", model.eyebrow);
  setText("[data-hero-title]", model.channel.displayName || model.channel.name);

  const logoMount = heroEl.querySelector("[data-hero-logo]");
  if (logoMount) {
    logoMount.replaceChildren();
    if (model.channel.logo) {
      const img = document.createElement("img");
      img.src = model.channel.logo;
      img.alt = "";
      img.loading = "eager";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        logoMount.appendChild(heroLogoFallback(model.channel));
      });
      logoMount.appendChild(img);
    } else {
      logoMount.appendChild(heroLogoFallback(model.channel));
    }
  }

  const programmeTitle = heroEl.querySelector("[data-hero-programme-title]");
  const programmeTime = heroEl.querySelector("[data-hero-programme-time]");
  const descriptionEl = heroEl.querySelector<HTMLElement>("[data-hero-description]");
  const progressWrap = heroEl.querySelector<HTMLElement>("[data-hero-progress-wrap]");
  const progressFill = heroEl.querySelector<HTMLElement>("[data-hero-progress-fill]");
  if (model.current) {
    if (programmeTitle) programmeTitle.textContent = model.current.title;
    if (programmeTime) programmeTime.textContent = model.current.timeRange;
    if (descriptionEl) {
      if (model.current.description) {
        descriptionEl.textContent = model.current.description;
        descriptionEl.removeAttribute("hidden");
      } else {
        descriptionEl.setAttribute("hidden", "");
        descriptionEl.textContent = "";
      }
    }
    if (progressWrap) {
      progressWrap.removeAttribute("hidden");
      progressWrap.setAttribute(
        "aria-valuenow",
        String(Math.round(Math.max(0, Math.min(1, model.current.progress)) * 100)),
      );
    }
    if (progressFill) {
      progressFill.style.width = `${Math.round(
        Math.max(0, Math.min(1, model.current.progress)) * 100,
      )}%`;
    }
  } else {
    if (programmeTitle) programmeTitle.textContent = "Live TV";
    if (programmeTime) programmeTime.textContent = "";
    if (descriptionEl) {
      descriptionEl.setAttribute("hidden", "");
      descriptionEl.textContent = "";
    }
    if (progressWrap) progressWrap.setAttribute("hidden", "");
    if (progressFill) progressFill.style.width = "0%";
  }

  const nextEl = heroEl.querySelector("[data-hero-next]");
  if (nextEl) {
    if (model.next) {
      nextEl.textContent = `Up next: ${model.next.title} · ${model.next.timeRange}`;
      nextEl.removeAttribute("hidden");
    } else {
      nextEl.setAttribute("hidden", "");
    }
  }

  const watchBtn = heroEl.querySelector<HTMLElement>("[data-hero-watch]");
  if (watchBtn) {
    watchBtn.setAttribute("data-channel-id", String(model.channel.id));
  }
  // Hero state classes for the no-programme / no-art compositions
  // (couch.css): the hero is programme-led whenever there IS a
  // current programme; otherwise it is an honest branded channel
  // hero, never a blank band. The art class follows what the art
  // layer actually holds right now — upgradeLandingHeroArt flips
  // it when real artwork lands, so a re-fill never mislabels an
  // already-enriched hero.
  heroEl.classList.toggle(
    "rs-livetv-landing-hero--no-programme",
    !model.current,
  );
  const hasArt = !!heroEl.querySelector(
    "[data-hero-art] img.rs-livetv-programme-art__img",
  );
  heroEl.classList.toggle("rs-livetv-landing-hero--no-art", !hasArt);
  heroEl.classList.toggle("rs-livetv-landing-hero--has-art", hasArt);
  stampHeroPlaceholderChannel(
    heroEl,
    model.channel.displayName || model.channel.name,
  );
  // Stamp the programme the art layer must match; a late
  // enrichment for a superseded hero is dropped on arrival.
  const artMount = heroEl.querySelector<HTMLElement>("[data-hero-art]");
  if (artMount) {
    artMount.setAttribute(
      "data-art-title",
      model.current ? model.current.title : "",
    );
    artMount.setAttribute(
      "data-art-channel",
      model.channel.displayName || model.channel.name,
    );
  }
  heroEl.removeAttribute("hidden");
  return true;
}

/**
 * Swap a hero art layer ([data-hero-art], the TvProgrammeArt
 * placeholder) to real programme artwork. Backdrop only — a
 * poster aspect would stretch across the band. A failed image
 * load restores the branded placeholder. The `expectedTitle`
 * guard drops art for a programme the hero no longer shows.
 * Returns false when there is no art layer or no backdrop.
 */
export function applyHeroArtwork(
  heroEl: HTMLElement,
  art: ProgrammeArtwork,
  expectedTitle?: string,
): boolean {
  const artMount = heroEl.querySelector<HTMLElement>("[data-hero-art]");
  if (!artMount) return false;
  if (expectedTitle != null && artMount.getAttribute("data-art-title") !== expectedTitle) {
    return false;
  }
  const url = art.backdropUrl;
  if (!url) return false;
  const placeholder = artMount.querySelector("[data-programme-art]");
  const img = document.createElement("img");
  img.className = "rs-livetv-programme-art__img";
  img.src = url;
  img.alt = "";
  img.loading = "eager";
  img.decoding = "async";
  img.addEventListener("error", () => {
    // Broken artwork URL: fall back to the branded placeholder.
    img.remove();
    heroEl.classList.remove("rs-livetv-landing-hero--has-art");
    heroEl.classList.add("rs-livetv-landing-hero--no-art");
    if (placeholder && !artMount.contains(placeholder)) {
      artMount.replaceChildren(placeholder);
      placeholder.setAttribute("data-art-state", "placeholder");
    }
  });
  artMount.replaceChildren(img);
  heroEl.classList.remove("rs-livetv-landing-hero--no-art");
  heroEl.classList.add("rs-livetv-landing-hero--has-art");
  if (placeholder) placeholder.setAttribute("data-art-state", "artwork");
  return true;
}

/**
 * Enrich the hero's current programme and upgrade the art layer
 * in place. Only runs when there IS a current programme (no
 * programme → no artwork, the branded fallback stands — never
 * unrelated art). Applies the cached artwork synchronously when
 * the enrichment cache already holds it, otherwise awaits the
 * network result and applies it only if the hero still shows the
 * same programme. When the EPG carries no synopsis, the
 * enrichment synopsis for the same title fills the description
 * line. Never throws, never tunes, never blocks the hero text.
 */
export async function upgradeLandingHeroArt(
  heroEl: HTMLElement,
  model: LandingHeroModel | null,
): Promise<boolean> {
  if (!model?.current) return false;
  const title = model.current.title;
  const channelName = model.channel.displayName || model.channel.name;
  const cached = getProgrammeArtworkSync(title);
  if (cached && cached.backdropUrl) {
    return applyHeroArtwork(heroEl, cached, title);
  }
  let art: ProgrammeArtwork;
  try {
    art = await enrichProgramme({
      title,
      channelName,
      startMs: model.current.start,
      endMs: model.current.stop,
    });
  } catch {
    return false;
  }
  // The hero may have re-rendered for another channel while the
  // request was in flight — the guard inside applyHeroArtwork
  // drops stale art, and the synopsis gets the same check.
  const applied = applyHeroArtwork(heroEl, art, title);
  if (art.synopsis && !model.current.description) {
    const artMount = heroEl.querySelector<HTMLElement>("[data-hero-art]");
    if (artMount?.getAttribute("data-art-title") === title) {
      const descriptionEl = heroEl.querySelector<HTMLElement>("[data-hero-description]");
      if (descriptionEl) {
        descriptionEl.textContent = art.synopsis;
        descriptionEl.removeAttribute("hidden");
      }
    }
  }
  return applied;
}

/**
 * Enrich each rendered category tile's now-playing programme and
 * swap its art layer to the matched backdrop. Prefetches the
 * visible titles first (bounded by the enrichment layer), then
 * applies cached art immediately and awaits the rest — a tile
 * whose programme has no artwork keeps its gradient + glyph.
 * Never throws; artwork is matched per tile, never shared across
 * tiles with different programmes.
 */
export async function enrichCategoryTiles(
  row: HTMLElement,
  categories: readonly LandingCategory[],
): Promise<void> {
  const titles = categories
    .map((c) => c.nowPlaying?.programmeTitle)
    .filter((t): t is string => !!t);
  if (!titles.length) return;
  prefetchProgrammes(titles);
  const tiles = [...row.querySelectorAll<HTMLElement>("[data-category-id]")];
  const byId = new Map(tiles.map((t) => [t.getAttribute("data-category-id"), t]));
  await Promise.all(
    categories.map(async (category) => {
      const title = category.nowPlaying?.programmeTitle;
      const tile = byId.get(category.id);
      if (!title || !tile) return;
      const cached = getProgrammeArtworkSync(title);
      if (cached?.backdropUrl) {
        applyCategoryTileArtwork(tile, cached.backdropUrl);
        return;
      }
      try {
        const art = await enrichProgramme({ title });
        if (art.backdropUrl) applyCategoryTileArtwork(tile, art.backdropUrl);
      } catch {
        // No artwork for this tile: gradient + glyph stand.
      }
    }),
  );
}

function heroLogoFallback(channel: LivetvChannel): HTMLSpanElement {
  const fallback = document.createElement("span");
  fallback.className = "rs-livetv-landing-hero__logo-fallback";
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = fallbackMarkFor(
    "logo",
    channel.displayName || channel.name,
  );
  return fallback;
}

/**
 * Stamp the hero channel's name into the TvProgrammeArt branded
 * placeholder. The placeholder is SSR'd without a channel name
 * (the hero channel is only known at runtime), so without this
 * the no-art hero shows a blank burgundy gradient with only the
 * "NylahBox" mark — the flat mauve slab from the user's photo.
 * Idempotent: the brand line is created once and re-stamped on
 * every fill, so a re-render for another channel updates it.
 * A no-op once real artwork has replaced the placeholder layer.
 */
function stampHeroPlaceholderChannel(
  heroEl: HTMLElement,
  channelName: string,
): void {
  const art = heroEl.querySelector("[data-hero-art] [data-programme-art]");
  if (!art || !channelName) return;
  art.setAttribute("data-channel", channelName);
  let brand = art.querySelector(".rs-livetv-programme-art__channel");
  if (!brand) {
    brand = document.createElement("span");
    brand.className = "rs-livetv-programme-art__channel";
    const placeholder = art.querySelector(
      ".rs-livetv-programme-art__placeholder",
    );
    const mark = art.querySelector(".rs-livetv-programme-art__mark");
    if (placeholder) {
      if (mark) placeholder.insertBefore(brand, mark);
      else placeholder.appendChild(brand);
    } else {
      art.appendChild(brand);
    }
  }
  brand.textContent = channelName;
}

// ── Mount ───────────────────────────────────────────────────────

export interface LandingHandle {
  /** Last-watched (hero) channel id, or null when there is none. */
  heroChannelId: string | number | null;
  unmount: () => void;
}

/**
 * Mount the landing inside a TvLiveLanding host: load the cached
 * home data, fill the hero / quick-access sublabels / category
 * row, wire the quick-access + hero actions, the focus memory and
 * the `livetv:back` handler. Returns null when there is no active
 * playlist (the host's empty state is shown instead).
 *
 * NEVER tunes on open: mounting dispatches no `livetv:tune` and
 * no `livetv:mode` — streams start only on an explicit Watch /
 * quick-access / category action. A late EPG load re-renders the
 * hero + categories (real programme lines only); favourites /
 * recents changes re-render the quick-access counts.
 */
export async function mountLivtvLanding(
  host: HTMLElement,
): Promise<LandingHandle | null> {
  const playlistId = readActivePlaylistId();
  if (!playlistId) {
    host.querySelector("[data-landing-empty]")?.removeAttribute("hidden");
    host.querySelector("[data-livetv-hero]")?.setAttribute("hidden", "");
    host.querySelector("[data-landing-categories-section]")?.setAttribute("hidden", "");
    return null;
  }
  host.querySelector("[data-landing-empty]")?.setAttribute("hidden", "");

  const unmounts: Array<() => void> = [];
  unmounts.push(mountLandingFocusMemory(host));
  unmounts.push(mountLandingBack());
  let heroChannelId: string | number | null = null;

  const render = async (): Promise<void> => {
    let data: LivetvHomeData;
    try {
      data = await loadLivetvHomeData(playlistId);
    } catch {
      return;
    }
    if (!data.channels.length) {
      host.querySelector("[data-landing-empty]")?.removeAttribute("hidden");
      host.querySelector("[data-livetv-hero]")?.setAttribute("hidden", "");
      host.querySelector("[data-landing-categories-section]")?.setAttribute("hidden", "");
      return;
    }
    host.querySelector("[data-landing-empty]")?.setAttribute("hidden", "");

    // Hero.
    const heroEl = host.querySelector<HTMLElement>("[data-livetv-hero]");
    const model = buildLandingHeroModel(data);
    heroChannelId = model?.channel.id ?? null;
    if (heroEl) {
      if (!fillLandingHero(heroEl, model)) {
        heroEl.setAttribute("hidden", "");
      } else {
        // Artwork upgrades in place once enrichment resolves;
        // the text hero above never waits on the network.
        void upgradeLandingHeroArt(heroEl, model);
      }
    }

    // Quick-access sublabels (real counts / real channel name only).
    const favourites = favouriteChannels(data.channels);
    const recents = recentlyWatchedChannels(data.channels, data.recents);
    const setSublabel = (action: string, text: string): void => {
      const el = host.querySelector(
        `[data-landing-sublabel-for="${action}"]`,
      );
      if (el) el.textContent = text;
    };
    const continueBtn = host.querySelector<HTMLElement>(
      '[data-landing-action="continue"]',
    );
    if (continueBtn) {
      if (recents[0]) {
        continueBtn.removeAttribute("hidden");
        continueBtn.setAttribute("data-channel-id", String(recents[0].id));
        setSublabel("continue", recents[0].displayName || recents[0].name);
      } else {
        continueBtn.setAttribute("hidden", "");
      }
    }
    const recentBtn = host.querySelector<HTMLElement>(
      '[data-landing-action="recent"]',
    );
    if (recentBtn) {
      if (recents.length > 0) {
        recentBtn.removeAttribute("hidden");
        setSublabel("recent", `${recents.length} channel${recents.length === 1 ? "" : "s"}`);
      } else {
        recentBtn.setAttribute("hidden", "");
      }
    }
    setSublabel("favourites", `${favourites.length} channel${favourites.length === 1 ? "" : "s"}`);
    setSublabel("all", `${data.channels.length} channel${data.channels.length === 1 ? "" : "s"}`);
    setSublabel("guide", "Now & Next");
    setSublabel("search", "Find a channel");

    // Categories.
    const section = host.querySelector<HTMLElement>(
      "[data-landing-categories-section]",
    );
    const row = host.querySelector<HTMLElement>("[data-landing-categories]");
    const categories = landingCategories(data);
    if (row) {
      row.replaceChildren();
      for (const category of categories) {
        const tile = buildCategoryTileElement(category);
        tile.addEventListener("click", () => {
          openLandingCategory(category.id);
        });
        row.appendChild(tile);
      }
      // Contextual programme artwork per tile, upgraded in place.
      void enrichCategoryTiles(row, categories);
    }
    if (section) {
      section.toggleAttribute("hidden", categories.length === 0);
    }

    // Restore the last selected card on return (after the rails
    // are rebuilt — the focus layer's load-time restore runs
    // before this async render, so it cannot see these cards).
    restoreLandingFocus(host);
  };

  // Quick-access + hero actions (delegated: the buttons are static
  // skeleton markup, the hero watch button is filled by render).
  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const actionBtn = target?.closest?.("[data-landing-action]") as HTMLElement | null;
    if (actionBtn) {
      const action = actionBtn.getAttribute("data-landing-action") as LandingQuickAction | null;
      if (!action) return;
      if (action === "continue") {
        const id = actionBtn.getAttribute("data-channel-id");
        performLandingQuickAction("continue", {
          lastWatchedChannelId:
            id == null ? heroChannelId : /^\d+$/.test(id) ? Number(id) : id,
        });
      } else {
        performLandingQuickAction(action);
      }
      return;
    }
    const watchBtn = target?.closest?.("[data-hero-watch]") as HTMLElement | null;
    if (watchBtn) {
      const id = watchBtn.getAttribute("data-channel-id");
      if (id != null) {
        dispatchLivetvTune(/^\d+$/.test(id) ? Number(id) : id);
      }
      return;
    }
    const guideBtn = target?.closest?.("[data-hero-guide]") as HTMLElement | null;
    if (guideBtn) {
      dispatchLandingMode("guide");
    }
  };
  host.addEventListener("click", onClick);
  unmounts.push(() => host.removeEventListener("click", onClick));

  // Late EPG load upgrades the hero (Featured → a real live
  // programme) and fills category "now playing" lines; favourites
  // / recents changes refresh the quick-access counts. Guarded to
  // this playlist; debounced like the 0.7.0 home shell.
  let rerenderTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRerender = (): void => {
    if (rerenderTimer) clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => void render(), 250);
  };
  const onEpgLoaded = (event: Event): void => {
    const detail = (event as CustomEvent<{ playlistId?: string }>).detail;
    if (detail?.playlistId && detail.playlistId !== playlistId) return;
    scheduleRerender();
  };
  const onPrefsChanged = (): void => scheduleRerender();
  document.addEventListener(EPG_LOADED_EVENT, onEpgLoaded);
  document.addEventListener("xt:favorites-changed", onPrefsChanged);
  document.addEventListener("xt:recents-changed", onPrefsChanged);
  unmounts.push(() => {
    document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded);
    document.removeEventListener("xt:favorites-changed", onPrefsChanged);
    document.removeEventListener("xt:recents-changed", onPrefsChanged);
    if (rerenderTimer) clearTimeout(rerenderTimer);
  });

  await render();
  return {
    get heroChannelId() {
      return heroChannelId;
    },
    unmount: () => {
      for (const unmount of unmounts) unmount();
    },
  };
}

// Re-exported for callers that only know the Programme shape.
export type { Programme };
