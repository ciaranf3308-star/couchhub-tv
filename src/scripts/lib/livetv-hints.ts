// RedSilk Couch — Live TV 2.0 contextual hints (0.11.7, W4).
//
// Hint configs for the navigation layers livetv-nav.ts defines,
// consumed by the ONE hints component (TvLivetvHints.astro).
// Existing layers (landing / browser / playback / guide) reuse
// the audited configs in couch-button-hints.ts verbatim — those
// rows were audited against the real handlers and are not
// restated here. New layers get configs that name ONLY buttons
// whose behaviour is defined by a contract this release owns:
//
//   drawer / subcategory: the nav contract itself (D-pad moves,
//     A selects, B pops exactly one layer). The drawer's own
//     extra bindings are W2's; until W2's mappings are final
//     this config deliberately claims nothing more — a hint
//     that does not match the real mapping is worse than no
//     hint (see the couch-button-hints.ts audit header).
//   search: the Search overlay's own bindings (D-pad moves, A
//     types/selects, B deletes on the on-screen keyboard and
//     closes elsewhere, X clears the query).
//   sort: the Sort overlay's own bindings (D-pad moves, A
//     selects the order, B closes without changing).
//
// HTML builders here emit `lv2-` classes (not the `rs-hint`
// classes): TvLivetvHints is self-contained and must render
// correctly even where TvButtonHints is not mounted. Glyph
// colours match the Xbox face-button colours TvButtonHints
// uses. Pure and DOM-free, so tests assert the table directly.

import {
  HINT_CONFIGS,
  RETURN_HOME_HINT,
  type HintConfig,
  type HintGlyph,
  type HintItem,
} from "./couch-button-hints.js";
import type { LivetvNavLayerId } from "./livetv-nav.js";
import type { GuideMode } from "./livetv-state.js";

export type { HintConfig, HintGlyph, HintItem };

/** Hint context = the top navigation layer. One id, no other state. */
export type LivetvHintContext = LivetvNavLayerId;

/** Configs for the layers couch-button-hints.ts does not cover yet. */
export const LIVETV_HINT_CONFIGS: Readonly<
  Record<"drawer" | "subcategory" | "search" | "sort", HintConfig>
> = {
  drawer: {
    id: "livetv-drawer",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select category" },
      { glyph: "b", label: "Close drawer" },
      RETURN_HOME_HINT,
    ],
  },
  subcategory: {
    id: "livetv-subcategory",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select subcategory" },
      { glyph: "b", label: "Back" },
      RETURN_HOME_HINT,
    ],
  },
  search: {
    id: "livetv-search",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Type / Select" },
      { glyph: "b", label: "Delete / Close", when: "on keyboard / elsewhere" },
      { glyph: "x", label: "Clear query" },
      RETURN_HOME_HINT,
    ],
  },
  sort: {
    id: "livetv-sort",
    items: [
      { glyph: "dpad", label: "Move" },
      { glyph: "a", label: "Select order" },
      { glyph: "b", label: "Close without changing" },
      RETURN_HOME_HINT,
    ],
  },
} as const;

export interface LivetvHintsOptions {
  /** Guide sub-mode, for the guide layer (day nav vs time nav rows). */
  guideMode?: GuideMode | string | null;
}

/**
 * Hint config for a navigation layer. Landing / browser /
 * playback delegate to the audited couch-button-hints configs;
 * guide delegates to the per-sub-mode configs when a guideMode
 * is given (else the base guide config); drawer / subcategory /
 * search / sort use LIVETV_HINT_CONFIGS. Unknown layers fall
 * back to the browser config — the browser is the surface a
 * Live TV user is most likely looking at, and its rows are all
 * nav-contract-true (move / watch / back). Never throws.
 */
export function hintsForLivetvLayer(
  layer: LivetvNavLayerId | string | null | undefined,
  opts: LivetvHintsOptions = {},
): HintConfig {
  switch (layer) {
    case "landing":
      return HINT_CONFIGS["livetv-landing"];
    case "browser":
      return HINT_CONFIGS["livetv-browser"];
    case "playback":
      return HINT_CONFIGS["livetv-playback"];
    case "guide": {
      const guideMode = (opts.guideMode ?? "").trim();
      if (guideMode === "now") return HINT_CONFIGS["livetv-guide-now"];
      if (guideMode === "tonight") return HINT_CONFIGS["livetv-guide-tonight"];
      if (guideMode === "channel") return HINT_CONFIGS["livetv-guide-channel"];
      if (guideMode === "grid") return HINT_CONFIGS["livetv-guide-grid"];
      return HINT_CONFIGS["livetv-guide"];
    }
    case "drawer":
      return LIVETV_HINT_CONFIGS.drawer;
    case "subcategory":
      return LIVETV_HINT_CONFIGS.subcategory;
    case "search":
      return LIVETV_HINT_CONFIGS.search;
    case "sort":
      return LIVETV_HINT_CONFIGS.sort;
    default:
      return HINT_CONFIGS["livetv-browser"];
  }
}

// ── Glyph + item markup (lv2 classes, self-contained) ───────────
// Mirrors couch-button-hints.ts glyphHtml/hintItemHtml with the
// lv2- prefix so TvLivetvHints never depends on TvButtonHints'
// global stylesheet being present on the page.

const FACE_GLYPH: Partial<Record<HintGlyph, string>> = {
  a: `<span class="lv2-hint-glyph lv2-hint-glyph--a" aria-hidden="true">A</span>`,
  b: `<span class="lv2-hint-glyph lv2-hint-glyph--b" aria-hidden="true">B</span>`,
  x: `<span class="lv2-hint-glyph lv2-hint-glyph--x" aria-hidden="true">X</span>`,
  y: `<span class="lv2-hint-glyph lv2-hint-glyph--y" aria-hidden="true">Y</span>`,
  lb: `<span class="lv2-hint-glyph lv2-hint-glyph--shoulder" aria-hidden="true">LB</span>`,
  rb: `<span class="lv2-hint-glyph lv2-hint-glyph--shoulder" aria-hidden="true">RB</span>`,
  menu: `<span class="lv2-hint-glyph lv2-hint-glyph--shoulder" aria-hidden="true">Menu</span>`,
  "dpad-v": `<span class="lv2-hint-glyph lv2-hint-glyph--shoulder" aria-hidden="true">↑↓</span>`,
  "dpad-h": `<span class="lv2-hint-glyph lv2-hint-glyph--shoulder" aria-hidden="true">←→</span>`,
  dpad: `<span class="lv2-hint-glyph lv2-hint-glyph--dpad" aria-hidden="true"></span>`,
};

const SHOULDER = `<span class="lv2-hint-glyph lv2-hint-glyph--shoulder" aria-hidden="true">`;

/** HTML for one glyph (face button, shoulder, D-pad, or combo). */
export function livetvGlyphHtml(glyph: HintGlyph): string {
  if (glyph === "lt-rt") {
    return `<span class="lv2-hint-glyphs" aria-hidden="true">${SHOULDER}LT</span>${SHOULDER}RT</span></span>`;
  }
  if (glyph === "view-menu") {
    return `<span class="lv2-hint-glyphs" aria-hidden="true">${SHOULDER}View</span><span class="lv2-hint-plus">+</span>${SHOULDER}Menu</span></span>`;
  }
  return FACE_GLYPH[glyph] ?? "";
}

/** HTML for one legend item (glyph + label + optional qualifier). */
export function livetvHintItemHtml(item: HintItem): string {
  const when = item.when
    ? ` <span class="lv2-hint__when">${item.when}</span>`
    : "";
  return `<li class="lv2-hint">${livetvGlyphHtml(item.glyph)}<span class="lv2-hint__label">${item.label}</span>${when}</li>`;
}

/** HTML for a whole config's item list. */
export function livetvHintsListHtml(config: HintConfig): string {
  return config.items.map((item) => livetvHintItemHtml(item)).join("");
}
