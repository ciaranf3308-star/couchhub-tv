/**
 * @vitest-environment jsdom
 */
// Native XInput controller path (0.11.4, W6) — the PRIMARY input
// pipeline, after the browser Gamepad API path failed on the user's PC
// twice (0.11.0, then the 0.11.1 four-break fix). Rust polls XInput
// from cold launch and forwards button edges + directions as Tauri
// events; the frontend feeds them into the SAME action pipeline the
// browser loop uses. There is no Rust toolchain in this sandbox and
// no Windows CI here, so these tests pin the contract statically —
// event names, button mapping, registration, and the ACL grant —
// plus the pure mapping table. Windows CI compile + the user's PC
// test (with /controller-status visible) are the real proof; see the
// W6 report.
//
// Contract under test (integration verifies this surface):
//   events: xinput-button {slot, button, pressed}
//           xinput-direction {slot, direction, phase}
//           xinput-status {available, slots[]}
//   command: xinput_status (snapshot for diagnostics)
//   pipeline: dispatchNativeButton / dispatchNativeDirection in
//             gamepad.ts — the same handleGamepadButtonPress /
//             handleDirection the browser loop calls.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  NATIVE_BUTTON_INDEX,
  dispatchNativeButton,
  dispatchNativeDirection,
  type NativeButtonName,
} from "@/scripts/lib/gamepad";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
function pageSource(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("native XInput button mapping (standard-mapping indices)", () => {
  it("maps every Rust button name to the index the browser loop uses", () => {
    expect(NATIVE_BUTTON_INDEX).toEqual({
      a: 0,
      b: 1,
      x: 2,
      y: 3,
      lb: 4,
      rb: 5,
      lt: 6,
      rt: 7,
      view: 8,
      menu: 9,
      left_stick: 10,
      right_stick: 11,
    });
  });

  it("covers every action button the shared pipeline handles", () => {
    const handled = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "menu"];
    for (const name of handled) {
      expect(
        NATIVE_BUTTON_INDEX[name as NativeButtonName],
        `${name} must map to a standard-mapping index`,
      ).toBeTypeOf("number");
    }
    // D-pad buttons are directions, never entries here: Rust sends
    // them as xinput-direction events, so a D-pad press can never
    // also fire as a button action.
    for (const name of ["dpad_up", "dpad_down", "dpad_left", "dpad_right"]) {
      expect(NATIVE_BUTTON_INDEX[name]).toBeUndefined();
    }
  });

  it("dispatchNativeButton / dispatchNativeDirection are exported and callable", () => {
    expect(typeof dispatchNativeButton).toBe("function");
    expect(typeof dispatchNativeDirection).toBe("function");
    // No pad, no Tauri, no focus target: a release and a
    // direction-centre are both safe no-ops, not throws.
    expect(() =>
      dispatchNativeButton("a", false, performance.now()),
    ).not.toThrow();
    expect(() => dispatchNativeDirection(null, performance.now())).not.toThrow();
  });
});

describe("native XInput Rust bridge (static contract)", () => {
  it("xinput.rs exists and dynamically loads the XInput DLL", () => {
    expect(existsSync(resolve(root, "src-tauri/src/xinput.rs"))).toBe(true);
    const src = pageSource("src-tauri/src/xinput.rs");
    // Dynamic load (LoadLibraryA), never a static #[link]: a machine
    // with no XInput DLL must degrade, never fail to launch.
    expect(src).toContain("xinput1_4.dll");
    expect(src).toContain("xinput1_3.dll");
    expect(src).toContain("LoadLibraryA");
    expect(src).not.toMatch(/^#\[link\(name = "xinput/m);
    expect(src).toContain("XInputGetState");
    expect(src).toContain("xinput-button");
    expect(src).toContain("xinput-direction");
    expect(src).toContain("xinput-status");
    expect(src).toContain("pub fn xinput_status");
    expect(src).toContain("pub fn start_xinput_poll");
    // 8 ms poll, all four XInput slots, cold-launch (no connect
    // event wait).
    expect(src).toContain("POLL_INTERVAL_MS: u64 = 8");
    expect(src).toContain("MAX_SLOTS: u32 = 4");
  });

  it("adds no new Cargo dependency (direct FFI, std only)", () => {
    const cargo = pageSource("src-tauri/Cargo.toml");
    expect(cargo).not.toMatch(/^\s*(windows|xinput|gilrs|gamepad)\s*=/m);
  });

  it("lib.rs registers the command and starts the poll thread at setup", () => {
    const lib = pageSource("src-tauri/src/lib.rs");
    expect(lib).toContain("mod xinput;");
    expect(lib).toContain("xinput::xinput_status,");
    expect(lib).toContain("xinput::start_xinput_poll(app.handle());");
  });

  it("the command is granted to the main window (0.11.2 ACL lesson)", () => {
    const permission = pageSource(
      "src-tauri/permissions/xinput-commands.toml",
    );
    expect(permission).toContain('identifier = "allow-xinput-commands"');
    expect(permission).toContain('"xinput_status"');
    const capability = JSON.parse(
      pageSource("src-tauri/capabilities/default.json"),
    ) as { permissions: string[] };
    expect(capability.permissions).toContain("allow-xinput-commands");
  });
});

describe("native XInput frontend wiring (static contract)", () => {
  it("native-gamepad.ts listens to all three Rust events and feeds the shared pipeline", () => {
    const src = pageSource("src/scripts/lib/native-gamepad.ts");
    expect(src).toContain('"xinput-button"');
    expect(src).toContain('"xinput-direction"');
    expect(src).toContain('"xinput-status"');
    expect(src).toContain("dispatchNativeButton(");
    expect(src).toContain("dispatchNativeDirection(");
    expect(src).toContain("mountNativeGamepad");
    // First slot wins; a second pad never drives navigation.
    expect(src).toContain("activeSlot");
    // View+Menu hold is enforced on the native side (edges only —
    // a hold with no further edge would otherwise never complete).
    expect(src).toContain("RETURN_HOME_HOLD_MS");
  });

  it("gamepad.ts exposes the native entry points and stands the browser fallback down", () => {
    const src = pageSource("src/scripts/lib/gamepad.ts");
    expect(src).toContain("export function dispatchNativeButton");
    expect(src).toContain("export function dispatchNativeDirection");
    expect(src).toContain("export function handleGamepadButtonPress");
    // Shared pipeline: the browser loop calls the same function the
    // native path calls — one focus engine, not two.
    expect(src).toContain("handleGamepadButtonPress(index, now)");
    expect(src).toContain("handleGamepadButtonPress(BTN_B, now)");
    // Suppression: one physical press must never fire twice.
    expect(src).toContain("isNativePathLive(now)");
    expect(src).toContain("noteNativeInputActive");
  });

  it("mountNativeGamepad runs in every layout that mounts the browser loop", () => {
    for (const layout of [
      "src/layouts/TvLayout.astro",
      "src/layouts/CouchLayout.astro",
      "src/layouts/Layout.astro",
    ]) {
      const src = pageSource(layout);
      expect(src, `${layout} must mount the browser loop`).toContain(
        "mountGamepad()",
      );
      expect(src, `${layout} must mount the native path`).toContain(
        "mountNativeGamepad()",
      );
    }
  });

  it("ControllerStatus diagnostics exist and invoke the status command", () => {
    expect(existsSync(resolve(root, "src/components/ControllerStatus.svelte"))).toBe(
      true,
    );
    const component = pageSource("src/components/ControllerStatus.svelte");
    expect(component).toContain('invoke<XInputStatus>("xinput_status")');
    expect(component).toContain('"xinput-status"');
    expect(component).toContain('"xinput-button"');
    expect(component).toContain('"xinput-direction"');
    expect(component).toContain("Last input");
    expect(existsSync(resolve(root, "src/pages/controller-status.astro"))).toBe(
      true,
    );
    const route = pageSource("src/pages/controller-status.astro");
    expect(route).toContain("ControllerStatus");
    expect(route).toContain("controller-status");
    // The integration mount point is documented on the route for W1/W2.
    expect(route).toContain("Help &");
    expect(route).toContain("Diagnostics");
  });
});
