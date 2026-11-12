/**
 * Live TV 2.0 hints tests (0.11.7, W4): one config per
 * navigation layer, existing layers delegating to the audited
 * couch-button-hints configs, new layers naming only
 * nav-contract-true buttons, every config carrying the global
 * return-home row, and the self-contained lv2 markup builders.
 */
import { describe, it, expect } from "vitest";
import {
  LIVETV_HINT_CONFIGS,
  hintsForLivetvLayer,
  livetvGlyphHtml,
  livetvHintItemHtml,
  livetvHintsListHtml,
} from "@/scripts/lib/livetv-hints";
import { RETURN_HOME_HINT } from "@/scripts/lib/couch-button-hints";

describe("hintsForLivetvLayer", () => {
  it("delegates landing / browser / playback to the audited configs", () => {
    expect(hintsForLivetvLayer("landing").id).toBe("livetv-landing");
    expect(hintsForLivetvLayer("browser").id).toBe("livetv-browser");
    expect(hintsForLivetvLayer("playback").id).toBe("livetv-playback");
  });

  it("picks the guide sub-mode config when a guideMode is given", () => {
    expect(hintsForLivetvLayer("guide").id).toBe("livetv-guide");
    expect(hintsForLivetvLayer("guide", { guideMode: "now" }).id).toBe("livetv-guide-now");
    expect(hintsForLivetvLayer("guide", { guideMode: "tonight" }).id).toBe("livetv-guide-tonight");
    expect(hintsForLivetvLayer("guide", { guideMode: "channel" }).id).toBe("livetv-guide-channel");
    expect(hintsForLivetvLayer("guide", { guideMode: "grid" }).id).toBe("livetv-guide-grid");
    expect(hintsForLivetvLayer("guide", { guideMode: "bogus" }).id).toBe("livetv-guide");
  });

  it("returns the new-layer configs for drawer / subcategory / search / sort", () => {
    expect(hintsForLivetvLayer("drawer")).toBe(LIVETV_HINT_CONFIGS.drawer);
    expect(hintsForLivetvLayer("subcategory")).toBe(LIVETV_HINT_CONFIGS.subcategory);
    expect(hintsForLivetvLayer("search")).toBe(LIVETV_HINT_CONFIGS.search);
    expect(hintsForLivetvLayer("sort")).toBe(LIVETV_HINT_CONFIGS.sort);
  });

  it("falls back to the browser config for unknown layers", () => {
    expect(hintsForLivetvLayer("options").id).toBe("livetv-browser");
    expect(hintsForLivetvLayer(null).id).toBe("livetv-browser");
    expect(hintsForLivetvLayer(undefined).id).toBe("livetv-browser");
    expect(hintsForLivetvLayer("").id).toBe("livetv-browser");
  });
});

describe("new-layer configs name only real bindings", () => {
  it("drawer: move / select category / close drawer", () => {
    const labels = LIVETV_HINT_CONFIGS.drawer.items.map((item) => item.label);
    expect(labels).toContain("Move");
    expect(labels).toContain("Select category");
    expect(labels).toContain("Close drawer");
    expect(LIVETV_HINT_CONFIGS.drawer.items.map((item) => item.glyph)).toEqual([
      "dpad",
      "a",
      "b",
      "view-menu",
    ]);
  });

  it("subcategory: move / select subcategory / back", () => {
    const labels = LIVETV_HINT_CONFIGS.subcategory.items.map((item) => item.label);
    expect(labels).toContain("Select subcategory");
    expect(labels).toContain("Back");
  });

  it("search: type/select, delete/close, clear query", () => {
    const items = LIVETV_HINT_CONFIGS.search.items;
    expect(items.find((item) => item.glyph === "a")?.label).toBe("Type / Select");
    expect(items.find((item) => item.glyph === "b")?.label).toBe("Delete / Close");
    expect(items.find((item) => item.glyph === "x")?.label).toBe("Clear query");
  });

  it("sort: select order, close without changing", () => {
    const items = LIVETV_HINT_CONFIGS.sort.items;
    expect(items.find((item) => item.glyph === "a")?.label).toBe("Select order");
    expect(items.find((item) => item.glyph === "b")?.label).toBe("Close without changing");
    expect(items).toHaveLength(4);
  });

  it("every layer config ends with the global return-home row", () => {
    for (const layer of ["landing", "browser", "drawer", "subcategory", "search", "sort", "guide", "playback"] as const) {
      const config = hintsForLivetvLayer(layer);
      expect(config.items[config.items.length - 1]).toEqual(RETURN_HOME_HINT);
    }
  });
});

describe("lv2 markup builders", () => {
  it("renders glyphs with lv2 classes, never rs-hint classes", () => {
    expect(livetvGlyphHtml("a")).toContain("lv2-hint-glyph--a");
    expect(livetvGlyphHtml("view-menu")).toContain("View");
    expect(livetvGlyphHtml("view-menu")).toContain("Menu");
    expect(livetvGlyphHtml("lt-rt")).toContain("LT");
    expect(livetvGlyphHtml("lt-rt")).toContain("RT");
    expect(livetvGlyphHtml("dpad")).toContain("lv2-hint-glyph--dpad");
    for (const glyph of ["a", "b", "x", "y", "lb", "rb", "menu", "dpad"] as const) {
      expect(livetvGlyphHtml(glyph)).not.toContain("rs-hint");
    }
  });

  it("renders items with label + qualifier", () => {
    const html = livetvHintItemHtml({ glyph: "b", label: "Delete / Close", when: "on keyboard / elsewhere" });
    expect(html).toContain("lv2-hint");
    expect(html).toContain("Delete / Close");
    expect(html).toContain("on keyboard / elsewhere");
  });

  it("renders a whole config list", () => {
    const html = livetvHintsListHtml(hintsForLivetvLayer("sort"));
    expect(html).toContain("Select order");
    expect(html).toContain("Close without changing");
    expect(html).toContain("Return home");
  });
});
