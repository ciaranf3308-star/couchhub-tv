/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10) — INTEGRATION. Pins the
// behaviour the integration pass itself owns: helpers relocated
// from the deleted seam shims into their owning modules, the
// verification fixes (Discover Y, Escape single-step, keyboard
// reopen suppression, coordinator mounts, Browse hints deletion),
// and the proof that no shim survives in src/.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { getLogicalView } from "@/scripts/lib/couch-focus";
import {
  navigateBackWithOrigin,
  readRouteOrigin,
  recordOriginFromReferrer,
  recordRouteOrigin,
  setRouteNavigator,
} from "@/scripts/lib/route-origin";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function pageSource(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSrc(full, out);
    else out.push(full);
  }
  return out;
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  setRouteNavigator(null);
});

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  setRouteNavigator(null);
  vi.restoreAllMocks();
});

describe("logical view default", () => {
  it("getLogicalView() is empty string when no owner has named a view", () => {
    // Fresh module state in this file: no setLogicalView has run.
    expect(getLogicalView()).toBe("");
  });
});

describe("recordOriginFromReferrer (relocated to route-origin.ts)", () => {
  function setReferrer(value: string): void {
    Object.defineProperty(document, "referrer", {
      value,
      configurable: true,
    });
  }

  afterEach(() => {
    setReferrer("");
  });

  it("records a same-origin referrer pathname", () => {
    setReferrer(`${window.location.origin}/movies?view=browse`);
    recordOriginFromReferrer("/discover");
    expect(readRouteOrigin()).toEqual({ route: "/movies", label: "" });
  });

  it("skips external, empty and same-page referrers", () => {
    setReferrer("https://evil.example/movies");
    recordOriginFromReferrer("/discover");
    expect(readRouteOrigin()).toBeNull();
    setReferrer("");
    recordOriginFromReferrer("/discover");
    expect(readRouteOrigin()).toBeNull();
    setReferrer(`${window.location.origin}/discover`);
    recordOriginFromReferrer("/discover");
    expect(readRouteOrigin()).toBeNull();
  });

  it("defaults the current path to the location pathname", () => {
    window.history.replaceState(null, "", "/search");
    setReferrer(`${window.location.origin}/`);
    recordOriginFromReferrer();
    expect(readRouteOrigin()).toEqual({ route: "/", label: "" });
  });

  it("a Back navigation consumes the flag so the destination does not re-record", () => {
    const navigated: string[] = [];
    setRouteNavigator((url) => navigated.push(url));
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    navigateBackWithOrigin("/");
    expect(navigated).toEqual(["/movies"]);
    expect(sessionStorage.getItem("nylah:route-back-nav")).toBe("1");
    // The destination page loads with the detail as its referrer;
    // the flag makes recordOriginFromReferrer skip once (no
    // ping-pong), then the flag is gone.
    setReferrer(`${window.location.origin}/movies/detail?id=9`);
    recordOriginFromReferrer("/movies");
    expect(readRouteOrigin()).toBeNull();
    expect(sessionStorage.getItem("nylah:route-back-nav")).toBeNull();
  });

  it("the backLink fallback sets the flag too", () => {
    const link = document.createElement("a");
    link.href = "/movies";
    link.addEventListener("click", (ev) => ev.preventDefault());
    document.body.appendChild(link);
    navigateBackWithOrigin("/movies", { backLink: link });
    expect(sessionStorage.getItem("nylah:route-back-nav")).toBe("1");
  });
});

describe("verification fixes (source wiring)", () => {
  it("Discover Y is wired: the key handler dispatches the focus-search event", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    expect(src).toContain('document.addEventListener("keydown", onDiscoverYKey)');
    expect(src).toContain('window.dispatchEvent(new CustomEvent("couch:discover-focus-search"))');
    expect(src).toContain("couch:discover-focus-search");
  });

  it("SearchView's final Escape branch stops the coordinator re-running the step", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("stopImmediatePropagation()");
    expect(src).toContain("One Back step (§27)");
  });

  it("every layout mounts the Back coordinator", () => {
    for (const layout of [
      "src/layouts/CouchLayout.astro",
      "src/layouts/Layout.astro",
      "src/layouts/TvLayout.astro",
    ]) {
      expect(pageSource(layout)).toContain("mountBackCoordinator");
    }
  });

  it("the Browse-local hints line is deleted; the shared bar owns the legend", () => {
    const src = pageSource("src/scripts/lib/browse-everything.ts");
    expect(src).not.toContain("rs-browse2__hints");
    expect(src).not.toContain("hintsEl");
    expect(src).toContain("setControllerHints(browseHintsForLayer(layer, kind))");
  });

  it("keyboard reopen suppression exists at every focus-open site", () => {
    for (const rel of [
      "src/components/couch/TvGuideView.astro",
      "src/components/couch/TvLivetvSearchOverlay.astro",
      "src/pages/login.astro",
      "src/scripts/settings/settings_search.ts",
    ]) {
      expect(pageSource(rel)).toContain("suppressKeyboardReopen");
    }
    // And the Browse overlay has no focus handler reopening the
    // session at all.
    const browse = pageSource("src/scripts/lib/browse-everything.ts");
    expect(browse).not.toContain('input.addEventListener("focus"');
  });
});

describe("no shim survives", () => {
  it("zero shim markers and zero shim-module imports in src/", () => {
    // The banned marker is built dynamically so this test itself
    // does not put the literal string back into the tree: a
    // tree-wide grep for it must return zero hits.
    const bannedMarker = ["SHIM", "0110"].join("-");
    const offenders: string[] = [];
    for (const file of walkSrc(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (
        text.includes(bannedMarker) ||
        text.includes("controller-0110-seams") ||
        text.includes("controller-seams-0110") ||
        text.includes("livetv-0110-seams")
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
