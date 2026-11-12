// Nylah Studios — return home to the CouchHub launcher.
//
// Triggers:
//   - the gamepad View + Menu 2 s hold (dispatched as
//     `couchhubtv:return-home` by gamepad.ts), and
//   - Ctrl+Alt+Home, the same global shortcut the CouchHub launcher
//     registers for itself.
//
// What happens: the Live TV stream (if any) is released, the
// current video is paused, fullscreen is exited, and the Tauri
// window is minimised. CouchHub's own hotkey / tray icon then
// brings the CouchHub dashboard back — Nylah Studios does not try
// to launch or focus CouchHub itself, and it never closes, kills
// or force-quits anything. Minimise (not hide/close) is deliberate:
// if CouchHub is ever unavailable, Nylah Studios is still sitting
// in the taskbar where the user can bring it back.
//
// Releasing (not just pausing) is load-bearing: pausing the video
// element leaves the HLS session attached and the provider's single
// connection held indefinitely while the window sits minimised —
// the user believes the app is closed, but no tune can ever
// succeed while that session lives. The release is the engine's
// own `livetv:release` event (stream.ts's
// releaseLocalPlaybackForHandoff); dispatching it with no listener
// is a harmless no-op, so the web preview is unaffected.
//
// In a plain web preview (no Tauri) there is no window to minimise, so
// the handler pauses video, exits fullscreen and does nothing else.
//
// Untested on hardware: whether the gamepad View+Menu hold fires while
// fullscreen playback owns the screen, and whether CouchHub's global
// Ctrl+Alt+Home fires while Nylah Studios is the foreground app. Both are
// flagged for Codex in CODEX_HANDOFF.md — do not claim they work until
// tested on the mini PC.

export function mountReturnHome(): void {
  if (typeof window === "undefined") return;
  const flag = "__couchhubTvReturnHomeMounted" as const;
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  async function goHome(): Promise<void> {
    // Release the Live TV stream FIRST — minimising must never
    // leave it playing invisibly and holding the provider's single
    // connection (see the header note). The video pause below is
    // belt-and-braces for players the engine does not own.
    try {
      window.dispatchEvent(
        new CustomEvent("livetv:release", { detail: { channelId: null } }),
      );
    } catch {
      // Releasing is best-effort; never block the return home.
    }
    try {
      const video =
        document.querySelector<HTMLVideoElement>("#tv-player-video") ??
        document.querySelector<HTMLVideoElement>("video");
      if (video && !video.paused) video.pause();
    } catch {
      // Pausing is best-effort; never block the return home.
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // Ignore — minimising still works with fullscreen left as-is.
    }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {
      // Not running under Tauri (web preview): nothing to minimise.
    }
  }

  window.addEventListener("couchhubtv:return-home", () => {
    void goHome();
  });
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.altKey && event.key === "Home") {
      event.preventDefault();
      void goHome();
    }
  });
}
