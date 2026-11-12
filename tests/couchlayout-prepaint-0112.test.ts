/**
 * CouchLayout pre-paint theme pin + Settings display diagnostics (0.11.2 W2).
 *
 * The 0.11.1 purple-wash report could not be reproduced from the bundle:
 * the built Settings page renders burgundy headless under every
 * combination tried (default, OS light scheme, couch.css blocked, forced
 * light scheme + violet accent), and the :root[data-couch] leak guard
 * pins every --color-* token to burgundy even with a light scheme and a
 * violet accent forced. Two gaps were still real and are pinned here:
 *
 * 1. CouchLayout — unlike Layout/TvLayout — never ran a pre-paint theme
 *    script, so Couch routes relied solely on the couch.css rule. The pin
 *    is hardening (it also covers the stylesheet-failure mode, where
 *    light-dark() tokens would otherwise resolve to the light fuchsia
 *    branch), NOT a fix for the purple report: nothing here claims the
 *    report's cause is found.
 * 2. The packaged build's live theme values were unobservable without
 *    devtools, so Settings captured them for a one-photo check on the PC
 *    (computed scheme, painted html background, --color-bg token, OS
 *    scheme, linked-stylesheet load count, WebView Chrome version).
 *    0.11.4 moved that raw line off the About surface into the
 *    diagnostics export only (window.__xtDisplayDiagnostics, carried by
 *    diagnostic-snapshot.ts into snapshot.json).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const couchLayout = readFileSync(
  join(repo, "src/layouts/CouchLayout.astro"),
  "utf8",
);
const settings = readFileSync(
  join(repo, "src/pages/settings.astro"),
  "utf8",
);

describe("CouchLayout pre-paint theme pin (0.11.2 W2)", () => {
  it("pins dark + burgundy before first paint, in <head>", () => {
    const head = couchLayout.split("</head>")[0];
    expect(head).toContain("<script is:inline>");
    expect(head).toContain('style.colorScheme = "dark"');
    expect(head).toContain('setAttribute("data-accent", "burgundy")');
  });

  it("keeps the per-playlist accent override, like Layout/TvLayout", () => {
    const head = couchLayout.split("</head>")[0];
    expect(head).toContain('localStorage.getItem("xt_accent_active")');
    expect(head).toContain("KNOWN_ACCENTS");
  });

  it("does not claim to fix the purple report", () => {
    // The pin is hardening: the report's cause is unproven, so the
    // comment on the pin must say so — a future reader must not mistake
    // this for the fix.
    expect(couchLayout).toMatch(/NOT a fix for the 0\.11\.1 purple-wash report/);
  });
});

describe("Settings display diagnostics (0.11.2 W2, moved 0.11.4)", () => {
  it("no longer renders the raw diagnostics line on the About surface", () => {
    expect(settings).not.toContain('id="update-display-diag"');
    expect(settings).not.toContain("Display: checking…");
  });

  it("captures the line for the diagnostics export instead", () => {
    expect(settings).toContain("window.__xtDisplayDiagnostics");
    const snapshot = readFileSync(
      join(repo, "src/scripts/lib/diagnostic-snapshot.ts"),
      "utf8",
    );
    expect(snapshot).toContain("displayDiagnostics");
    expect(snapshot).toContain("__xtDisplayDiagnostics");
  });

  it("fills it with the live computed theme values", () => {
    expect(settings).toContain("fillDisplayDiagnostics()");
    expect(settings).toContain('getPropertyValue("--color-bg")');
    expect(settings).toContain("prefers-color-scheme: dark");
    expect(settings).toContain("Chrome\\/");
    // Only linked stylesheets count: the page also carries inline
    // <style> blocks, which must not inflate the load count.
    expect(settings).toContain("filter((s) => !!s.href)");
  });
});
