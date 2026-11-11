/**
 * Fullscreen launch contract (0.11.1 W1 — white bar at the bottom).
 *
 * User photos 2026-11-11 (Home + Settings) show the same full-width
 * white strip at the very bottom of the projector screen on both
 * screens, below the fixed hints pill, with page content sliced at
 * its top edge. Pixel analysis of the Home photo: the strip is a
 * uniform blank band (row min brightness 219/255, no icons, no clock
 * — so NOT the Windows taskbar) and the layout viewport ends exactly
 * where the strip begins. That is a window/viewport-level cause, not
 * a page-level one: the window (or its WebView) does not cover the
 * bottom of the screen and something white shows through below it.
 *
 * The 0.10.0 redirect-stub theory is dead for this symptom: the stubs
 * were a transient full-screen white flash on navigation, the only
 * remaining stub (/epg) is dark and deep-link-only, and the strip is
 * persistent on Home/Settings, which never load a stub.
 *
 * What can still land the window in a windowed rect on the user's PC:
 * the window-state plugin restored SIZE/POSITION/MAXIMIZED from the
 * pre-fullscreen saved state (v0.2.2 excluded only FULLSCREEN and
 * DECORATIONS), and the launch path called set_fullscreen(true) exactly
 * once, before show(), with no verification — a fullscreen request on
 * a hidden window can be dropped by the window manager. These tests
 * pin the fixed launch contract at the source level so it cannot
 * silently regress: no geometry restore, fullscreen re-asserted after
 * show() and on Ready, tray show paths re-assert, config fullscreen +
 * dark window background, and the burgundy canvas underneath it all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const libRs = readFileSync(join(repo, "src-tauri/src/lib.rs"), "utf8");
const trayRs = readFileSync(join(repo, "src-tauri/src/tray.rs"), "utf8");
const tauriConf = JSON.parse(
  readFileSync(join(repo, "src-tauri/tauri.conf.json"), "utf8"),
) as {
  app: { windows: Array<Record<string, unknown>> };
};
const couchCss = readFileSync(
  join(repo, "src/styles/couch.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function fnBody(src: string, name: string, endMarker?: string): string {
  const start = src.indexOf(`fn ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  return src.slice(start, end === -1 ? src.length : end);
}

describe("fullscreen launch contract (0.11.1 white bar)", () => {
  it("config launches fullscreen, borderless, hidden, dark window background", () => {
    const main = tauriConf.app.windows[0];
    expect(main["fullscreen"]).toBe(true);
    expect(main["decorations"]).toBe(false);
    expect(main["visible"]).toBe(false);
    expect(main["backgroundColor"]).toBe("#170a0c");
  });

  it("window-state plugin restores no geometry at all", () => {
    const start = libRs.indexOf("with_state_flags(");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = libRs.slice(start, libRs.indexOf(".build()", start));
    for (const flag of [
      "StateFlags::SIZE",
      "StateFlags::POSITION",
      "StateFlags::MAXIMIZED",
      "StateFlags::VISIBLE",
      "StateFlags::FULLSCREEN",
      "StateFlags::DECORATIONS",
    ]) {
      expect(block).toContain(`- tauri_plugin_window_state::${flag}`);
    }
  });

  it("setup re-asserts fullscreen after show() and logs the outcome", () => {
    const showAt = libRs.indexOf("main_window.show()");
    expect(showAt).toBeGreaterThanOrEqual(0);
    const afterShow = libRs.slice(showAt, showAt + 2000);
    expect(afterShow).toContain("set_fullscreen(true)");
    expect(afterShow).toContain("is_fullscreen()");
    expect(afterShow).toContain("[window] launch fullscreen=");
  });

  it("run loop re-asserts fullscreen on Ready", () => {
    // Match the code pattern, not the prose: the flags comment above
    // also names RunEvent::Ready.
    const readyAt = libRs.indexOf("RunEvent::Ready = event");
    expect(readyAt).toBeGreaterThanOrEqual(0);
    const readyBlock = libRs.slice(readyAt, readyAt + 800);
    expect(readyBlock).toContain("set_fullscreen(true)");
  });

  it("tray show paths re-assert fullscreen", () => {
    const toggle = fnBody(trayRs, "toggle_main_window", "fn navigate");
    const navigate = fnBody(trayRs, "navigate");
    for (const body of [toggle, navigate]) {
      expect(body).toContain("window.show()");
      expect(body).toContain("set_fullscreen(true)");
      expect(body.indexOf("set_fullscreen(true)")).toBeGreaterThan(
        body.indexOf("window.show()"),
      );
    }
  });

  it("canvas underneath is burgundy, so no white can show through the page", () => {
    expect(couchCss).toContain("--rs-bg: #170a0c;");
    expect(couchCss).toContain("background: var(--rs-bg);");
  });
});
