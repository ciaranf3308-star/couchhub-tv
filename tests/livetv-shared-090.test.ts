// W5 (0.9.0) — shared Live TV spine contracts: the shell mounts,
// the redirect, the shared row components, and the gamepad back
// dispatch. Astro pages/components are not vitest-renderable in
// this repo (node env), so these tests pin the contract in the
// source the way couch-button-hints.test.ts already does for
// component wiring — the behavioural halves (state transitions,
// key tables, back dispatch, ?mode= mapping) are covered by the
// pure-module tests in livetv-state / livetv-controller.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("shell — livetv.astro mounts all four modes", () => {
  const shell = read("src/pages/livetv.astro");

  it("has exactly the four 0.9.0 mounts, no legacy home mount", () => {
    for (const id of [
      "livetv-mode-landing",
      "livetv-mode-browser",
      "livetv-mode-playback",
      "livetv-mode-guide",
    ]) {
      expect(shell).toContain(`id="${id}"`);
    }
    expect(shell).not.toContain('id="livetv-mode-home"');
  });

  it("mounts TvChannelBrowser in the browser mount as the screen (browser id + screenMode)", () => {
    // INTEGRATION: W5 wired browserId="browser-mode"; the component
    // contract (TvChannelBrowser.astro) names the screen instance
    // browserId "browser", and the directive pins screenMode on.
    expect(shell).toContain('<TvChannelBrowser browserId="browser" screenMode />');
    expect(shell).not.toContain('browser-mode');
  });

  it("mounts TvLiveLanding in the landing mount; the 0.7.0 Home interior is gone", () => {
    expect(shell).toContain("<TvLiveLanding />");
    for (const retired of [
      'id="livetv-resume"',
      'data-livetv-rail=',
      'id="livetv-collections"',
      'id="livetv-browser-section"',
      'data-livetv-browser-toggle',
    ]) {
      expect(shell).not.toContain(retired);
    }
  });

  it("setMode accepts the legacy \"home\" alias and sets html[data-livetv-mode]", () => {
    expect(shell).toContain('if (mode === "home") mode = "landing";');
    expect(shell).toContain("document.documentElement.dataset.livetvMode = mode;");
  });

  it("mirrors the mode detail onto the browser mount as data attributes", () => {
    for (const attr of [
      "dataset.initialCategory",
      "dataset.browserFilterKind",
      "dataset.browserFilterValue",
      "dataset.openSearch",
    ]) {
      expect(shell).toContain(attr);
    }
  });

  it("mirrors the guide sub-mode to html[data-livetv-guide-mode]", () => {
    expect(shell).toContain("document.documentElement.dataset.livetvGuideMode");
  });

  it("initial mode comes from parseLivetvModeParam (?mode= mapping)", () => {
    expect(shell).toContain("parseLivetvModeParam(initialParams.get(\"mode\"))");
    expect(shell).toContain(
      "import { restoreLivetvState, parseLivetvModeParam }",
    );
  });

  it("keeps the hidden legacy-engine DOM untouched", () => {
    for (const id of ["list", "spacer", "viewport", "list-status", "search"]) {
      expect(shell).toContain(`id="${id}"`);
    }
    expect(shell).toContain('class="rs-livetv-engine"');
  });

  it("never re-initialises the player on a mode switch (visibility only)", () => {
    expect(shell).toContain('mount.toggleAttribute("hidden", key !== mode);');
  });
});

describe("redirect — epg.astro still sends /epg to /livetv?mode=guide", () => {
  const epg = read("src/pages/epg.astro");
  it("redirects via meta refresh and location.replace", () => {
    expect(epg).toContain("url=/livetv?mode=guide");
    expect(epg).toContain('window.location.replace("/livetv?mode=guide")');
  });
});

// INTEGRATION (0.9.0): W3 and W5 both built TvChannelRow /
// TvProgrammeRow. W3's versions won the reconciliation — they are
// mockup-matched (soft tiles, not flat divider lists) and
// render-verified — so the contract below is W3's: flat scalar
// props + [data-row-*] / [data-programme-*] paint hooks, rows as
// <button>s. W5's object-prop contract (channel / nowProgramme /
// variant + catch-up gating inside the component) is retired; Guide
// catch-up badges live in W4's inline row builder instead.
describe("shared components — TvChannelRow / TvProgrammeRow", () => {
  it("TvChannelRow takes the W3 contract props and paint hooks", () => {
    const src = read("src/components/couch/TvChannelRow.astro");
    expect(src).toContain("nowTitle?");
    expect(src).toContain("nextTitle?");
    expect(src).toContain("highlighted?: boolean");
    expect(src).toContain("favourite?: boolean");
    expect(src).toContain("data-row-num");
    expect(src).toContain("data-row-name");
    expect(src).toContain("data-row-now");
    expect(src).toContain("data-row-progress");
    expect(src).toContain("rs-channel-row--highlighted");
  });

  it("TvProgrammeRow takes the W3 contract props and paint hooks", () => {
    const src = read("src/components/couch/TvProgrammeRow.astro");
    expect(src).toContain("showChannel?: boolean");
    expect(src).toContain("nowTitle?");
    expect(src).toContain("nowStartMs?");
    expect(src).toContain("nextTitle?");
    expect(src).toContain("data-programme-now-title");
    expect(src).toContain("data-programme-now-time");
    expect(src).toContain("data-programme-progress");
    expect(src).toContain("data-programme-next-title");
  });

  it("rows are soft tiles with gaps, never flat divider lists", () => {
    for (const file of [
      "src/components/couch/TvChannelRow.astro",
      "src/components/couch/TvProgrammeRow.astro",
    ]) {
      const src = read(file);
      expect(src).not.toContain("border-bottom: 1px solid var(--rs-line-soft)");
    }
  });
});

describe("gamepad.ts — Live TV back dispatch + global return-home untouched", () => {
  const gamepad = read("src/scripts/lib/gamepad.ts");

  it("dispatches livetv:back (via dispatchLivetvBack) for B in a Live TV context", () => {
    expect(gamepad).toContain("dispatchLivetvBack(window, liveContext)");
    expect(gamepad).toContain("const liveContext = livetvContext();");
  });

  it("reads the context from html[data-livetv-mode] with the home→landing alias", () => {
    expect(gamepad).toContain('if (mode === "landing" || mode === "home") return "landing";');
  });

  it("plumbs LT/RT (6/7) to page nav in the browser, volume elsewhere", () => {
    expect(gamepad).toContain('if (livetvBrowserActive()) dispatchKey("PageUp");');
    expect(gamepad).toContain('if (livetvBrowserActive()) dispatchKey("PageDown");');
  });

  it("View+Menu 2s return-home stays global and is never intercepted", () => {
    expect(gamepad).toContain("couchhubtv:return-home");
    expect(gamepad).toContain("RETURN_HOME_HOLD_MS = 2000");
    // No Live TV branch may claim View: the resolver test pins
    // that, and the hold block runs before any context branch.
    expect(gamepad.indexOf("couchhubtv:return-home")).toBeLessThan(
      gamepad.indexOf("justPressed(BTN_B)"),
    );
  });
});

describe("shared CSS — Live TV 0.9.0 section", () => {
  it("couch.css carries the marked shared section with the mount guard", () => {
    const css = read("src/styles/couch.css");
    expect(css).toContain("/* Live TV 0.9.0 — Shared (W5)");
    expect(css).toContain("#livetv-mode-browser[hidden]");
    expect(css).toContain(".rs-tv-row-list");
  });
});
