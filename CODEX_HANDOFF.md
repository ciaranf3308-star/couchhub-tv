# CouchHub TV v0.1 — Deployment Handoff for Codex

**For:** Codex (installation agent on the real Windows mini PC)
**Hardware:** MINISFORUM UM790 Pro, Ryzen 9 7940HS, Radeon 780M, 32 GB,
Windows 11 x64, Xbox-compatible wireless controller, HDMI TV.
**Build status:** source complete, **compilation NOT verified** — the
authoring environment is Linux with no Node, pnpm, Rust or Tauri, so no
build or test ran here. Build it on Windows first (see below) and treat
the first on-device run as the real verification pass.

## 0. What this is (read first — the stack is not what was assumed)

Upstream **Extreme InfiniTV is not a WPF/.NET app**. It is **Tauri 2 +
Astro + Svelte 5** (Rust shell, web frontend), v1.9.0, GPL-3.0-or-later.
CouchHub TV is a fork of that codebase, not a rewrite, and the fork
follows the stack the upstream actually has:

- Controller input is the **Gamepad API** in the web frontend
  (`src/scripts/lib/gamepad.ts`), not XInput P/Invoke — there is no C#
  layer in this app to call XInput from. The CouchHub launcher (C#/WPF)
  still uses XInput; each app uses the input method that fits its stack.
- The build is `pnpm tauri build`, not `dotnet build`. There is no
  .NET target to force, and none was forced.
- The updater feed is emptied in `src-tauri/tauri.conf.json`, so the
  fork can never auto-update itself back to upstream releases.

Fork base: upstream commit `1efcc1b` (2026-08-31), shallow clone, remote
`origin` still points at
`https://github.com/infinitel8p/Extreme-InfiniTV.git`. **No GitHub fork
was created** — the separate repo-creation step is blocked pending the
user's browser login, so create the fork on GitHub when that unblocks
and push this tree there. Do not push to upstream.

## 1. Build on Windows

Prerequisites: Node.js 22, pnpm 10, stable Rust toolchain (`rustup`),
Visual Studio C++ Build Tools. WebView2 is on Windows 11 by default.

```powershell
cd <repo root>
pnpm install --frozen-lockfile
pnpm tauri build
# or: powershell -ExecutionPolicy Bypass -File .\publish.ps1
```

Output: `src-tauri\target\release\bundle\` — NSIS installer (`.exe`)
and MSI. The build runs `ensure-ffmpeg-sidecar.mjs`, which fetches the
ffmpeg sidecar from upstream's rolling prerelease and needs network
access to GitHub releases. If the build fails, fix the error there and
report it back; do not silently swap frameworks or add packages.

CI: `.github/workflows/build.yml` does the same build on
`windows-latest` and uploads the bundle as an artifact. Upstream's
`release.yml` (tag-triggered releases) is untouched.

## 2. Install (portable installer, no admin claim — verify on device)

1. Copy the NSIS installer to the mini PC and run it.
2. Launch **CouchHub TV** from Start. Confirm the window opens titled
   "CouchHub TV" with the blue accent (CouchHub palette).
3. First run shows the login / add-playlist screen. No playlist is
   bundled — see §3.

## 3. Configure the Xtream Codes account (on the PC, in the app)

Do this in CouchHub TV under **Settings → Playlists → Add playlist →
Xtream Codes** (or the first-run login screen), using the user's real
subscription details. The field shape is documented in
`docs/xtream-config.example.json` (placeholders only — the app does not
read that file):

- Server URL (e.g. `http://provider:8080`)
- Username
- Password

Credentials are stored locally by the app (Tauri plugin-store,
`.xtream.creds.json`) — never in source, never in a launch argument,
never in CouchHub. Do not re-enter anything into HotPlayer, and do not
change the subscription: HotPlayer already plays it and stays installed
as the fallback. Do not modify HotPlayer.

## 4. CouchHub launcher integration

CouchHub (the launcher) still points its TV tile at HotPlayer for now.
Do **not** repoint it at CouchHub TV in this milestone — the launcher
handoff says HotPlayer is the confirmed TV app. Once CouchHub TV is
validated on the hardware (§5), repointing the TV tile is a one-line
config change in CouchHub (`%LOCALAPPDATA%\CouchHub\config.json`, TV
target → the CouchHub TV executable) and is a separate decision for the
user. Return home from CouchHub TV is designed for that future state:
View+Menu (2 s hold) or Ctrl+Alt+Home pauses video, exits fullscreen
and minimises CouchHub TV, and CouchHub's own hotkey/tray brings its
dashboard back.

## 5. Verify on the hardware (checklist — report results back)

- [ ] Installer runs; app launches titled "CouchHub TV"; About in
      Settings shows the fork attribution to Extreme InfiniTV / GPL-3.0.
- [ ] Xtream Codes login works with the real subscription; Live TV
      channels, categories and EPG load; a channel plays fullscreen.
- [ ] Movies: poster grid, categories, search, details, playback.
- [ ] Series: show browsing, seasons, episodes, search, playback.
- [ ] Controller, every screen: D-pad and left stick move focus, A
      activates, B goes back / closes dialogs / exits fullscreen
      playback, Menu opens Settings. Unplug/replug mid-session works.
- [ ] Controller playback: X play/pause, Y fullscreen, LB/RB seek
      ±10 s (VOD only), LT/RT volume. Record what actually works per
      control — do not claim the full set works until tested.
- [ ] Return home: View+Menu held 2 s **and** Ctrl+Alt+Home, each
      tested from the home screen, from Live TV playback, and from a
      movie. Record the real result per case. **Honest limitation:**
      neither is verified to fire while fullscreen playback owns the
      screen — that is untested, not a claim.
- [ ] Keyboard/mouse still work everywhere; no double activation from
      one controller press; text fields (login, search) take keyboard
      input normally and the controller does not hijack them.
- [ ] Hidden/minimised: the app stops polling (no runaway CPU) and
      video is paused on return home. Record idle CPU % and private
      working set (Task Manager) — targets are a guide, record the real
      numbers.
- [ ] Logs: Tauri log plugin output; check for errors on first launch
      and after a failed login (wrong password must fail gracefully,
      with the app's own error, not a crash).
- [ ] No auto-update to upstream: check the app does not offer an
      upstream release (updater endpoints are empty in v0.1).

## 6. Known limitations / untested (do not claim otherwise)

- Compilation, playback with the real subscription, controller
  behaviour, return-home behaviour and performance were **not tested**
  during this build (Linux authoring environment, no Node/Rust/Tauri).
- The gamepad module synthesises the keyboard events the app already
  handles; any screen with custom key handling that ignores synthetic
  events will need a follow-up, reported per screen.
- The fork is a shallow clone (depth 1) of upstream commit `1efcc1b`;
  full upstream history was not pulled (the full clone is ~230 MB and
  mostly history/binaries).
- Auto-update is disabled in v0.1 (no fork release feed yet). Updates
  are manual reinstalls until a feed exists.

## 7. If something is wrong

- Build fails: check Node 22 / pnpm 10 / Rust / VS Build Tools versions
  first, then the ffmpeg sidecar fetch (needs GitHub access).
- Login fails: verify server URL/username/password exactly as the
  provider gave them (watch for extra spaces); check the provider is
  reachable from the mini PC; HotPlayer playing the same subscription
  proves the subscription itself is live.
- Controller not responding: confirm Windows sees it (Xbox Accessories
  / joy.cpl), then check the browser Gamepad API sees it — keyboard and
  mouse are the fallback, and the app must never depend on the
  controller to be usable.
- Return home does not fire from playback: use Ctrl+Alt+Home or the
  taskbar to get back to CouchHub, and report exactly which trigger
  failed in which screen.
- Do not install, bundle or modify HotPlayer, ES-DE or FreeTube as part
  of CouchHub TV; do not add an IPTV subscription to the app.
