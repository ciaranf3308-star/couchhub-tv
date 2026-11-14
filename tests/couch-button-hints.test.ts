// W6 — Xbox button hints: the legend configs match the audited
// controller mappings, and no screen hints an action its handler
// does not implement.
//
// The audit (2026-11-10, gamepad.ts + per-screen handlers) found:
// X = Details works ONLY where the focused card link carries
// ?autoplay AND no page handler consumes "x" (0.11.14: HomeView's
// onCardKey consumes it for the card menu, so Home hints Actions);
// B/Escape has no back navigation on the
// browse screens; Live TV Home Y = Search and Menu = Settings at
// runtime (livetv-keys.ts's "home" rows claim Guide/Options but no
// production handler consumes them); X is deliberately swallowed in
// the Guide; LB/RB seek needs a video with a finite duration (VOD
// only — live streams are infinite, so no seek on Live TV).
// These tests pin that table: a config change that re-adds a dead
// button fails here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  HINT_CONFIGS,
  EDITING_HINTS,
  GENERIC_HINTS,
  RETURN_HOME_HINT,
  hintsForView,
  glyphsOf,
  configHasGlyph,
  glyphHtml,
  hintItemHtml,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const labelsOf = (config: HintConfig): string[] =>
  config.items.map((item) => item.label);

/** Every shipped config must carry the global return-home combo. */
describe("return home is global", () => {
  it("every config ends with View+Menu Return home", () => {
    for (const config of Object.values(HINT_CONFIGS)) {
      expect(configHasGlyph(config, "view-menu")).toBe(true);
      expect(config.items[config.items.length - 1]).toEqual(RETURN_HOME_HINT);
      expect(labelsOf(config)).toContain("Return home");
    }
    expect(configHasGlyph(EDITING_HINTS, "view-menu")).toBe(true);
    expect(configHasGlyph(GENERIC_HINTS, "view-menu")).toBe(true);
  });
});

describe("Home — X opens the card context menu (HomeView onCardKey consumes it)", () => {
  it("Move / Play-Select / Actions / Search / Settings / Home", () => {
    const config = HINT_CONFIGS.home;
    expect(glyphsOf(config)).toEqual(["dpad", "a", "x", "y", "menu", "view-menu"]);
    expect(labelsOf(config)).toEqual([
      "Move",
      "Play / Select",
      "Actions",
      "Search",
      "Settings",
      "Return home",
    ]);
  });

  it("the static config matches HomeView's live override label", () => {
    // HomeView claims the legend on mount; a static config that said
    // "Details" would flash a dead action before the claim lands.
    expect(read("src/components/HomeView.svelte")).toContain('{ glyph: "x", label: "Actions" }');
  });

  it("no B hint — Escape has no back handler on Home", () => {
    expect(configHasGlyph(HINT_CONFIGS.home, "b")).toBe(false);
  });
});

describe("Live TV landing — 0.9.0: B backs via livetv:back, X is contextual, Y opens the Guide", () => {
  it("Move / Watch / Back / Contextual / Guide / Options / Home", () => {
    const config = HINT_CONFIGS["livetv-landing"];
    expect(glyphsOf(config)).toEqual([
      "dpad",
      "a",
      "b",
      "x",
      "y",
      "menu",
      "view-menu",
    ]);
    expect(labelsOf(config)).toEqual([
      "Move",
      "Watch",
      "Back",
      "Contextual action",
      "Open Guide",
      "Options",
      "Return home",
    ]);
    expect(configHasGlyph(config, "lb")).toBe(false);
    expect(configHasGlyph(config, "rb")).toBe(false);
  });

  it("the legacy \"livetv-home\" key is the same landing config", () => {
    expect(HINT_CONFIGS["livetv-home"].id).toBe("livetv-landing");
    expect(glyphsOf(HINT_CONFIGS["livetv-home"])).toEqual(
      glyphsOf(HINT_CONFIGS["livetv-landing"]),
    );
  });
});

describe("Live TV browser — 0.9.0: A Watch, LB/RB categories, LT/RT pages, X favourite, Y search", () => {
  it("Move / Watch / Back / categories / pages / Favourite / Search / Options / Home", () => {
    const config = HINT_CONFIGS["livetv-browser"];
    expect(glyphsOf(config)).toEqual([
      "dpad",
      "a",
      "b",
      "lb",
      "rb",
      "lt-rt",
      "x",
      "y",
      "menu",
      "view-menu",
    ]);
    expect(labelsOf(config)).toEqual([
      "Move",
      "Watch",
      "Back",
      "Previous category",
      "Next category",
      "Previous / Next page",
      "Favourite",
      "Search",
      "Options",
      "Return home",
    ]);
  });
});

describe("Guide sub-modes — 0.9.0: day nav in By Channel, time nav in grid", () => {
  it("By Channel shows Previous/Next day; grid shows Earlier/Later in time", () => {
    expect(configHasGlyph(HINT_CONFIGS["livetv-guide-channel"], "lb")).toBe(true);
    expect(labelsOf(HINT_CONFIGS["livetv-guide-channel"])).toContain("Previous day");
    expect(labelsOf(HINT_CONFIGS["livetv-guide-channel"])).toContain("Next day");
    expect(labelsOf(HINT_CONFIGS["livetv-guide-grid"])).toContain("Earlier in time");
    expect(labelsOf(HINT_CONFIGS["livetv-guide-grid"])).toContain("Later in time");
  });

  it("On Now / Tonight show no LB/RB rows (no day or time stepping there)", () => {
    expect(configHasGlyph(HINT_CONFIGS["livetv-guide-now"], "lb")).toBe(false);
    expect(configHasGlyph(HINT_CONFIGS["livetv-guide-now"], "rb")).toBe(false);
    expect(configHasGlyph(HINT_CONFIGS["livetv-guide-tonight"], "lb")).toBe(false);
    expect(configHasGlyph(HINT_CONFIGS["livetv-guide-tonight"], "rb")).toBe(false);
  });

  it("no sub-mode config hints X — it stays swallowed in the Guide", () => {
    for (const id of [
      "livetv-guide",
      "livetv-guide-now",
      "livetv-guide-tonight",
      "livetv-guide-channel",
      "livetv-guide-grid",
    ] as const) {
      expect(configHasGlyph(HINT_CONFIGS[id], "x")).toBe(false);
    }
  });
});

describe("Live TV playback — OSD / Quick Surf mapping", () => {
  it("surf directions, Show controls, Close, Guide, Channels, Volume, Options", () => {
    const config = HINT_CONFIGS["livetv-playback"];
    expect(glyphsOf(config)).toEqual([
      "dpad-v",
      "dpad-h",
      "a",
      "b",
      "x",
      "y",
      "lt-rt",
      "menu",
      "view-menu",
    ]);
    expect(labelsOf(config)).toEqual([
      "Quick Surf",
      "Programme info",
      "Show controls",
      "Close, then Live Home",
      "Guide",
      "Channels",
      "Volume",
      "Options",
      "Return home",
    ]);
  });

  it("no LB/RB seek — live streams have no finite duration to seek", () => {
    expect(configHasGlyph(HINT_CONFIGS["livetv-playback"], "lb")).toBe(false);
    expect(configHasGlyph(HINT_CONFIGS["livetv-playback"], "rb")).toBe(false);
  });
});

describe("Guide — X is swallowed by design, LB/RB shift time", () => {
  it("Move / Select / Leave / Earlier / Later / actions / Home", () => {
    const config = HINT_CONFIGS["livetv-guide"];
    expect(glyphsOf(config)).toEqual([
      "dpad",
      "a",
      "b",
      "lb",
      "rb",
      "y",
      "menu",
      "view-menu",
    ]);
    expect(labelsOf(config)).toEqual([
      "Move",
      "Select programme",
      "Leave Guide",
      "Earlier in time",
      "Later in time",
      "Guide actions",
      "Guide actions",
      "Return home",
    ]);
  });

  it("no X hint — gamepad.ts deliberately swallows X in the Guide", () => {
    expect(configHasGlyph(HINT_CONFIGS["livetv-guide"], "x")).toBe(false);
  });
});

describe("Browse family — X is dead (links carry no ?autoplay)", () => {
  it.each(["browse", "discover", "movies", "series", "followed"] as const)(
    "%s: Move / Select / Search / Settings / Home, no X, no B",
    (id) => {
      const config = HINT_CONFIGS[id];
      expect(glyphsOf(config)).toEqual(["dpad", "a", "y", "menu", "view-menu"]);
      expect(configHasGlyph(config, "x")).toBe(false);
      expect(configHasGlyph(config, "b")).toBe(false);
      expect(configHasGlyph(config, "lb")).toBe(false);
      expect(configHasGlyph(config, "rb")).toBe(false);
    },
  );
});

describe("Detail — playing-only rows are qualified", () => {
  it.each(["movies-detail", "series-detail"] as const)(
    "%s: browsing actions + while-playing transport",
    (id) => {
      const config = HINT_CONFIGS[id];
      const byGlyph = new Map(config.items.map((i) => [i.glyph, i]));
      expect(byGlyph.get("a")?.label).toBe("Play / Select");
      // B exits the player only while playing (couch-detail.ts).
      expect(byGlyph.get("b")).toEqual({
        glyph: "b",
        label: "Exit player",
        when: "while playing",
      });
      expect(byGlyph.get("x")).toEqual({
        glyph: "x",
        label: "Play / Pause",
        when: "while playing",
      });
      // Y is Search while browsing, fullscreen while playing.
      expect(byGlyph.get("y")).toEqual({
        glyph: "y",
        label: "Search",
        when: "when browsing",
      });
      expect(byGlyph.get("lb")?.when).toBe("while playing");
      expect(byGlyph.get("rb")?.when).toBe("while playing");
      expect(byGlyph.get("lb")?.label).toBe("Seek −10s");
      expect(byGlyph.get("rb")?.label).toBe("Seek +10s");
      expect(byGlyph.get("lt-rt")?.label).toBe("Volume");
      expect(byGlyph.get("menu")?.label).toBe("Settings");
    },
  );
});

describe("Search — B backs out, Y already here, X dead", () => {
  it("Move / Select / Back-Clear / Settings / Home", () => {
    const config = HINT_CONFIGS.search;
    expect(glyphsOf(config)).toEqual(["dpad", "a", "b", "menu", "view-menu"]);
    expect(labelsOf(config)).toContain("Back / Clear");
    expect(configHasGlyph(config, "x")).toBe(false);
    expect(configHasGlyph(config, "y")).toBe(false);
  });
});

describe("Settings — no B, no X, no Menu (already here)", () => {
  it("Move / Select / Search / Home only", () => {
    const config = HINT_CONFIGS.settings;
    expect(glyphsOf(config)).toEqual(["dpad", "a", "y", "view-menu"]);
    expect(configHasGlyph(config, "b")).toBe(false);
    expect(configHasGlyph(config, "x")).toBe(false);
    expect(configHasGlyph(config, "menu")).toBe(false);
  });
});

describe("editing + fallback", () => {
  it("text-field focus: only B + View+Menu (gamepad.ts editing branch)", () => {
    expect(glyphsOf(EDITING_HINTS)).toEqual(["b", "view-menu"]);
    expect(labelsOf(EDITING_HINTS)).toEqual(["Back", "Return home"]);
  });

  it("on-screen keyboard focus: Type / Close keyboard, no X (B never deletes)", () => {
    // A types the focused key, B closes the keyboard (B never
    // deletes — the Backspace key deletes, the Clear key clears;
    // the old "Delete / Clear" legend lied). Y goes to Search
    // except on Search itself.
    const discover = hintsForView("discover", { osk: true });
    expect(discover.id).toBe("osk");
    expect(glyphsOf(discover)).toEqual(["dpad", "a", "b", "y", "menu", "view-menu"]);
    expect(labelsOf(discover)).toEqual([
      "Move",
      "Type",
      "Close keyboard",
      "Search",
      "Settings",
      "Return home",
    ]);
    const search = hintsForView("search", { osk: true });
    expect(glyphsOf(search)).toEqual(["dpad", "a", "b", "menu", "view-menu"]);
    expect(configHasGlyph(search, "x")).toBe(false);
    expect(configHasGlyph(discover, "x")).toBe(false);
  });

  it("editing wins over OSK focus (an input owns the controller)", () => {
    expect(hintsForView("search", { editing: true, osk: true }).id).toBe("editing");
  });

  it("no X-clear poll in the OSK (0.11.10 §28 removed it)", () => {
    // The W2 poll is gone: it read navigator.getGamepads()[0] only
    // and was invisible to the native XInput path. The Clear key is
    // the clear path. The `.search-view` scope must never come back
    // in any form (it matched no element anywhere).
    const osk = read("src/components/OnScreenKeyboard.svelte");
    expect(osk).not.toContain("getGamepads");
    expect(osk).not.toContain("pollGamepadX");
    expect(osk).not.toContain('".search-view"');
    expect(read("src/components/SearchView.svelte")).not.toContain("search-view");
    const hits = read("src/components/DiscoverView.svelte").match(/search-view/g) ?? [];
    expect(hits.length).toBe(0);
  });

  it("unknown view: global buttons only, never a guessed mapping", () => {
    expect(glyphsOf(GENERIC_HINTS)).toEqual(["dpad", "a", "menu", "view-menu"]);
    expect(configHasGlyph(GENERIC_HINTS, "b")).toBe(false);
    expect(configHasGlyph(GENERIC_HINTS, "x")).toBe(false);
    expect(configHasGlyph(GENERIC_HINTS, "y")).toBe(false);
  });
});

describe("hintsForView resolver", () => {
  it("Live TV resolves through its mode", () => {
    expect(hintsForView("livetv").id).toBe("livetv-landing");
    expect(hintsForView("livetv", { livetvMode: "landing" }).id).toBe("livetv-landing");
    expect(hintsForView("livetv", { livetvMode: "home" }).id).toBe("livetv-landing");
    expect(hintsForView("livetv", { livetvMode: "browser" }).id).toBe("livetv-browser");
    expect(hintsForView("livetv", { livetvMode: "playback" }).id).toBe("livetv-playback");
    expect(hintsForView("livetv", { livetvMode: "guide" }).id).toBe("livetv-guide");
    expect(hintsForView("livetv", { livetvMode: "bogus" }).id).toBe("livetv-landing");
  });

  it("Guide resolves through its sub-mode", () => {
    expect(
      hintsForView("livetv", { livetvMode: "guide", guideMode: "now" }).id,
    ).toBe("livetv-guide-now");
    expect(
      hintsForView("livetv", { livetvMode: "guide", guideMode: "tonight" }).id,
    ).toBe("livetv-guide-tonight");
    expect(
      hintsForView("livetv", { livetvMode: "guide", guideMode: "channel" }).id,
    ).toBe("livetv-guide-channel");
    expect(
      hintsForView("livetv", { livetvMode: "guide", guideMode: "grid" }).id,
    ).toBe("livetv-guide-grid");
    expect(
      hintsForView("livetv", { livetvMode: "guide", guideMode: "bogus" }).id,
    ).toBe("livetv-guide");
  });

  it("plain views resolve directly; unknown views fall back to generic", () => {
    expect(hintsForView("home").id).toBe("home");
    expect(hintsForView("browse").id).toBe("browse");
    expect(hintsForView("discover").id).toBe("discover");
    expect(hintsForView("movies-detail").id).toBe("movies-detail");
    expect(hintsForView("series-detail").id).toBe("series-detail");
    expect(hintsForView("search").id).toBe("search");
    expect(hintsForView("followed").id).toBe("followed");
    expect(hintsForView("settings").id).toBe("settings");
    expect(hintsForView("definitely-not-a-view").id).toBe("generic");
    expect(hintsForView(null).id).toBe("generic");
    expect(hintsForView(undefined).id).toBe("generic");
  });

  it("editing wins over every view/mode", () => {
    expect(hintsForView("livetv", { livetvMode: "playback", editing: true }).id).toBe("editing");
    expect(hintsForView("home", { editing: true }).id).toBe("editing");
  });
});

describe("glyph rendering", () => {
  it("face buttons render their letter with the Xbox colour class", () => {
    expect(glyphHtml("a")).toContain("rs-hint-glyph--a");
    expect(glyphHtml("a")).toContain(">A<");
    expect(glyphHtml("b")).toContain("rs-hint-glyph--b");
    expect(glyphHtml("x")).toContain("rs-hint-glyph--x");
    expect(glyphHtml("y")).toContain("rs-hint-glyph--y");
  });

  it("combos render both buttons; D-pad renders its CSS tile", () => {
    expect(glyphHtml("view-menu")).toContain("View");
    expect(glyphHtml("view-menu")).toContain("Menu");
    expect(glyphHtml("lt-rt")).toContain("LT");
    expect(glyphHtml("lt-rt")).toContain("RT");
    expect(glyphHtml("dpad")).toContain("rs-hint-glyph--dpad");
    expect(glyphHtml("dpad-v")).toContain("↑↓");
    expect(glyphHtml("dpad-h")).toContain("←→");
    expect(glyphHtml("lb")).toContain("LB");
    expect(glyphHtml("rb")).toContain("RB");
    expect(glyphHtml("menu")).toContain("Menu");
  });

  it("hint items carry the label and the state qualifier", () => {
    const html = hintItemHtml({ glyph: "b", label: "Exit player", when: "while playing" });
    expect(html).toContain("Exit player");
    expect(html).toContain("while playing");
    expect(html).toContain("rs-hint-glyph--b");
    expect(hintItemHtml({ glyph: "a", label: "Select" })).not.toContain("rs-hint__when");
  });
});

describe("configs grounded in the gamepad layer (source)", () => {
  it("return-home hold is 2 s and owned by gamepad.ts", () => {
    const gamepad = read("src/scripts/lib/gamepad.ts");
    expect(gamepad).toContain("RETURN_HOME_HOLD_MS = 2000");
    expect(gamepad).toContain("couchhubtv:return-home");
  });

  it("X = Details only acts on links carrying ?autoplay", () => {
    const gamepad = read("src/scripts/lib/gamepad.ts");
    expect(gamepad).toContain('url.searchParams.has("autoplay")');
    // And only Home rails attach that param to card links.
    expect(read("src/scripts/lib/home-rails.ts")).toContain("autoplay");
    expect(read("src/scripts/lib/discover.ts")).not.toContain("autoplay=1");
  });

  it("X is deliberately swallowed in the Guide", () => {
    const gamepad = read("src/scripts/lib/gamepad.ts");
    expect(gamepad).toContain("X is unmapped in the Guide");
  });

  it("LB/RB seek is guarded to videos with a finite duration", () => {
    const gamepad = read("src/scripts/lib/gamepad.ts");
    expect(gamepad).toContain("Number.isFinite(video.duration)");
  });

  // 0.11.14 (W1b, §7.3/§7.15): A joins B in a text field — it enters
  // editing through the shared keyboard lifecycle instead of being
  // silently swallowed. Directions and every other button stay with
  // the field.
  it("editing branch leaves only A (enter editing) + B + View+Menu to the controller", () => {
    const gamepad = read("src/scripts/lib/gamepad.ts");
    expect(gamepad).toContain("In a text field the controller only gets A (enter editing,");
    expect(gamepad).toContain("every other button belong to the field");
  });
});

describe("wiring — CouchLayout renders the shared legend", () => {
  it("layout imports TvButtonHints and renders it with the view", () => {
    const layout = read("src/layouts/CouchLayout.astro");
    expect(layout).toContain('import TvButtonHints from "@/components/couch/TvButtonHints.astro"');
    expect(layout).toContain("<TvButtonHints view={view ?? active} />");
  });

  it("component observes Live TV mode, dialogs and playback overlays", () => {
    const component = read("src/components/couch/TvButtonHints.astro");
    expect(component).toContain("data-button-hints");
    expect(component).toContain("data-livetv-mode");
    expect(component).toContain("dialog[open]");
    expect(component).toContain("[data-livetv-osd]");
    expect(component).toContain("[data-livetv-options]");
    expect(component).toContain("[data-livetv-quicksurf]");
    expect(component).toContain("[data-livetv-play-browser]");
    expect(component).toContain("hintsForView");
    // Focus states: text-field editing and on-screen keyboard keys.
    expect(component).toContain('[data-osk]');
    expect(component).toContain("isEditingTarget");
    // The legend never swallows input: it is display-only.
    expect(component).toContain("pointer-events: none");
  });

  it("component does not touch couch.css tokens or TvImage", () => {
    const component = read("src/components/couch/TvButtonHints.astro");
    expect(component).not.toContain("TvImage");
    expect(component).not.toContain("couch.css");
  });
});
