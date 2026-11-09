// Nylah Studios — Xbox controller input via the Gamepad API.
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
//   D-pad / left stick .... move focus (spatial navigation; on the home
//                            page the rail-aware model below takes over)
//   A .................... activate the focused item
//   B .................... back (Escape — closes dialogs, exits fullscreen
//                            playback, per the app's own handlers)
//   X .................... details of the focused card (opens its detail
//                            page without autoplay); in the player it
//                            stays play / pause — see inPlayerContext()
//   Y .................... search; in the player it stays fullscreen
//                            toggle — see inPlayerContext()
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

// The player owns X / Y while it is the thing on screen: a video is
// playing, fullscreen is active, or the dedicated player video exists.
// Everywhere else X opens details and Y opens search, per the redesign
// navigation model. This keeps the player controllable (there is no
// other controller path to play/pause or fullscreen) without stealing
// X / Y from browsing.
function inPlayerContext(): boolean {
  if (document.fullscreenElement) return true;
  const playerVideo = document.querySelector<HTMLVideoElement>("#tv-player-video");
  if (playerVideo) return true;
  const video = currentVideo();
  return !!video && !video.paused;
}

// X on a focused card: open its detail page without autoplay, so X is
// "details" and A stays "play / resume". Only acts when stripping the
// autoplay param actually changes the destination (movie / series
// detail links); live channels and plain buttons are left alone.
function openDetailsOfFocused(): void {
  const el = document.activeElement as HTMLElement | null;
  const link = el?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link) return;
  const raw = link.getAttribute("href") || "";
  if (!raw || raw === "#") return;
  let href: string;
  try {
    const url = new URL(raw, window.location.href);
    if (!url.searchParams.has("autoplay")) return;
    url.searchParams.delete("autoplay");
    href = url.pathname + url.search + url.hash;
  } catch {
    return;
  }
  if (href && href !== window.location.pathname + window.location.search) {
    window.location.assign(href);
  }
}

function goSearch(): void {
  if (window.location.pathname === "/search") return;
  window.location.assign("/search");
}

// ──────────────────────────────────────────────────────────────────────
// Nylah home rails — rail-aware navigation model (v0.2.0).
//
// Contract for rail components (worker 2's four rails + the Continue
// Watching rail): each rail renders
//   <section data-nylah-rail="<id>" class="nylah-rail"> … </section>
// and marks the primary focusable of every card with `data-nylah-item`.
// The home page wraps the stack in `[data-nylah-rails]`. Rail header
// and row classes live in global.css (.nylah-rail__head / __title /
// __row); a strip may reuse its existing .hub-section-head instead.
//
// Behaviour, only while the focused element is inside a rail (or no
// element is focused yet):
//   left / right ... move within the rail; at either end the move is
//                    NOT consumed, so spatial navigation can carry it
//                    on into the sidebar (left edge) as before.
//   up / down ...... move to the adjacent rail, restoring that rail's
//                    remembered column (focus memory); at the top /
//                    bottom edge the move is NOT consumed, so spatial
//                    navigation can carry it to the hero / nav.
//   focus .......... is never lost: every handled move lands on a real
//                    item, and a focusin handler scrolls the focused
//                    item into view (both axes, nearest edge) so the
//                    focused card is always visible.
// Anything outside the rails (sidebar, dialogs, grids, player) keeps
// the previous behaviour: plain arrow keys into spatial navigation.
// ──────────────────────────────────────────────────────────────────────

const railMemory = new Map<Element, number>();

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

function railItems(rail: Element): HTMLElement[] {
  const marked = Array.from(
    rail.querySelectorAll<HTMLElement>("[data-nylah-item]"),
  ).filter((el) => isVisible(el));
  if (marked.length > 0) return marked;
  // Fallback for a rail whose cards carry no marker: top-level links
  // and buttons only (a nested button inside a card link is not its
  // own item).
  const candidates = Array.from(
    rail.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
  ).filter((el) => isVisible(el));
  return candidates.filter(
    (el) =>
      !candidates.some(
        (other) => other !== el && other.contains(el),
      ),
  );
}

function homeRails(): Element[] {
  return Array.from(document.querySelectorAll("[data-nylah-rail]")).filter(
    (rail) => railItems(rail).length > 0 && isVisible(rail),
  );
}

function focusRailItem(rail: Element, index: number): void {
  const items = railItems(rail);
  if (items.length === 0) return;
  const clamped = Math.max(0, Math.min(index, items.length - 1));
  railMemory.set(rail, clamped);
  items[clamped].focus({ preventScroll: true });
  // The focusin handler below scrolls it into view; calling it here
  // too covers the (rare) case where focus was already on the item.
  items[clamped].scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Returns true when the direction was consumed by the rail model.
function handleRailDirection(dir: Direction): boolean {
  const rails = homeRails();
  if (rails.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const rail = active?.closest?.("[data-nylah-rail]") ?? null;

  if (dir === "left" || dir === "right") {
    if (!rail) return false;
    const items = railItems(rail);
    const at = items.indexOf(active as HTMLElement);
    if (at === -1) return false;
    const next = dir === "right" ? at + 1 : at - 1;
    // Past either end: don't consume — spatial navigation carries the
    // move on (left edge reaches the sidebar).
    if (next < 0 || next >= items.length) return false;
    focusRailItem(rail, next);
    return true;
  }

  // up / down
  if (!rail) {
    // Nothing in a rail focused yet: Down from the hero (or from no
    // focus at all) enters the first rail at its remembered item.
    if (
      dir === "down" &&
      (!active ||
        active === document.body ||
        active.closest?.("[data-nylah-hero]"))
    ) {
      focusRailItem(rails[0], railMemory.get(rails[0]) ?? 0);
      return true;
    }
    return false;
  }
  const atRail = rails.indexOf(rail);
  const target = dir === "down" ? rails[atRail + 1] : rails[atRail - 1];
  // Past the top / bottom rail: don't consume — spatial navigation
  // carries the move to the hero / nav as before.
  if (!target) return false;
  const items = railItems(rail);
  const col = items.indexOf(active as HTMLElement);
  const remembered = railMemory.get(target) ?? 0;
  const index = col === -1 ? remembered : Math.min(col, railItems(target).length - 1);
  focusRailItem(target, Math.max(0, index));
  return true;
}

function mountRailAutoScroll(): void {
  const flag = "__couchhubTvRailAutoScrollMounted" as const;
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  document.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target === document.body) return;
    const rail = target.closest?.("[data-nylah-rail]");
    if (!rail) return;
    // Remember the column so up/down restores it on return.
    const items = railItems(rail);
    const at = items.indexOf(target);
    if (at !== -1) railMemory.set(rail, at);
    // Auto-scroll: keep the focused item fully in view, both axes.
    // block/inline "nearest" is a no-op when it is already visible,
    // so manual scrolling is never fought. Instant, not smooth: a
    // held D-pad repeats faster than a smooth scroll settles.
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
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
  // Rail auto-scroll + focus memory live here so keyboard (spatial
  // nav) focus moves get them too, not only gamepad moves.
  mountRailAutoScroll();
  window.addEventListener("pointerdown", () => {
    document.documentElement.classList.remove("gamepad-active");
  }, { passive: true });
  window.addEventListener("keydown", () => {
    document.documentElement.classList.remove("gamepad-active");
  });

  function move(dir: Direction): void {
    markGamepadActive();
    // Home rails get the rail-aware model; everything else falls
    // through to plain arrow keys into spatial navigation.
    if (handleRailDirection(dir)) return;
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
      // Player keeps play / pause; browsing opens the card's details.
      if (inPlayerContext()) togglePlayPause();
      else openDetailsOfFocused();
    }
    if (justPressed(BTN_Y)) {
      markGamepadActive();
      // Player keeps the fullscreen toggle; browsing opens search.
      if (inPlayerContext()) toggleFullscreen();
      else goSearch();
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
