// 0.11.14 (W3, §8) — hints transition pins: the Live TV legend
// follows Cursor Mode like the shared legend does, exactly one hint
// bar renders per page, and no config names a dead X/Y action.
// Behavioural coverage of the .astro renderers lives on Windows
// hardware; these pins guard the wiring so a refactor cannot silently
// drop a transition (the repo's established source-pin convention).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  HINT_CONFIGS,
  configHasGlyph,
} from "@/scripts/lib/couch-button-hints";
import { KEYBOARD_OPEN_HINTS } from "@/scripts/lib/couch-keyboard";
import { hintsForLivetvLayer } from "@/scripts/lib/livetv-hints";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("Live TV legend follows Cursor Mode (§8)", () => {
  const livetvHints = read("src/components/couch/TvLivetvHints.astro");

  it("renders the cursor hint set while Cursor Mode is active", () => {
    expect(livetvHints).toContain("CURSOR_MODE_HINTS");
    expect(livetvHints).toContain('dataset.cursorMode === "active"');
    expect(livetvHints).toContain("cursorActive");
  });

  it("re-renders when the cursor-mode signal changes", () => {
    expect(livetvHints).toContain('"data-cursor-mode"');
  });

  it("keeps the cursor legend visible (no playback-overlay hide)", () => {
    expect(livetvHints).toContain("!cursorActive");
  });
});

describe("exactly one hint bar per page (§8)", () => {
  it("only the Live TV page mounts TvLivetvHints", () => {
    const mounters: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(rel);
        } else if (/\.(astro|svelte)$/.test(entry.name)) {
          const content = read(rel);
          if (
            content.includes("import TvLivetvHints") ||
            content.includes("<TvLivetvHints")
          ) {
            mounters.push(rel);
          }
        }
      }
    };
    walk("src/pages");
    walk("src/layouts");
    expect(mounters).toEqual(["src/pages/livetv.astro"]);
  });

  it("the Live TV page hides the shared legend", () => {
    expect(read("src/pages/livetv.astro")).toContain("hideButtonHints");
    expect(read("src/layouts/CouchLayout.astro")).toContain(
      "{!hideButtonHints && <TvButtonHints",
    );
  });
});

describe("no dead X/Y actions in the configs (§8)", () => {
  it("Discover / Browse / Movies / Series / Search / Settings hint no X", () => {
    for (const id of ["discover", "browse", "movies", "series", "search", "settings"]) {
      expect(configHasGlyph(HINT_CONFIGS[id], "x")).toBe(false);
    }
  });

  it("no Guide config hints X (deliberately swallowed)", () => {
    for (const id of [
      "livetv-guide",
      "livetv-guide-now",
      "livetv-guide-tonight",
      "livetv-guide-channel",
      "livetv-guide-grid",
    ]) {
      expect(configHasGlyph(HINT_CONFIGS[id], "x")).toBe(false);
    }
    expect(
      configHasGlyph(hintsForLivetvLayer("guide", { guideMode: "grid" }), "x"),
    ).toBe(false);
  });

  it("Live TV playback hints no LB/RB seek (live streams have no finite duration)", () => {
    expect(configHasGlyph(HINT_CONFIGS["livetv-playback"], "lb")).toBe(false);
    expect(configHasGlyph(HINT_CONFIGS["livetv-playback"], "rb")).toBe(false);
  });

  it("the keyboard-open legend hints no X (no clear shortcut while typing)", () => {
    expect(configHasGlyph(KEYBOARD_OPEN_HINTS, "x")).toBe(false);
    expect(configHasGlyph(KEYBOARD_OPEN_HINTS, "y")).toBe(false);
  });

  it("Search hints no Y (already on Search)", () => {
    expect(configHasGlyph(HINT_CONFIGS.search, "y")).toBe(false);
  });
});

describe("Guide-mode hint transitions (§8)", () => {
  it("the Guide mirrors its sub-mode for the legend", () => {
    expect(read("src/components/couch/TvGuideView.astro")).toContain(
      "dataset.livetvGuideMode = next",
    );
  });

  it("By Channel hints day nav, grid hints time nav", () => {
    const channel = hintsForLivetvLayer("guide", { guideMode: "channel" });
    const grid = hintsForLivetvLayer("guide", { guideMode: "grid" });
    expect(channel.items.map((item) => item.label)).toContain("Previous day");
    expect(grid.items.map((item) => item.label)).toContain("Earlier in time");
  });
});

describe("Discover diagnostics hints release (§7.3/§8)", () => {
  const discover = read("src/components/DiscoverView.svelte");

  it("closing diagnostics releases the override on every path", () => {
    expect(discover).toContain("function closeDiagnostics");
    expect(discover).toContain("setControllerHints(null)");
    // Toggle, Back step, New Search, root reset, Clear and unmount
    // all funnel through the one close helper.
    expect(discover.match(/closeDiagnostics\(/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("the Back-step close returns focus to the diagnostics toggle", () => {
    expect(discover).toContain("closeDiagnostics(true)");
    expect(discover).toContain("[data-ai-diagnostics] .rs-discover-diag__toggle");
  });
});
