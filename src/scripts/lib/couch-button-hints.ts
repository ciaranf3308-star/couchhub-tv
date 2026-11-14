// RedSilk Couch — Xbox button-legend configs (W6, browse / visual-quality pass).
//
// The SINGLE source of truth for what the controller does on each Couch
// screen, and therefore what the shared TvButtonHints legend may show.
// Every row below was audited against the real input path —
// gamepad.ts (the Gamepad API bridge: buttons -> synthetic keyboard
// events + the rail model) and the per-screen keydown handlers — on
// 2026-11-10. A hint that does not match the real mapping is worse
// than no hint, so a button is listed ONLY where its handler actually
// does something on that screen. Omissions below are deliberate and
// audited; the mapping gaps they expose are reported in the W6
// hand-back, not silently "fixed" here (muscle memory).
//
// AUDIT TABLE (gamepad.ts + handlers; "—" = the button does nothing
// there, so the legend must not name it):
//
//   Screen            A               B                    X
//   ───────────────── ─────────────── ─────────────────── ─────────────────
//   Home              Play / Select   —                    Actions (*1)
//   Live TV Home      Watch (tune)    —                    — (*2)
//   Live TV playback  Show controls   Close → Live Home    Guide
//   Guide             Select programme Leave Guide         — (swallowed, *3)
//   Browse / Discover Select          —                    — (*4)
//   Movies / Series   Select          —                    — (*4)
//   Movie / Series    Play / Select   Exit player (*5)     Play / Pause (*5)
//     detail
//   Search            Select          Back / Clear (*6)    — (*4)
//   Followed          Select          —                    — (*7)
//   Settings          Select          —                    — (*4)
//   Text field focused — (field owns)  Blur / Back          — (field owns)
//
//   Screen            Y               LB / RB              Menu
//   ───────────────── ─────────────── ─────────────────── ─────────────────
//   Home              Search          —                    Settings
//   Live TV Home      Search (*2)     — (live: no seek)    Settings (*2)
//   Live TV playback  Channels        — (live: no seek)    Options overlay
//   Guide             Guide actions   Earlier / Later 6h   Guide actions
//   Browse / Discover Search          —                    Settings
//   Movies / Series   Search          —                    Settings
//   Movie / Series    Search (*8)    Seek ∓10s (*5)       Settings
//     detail          (Fullscreen *5)
//   Search            — (already here)—                    Settings
//   Followed          Search          —                    Settings
//   Settings          Search          —                    — (already here)
//   Text field focused — (field owns) — (field owns)       — (field owns)
//   On-screen keys    Search (*9)    —                    Settings
//     focused         (— on Search)
//   (*9) On-screen keyboard focus (TvKeyboard / OnScreenKeyboard):
//        A types the focused key, B (Escape) backspaces (the OSK's
//        own keydown handler), D-pad moves between keys. X clears the
//        query: the clear poll fires while focus is inside
//        [data-couch-keyboard] (OnScreenKeyboard.svelte, W2 fix — the
//        old `.search-view` scope matched nothing, so X cleared
//        nothing before W2). The OSK legend therefore shows X Clear.
//        See W6 hand-back + integration fix.
//
//   Global, every screen: D-pad / left stick moves focus; LT / RT
//   volume works only where a video element exists (Live TV playback,
//   detail pages); View + Menu held 2 s returns home (gamepad.ts owns
//   the hold — no screen may intercept it, return-home.ts minimises).
//
//   (*1) X = Actions on Home (0.11.10): HomeView's onCardKey consumes
//        the "x" key on hero/rail cards and opens the card context
//        menu, and HomeView claims the legend with the same label —
//        so the static config below matches it. The legacy ?autoplay
//        details fallback in gamepad.ts (openDetailsOfFocused) only
//        runs where NO handler consumes "x"; no Home card reaches it.
//        The 0.8.0 audit's "Details" label is superseded (0.11.14 W3).
//   (*2) livetv-keys.ts claims Live TV Home X = contextual, Y = Guide,
//        Menu = Options — but no production handler consumes the
//        "home" context (only the Guide context is read, by
//        TvGuideView). Runtime reality is X = nothing, Y = Search
//        (gamepad.ts goSearch), Menu = Settings. See W6 hand-back.
//   (*3) X is deliberately swallowed in the Guide (gamepad.ts W3
//        branch): unmapped by design, never hint it.
//   (*4) Discover / Movies / Series / Search / Settings card links
//        carry NO ?autoplay param (candidateDetailHref, detailHref,
//        buildHref), so openDetailsOfFocused() returns without acting.
//   (*5) Detail "while playing" rows: B exits the player to the
//        detail (couch-detail.ts capture-phase Escape handler); X
//        play/pause and Y fullscreen come from gamepad.ts's
//        inPlayerContext() branch; LB/RB seek needs a video with a
//        finite duration (VOD only).
//   (*6) Search B/Escape: exit person mode → focus input → clear
//        query → leave search (SearchView.svelte onKey; isTvDevice()
//        is false on Couch desktop, so the handler is live).
//   (*7) Followed cards are <article>/buttons, not anchor links, so
//        openDetailsOfFocused() has no link to act on.
//   (*8) Detail Y is Search while browsing and fullscreen-toggle
//        while playing; the legend says "Search · when browsing" and
//        the playing-only rows carry "while playing".

export type HintGlyph =
  | "a"
  | "b"
  | "x"
  | "y"
  | "lb"
  | "rb"
  | "lt-rt"
  | "menu"
  | "view-menu"
  | "dpad"
  | "dpad-v"
  | "dpad-h";

export interface HintItem {
  /** Button glyph shown before the label. */
  glyph: HintGlyph;
  /** What the button does on this screen. Short imperative. */
  label: string;
  /** State qualifier, e.g. "while playing" — rendered as a suffix. */
  when?: string;
}

export interface HintConfig {
  /** Screen/mode id this config belongs to. */
  id: string;
  items: readonly HintItem[];
}

/** The return-home combo — global, present in every config. */
export const RETURN_HOME_HINT: HintItem = {
  glyph: "view-menu",
  label: "Return home",
} as const;

/** Minimal legend while a text field owns the controller (gamepad.ts
 *  editing branch: only B and View+Menu keep working). */
export const EDITING_HINTS: HintConfig = {
  id: "editing",
  items: [
    { glyph: "b", label: "Back" },
    RETURN_HOME_HINT,
  ],
} as const;

/**
 * Legend while focus is on an on-screen keyboard key ([data-osk]).
 * A types the focused key, B closes the keyboard (B never deletes —
 * the ⌫ key deletes, see oskKeyAction in couch-keyboard.ts), and
 * there is no X shortcut (the Clear key clears). D-pad moves
 * between keys. Y goes to Search except on the Search screen
 * itself, where it is a no-op.
 */
export function hintsForOsk(view: string | null | undefined): HintConfig {
  const items: HintItem[] = [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Type" },
    { glyph: "b", label: "Close keyboard" },
  ];
  if ((view ?? "").trim() !== "search") {
    items.push({ glyph: "y", label: "Search" });
  }
  items.push({ glyph: "menu", label: "Settings" }, RETURN_HOME_HINT);
  return { id: "osk", items };
}

/** Fallback for a Couch view with no audited config yet: only the
 *  global buttons (D-pad move, A activate, Menu Settings,
 *  View+Menu home) — never guess a screen-specific mapping. */
export const GENERIC_HINTS: HintConfig = {
  id: "generic",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Select" },
    { glyph: "menu", label: "Settings" },
    RETURN_HOME_HINT,
  ],
} as const;

/** Live TV landing config, defined once — HINT_CONFIGS references it under both its current and deprecated keys. */
const LIVETV_LANDING_HINTS: HintConfig = {
  id: "livetv-landing",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Watch" },
    { glyph: "b", label: "Back" },
    { glyph: "x", label: "Contextual action" },
    { glyph: "y", label: "Open Guide" },
    { glyph: "menu", label: "Options" },
    RETURN_HOME_HINT,
  ],
};

export const HINT_CONFIGS: Readonly<Record<string, HintConfig>> = {
  home: {
    id: "home",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Play / Select" },
      { glyph: "x", label: "Actions" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  // 0.9.0 Live TV landing (W5): B backs out via `livetv:back`
  // (gamepad.ts dispatches it; W1's landing owns the back step),
  // X is the landing's contextual action, Y opens the Guide.
  // Supersedes the 0.8.0 W6 audit (*2) for this mode — those
  // buttons were dead in 0.8.0 because no handler consumed the
  // "home" context; in 0.9.0 W1 implements them.
  // Single source: the config object is defined once above
  // (LIVETV_LANDING_HINTS) and both keys reference it — the old
  // duplicated "livetv-home" literal was a second source that
  // could drift from the landing config.
  "livetv-landing": LIVETV_LANDING_HINTS,
  /** @deprecated 0.8.0 name for the landing config — use "livetv-landing". Same object, not a copy. */
  "livetv-home": LIVETV_LANDING_HINTS,
  // 0.9.0 Channel Browser (W5/W2): A watches the highlighted
  // channel live, LB/RB step categories, LT/RT step pages, X
  // toggles the favourite, Y opens search, B returns to the
  // landing via `livetv:back`. (INTEGRATION: A was "Select" in
  // W5; W2's spec names it Watch — Enter on a row tunes live.)
  "livetv-browser": {
    id: "livetv-browser",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Watch" },
      { glyph: "b", label: "Back" },
      { glyph: "lb", label: "Previous category" },
      { glyph: "rb", label: "Next category" },
      { glyph: "lt-rt", label: "Previous / Next page" },
      { glyph: "x", label: "Favourite" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Options" },
      RETURN_HOME_HINT,
    ],
  },
  "livetv-playback": {
    id: "livetv-playback",
    items: [
      { glyph: "dpad-v", label: "Quick Surf" },
      { glyph: "dpad-h", label: "Programme info" },
      { glyph: "a", label: "Show controls" },
      { glyph: "b", label: "Close, then Live Home" },
      { glyph: "x", label: "Guide" },
      { glyph: "y", label: "Channels" },
      { glyph: "lt-rt", label: "Volume" },
      { glyph: "menu", label: "Options" },
      RETURN_HOME_HINT,
    ],
  },
  "livetv-guide": {
    id: "livetv-guide",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select programme" },
      { glyph: "b", label: "Leave Guide" },
      { glyph: "lb", label: "Earlier in time" },
      { glyph: "rb", label: "Later in time" },
      { glyph: "y", label: "Guide actions" },
      { glyph: "menu", label: "Guide actions" },
      RETURN_HOME_HINT,
    ],
  },
  // 0.9.0 Guide sub-modes (W5/W4). The base "livetv-guide" config
  // above is the grid default (kept byte-identical for the 0.8.0
  // audit pin); the sub-mode configs add the rows that only make
  // sense in that sub-mode — Left/Right on the tab row switches
  // guide views, and LB/RB step days in By Channel mode (time in
  // grid mode). N (jump to now) is keyboard-only, so the legend
  // never names it. hintsForView picks by guideMode.
  "livetv-guide-now": {
    id: "livetv-guide-now",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "dpad-h", label: "Switch guide view", when: "on tab row" },
      { glyph: "a", label: "Select programme" },
      { glyph: "b", label: "Leave Guide" },
      { glyph: "y", label: "Guide actions" },
      { glyph: "menu", label: "Guide actions" },
      RETURN_HOME_HINT,
    ],
  },
  "livetv-guide-tonight": {
    id: "livetv-guide-tonight",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "dpad-h", label: "Switch guide view", when: "on tab row" },
      { glyph: "a", label: "Select programme" },
      { glyph: "b", label: "Leave Guide" },
      { glyph: "y", label: "Guide actions" },
      { glyph: "menu", label: "Guide actions" },
      RETURN_HOME_HINT,
    ],
  },
  "livetv-guide-channel": {
    id: "livetv-guide-channel",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "dpad-h", label: "Switch guide view", when: "on tab row" },
      { glyph: "a", label: "Select programme" },
      { glyph: "b", label: "Leave Guide" },
      { glyph: "lb", label: "Previous day" },
      { glyph: "rb", label: "Next day" },
      { glyph: "y", label: "Guide actions" },
      { glyph: "menu", label: "Guide actions" },
      RETURN_HOME_HINT,
    ],
  },
  "livetv-guide-grid": {
    id: "livetv-guide-grid",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "dpad-h", label: "Switch guide view", when: "on tab row" },
      { glyph: "a", label: "Select programme" },
      { glyph: "b", label: "Leave Guide" },
      { glyph: "lb", label: "Earlier in time" },
      { glyph: "rb", label: "Later in time" },
      { glyph: "y", label: "Guide actions" },
      { glyph: "menu", label: "Guide actions" },
      RETURN_HOME_HINT,
    ],
  },
  browse: {
    id: "browse",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  discover: {
    id: "discover",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  movies: {
    id: "movies",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  series: {
    id: "series",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  "movies-detail": {
    id: "movies-detail",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Play / Select" },
      { glyph: "b", label: "Exit player", when: "while playing" },
      { glyph: "x", label: "Play / Pause", when: "while playing" },
      { glyph: "y", label: "Search", when: "when browsing" },
      { glyph: "lb", label: "Seek −10s", when: "while playing" },
      { glyph: "rb", label: "Seek +10s", when: "while playing" },
      { glyph: "lt-rt", label: "Volume" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  "series-detail": {
    id: "series-detail",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Play / Select" },
      { glyph: "b", label: "Exit player", when: "while playing" },
      { glyph: "x", label: "Play / Pause", when: "while playing" },
      { glyph: "y", label: "Search", when: "when browsing" },
      { glyph: "lb", label: "Seek −10s", when: "while playing" },
      { glyph: "rb", label: "Seek +10s", when: "while playing" },
      { glyph: "lt-rt", label: "Volume" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  search: {
    id: "search",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "b", label: "Back / Clear" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  followed: {
    id: "followed",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  // 0.11.13 Sports Corner hub (/followed/sports): same mapping as
  // the hub's own setControllerHints call in followed-sports-page.ts
  // — A watches, X opens fixture actions. Kept in step deliberately.
  "followed-sports": {
    id: "followed-sports",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Watch" },
      { glyph: "b", label: "Back" },
      { glyph: "x", label: "Actions" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  // 0.10.0 (W5): Library lists (Favourites / Watch Later) had no
  // config and fell back to the generic legend (no Search row). They
  // are plain card lists like Followed — same audited mapping: Y is
  // the global gamepad.ts goSearch binding, Menu opens Settings.
  favorites: {
    id: "favorites",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  watchlist: {
    id: "watchlist",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      { glyph: "menu", label: "Settings" },
      RETURN_HOME_HINT,
    ],
  },
  settings: {
    id: "settings",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select" },
      { glyph: "y", label: "Search" },
      RETURN_HOME_HINT,
    ],
  },
} as const;

export type LivetvMode = "landing" | "browser" | "playback" | "guide";

export interface HintsForViewOptions {
  /** Live TV mode (html[data-livetv-mode]); only read for view "livetv". */
  livetvMode?: string | null;
  /** Live TV guide sub-mode (html[data-livetv-guide-mode]); only read for the guide. */
  guideMode?: string | null;
  /** A text field currently owns the controller (gamepad.ts editing branch). */
  editing?: boolean;
  /** Focus is on an on-screen keyboard key ([data-osk]). */
  osk?: boolean;
}

/**
 * Config for a Couch view id (the `view` prop CouchLayout passes,
 * rendered as main[data-couch-view]). Live TV resolves through its
 * mode; unknown views fall back to the generic global-only config
 * rather than guessing. Pure and DOM-free, so tests assert the
 * audited table directly.
 */
export function hintsForView(
  view: string | null | undefined,
  opts: HintsForViewOptions = {},
): HintConfig {
  if (opts.editing) return EDITING_HINTS;
  if (opts.osk) return hintsForOsk(view);
  const id = (view ?? "").trim();
  if (id === "livetv") {
    const mode = (opts.livetvMode ?? "landing").trim();
    if (mode === "playback") return HINT_CONFIGS["livetv-playback"];
    if (mode === "browser") return HINT_CONFIGS["livetv-browser"];
    if (mode === "guide") {
      const guideMode = (opts.guideMode ?? "").trim();
      if (guideMode === "now") return HINT_CONFIGS["livetv-guide-now"];
      if (guideMode === "tonight") return HINT_CONFIGS["livetv-guide-tonight"];
      if (guideMode === "channel") return HINT_CONFIGS["livetv-guide-channel"];
      if (guideMode === "grid") return HINT_CONFIGS["livetv-guide-grid"];
      return HINT_CONFIGS["livetv-guide"];
    }
    return HINT_CONFIGS["livetv-landing"];
  }
  return HINT_CONFIGS[id] ?? GENERIC_HINTS;
}

/** Glyphs a config uses, in order — for tests and the renderer. */
export function glyphsOf(config: HintConfig): HintGlyph[] {
  return config.items.map((item) => item.glyph);
}

// ── Controller hints override (Controller Experience 2.0, §42) ───────
// Single source of truth, enforced at runtime: the shared legend
// (TvButtonHints.astro) renders getControllerHints() when an owner
// has set one, else the view-derived hintsForView() config. Owners —
// drawers, overlays, playback modes, the keyboard — route ALL hint
// updates through setControllerHints; no inline hint bars, no second
// legend component, no duplicate legends on one screen.
//
// Rules the owner must honour (the API cannot check them):
//   - hints reflect the actual current input owner; never hint an
//     unimplemented action, and never hint page actions behind an
//     active modal — set the modal's own hints, or clear (null) and
//     let the view config + modal-hide rule apply;
//   - update on mode / playback / cursor change, and clear (null)
//     when the surface closes, so a stale legend never outlives it;
//   - restrained design: only buttons that do something right now.

/** Window event fired whenever the override changes (renderers re-render on it). */
export const CONTROLLER_HINTS_CHANGE_EVENT = "couchhints:change";

let controllerHintsOverride: HintConfig | null = null;

/** Claim the legend with this config, or pass null to release it back to the view-derived config. */
export function setControllerHints(config: HintConfig | null): void {
  controllerHintsOverride = config;
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(CONTROLLER_HINTS_CHANGE_EVENT));
    } catch {
      // No window / dispatch unavailable: the stored value still wins on the next render.
    }
  }
}

/** The currently claimed legend config, or null when no owner has claimed it. */
export function getControllerHints(): HintConfig | null {
  return controllerHintsOverride;
}

/** True when the config hints an action for the given glyph. */
export function configHasGlyph(config: HintConfig, glyph: HintGlyph): boolean {
  return config.items.some((item) => item.glyph === glyph);
}

// ── Glyph markup ──────────────────────────────────────────────────
// One implementation, shared by the Astro server render and the
// client-side re-render in TvButtonHints.astro (import glyphHtml
// there; never hand-write glyph spans elsewhere).

const FACE_GLYPH: Partial<Record<HintGlyph, string>> = {
  a: `<span class="rs-hint-glyph rs-hint-glyph--a" aria-hidden="true">A</span>`,
  b: `<span class="rs-hint-glyph rs-hint-glyph--b" aria-hidden="true">B</span>`,
  x: `<span class="rs-hint-glyph rs-hint-glyph--x" aria-hidden="true">X</span>`,
  y: `<span class="rs-hint-glyph rs-hint-glyph--y" aria-hidden="true">Y</span>`,
  lb: `<span class="rs-hint-glyph rs-hint-glyph--shoulder" aria-hidden="true">LB</span>`,
  rb: `<span class="rs-hint-glyph rs-hint-glyph--shoulder" aria-hidden="true">RB</span>`,
  menu: `<span class="rs-hint-glyph rs-hint-glyph--shoulder" aria-hidden="true">Menu</span>`,
  "dpad-v": `<span class="rs-hint-glyph rs-hint-glyph--shoulder" aria-hidden="true">↑↓</span>`,
  "dpad-h": `<span class="rs-hint-glyph rs-hint-glyph--shoulder" aria-hidden="true">←→</span>`,
  dpad: `<span class="rs-hint-glyph rs-hint-glyph--dpad" aria-hidden="true"></span>`,
};

const SHOULDER = `<span class="rs-hint-glyph rs-hint-glyph--shoulder" aria-hidden="true">`;

/** HTML for one glyph (face button, shoulder, D-pad, or combo). */
export function glyphHtml(glyph: HintGlyph): string {
  if (glyph === "lt-rt") {
    return `<span class="rs-hint-glyphs" aria-hidden="true">${SHOULDER}LT</span>${SHOULDER}RT</span></span>`;
  }
  if (glyph === "view-menu") {
    return `<span class="rs-hint-glyphs" aria-hidden="true">${SHOULDER}View</span><span class="rs-hint-plus">+</span>${SHOULDER}Menu</span></span>`;
  }
  return FACE_GLYPH[glyph] ?? "";
}

/** HTML for one legend item (glyph + label + optional qualifier). */
export function hintItemHtml(item: HintItem): string {
  const when = item.when
    ? ` <span class="rs-hint__when">${item.when}</span>`
    : "";
  return `<li class="rs-hint">${glyphHtml(item.glyph)}<span class="rs-hint__label">${item.label}</span>${when}</li>`;
}
