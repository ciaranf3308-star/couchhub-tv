# Nylah Studios v0.1.5

A custom, Xbox-controller-first IPTV application for Windows 11, built for
a MINISFORUM UM790 Pro mini PC connected to a TV. It is the second half of
the two-app CouchHub system: the [CouchHub launcher](../couchhub/) is the
lightweight dashboard, and Nylah Studios is the player it launches for
Live TV, Movies and Series.

> **Build status — read this first:** this project was authored on Linux,
> where Node, pnpm, Rust and the Tauri toolchain are not installed, so
> **no build has been verified here**. The code is the upstream project
> plus the focused CouchHub changes listed below. Build it on Windows
> with the steps under "Build" and treat the first on-device run as the
> real verification pass. See `CODEX_HANDOFF.md` for what Codex must
> still test on the hardware.

## What it is

A fork of **Extreme InfiniTV** by infinitel8p
(<https://github.com/infinitel8p/Extreme-InfiniTV>), version 1.9.0,
commit `1efcc1b` (2026-08-31), licensed **GPL-3.0-or-later** (see
`LICENSE`, retained unchanged). The upstream README is kept at
[`docs/upstream-readme.md`](docs/upstream-readme.md).

Upstream already provides, and Nylah Studios keeps unchanged:

- Live TV with channel categories, channel list, EPG and catch-up
- Movies: poster browsing, categories, search, details, playback
- Series: show browsing, seasons, episodes, search, playback
- Xtream Codes and M3U / M3U8 playlist support, with credentials stored
  locally by the app (Tauri plugin-store, `.xtream.creds.json`) — never
  in source
- HLS / MPEG-TS / DASH playback (hls.js, mpegts.js, shaka-player),
  progressive poster/catalog loading (lazy images, IntersectionObserver
  cache, catalog warming)
- Keyboard / D-pad spatial navigation throughout the UI

## What the fork changes (Nylah Studios)

| Area | Change |
| --- | --- |
| Branding | App name, window title and About screen say **Nylah Studios**; Settings → About attributes the fork to Extreme InfiniTV / infinitel8p with the GPL-3.0-or-later notice. Default accent is **burgundy** (Bedroom theme), matching the CouchHub launcher. Upstream's own accent picker still works. |
| Controller | **New** `src/scripts/lib/gamepad.ts`: Xbox controller via the standard Gamepad API — D-pad / left stick navigate, A activates, B goes back, X play/pause, Y fullscreen, LB/RB seek ±10s, LT/RT volume, Menu opens Settings, View+Menu held 2s returns home. Buttons are edge-triggered with 350 ms / 140 ms repeat and a 0.30 stick dead zone; text fields keep keyboard behaviour. It drives the app's existing keyboard/spatial-nav handlers, so no screen was rewritten. |
| Return home | **New** `src/scripts/lib/return-home.ts`: on View+Menu hold or Ctrl+Alt+Home, pauses video, exits fullscreen and minimises the Tauri window so the CouchHub dashboard can come back. Nothing is closed or force-killed. |
| Focus | **New** `src/styles/couchhub-tv.css`: a thick accent focus ring while a controller is in use (`.gamepad-active`). |
| Updates | The updater is active with the fork's own feed (`https://ciaranf3308-star.github.io/couchhub-updates/couchhub-tv/update.json`); installed copies auto-update on launch. The feed never points at upstream releases. |

What was **not** changed: the streaming engine, Xtream Codes auth,
playlist/EPG code, player engines, and the upstream UI screens. No
IPTV subscription is bundled, and no credentials are hardcoded anywhere.

### Why the Gamepad API, not XInput

This app is Tauri + web (Astro/Svelte), not a native Win32/WPF app, so
there is no C# layer to P/Invoke XInput from. The Gamepad API is the
standard way an Xbox controller reaches a Tauri/WebView2 app on
Windows. The CouchHub launcher (C#/WPF) still uses XInput; the two apps
just use the input method that fits their own stack.

## Configure an Xtream Codes account

In the app, open **Settings → Playlists → Add playlist → Xtream Codes**
(or the login screen on first run) and enter:

- Server URL — e.g. `http://your-provider.example:8080` (your provider's
  address; see `docs/xtream-config.example.json` for the field shape)
- Username
- Password

Nylah Studios stores these locally on the mini PC only. Never put them in
source, in `config.example.json`, or in a launch argument. The same
subscription already plays in HotPlayer, which stays installed as the
fallback — Nylah Studios is an addition, not a replacement.

## Prerequisites (Windows build machine)

- Windows 11 x64
- [Node.js 22](https://nodejs.org/) (LTS) and
  [pnpm 10](https://pnpm.io/installation) (`corepack enable` then
  `corepack prepare pnpm@10 --activate`, or the standalone installer)
- [Rust toolchain (stable)](https://rustup.rs/) — `rustup` on PATH
- Visual Studio Build Tools (C++ workload) — required by Tauri on Windows
- WebView2 runtime (present on Windows 11 by default)

The target mini PC needs no Node, pnpm or Rust: it runs the packaged
installer only.

## Build

```powershell
# From the repo root, on Windows:
pnpm install --frozen-lockfile
pnpm tauri build
```

That runs the Astro frontend build, then Tauri. Output is under
`src-tauri\target\release\bundle\` — the NSIS installer (`.exe`) and the
MSI. (The build also runs `ensure-ffmpeg-sidecar.mjs`, which fetches the
ffmpeg sidecar from upstream's rolling prerelease; it needs network
access to GitHub releases.)

Or run the script, which does the same and prints the artifact paths:

```powershell
powershell -ExecutionPolicy Bypass -File .\publish.ps1
```

## Run / develop

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev        # dev build with hot reload (frontend on :4321)
```

## Tests

Upstream ships Vitest + Playwright suites (`pnpm test`, `pnpm test:e2e`).
No new tests were added for the fork in v0.1 — the gamepad and
return-home modules are small, DOM-only bridges, and they have not been
exercised on hardware yet. They are flagged as untested in
`CODEX_HANDOFF.md`.

## Project structure (fork additions marked ★)

```
package.json / src-tauri/tauri.conf.json  # ★ renamed to CouchHub TV 0.1.0 (now Nylah Studios)
src/scripts/lib/gamepad.ts               # ★ Xbox controller (Gamepad API)
src/scripts/lib/return-home.ts           # ★ View+Menu / Ctrl+Alt+Home
src/styles/couchhub-tv.css               # ★ controller focus ring
src/layouts/Layout.astro, TvLayout.astro # ★ mount gamepad + return home
src/pages/settings.astro                 # ★ fork attribution in About
docs/upstream-readme.md                  # upstream README, kept verbatim
README.md / publish.ps1 / CODEX_HANDOFF.md  # ★ fork docs
.github/workflows/build.yml             # ★ Windows CI build
```

Everything else is upstream Extreme InfiniTV, GPL-3.0-or-later.

## Deployment

See [`CODEX_HANDOFF.md`](CODEX_HANDOFF.md) — install, Xtream Codes
configuration on the mini PC, and the full untested-on-hardware list
(build, playback with the real subscription, controller, return home,
performance). HotPlayer remains the fallback and must not be touched.
