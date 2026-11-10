// RedSilk Couch — Live TV Landing (0.9.0, W1).
//
// The cinematic Live TV landing: a full-width Now Watching hero, a
// restrained quick-access row, and fixed-size Browse by Category
// tiles. This module is the landing's whole behaviour — pure model
// builders plus the DOM mount — so the Astro components
// (TvLiveLanding / TvLiveHero / TvCategoryTile) stay thin shells
// and the behaviour is unit-testable in jsdom.
//
// Contracts (shared with W5's shell — this module never imports
// W5-owned code, it dispatches the same window events):
//   - `livetv:tune` {channelId} + `livetv:mode` {mode:"playback"}
//     via dispatchLivetvTune — explicit Watch only, never on open,
//     never on highlight/focus. Opening the landing starts NO stream.
//   - `livetv:mode` {mode, ...detail} where mode is "browser" |
//     "guide" | "playback" | "home" and detail is
//     {browserFilter?, guideMode?, openSearch?}. W5 extends
//     requestLivetvMode(mode, detail?) to the same shape; until that
//     lands this module dispatches the window event directly with
//     the identical detail shape, using the LIVETV_MODE_EVENT
//     constant from livetv-data.ts (never a second event name).
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
// Artwork honesty: the EPG Programme shape carries NO artwork
// field (start/stop/title/desc only — see now-next.ts), so there is
// no genuine programme artwork to show. The hero is a branded
// burgundy gradient + the channel logo through the 0.8.0 TvImage
// fallback system (fallbackMarkFor), never a fabricated image.
// Category tiles carry NO channel logos at all — no stacked-logo
// artwork: a deterministic burgundy gradient variant + one large
// initial motif per category, fixed dimensions, artwork bounded.
import {
  LIVETV_MODE_EVENT,
  collectionNowPlaying,
  dispatchLivetvTune,
  favouriteChannels,
  groupChannels,
  loadLivetvHomeData,
  nowNextForChannel,
  pickResumeHero,
  readActivePlaylistId,
  recentlyWatchedChannels,
  type LivetvChannel,
  type LivetvGroup,
  type LivetvHomeData,
} from "./livetv-data";
import { formatTimeRange, type Programme } from "./now-next";
import { fallbackMarkFor } from "./couch-image";
import { readCouchFocusMemory } from "./couch-focus";
import { EPG_LOADED_EVENT } from "./epg-data.js";

// ── Events / mode contract ──────────────────────────────────────

/** W5 contract: gamepad resolves B/Escape to "back"; the shell dispatches this. */
export const LIVETV_BACK_EVENT = "livetv:back";

/** Dedicated sessionStorage key: last landing card's data-focus-key. */
export const LANDING_FOCUS_STORAGE_KEY = "redsilk:livetv:landing-card";

/** Rails the landing registers with the couch-focus layer. */
export const LANDING_RAIL_HERO = "livetv-landing-hero";
export const LANDING_RAIL_QUICK = "livetv-landing-quick";
export const LANDING_RAIL_CATEGORIES = "livetv-landing-categories";

export type LandingMode = "home" | "playback" | "guide" | "browser";

export type LandingBrowserFilter =
  | { kind: "favourites" }
  | { kind: "all" }
  | { kind: "category"; value: string };

export interface LandingModeDetail {
  browserFilter?: LandingBrowserFilter;
  guideMode?: string;
  openSearch?: boolean;
}

/**
 * Ask the shell to show a mode, with the contracted detail shape.
 * Dispatches `livetv:mode` {mode, ...detail} on window — the same
 * event + shape W5's requestLivetvMode(mode, detail?) will emit, so
 * the shell cannot tell the two apart.
 */
export function dispatchLandingMode(
  mode: LandingMode,
  detail: LandingModeDetail = {},
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(LIVETV_MODE_EVENT, { detail: { mode, ...detail } }),
  );
}

// ── Quick access ────────────────────────────────────────────────

export type LandingQuickAction =
  | "continue"
  | "favourites"
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
  const nn = nowNextForChannel(pick.channel, data.programmes, data.playlistId, atMs);
  return {
    channel: pick.channel,
    eyebrow: pick.eyebrow,
    current: nn.current
      ? {
          title: nn.current.title,
          start: nn.current.start,
          stop: nn.current.stop,
          progress: nn.current.progress ?? 0,
          timeRange: formatTimeRange(nn.current.start, nn.current.stop),
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
    isResume: pick.eyebrow === "Resume Watching",
  };
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
 * (groupChannels — never hardcoded provider naming), "all"
 * excluded, capped at LANDING_MAX_CATEGORIES. Empty groups never
 * appear; the row hides entirely when there are no groups.
 */
export function landingCategories(
  data: LivetvHomeData,
  max: number = LANDING_MAX_CATEGORIES,
  atMs: number = Date.now(),
): LandingCategory[] {
  const groups = groupChannels(data.channels).filter(
    (g: LivetvGroup) => g.id !== "all" && g.channels.length > 0,
  );
  return groups.slice(0, Math.max(0, max)).map((group: LivetvGroup) => ({
    id: group.id,
    label: group.label,
    count: group.channels.length,
    nowPlaying: collectionNowPlaying(group, data.programmes, data.playlistId, atMs),
    variant: categoryTileVariant(group.id),
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
 * the app Home. Events for another context are ignored. `navigate`
 * defaults to window.location.assign (the gamepad.ts pattern);
 * tests inject a stub. Returns true when navigation happened.
 */
export function handleLandingBack(
  event?: { detail?: { context?: string } | null } | null,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): boolean {
  const context = event?.detail?.context;
  if (context != null && context !== "landing") return false;
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
 * auto height). Contains NO <img> and NO channel logos: the
 * artwork is the gradient variant + one large initial motif.
 * The "now playing" line is real EPG only, omitted when uncovered.
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

  const motif = document.createElement("span");
  motif.className = "rs-livetv-landing-category-tile__motif";
  motif.setAttribute("aria-hidden", "true");
  motif.textContent = (category.label.trim()[0] ?? "•").toUpperCase();
  tile.appendChild(motif);

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
 * Fill a TvLiveHero skeleton (the [data-hero-*] mounts) from a
 * hero model. The logo mount gets the real channel logo <img> when
 * one exists, else the branded fallback mark (fallbackMarkFor —
 * the 0.8.0 TvImage fallback system). Programme artwork is never
 * fabricated: with no current programme the title line reads
 * "Live TV" and the progress bar stays hidden. Returns false when
 * there is no model (caller hides the hero).
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
  const progressWrap = heroEl.querySelector<HTMLElement>("[data-hero-progress-wrap]");
  const progressFill = heroEl.querySelector<HTMLElement>("[data-hero-progress-fill]");
  if (model.current) {
    if (programmeTitle) programmeTitle.textContent = model.current.title;
    if (programmeTime) programmeTime.textContent = model.current.timeRange;
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
  heroEl.removeAttribute("hidden");
  return true;
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
    setSublabel("favourites", `${favourites.length} channel${favourites.length === 1 ? "" : "s"}`);
    setSublabel("all", `${data.channels.length} channel${data.channels.length === 1 ? "" : "s"}`);
    setSublabel("guide", "Now & Next");
    setSublabel("search", "Find a channel");

    // Categories.
    const section = host.querySelector<HTMLElement>(
      "[data-landing-categories-section]",
    );
    const row = host.querySelector("[data-landing-categories]");
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

// Re-exported for callers that only know the Programme shape: the
// EPG carries no artwork, so the hero never asks for any.
export type { Programme };
