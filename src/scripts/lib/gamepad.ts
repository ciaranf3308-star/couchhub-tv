// CouchHub TV — Xbox controller input via the Gamepad API.
//
// Upstream Extreme InfiniTV already navigates by keyboard / D-pad through
// spatial-navigation.js, but it has no Gamepad API support at all (no
// `gamepad` string anywhere in src/). This module bridges that gap without
// touching any screen: it polls the first standard-mapping controller and
// turns its buttons/sticks into the keyboard events the app already
// understands (arrows, Enter, Escape), so every existing view — Live TV,
// Movies, Series, EPG, search, settings, dialogs — gains controller
// navigation for free.
//
// Why the Gamepad API and not XInput: this app is Tauri + web (Astro /
// Svelte), not a native Win32/WPF app, so there is no C# layer to P/Invoke
// XInput from. The Gamepad API is the standard way an Xbox controller
// reaches a Tauri/WebView2 app on Windows, and it needs no driver, no
// native module and no extra permission.
//
// Mapping (standard mapping, Xbox controller):
//   D-pad / left stick .... move focus (spatial navigation)
//   A .................... activate the focused item
//   B .................... back (Escape — closes dialogs, exits fullscreen
//                            playback, per the app's own handlers)
//   X .................... play / pause the current video
//   Y .................... toggle fullscreen
//   LB / RB .............. seek -10s / +10s (video with a duration only)
//   LT / RT .............. volume down / up
//   Menu (Start) ......... open Settings
//   View + Menu, held 2s . return home (dispatches `couchhubtv:return-home`,
//                            handled by return-home.ts; see that file)
//
// Safety rules:
//   - Edge-triggered buttons (a held button fires once); D-pad/stick
//     repeat after a 350 ms initial delay, then every 140 ms.
//   - Dead zone 0.30 on the left stick, so drift never moves focus.
//   - While a text field is focused, navigation keys are left to the
//     field (only B / View+Menu keep working, so the user can always
//     blur out and return home).
//   - The poll loop runs on requestAnimationFrame and stops entirely
//     while the window is hidden, so a minimised/hidden app costs nothing.
//   - No double activation: synthetic keyboard events are only produced
//     from gamepad edges, and physical keyboard events take their own
//     path — one press, one action, from either device.

const RETURN_HOME_HOLD_MS = 2000;
const STICK_DEAD_ZONE = 0.3;
const REPEAT_INITIAL_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 140;

// Standard-mapping button indices.
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_VIEW = 8;
const BTN_MENU = 9;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

type Direction = "up" | "down" | "left" | "right";

const ARROW_KEY: Record<Direction, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

function dispatchKey(key: string): void {
  const target = document.activeElement ?? document.body;
  const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

function currentVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>("#tv-player-video") ??
    document.querySelector<HTMLVideoElement>("video")
  );
}

function activateFocused(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) {
    dispatchKey("Enter");
    return;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (
    tag === "button" ||
    tag === "a" ||
    el.getAttribute("role") === "button"
  ) {
    el.click();
    return;
  }
  dispatchKey("Enter");
}

function togglePlayPause(): void {
  const video = currentVideo();
  if (!video) return;
  if (video.paused) void video.play().catch(() => {});
  else video.pause();
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  } else {
    void document.documentElement.requestFullscreen().catch(() => {});
  }
}

function seekBy(seconds: number): void {
  const video = currentVideo();
  if (!video || !Number.isFinite(video.duration)) return;
  video.currentTime = Math.min(
    Math.max(0, video.currentTime + seconds),
    video.duration,
  );
}

function adjustVolume(delta: number): void {
  const video = currentVideo();
  if (!video) return;
  video.volume = Math.min(1, Math.max(0, video.volume + delta));
}

function openSettings(): void {
  const path = window.location.pathname;
  if (path === "/settings" || path.startsWith("/settings/")) return;
  if (path === "/tv/settings" || path.startsWith("/tv/settings/")) return;
  window.location.assign(path.startsWith("/tv") ? "/tv/settings" : "/settings");
}

interface HeldDirection {
  dir: Direction;
  since: number;
  lastRepeat: number;
}

export function mountGamepad(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  const flag = "__couchhubTvGamepadMounted" as const;
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  let rafId = 0;
  let running = false;
  let prevSnapshot: boolean[] = [];
  let held: HeldDirection | null = null;
  let viewMenuHoldStart: number | null = null;
  let menuPressedWithView = false;

  const markGamepadActive = () => {
    document.documentElement.classList.add("gamepad-active");
  };
  window.addEventListener("pointerdown", () => {
    document.documentElement.classList.remove("gamepad-active");
  }, { passive: true });
  window.addEventListener("keydown", () => {
    document.documentElement.classList.remove("gamepad-active");
  });

  function move(dir: Direction): void {
    markGamepadActive();
    dispatchKey(ARROW_KEY[dir]);
  }

  function handleDirection(dir: Direction | null, now: number): void {
    if (dir === null) {
      held = null;
      return;
    }
    if (held === null || held.dir !== dir) {
      held = { dir, since: now, lastRepeat: now };
      move(dir);
      return;
    }
    if (
      now - held.since >= REPEAT_INITIAL_DELAY_MS &&
      now - held.lastRepeat >= REPEAT_INTERVAL_MS
    ) {
      held.lastRepeat = now;
      move(dir);
    }
  }

  function stickDirection(gp: Gamepad): Direction | null {
    const x = gp.axes[0] ?? 0;
    const y = gp.axes[1] ?? 0;
    if (Math.abs(x) > STICK_DEAD_ZONE && Math.abs(x) >= Math.abs(y)) {
      return x > 0 ? "right" : "left";
    }
    if (Math.abs(y) > STICK_DEAD_ZONE) {
      return y > 0 ? "down" : "up";
    }
    return null;
  }

  function pollLoop(now: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(pollLoop);
    if (document.hidden) return;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads ? pads[0] ?? null : null;
    if (!gp || !gp.connected) {
      prevSnapshot = [];
      held = null;
      viewMenuHoldStart = null;
      return;
    }

    const snapshot = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    const justPressed = (index: number): boolean =>
      snapshot[index] === true && prevSnapshot[index] !== true;
    prevSnapshot = snapshot;

    const editing = isEditingTarget(document.activeElement);

    // View + Menu held together for 2 s -> return home.
    if (snapshot[BTN_VIEW] && snapshot[BTN_MENU]) {
      menuPressedWithView = true;
      if (viewMenuHoldStart === null) viewMenuHoldStart = now;
      if (now - viewMenuHoldStart >= RETURN_HOME_HOLD_MS) {
        viewMenuHoldStart = null;
        markGamepadActive();
        window.dispatchEvent(new CustomEvent("couchhubtv:return-home"));
      }
    } else {
      viewMenuHoldStart = null;
      if (!snapshot[BTN_MENU]) menuPressedWithView = false;
    }

    if (editing) {
      // In a text field the controller only gets B (blur/back) and the
      // View+Menu return-home hold — arrows and A belong to the field.
      if (justPressed(BTN_B)) {
        markGamepadActive();
        (document.activeElement as HTMLElement | null)?.blur?.();
        dispatchKey("Escape");
      }
      held = null;
      return;
    }

    // D-pad (edge + repeat) and left stick (repeat) share one direction.
    let dir: Direction | null = null;
    if (snapshot[BTN_DPAD_UP]) dir = "up";
    else if (snapshot[BTN_DPAD_DOWN]) dir = "down";
    else if (snapshot[BTN_DPAD_LEFT]) dir = "left";
    else if (snapshot[BTN_DPAD_RIGHT]) dir = "right";
    else dir = stickDirection(gp);
    handleDirection(dir, now);

    if (justPressed(BTN_A)) {
      markGamepadActive();
      activateFocused();
    }
    if (justPressed(BTN_B)) {
      markGamepadActive();
      dispatchKey("Escape");
    }
    if (justPressed(BTN_X)) {
      markGamepadActive();
      togglePlayPause();
    }
    if (justPressed(BTN_Y)) {
      markGamepadActive();
      toggleFullscreen();
    }
    if (justPressed(BTN_LB)) {
      markGamepadActive();
      seekBy(-10);
    }
    if (justPressed(BTN_RB)) {
      markGamepadActive();
      seekBy(10);
    }
    if (justPressed(BTN_LT)) {
      markGamepadActive();
      adjustVolume(-0.1);
    }
    if (justPressed(BTN_RT)) {
      markGamepadActive();
      adjustVolume(0.1);
    }
    if (justPressed(BTN_MENU) && !menuPressedWithView) {
      markGamepadActive();
      openSettings();
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(pollLoop);
  }

  function stop(): void {
    running = false;
    cancelAnimationFrame(rafId);
    held = null;
    viewMenuHoldStart = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  window.addEventListener("gamepadconnected", () => start());
  window.addEventListener("gamepaddisconnected", () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const anyConnected = pads ? Array.from(pads).some((p) => p?.connected) : false;
    if (!anyConnected) stop();
  });

  // Start immediately if a controller is already connected (the
  // gamepadconnected event only fires on plug-in after page load).
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (pads && Array.from(pads).some((p) => p?.connected)) start();
  } catch {
    // No Gamepad API in this webview — keyboard/mouse keep working.
  }
}
