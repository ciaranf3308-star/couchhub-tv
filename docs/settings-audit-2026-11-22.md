# Settings Audit — CouchHub TV (NylahBox Studios)

- **Date:** 2026-11-22
- **Baseline:** `main` at 0.11.22, commit `1af3ec8` ("chore: update visual regression baselines")
- **Branch:** `settings-redesign` (branched from main, pushed to origin)
- **Scope:** full inventory of the Settings surface — nothing else. No app code changed.
- **Auditor method:** read every file under `src/pages/settings/` + `src/pages/settings.astro`, the shared wiring in `src/scripts/settings/settings-page.js` (3,295 lines), `src/scripts/lib/app-settings.js` (central settings registry), `src/scripts/settings/{followed,receiver,play-on-tv}-card.ts`, `src/scripts/lib/ai/status.ts`, `src/scripts/lib/ai/keystore.ts`, `src-tauri/src/ai_keyring.rs`, `src/scripts/lib/keys-onboarding.ts`, `src/scripts/lib/backup.js`, `src/scripts/lib/backup-snapshot.ts`, `src/scripts/lib/preferences.js`, `src/scripts/lib/epg-data.js`, `src/scripts/lib/net-log.ts`, `src/scripts/lib/compositing.ts`, `src/components/settings/SettingsShell.astro`, and every component the pages mount (ProfileSwitcher, LocalePicker, HubStripsEditor, TvOverscanCard, CloseToTrayCard, ExitAppCard, PlayerPicker, AndroidNativePlayerCard, RememberedAndroidPlayerCard, HiddenCategoriesEditor, FavoritesReorder, ChannelOverridesEditor, ConnectionLimitBanner).

## How Settings is built (read this first)

- **One page per section.** `src/pages/settings.astro` is only the home list (12 sections from `SETTINGS_SECTIONS` in `src/scripts/settings/settings-index.ts`, plus a search box and an Exit row). Each section is its own page under `src/pages/settings/*.astro`, wrapped in `SettingsShell` (sticky section nav + search).
- **One shared script.** `settings-page.js` runs on every settings subpage and is null-safe: only the controls present on the current page are wired. `settings_effects.ts` adds the morphing segmented-control pill, scroll-spy rail and commit pulse (cosmetic only).
- **One central registry.** `src/scripts/lib/app-settings.js` owns almost every setting: getter/setter pairs over `localStorage`, with defaults and change events. Exceptions are called out per row below (profiles, prefs blob, keyring, Rust commands, IndexedDB).
- **Control idiom.** Booleans are On/Off segmented button groups (`role="radiogroup"`, `aria-pressed`/`aria-checked`); multi-way choices are segmented groups or `<select>`s. There are no sliders anywhere. Key/password fields save on a 350 ms debounce + on blur.
- **Profiles do NOT scope settings.** All settings and all three API keys are global (one WebView `localStorage`, one OS credential entry). Profiles (`nylah_*` keys) namespace only watch history / favorites / progress / suggestions. The keys onboarding dialog is likewise global — "once saved, never ask again" across profiles.
- **Search.** The shell search box filters the home list in place and can jump cross-page via `settings-index.ts` (`items` + `keywords` per section). The index is a second source of truth for labels/keywords — it must be kept in sync with any redesign.

## Item count

**107 inventoried items** (one table row each, across 12 pages + the home shell). Duplicates are counted where they appear (see §13, open questions Q1–Q2).

---

## 1. Settings home — `src/pages/settings.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 1.1 | Section list | 12 rows: Playlists, Profile, Display, Playback, Live TV, Followed Series, Discover & AI, Casting, Data & Backup, App & Updates, Help & Diagnostics, Danger zone (flagged `data-danger`) — each with a one-line description | Navigation links (`/settings/<slug>`) | Navigates to the section page | `SETTINGS_SECTIONS` in `src/scripts/settings/settings-index.ts` (hard-coded) | — |
| 1.2 | Search | Placeholder via `settings.search.placeholder` ("Search settings" in en) + clear button; "No settings match your search." empty state; cross-page results list | Search input (in `SettingsShell`) | Filters home list in place; cross-page hits link to `section#anchor` | `src/scripts/settings/settings_search.ts`; index = `settings-index.ts` | Search index keywords must match redesigned labels or cross-page search breaks |
| 1.3 | Exit app | Exit row at bottom of home (W3 slot, renders `ExitAppCard`) | Two-tap arm button ("Exit" → confirm state → quits) | Calls `requestAppExit()` → Tauri `quit_app`; on web does nothing and re-arms | No storage (action) | Desktop only in effect; **duplicated** on Display page (see 3.9, Q2) |

---

## 2. Playlists — `src/pages/settings/playlists.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 2.1 | Playlist list | List of playlists; empty state "No playlists yet." | List with per-playlist rows (rendered by `renderPlaylistRow` in `src/scripts/lib/playlist-rows.js`) | Switch active playlist; per-row actions (refresh / edit / remove — see Q4, not fully traced) | Playlist entries + `selectedId` in `localStorage["xt_playlists"]` (JSON); credentials in Tauri plugin-store file `.xtream.creds.json` | Active playlist drives EPG time zone (5.2), download concurrency cap (9.3), hidden categories / favorites / overrides (all per-playlist) |
| 2.2 | Add playlist | "Add playlist" | Link button → `/login` | Opens the Xtream/M3U sign-in flow | — | — |
| 2.3 | Refresh active | "Refresh active" | Button, **hidden until a playlist is active** | Re-fetches the active playlist's catalog (live/VOD/series + EPG) | — | Requires an active playlist |
| 2.4 | Add from website | "Add from website" | Button, **hidden by default** | Adds a playlist from a provider website flow | — | Visibility condition not verified from code (see Q3) |
| 2.5 | New custom playlist | "New custom playlist" | Button → dialog with "Playlist name" text field (placeholder "My playlist") + Cancel / Create | Creates an empty user-curated playlist entry | New entry in the playlist store (`xt_playlists` / creds store) | — |

---

## 3. Display — `src/pages/settings/display.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 3.1 | Language | "Language" — "Pick a language for the interface. Translations are community-driven — missing strings fall back to English." | Select (`LocalePicker.svelte`): "System" + one option per locale (`code` + native name) | Applies locale app-wide immediately (`LOCALE_EVENT`); `dir` flips to RTL for ar/ur | `localStorage["xt_locale"]` (code string; absent = System). Message cache in `localStorage["xt_locale_messages_v3"]` | Content-language default (4.11) follows the interface language when unset |
| 3.2 | Font scale | "Font scale" — "Bumps the base font size. Use Large or X-Large when viewing on a TV from across the room." | Segmented: Small 0.875 / Default 1 / Medium 1.125 / Large 1.25 / X-Large 1.5 | Sets root font size immediately (applied inline in `<head>` on every load via `Layout.astro`); value clamped to 0.75–2 | `localStorage["xt_font_scale"]` (string number; **removed when 1** = default) | Independent of Density |
| 3.3 | Density | "Density" — "Tightens or loosens spacing in lists and menus. Independent of font scale." | Segmented: Compact / Cozy / Comfortable | Sets `--xt-density` (0.75 / 1 / 1.3) + `data-density` on `<html>` immediately | `localStorage["xt_density"]` (`"compact"`/`"comfortable"`; **removed when Cozy** = default) | Independent of Font scale |
| 3.4 | Performance mode | "Performance mode" — "Disables decorative animations (the comet in the sidebar, hub entry stagger, sliding focus ring) for smoother scrolling and D-pad navigation on TV boxes and low-end devices." | Segmented On/Off | Sets `data-perf-mode` on `<html>` + fires `xt:perf-mode-changed`; animations collapse to instant snaps; hub tile-art rotator pauses while hidden | `localStorage["xt_perf_mode"]` (`"1"` = on; default off) | Also gates the morphing pill / commit pulse in `settings_effects.ts` |
| 3.5 | Interface sounds | "Interface sounds" — "A soft chime when the app starts and gentle ticks when moving around with a remote or keyboard. Mouse and touch stay silent." | Segmented On/Off | Enables launch chime + D-pad/keyboard nav ticks | `localStorage["xt_ui_sounds"]` (`"1"`/`"0"`; **default: on, except off when `prefers-reduced-motion: reduce`** and never set) | Reduced-motion media query |
| 3.6 | Controller Cursor Mode | "Controller Cursor Mode" — "Press the right stick (R3) to show an on-screen pointer: right stick moves it, left stick scrolls the page under it, A clicks, RB right-clicks, D-pad still moves focus, and B or R3 exits. Normal navigation stays primary; turn this off and R3 does nothing." | Segmented Enabled/Disabled | Enables/disables the R3 pointer; `cursor-mode.ts` exits immediately if turned off mid-session | `localStorage["xt_cursor_mode"]` (`"1"`/`"0"`; **default Enabled for new installs** — absent key reads as on; only explicit `"0"` disables) | ⚠️ Pre-0.11.14 disables were stored by *removing* the key, so they read as **on** after 0.11.14 (known migration caveat in code comments) |
| 3.7 | TV safe area | "TV safe area" — "Most TVs hide a small band at each edge of the picture (overscan). If sidebar icons or version text look cut off, increase this to inset the whole UI by a few percent." | Segmented (`TvOverscanCard.svelte`): Off / 2% / 4% / 6% / 8% | Sets `--xt-tv-overscan` + `data-tv-overscan` on `<html>` live, no reload | `localStorage["xt_tv_overscan"]` (number string; default 0; clamped 0–8) | Applied pre-paint by `Layout.astro` |
| 3.8 | Close behaviour | "Close" — helper via `settings.closeBehavior.helper` | Segmented (`CloseToTrayCard.svelte`, **desktop only**, hidden on web/Android): "Minimise to tray" / "Quit" | X button hides window to system tray (Skype-style) vs fully quits; pushed to Rust via Tauri `set_close_to_tray` on change and re-synced on boot | `localStorage["xt_close_to_tray"]` (`"1"` = tray; default Quit since 0.11.4) | ⚠️ Encoding inverted in 0.11.4: pre-0.11.4 `""` meant tray and now means quit (intended behaviour change; only explicit `"1"` opts back into tray) |
| 3.9 | Exit app | Same `ExitAppCard` as home (1.3) | Two-tap arm button | Same as 1.3 | No storage | **Duplicate of 1.3** (see Q2) |
| 3.10 | Rendering | "Rendering" — "Some Linux graphics drivers (Raspberry Pi, Nvidia proprietary, virtual machines) show a garbled screen or crash on launch with the default renderer. Safe mode works around this at a small performance cost." + status line (active mode + detected hardware) + "Restart now" button | Select: Auto (recommended) / Faster / Safe — **Linux desktop only** (`card-rendering` hidden unless `compositing_state.platformSupported`); disabled with a note if a WebKit env var overrides it | Writes the mode to Rust (`compositing_set`); "Faster" is stored as a **trial** (`fast-trial`): if not confirmed it reverts on next launch. Restart required. Escape hatch: run once with `--safe-rendering`. | **Rust-managed state** (`src-tauri/src/compositing.rs`), **not** localStorage — storage mechanism/file not traced to a named key (see Q6) | Linux desktop only; env-var override disables the control |
| 3.11 | Home page sections | "Home page sections" — "Choose which sections appear on your home page and what order they're in." | Editor (`HubStripsEditor.svelte`): drag handles + up/down arrows + remove per strip; "Add a section" picker of unused strips; "Reset" link | Reorders/adds/removes home strips; changes apply immediately (`xt:hub-strips-changed`) | `localStorage["xt_hub_strips"]` (JSON array of strip ids; default `["favorites","continue-watching","watchlist","recently-added","because-watched"]`) | Catalog (12 strips): continue-watching, favorites (+ :live/:vod/:series), watchlist (+ :vod/:series), because-watched, recently-added (+ :vod/:series). Unknown/corrupt ids are dropped on read |

---

## 4. Playback — `src/pages/settings/playback.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 4.1 | Continue watching | "Continue watching" — "How long to keep paused movies and episodes in Continue Watching. Older entries are dropped on the next save. The 200-item cap still applies regardless." | Segmented: 30 days / 90 days / 180 days / Never | Read by `trimBucket()` in `preferences.js` on every progress save; takes effect on next playback tick, no reload | `localStorage["xt_progress_retention_days"]` (`"30"`/`"90"`/`"180"`/`"0"`; **removed when 90** = default; invalid → 90) | 200-item progress cap is independent and not user-settable |
| 4.2 | Player backend | "Playback" — "Choose how streams open. External players play 4K and HDR more reliably." (`PlayerPicker.svelte`) | Radio list: ArtPlayer (default) / Video.js / Shaka Player / MPV (external) / VLC (external) | Selects the playback engine for all streams | `localStorage["xt_player_backend"]` (removed when ArtPlayer = default) | MPV/VLC clamped back to ArtPlayer when sandboxed (Snap/Flatpak); ArtPlayer unsupported on Android → Video.js used instead; picker UI hidden on web/Android for external backends |
| 4.3 | MPV path | "Path" (under MPV row) + Detect / Auto-detect / Browse… | Text field + buttons | Path to the MPV binary; Detect probes the system, Browse opens a file picker | `localStorage["xt_player_path_mpv"]` (string; default empty = auto-detect); detection cache `xt_player_detected_mpv`, status `xt_player_detect_status_mpv` | Only meaningful when backend = MPV |
| 4.4 | VLC path | "Path" (under VLC row) + Detect / Auto-detect / Browse… | Text field + buttons | Path to the VLC binary | `localStorage["xt_player_path_vlc"]`; detection cache `xt_player_detected_vlc`, status `xt_player_detect_status_vlc` | Only meaningful when backend = VLC |
| 4.5 | MPV extra arguments | "Extra arguments (one per line)" (under MPV Advanced) | Textarea | Extra CLI args passed to MPV on launch | `localStorage["xt_player_args_mpv"]` (newline-joined, trimmed, blank lines dropped) | MPV only |
| 4.6 | VLC extra arguments | "Extra arguments (one per line)" (under VLC Advanced) | Textarea | Extra CLI args passed to VLC on launch | `localStorage["xt_player_args_vlc"]` | VLC only |
| 4.7 | MPV reuse window | "Reuse the same window" (+ MPV helper) | Segmented On/Off | Reuses the same MPV window across launches (MPV IPC) | `localStorage["xt_player_reuse_mpv"]` (`"1"` = on; default off) | MPV only |
| 4.8 | VLC reuse window | "Reuse the same window" (+ VLC helper) | Segmented On/Off | Reuses the same VLC window across launches (VLC RC) | `localStorage["xt_player_reuse_vlc"]` (`"1"` = on; default off) | VLC only |
| 4.9 | Preferred external player | "Preferred external player" — "Which player the 'Open in…' button uses when both MPV and VLC are set." | Radio: MPV / VLC / "Ask each time" | Decides the "Open in…" escape hatch when both externals are configured | `localStorage["xt_external_player_pref"]` (`"mpv"`/`"vlc"`/`"ask"`; **removed when mpv** = default) | Only meaningful when both MPV and VLC are configured |
| 4.10 | Fix unsupported audio automatically | "Fix unsupported audio automatically" — "When a live channel plays video with no sound (AC-3, E-AC-3, MP2, or DTS audio), fix it automatically instead of asking each time." + FFmpeg status line | Segmented On/Off (collapsible card, **desktop only**) | Auto-transcodes unsupported live audio via FFmpeg instead of prompting per channel | `localStorage["xt_audio_transcode_auto"]` (`"1"` = on; default off) | Requires FFmpeg (bundled sidecar or custom path, 4.11) |
| 4.11 | FFmpeg path | "FFmpeg path" — "Point to your own FFmpeg if the bundled one is missing or you prefer a specific build." | Text field + Browse… + Test buttons | Custom FFmpeg binary path; empty falls through to bundled sidecar, then PATH `ffmpeg`; Test verifies it | `localStorage["xt_ffmpeg_path"]` (trimmed string; default empty) | Gates 4.10; desktop only |
| 4.12 | Group language variants | "Group language variants" — "Combine copies of the same title in different languages into one entry. Turn off if titles are grouped incorrectly for your provider." | Select On/Off | Global master switch overriding per-playlist/per-kind grouping toggles in `preferences.js` when off | `localStorage["xt_lang_grouping"]` (`"1"`/`"0"`; **default on** — absent/`"1"` = on, only `"0"` disables) | Per-playlist/per-kind grouping prefs (not exposed in Settings) |
| 4.13 | Preferred audio language | "Preferred audio language" — "When a title exists in several languages, open and recommend this one first. Auto follows the interface language." | Select (populated from `LANGUAGE_TOKENS`; "Auto" = empty) | Preferred content-language token for playback + recommendations | `localStorage["xt_content_lang"]` (uppercase BCP-47 tag; **empty = Auto**; invalid tags discarded) | Follows Language (3.1) when Auto |
| 4.14 | HEVC video (H.265) | "HEVC video (H.265)" — "Some channels use HEVC video, which Windows can't decode out of the box. Install Microsoft's HEVC extension to play them in the built-in player." + status line ("Already supported on this device." when supported) | Button "Install", **Windows desktop only**; button hides itself when already supported | Opens the Microsoft Store HEVC extension install flow (`ensureHevcDecodable`) | No setting stored (one-shot action; support re-detected each load) | Windows desktop only |
| 4.15 | Captions on by default | "Captions on by default" — "Automatically turns on subtitles when a movie or episode has them, preferring your app language. You can still turn them off in the player. Applies to this device." | Segmented On/Off | Auto-enables subtitles at playback start when the title has them | `localStorage["xt_captions_auto"]` (`"1"` = on; default off) | Per-device (not per-profile) |
| 4.16 | Resume last channel | "Resume last channel on entering Live TV" — "When on, opening Live TV jumps straight back to the last channel you watched. When off, Live TV opens on its home screen instead." | Segmented On/Off | Entering Live TV goes straight to fullscreen playback of the last channel | `localStorage["xt_livetv_resume_last"]` (`"1"` = on; **default off**) | **Duplicate of 5.3** — same store, both copies kept in sync by `settings-page.js` (see Q1) |
| 4.17 | Android native player | "Android native player" (`AndroidNativePlayerCard.svelte`, **Android only**) | Segmented On/Off | Plays movies/series/live TV through the native ExoPlayer Activity instead of in-WebView Video.js (proper PiP, MediaSession lock-screen controls, hardened HLS) | `localStorage["xt_android_native_player"]` (`"1"` = on; default off) | Android only; explicitly default-off until on-device validation completes |
| 4.18 | Remembered Android player | "Android default player" (`RememberedAndroidPlayerCard.svelte`, **Android only**, shown only when a choice was remembered) | Card showing remembered app (icon + label) + "Clear" / forget button | Forgets the "Always use this app" choice from the external-player picker so the picker appears again | `localStorage["xt_android_remembered_player"]` (JSON `{pkg, activity, label, icon}`; absent = none) | Set by the external-player picker elsewhere, not by Settings itself |

---

## 5. Live TV — `src/pages/settings/live-tv.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 5.1 | Channel column width | "Channel column width" | Segmented: Compact 22 / Default 28 / Wide 34 / X-Wide 42 | Width (rem) of the channel column in the Live TV layout | `localStorage["xt_channels_w"]` (number string; **removed when 28** = default) | Live TV layout only |
| 5.2 | EPG time zone | "EPG time zone" — "Some providers ship XMLTV with timestamps already shifted to the server's local time, so EPG times look off. Auto-detect picks the offset where the most channels have a programme airing right now." + status line ("Auto-detected UTC±HH:MM." / "Using manual UTC±HH:MM." / "EPG hasn't been loaded for this playlist yet…") | Select: Auto-detect + UTC−12:00 … UTC+14:00 in 30-min steps. **Disabled with "No playlist selected." when no active playlist** | Manual offset override for the active playlist's EPG; auto-detection infers the offset where most channels have a programme airing now | **Per-playlist:** `localStorage["xt_epg_offset:<playlistId>"]` (minutes; removed = auto). Inferred value cached separately in `xt_epg_offset_inferred:<playlistId>`; HTTP metadata in `xt_epg_http:<playlistId>`; M3U EPG URL override in `xt_m3u_epg:<playlistId>` | Requires an active playlist; applies next time EPG loads |
| 5.3 | Resume last channel | Same label/copy as 4.16 | Segmented On/Off | Same as 4.16 | `localStorage["xt_livetv_resume_last"]` (same key as 4.16) | **Duplicate of 4.16** (see Q1) |
| 5.4 | Categories | "Categories" — "Per-playlist mute list. Hidden categories are hidden from the picker and the main grid on Live TV, Movies, and Series." | Editor (`HiddenCategoriesEditor.svelte`, collapsible): per-kind hide/unhide toggles | Hides categories from picker + grids on Live TV, Movies, Series | **Per-playlist + per-kind**, inside the prefs blob: `localStorage["xt_prefs"]` (JSON, cookie-mirrored ≤3.5 KB) + Tauri plugin-store file `.xtream.creds.json`, key `"xt_prefs"` | Per active playlist; included in backup export |
| 5.5 | Channel edits | "Channel edits" — "Custom names, logos and numbers you set from a channel's right-click menu on Live TV, plus the channels you hid. Provider data is never changed, so any edit can be reset." | Editor (`ChannelOverridesEditor.svelte`, collapsible): list of overrides with per-row Revert; affix-strip preview | Per-channel display overrides (name/logo/number/hidden); reverting clears the override. Edits themselves are made from the Live TV right-click menu, not here — this page only reviews/reverts | **Per-playlist**, inside the `xt_prefs` blob (same mechanism as 5.4), keyed by content-derived key from `channel-overrides.ts` (never runtime id) | Provider data untouched; stale overrides (channel gone from provider) are flagged |
| 5.6 | Favorites | "Favorites" — "Reorder your favorites per kind. The hub Favorites strip and the per-page favorites filter follow this order." | Editor (`FavoritesReorder.svelte`, collapsible): per-kind (live/vod/series) drag + arrow reorder | Reorders favorites; hub strip + per-page favorites filter follow this order | **Per-playlist + per-kind**, inside the `xt_prefs` blob (same mechanism as 5.4) via `getFavoritesOrdered` / `setFavoritesOrder` | Per active playlist |

---

## 6. Followed Series — `src/pages/settings/followed.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 6.1 | Scheduled background checks | "Scheduled background checks" — "When on, the app checks every few hours even while closed, using a Windows Scheduled Task. Turning it off removes the task; in-app checks still work." (Non-Windows copy swaps to a no-task variant; task note hidden off Windows.) + inline error line if the task sync fails | Segmented On/Off | Registers/removes the Windows Scheduled Task "NylahBox Studios Followed Series Check" via Rust `followed_schedule_set`; in-app checks follow the stored flag regardless. On task-sync failure the toggle stays where the user put it and the error line says the while-closed part did not update | `localStorage["xt_followed_check_enabled"]` (`"1"`/`"0"`; **default on** — absent = enabled) | Windows desktop only for the task; interval (6.2) is only pushed to the task when checks are enabled |
| 6.2 | Check every | "Check every" — "How often background checks run. A check also runs when you open the app, if the last one is stale." | Segmented: 3 hours / 6 hours / 12 hours / 24 hours | Background-check interval; also drives the stale check on app open | `localStorage["xt_followed_check_interval_hours"]` (string hours; **default 6**; invalid → 6) | Pushed to the Windows task when 6.1 is on |
| 6.3 | Status + Check now | "Status" + status line ("Last checked <date/time>" / "Never checked" + unread count) | Button "Check now" | Runs a manual followed-series check immediately (`runFollowedCheck({manual:true})`), toasts new-episode/error/done results | Last-check timestamp in the followed IndexedDB store metadata (`lastCheckAt`); unread count from same store | Uses provider metadata only, never opens a stream |
| 6.4 | Manage followed series | "Manage followed series" | Link button → `/followed` | Opens the Followed page (follow/unfollow, per-show management) | — | — |

> Note on this page: the copy warns "Uninstalling the app does not remove the task automatically — delete it in Task Scheduler, or turn scheduled checks off before uninstalling." That is a real uninstall-leak risk (see §13, Q13).

## 7. Discover & AI — `src/pages/settings/discover-ai.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 7.1 | TheTVDB metadata | "TheTVDB metadata" — "Titles you open are sent to TheTVDB through our proxy to look up artwork and episode details. No account or key is needed." | Segmented On/Off | Enables/disables TheTVDB enrichment (posters, cast, episode details) | `localStorage["xt_tvdb_enabled"]` (`""` = on / `"0"` = off; **default on**) | TheTVDB is the only enrichment most users get (needs no key). `isEnrichmentActive()` = TVDB on OR TMDB active |
| 7.2 | Enable enrichment (TMDB) | "Enable enrichment" — "Optional: adds trailers, cast, and similar titles once you add a TMDB key below. Titles you open are sent to TMDB for matching." + honest state line ("Enrichment active." / "On, no key — enrichment inactive. Add a key below." / "Off — enrichment disabled.") + "Set up key" button (only in the on-no-key state) | Segmented On/Off | Master switch for TMDB enrichment; with no key, On and Off are indistinguishable unless the state line says so | `localStorage["xt_tmdb_enabled"]` (`""` = on / `"0"` = off; **default on** — toggle only matters once a key is set). Legacy migration marker `xt_tmdb_enabled_v2` (pre-1.9 `"off"` stored as `""` was rewritten once; see Q11) | **Gates:** TMDB key (7.3). Enrichment is active only when toggle on AND key saved (`isTmdbActive()`). "Set up key" opens the unified keys-onboarding dialog at the TMDB step |
| 7.3 | TMDB API key | "API key" — "Paste a free TMDB API key or v4 access token." + "Get a key at themoviedb.org" link | Password field + "Test key" button | Saves on 350 ms debounce + blur (write verified by read-back; failure shows "Could not save the key"); Test saves first, then validates against TMDB (ok / 401-403-404 invalid / network error) | `localStorage["xt_tmdb_key"]` (**plaintext localStorage**, trimmed; field is filled back from storage on load) | **Gates:** trailers, similar titles, TMDB-backed artwork. Deliberately **excluded from backup export/import and from Reset-restore** (see 9.4, 12.2). Test button disabled while field empty |
| 7.4 | Feed status (Sports Corner) | "Feed status" + state line ("Feed active — table and fixtures available." / "No key — Sports Corner shows no table or fixtures until you add one.") | Read-only text | Honest feed state; without a key the hub shows a no-key state, never invented fixtures | Derived from 7.5 (no separate key) | — |
| 7.5 | football-data.org API key | "API key" — "Paste a free football-data.org API key." + "Get a key at football-data.org" link + "Free registration, no card. One key per application — this key is only for CouchHub TV, and it must stay confidential." | Password field + "Test key" button | Same save pattern as TMDB (debounce + blur + verified write); Test saves first, then validates (ok / 401-403 rejected / network error) | `localStorage["xt_football_data_key"]` (**plaintext localStorage**; constant `FOOTBALL_DATA_KEY_STORAGE_KEY` in `football-data.ts`) | **Gates:** Sports Corner (Manchester United league table + next matches). Whether it is exported in backups is **not verified** (see Q10) |
| 7.6 | AI connection status | "Connection status" + detail line + "Last tested <date/time>" | Read-only text (from `getAiStatus()` in `ai/status.ts`) | Shows mode label (Local recommendations / AI ready / etc.) and detail; "Last tested" from the stored test record | Last-test record in `localStorage["xt_ai_last_test_v1"]` (JSON; cleared when the AI key is deleted) | Reflects endpoint + key + model verification, not just key presence |
| 7.7 | Enable AI Discovery | "Enable AI Discovery" — "Discover works fully without AI, using the local engine." | Segmented On/Off | Master switch for AI Discovery; **gates use, never verification** (Test connection runs against the stored key whatever the toggle says) | `localStorage["xt_ai_enabled"]` (`"1"` = on / `"0"` = off; **default off** — explicit opt-in) | **Gates:** all AI Discovery use. Without it, Discover uses the local engine only |
| 7.8 | Provider | "Provider" — "OpenAI, or any OpenAI-compatible API. Picking OpenAI fills in its endpoint below." | Segmented: OpenAI / Other provider | Picking OpenAI resets the endpoint to `https://api.openai.com/v1` and shows the platform.openai.com key link; Other hides that link and shows "Get a key from your provider's dashboard." | `localStorage["xt_ai_provider"]` (`"openai"`/`"other"`; **default openai**) | Drives endpoint default (7.9) and key-link target (7.11) |
| 7.9 | Provider endpoint | "Provider endpoint" — "OpenAI-compatible API base URL." (placeholder `https://api.openai.com/v1`) | Text field | OpenAI-compatible base URL; saved debounced + on blur; truncated to 256 chars | `localStorage["xt_ai_endpoint"]` (trimmed; **default `https://api.openai.com/v1`** when empty) | Set automatically when Provider (7.8) switches to OpenAI |
| 7.10 | Model | "Model" — "Model on your provider. Smaller models cost less per question." | Select: gpt-4o-mini / gpt-4o / gpt-4.1-mini / gpt-4.1 / o4-mini / Custom… (+ inline "Custom model name" text field revealed when Custom is picked) | Stored model name sent to the provider; Custom reveals a free-text field inside the same bordered group (one control, not two rows) | `localStorage["xt_ai_model"]` (trimmed; **no default** — empty until the user picks/types; truncated to 128 chars) | Test connection verifies the model when possible ("Endpoint, key and model all verified." vs "Endpoint and key verified.") |
| 7.11 | AI API key | "API key" — "Stored in your device's credential store (Windows Credential Manager on this PC), never in the app's files. It is never shown back in full." + "Get a key at platform.openai.com" link (OpenAI only) + "Key saved" badge + status line | Password field + "Clear key" button | Saves on **blur** (and on Test) via Rust keyring; field is **cleared on success and never filled back**; badge + placeholder say a key is saved. Clear deletes the entry + clears the test record. Save failure shows the Rust error detail (never the key). There is deliberately **no reveal** button. | **OS credential store, NOT localStorage:** keyring entry service `"Nylah Studios"`, username `"ai-discovery-api-key"` (`src-tauri/src/ai_keyring.rs` — Windows Credential Manager / macOS Keychain / Linux Secret Service; stub on mobile). Write verified by reading the entry back inside the same blocking call | **Gates:** all AI calls. Presence check is fail-closed (0.11.22): an unreadable store reads as *unknown*, never as "no key saved". **Not exported in backups; survives Reset Everything** (see Q9) |
| 7.12 | Share viewing history & preferences | "Share viewing history & preferences" — "Off by default. When on, Discover also sends a short taste summary (favourite genres, liked and disliked titles) so picks fit you better. Your full watch history, IPTV credentials and stream links are never sent." | Segmented On/Off | Opt-in to send a taste summary with AI questions | `localStorage["xt_ai_share_taste"]` (`"1"`/`"0"`; **default off**) | Only affects AI requests; card header states only the question + candidate titles go to the provider otherwise |
| 7.13 | When AI is asked | "When AI is asked" — "Manual (recommended): searching runs locally and you tap 'Ask AI' for one question at a time. Automatic: submitting a question in Discover sends it to AI straight away. AI is never asked while browsing, scrolling or changing focus." | Segmented: Manual / Automatic | Governs Discover **search submit only** | `localStorage["xt_ai_auto_requests"]` (`"1"` = auto; **default manual**) | Distinct from Home auto-refresh (7.14) |
| 7.14 | Refresh Movies & Series picks automatically | "Refresh Movies & Series picks automatically" — "Off by default. When on, Movies and Series refresh their AI picks at most once a day per library, quietly in the background, showing cached picks meanwhile. 'Generate AI Picks' on those pages always requests fresh picks." | Segmented On/Off | The ONE Home AI preference; at most one quiet refresh per library per day | `localStorage["xt_ai_home_auto_refresh"]` (`"1"` = on; **default off**) | Distinct from 7.13 (Discover search). "Generate AI Picks" buttons bypass it |
| 7.15 | Test connection | "Test connection" — "Checks the saved key against the endpoint above." + result + detail line | Button "Test connection" | Real verification (endpoint + stored key + model) via `testAiConnection()`; saves any typed key first; on "not configured" it names exactly what is missing ("turn on AI Discovery", "save an API key", "set an endpoint", "pick a model") | Writes/updates the last-test record `xt_ai_last_test_v1` | Runs regardless of the Enable toggle (7.7) |

> Keys onboarding (0.11.19, `src/scripts/lib/keys-onboarding.ts` + `keys-feature-entry.ts`): one unified dialog covering the three keys in order **AI → TMDB → football-data**, writing to the same three stores above. Dismissal is **session-scoped**: `sessionStorage["rs-keys-onboarding-dismissed-v1"] = "1"` (skip recurs next session). Legacy AI-only flag `localStorage["rs-ai-onboarding-dismissed-v1"]`. Within Settings, the only onboarding entry point is the TMDB "Set up key" button (7.2); there is no equivalent entry point on the AI or football-data cards.

---

## 8. Casting — `src/pages/settings/casting.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 8.1 | Allow casting to this device | "Allow casting to this device" (under "TV receiver" — "Let other devices running NylahBox Studios send playback to this one over your local network.") + "On" live badge | Segmented On/Off | Starts/stops the local receiver (`receiver_start` / `receiver_stop` Rust commands); on failure the toggle is forced back to Off with the error surfaced | `localStorage["xt_receiver_mode"]` (`"1"` = on; default off) | **Desktop only** (`card-tv-receiver` hidden unless desktop; unhidden by `receiver-card.ts`). Receiver must be on for pairing |
| 8.2 | Device name | "Device name" — "Shown on the pairing screen and in other devices' cast menus." | Text field (placeholder "This device's name") | Renames this receiver; pushed live to a running receiver (`receiver_set_name`) + re-advertised | `localStorage["xt_receiver_name"]` (string; default empty → falls back to Android device name, else Rust uses the hostname) | Only applied while receiver is on; receiver id is a separate persistent value `xt_receiver_id` (random 16-byte hex, generated once) |
| 8.3 | Receiver status / address | Status line + discoverable line + "Address" (list of LAN addresses) | Read-only display (shown only while receiver is on) | From Rust `receiver_status` | — (live state, not a setting) | Requires 8.1 on |
| 8.4 | Windows Firewall warning | "Windows Firewall may be blocking this" — "Other devices on your network may not be able to reach this receiver. Add a firewall rule to allow it." | Button "Allow through firewall" | Runs `receiver_firewall_allow` (Rust) | No setting stored (one-shot action) | Windows desktop only; shown only when `receiver_firewall_status` reports blocked |
| 8.5 | Pair code | "Pair code" — 6-digit display (masked until revealed) | Show/hide (eye) button + "Regenerate code" button | Reveals the current pairing code; regenerate issues a new code via Rust `receiver_regenerate_code` | Code is **Rust-side state**, not localStorage | Requires 8.1 on; code is shown in clear text on a living-room screen by design (pairing UX) |
| 8.6 | Paired devices | "Paired devices" — "No devices have paired yet. Pair one by choosing Play on TV on your phone or computer." | List with per-device Revoke | Revokes a paired sender via Rust `receiver_revoke_device` | Paired-device list is **Rust-side state** (not localStorage) | Requires 8.1 on |
| 8.7 | Open receiver screen | "Open receiver screen" | Button | Navigates to the receiver/pairing screen | — | — |
| 8.8 | Start on receiver screen | "Start on receiver screen" — "Start the app on the pairing screen, like a dedicated receiver. Exit it anytime; it returns on the next launch." | Segmented On/Off | App launches straight onto the pairing screen | `localStorage["xt_receiver_boot"]` (`"1"` = on; default off) | Receiver feature; boot screen returns on next launch after exit |
| 8.9 | Screensaver | "Screensaver" — "Select NylahBox Studios as the system screensaver to see artwork from your library while idle." | Button "Open screensaver settings" | Opens the OS screensaver settings | No setting stored | Row is **hidden by default** (`settings-receiver-screensaver-hint`); show condition not verified (see Q5) |
| 8.10 | Play on TV session | Session banner ("Casting" live badge + current title) + "Stop casting" | Button "Stop casting" (shown only while a cast session is active) | Ends the active cast session (`castStop`) | Session in `localStorage["xt_cast_session"]` + backup `xt_cast_session_backup_v1` (so a still-playing receiver is found again after relaunch) | **Desktop + Android** (`card-play-on-tv` unhidden by `play-on-tv-card.ts`) |
| 8.11 | Paired TVs | "Paired TVs" — "No TVs paired yet. On the TV, open Settings, TV receiver and allow casting, then add it here." | List with per-TV Remove | Removes a paired TV (`removeTvDevice`) | `localStorage["xt_tv_devices"]` (JSON array of TV devices, in `tv-cast.ts`) | Requires a TV with 8.1 on |
| 8.12 | Add a TV | "Add a TV" | Button | Opens the TV device picker dialog (discovery + pair-code entry) | Writes to `xt_tv_devices` on successful pairing | — |

> No Settings UI exists for the receiver playback-engine override: `xt_receiver_engine` (`"auto"`/`"embedded"`/`"native"`, default `"auto"`) is getter-only in `app-settings.js` ("No Settings UI yet").

---

## 9. Data & Backup — `src/pages/settings/data-backup.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 9.1 | Save to (downloads folder) | "Save to" — "Folder where new downloads land. Manage the queue itself on the Downloads page." + "Downloads" availability label ("Desktop only" when not downloadable) + connection-limit banner (`ConnectionLimitBanner.svelte`, read-only) | Read-only text field (current path) + "Choose…" + "Clear" + "Open folder" (desktop Tauri only) | Choose opens a native folder picker (Tauri dialog on desktop; Android SAF picker on Android); Clear releases the SAF grant on Android and empties the path; Open folder opens the dir in the OS file manager | `localStorage["xt_download_dir"]` (string path, or JSON-wrapped SAF `content://` URI on Android; default empty = picked on first download / Android default `/Download/NylahBox Studios/`). A stored path from a foreign OS shape is ignored with a warning | Desktop + Android; web shows "Desktop only" and disables Choose/Clear |
| 9.2 | Restore from folder | "Restore from folder" — "After a reinstall, scan the folder above for `.xtmeta.json` sidecars and re-add the matching files to your downloads list." | Button "Scan folder" (+ result message) | Scans the Save-to folder for `.xtmeta.json` sidecars and re-adds matching files to the downloads list | — (action; uses 9.1's folder) | **Desktop only** (disabled + "Folder scan is desktop-only." on Android/web) |
| 9.3 | Concurrent downloads | "Concurrent downloads" — "Most Xtream providers cap connections per account, so a second parallel download fails mid-stream. Keep this at 1 unless your provider explicitly allows multiple slots." + live cap line ("Provider allows N connection(s) (M in use).") | Segmented 1 / 2 / 3 / 4 | Sets max parallel downloads; buttons above the provider cap are **disabled** with a tooltip ("Your provider only allows N connection(s).") | `localStorage["xt_download_concurrency"]` (string int; **default 1**; clamped 1–4) | Cap comes from the active playlist's provider `user_info` (`max_connections`); M3U sources / cold cache report cap 0 = unknown → all four enabled, no cap line. Refreshed on active-playlist change |
| 9.4 | Write Kodi metadata | "Write Kodi metadata" — "Save a .nfo file with title, year, plot and poster next to each finished download so Kodi, Jellyfin or Emby can index it." | Segmented On/Off (**desktop only** — card hidden otherwise) | Writes a `.nfo` sidecar next to each finished download | `localStorage["xt_write_nfo"]` (`"1"` = on; default off) | Desktop only |
| 9.5 | Export to file (Backup) | "Backup" — "Save all playlists, favorites, recents, watched progress, hidden categories, and app settings to a file. Cache and the downloads queue are not exported." | Button "Export to file" | Downloads a JSON snapshot (`exportAll()` in `backup.js`; filename from `suggestedFilename()`). Also saves the same payload as the auto-snapshot for Restore-last-backup (12.2) | Output file (user-chosen location); snapshot copy at AppData `last-backup.json` (Tauri only) | **Deliberately NOT exported:** TMDB key, AI key (OS store, unreachable), cache, downloads queue, accent/theme (`xt_accent` ignored since Layout forces dark + burgundy). Football-data key export status unverified (Q10) |
| 9.6 | Import from file (Backup) | "Import from file" | Button → hidden file input (`.json`) → **confirmation dialog** "Replace everything with this backup?" (Cancel / Continue) | Replaces all playlists, favorites, recents, watched progress, hidden categories and app settings with the file's contents (`importAll()`); a `tmdbKey` in an old backup is deliberately ignored | — (action) | Destructive; confirmation dialog is the only guard. Old-format backups still import (migration handled in `backup.js`) |
| 9.7 | Cache size | "Cache" + "Last updated <time>" | Read-only text | Shows catalog cache size (bytes, animated tween on clear) + newest cache timestamp | Cache lives in the cache layer (`cache.js` / `img-cache.ts`), not a settings key | — |
| 9.8 | Clear cache | "Clear cache" — "Clears channel, movie, and series lists. Playlists, favorites, and recents are kept." | Button "Clear cache" | Clears catalog cache (`clearAllCache()`) + image cache (`clearImageCache()`); toasts entry count removed | — (action) | Playlists/favorites/recents/progress untouched |
| 9.9 | Open log folder | "Open log folder" | Button, **desktop Tauri only** (hidden otherwise) | Opens the app log dir in the OS file manager; on failure copies the path to clipboard instead | — (action) | Desktop only |
| 9.10 | Open app data folder | "Open app data folder" | Button, **desktop Tauri only** (hidden otherwise) | Opens the app data dir in the OS file manager | — (action) | Desktop only |
| 9.11 | Share logs | "Share logs" | Button, **Android only** (hidden otherwise) | Shares the newest log file via the Android share sheet (`AndroidLog.shareNewestLog`); "No log file yet." if none | — (action) | Android only |
| 9.12 | Clear viewing history | "Clear viewing history" — "Removes continue watching and recently watched items from every playlist. Favorites and watchlist are kept." | Button "Clear history" → **confirmation dialog** (destructive) | Clears continue-watching + recently-watched across every playlist (`clearViewingHistory()` in `preferences.js`) | Progress data in the `xt_prefs` blob (same mechanism as 5.4) | Favorites + watchlist kept; per-profile history is namespaced (`nylah_profile_data_*`) — whether Clear history clears all profiles or only the active one is **not verified** (see Q12) |

---

## 10. App & Updates — `src/pages/settings/app-updates.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 10.1 | Version display | "Current" / "Latest" / "Account expires" (+ "Update available" pill when an update is found; download progress bar + % when installing) | Read-only display | Current from Tauri `getVersion()` (fallback: `meta[name="x-app-version"]`); Latest from the update check; Account expires from provider `user_info` (`data-account-expiration`) | No setting stored | "Account expires" population path not fully traced (see Q14) |
| 10.2 | Automatic updates | "Automatic updates" — "When disabled, updates will not install automatically. You will still see when one is available." | Select: Enabled / Disabled | When off, the Tauri updater never auto-installs; availability is still shown | `localStorage["xt_auto_update"]` (`""` = on / `"0"` = off; **default on**) | Row hidden when the Tauri updater is unavailable (store builds, Snap/Flatpak, web) |
| 10.3 | Update channel | "Update channel" — "Beta versions are early test builds and may be unstable." | Select: Stable / Beta | Switching channels triggers an immediate update check; Beta channel checks via Rust `updater_check_from` against the beta feed URL; prerelease builds default to Beta | `localStorage["xt_update_channel"]` (`"stable"`/`"beta"`; **default stable**, or beta when the running build is a prerelease) | Row hidden on store builds (MS Store / Play Store own updates) |
| 10.4 | Check for updates | "Check for updates" | Button | Runs the check: Tauri updater (stable) or Rust beta-feed check (beta), falling back to a GitHub releases check; shows degraded notice ("Couldn't reach the update server…") on transient failure | — (action) | Network-dependent |
| 10.5 | Download & install | "Download & install" (label changes to "Download again" on failure) | Button, **hidden until an update is available** | Downloads + installs via the Tauri updater plugin (or `updater_install` Rust command in beta mode) with live progress events | — (action) | Requires an available update; not available on store/sandboxed builds |
| 10.6 | Restart now | "Restart now" | Button, **hidden until install finishes** | Relaunches the app (`@tauri-apps/plugin-process` relaunch) | — (action) | Shown after a successful install |
| 10.7 | Get it on GitHub / store | "Get it on GitHub" (label swaps to "Get it from the Microsoft Store" / Play Store on store builds) | Button, shown when in-app install is unavailable | Opens the releases page (or store listing) externally | — (action) | Target URL depends on build type; hidden for Snap/Flatpak (no deep link) |
| 10.8 | GitHub | "GitHub" | Link → `https://github.com/ciaranf3308-star/couchhub-tv/releases/latest` | Opens releases page externally | — | — |
| 10.9 | What's new | "What's new" (collapsible; "Loading…" status) | Collapsible details | Renders the changelog from GitHub releases (`fetchReleases` / `renderMarkdown`, filtered for display) | — (fetched live) | Network-dependent; empty when offline |
| 10.10 | Licenses and attribution | "Licenses and attribution" (collapsible) | Collapsible details + outbound links | Static attribution: FFmpeg (LGPL 2.1+), TMDB, hls.js/mpegts.js/Shaka/Video.js/ArtPlayer (Apache-2.0/MIT), Geist + Instrument Serif (SIL OFL), Tauri + Tabler (MIT/Apache-2.0), TheTVDB, **sports photography credits rendered from `SPORT_ARTWORK_MANIFEST`** (Wikimedia Commons, per-photo licence + source links) | Manifest is code, not a setting | Sports credits must never drift from the bundle (rendered from the manifest by design) |

> Linux note on this page: "Auto-updates on Linux are only delivered to the AppImage build. For deb / rpm installs, grab new versions from the GitHub releases page above." (shown on any Tauri Linux session except Snap/Flatpak). "Auto-update isn't available on this build." shows when the updater can't be used.

---

## 11. Help & Diagnostics — `src/pages/settings/help-diagnostics.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 11.1 | User-Agent preset | "User-Agent preset" — "Some IPTV providers reject the default browser User-Agent. Pick a preset or enter a custom string. Applies to provider API, M3U, and EPG fetches. Effective in the desktop build." | Select: Default (browser/WebView) / VLC media player / Kodi / OTT navigator / Samsung Smart TV / Custom | Picking a preset **applies it immediately** (no Save needed); stored as the preset's UA string. If the current UA matches no preset, the select shows Custom and the custom field is filled | `localStorage["xt_user_agent"]` (string; **default empty** = browser/WebView default) | Desktop build only in effect; applied to provider API, M3U and EPG fetches |
| 11.2 | Custom User-Agent | "Custom (overrides preset)" (placeholder "e.g. VLC/3.0.20 LibVLC/3.0.20") + persistent warning "Custom override is active — it overrides the preset above. Clear it to use the preset." | Text field + "Save" button | A non-empty custom string **silently overrides** the preset (the preset stays recorded as fallback); Save writes the effective value | Same key as 11.1 (`xt_user_agent`) — preset and custom share one slot; the distinction is reconstructed by matching the stored string against the preset list | Overrides 11.1; typing in the field updates the warning live, saving requires the Save button |
| 11.3 | Request timeout | "Request timeout" — "How long to wait for a provider response before giving up. Bump this when a large catalog (tens of thousands of movies / series) times out before it finishes loading." | Segmented: 20s / 45s / 90s / 3 min | Deadline for `providerFetch` (AbortSignal) and per-mirror failover budget in `xtreamApiFetch`; read on every fetch, so it takes effect on the next catalog refresh without reload | `localStorage["xt_network_timeout_s"]` (string seconds; **removed when 20** = default; invalid → 20) | Provider fetches only |
| 11.4 | Developer mode | "Developer mode" — "Unlocks a network log of recent provider requests, useful when troubleshooting a connection issue. Off by default." | Segmented On/Off | Shows/hides the Network log card (11.5) below; fires `xt:dev-mode-changed` | `localStorage["xt_dev_mode"]` (`"1"` = on; default off) | **Gates 11.5** |
| 11.5 | Network log | "Network log" — "Recent provider requests, with credentials stripped. Kept for this app session only and cleared when you close the app." (collapsible, **hidden unless Developer mode is on**) | Card with: "Clear" button; kind filter select (All kinds / API / Playlist / EPG / Image / Media / Update / Other); "Include image requests" On/Off pill pair; "Copy as JSON" button; rows (time, method, status/outcome, duration, kind + transport badges, URL, error line); count line ("N entries, capacity 200", + dropped count) | In-memory/session log of provider requests; renders newest-first, capped at 100 rows on screen; Clear empties it; Copy writes the full JSON to clipboard | Filter + include-images in `localStorage["xt_netlog_images"]` (`"1"`/`"0"`; default off — need to confirm default; see Q15). Log entries in **`sessionStorage["xt_netlog_v1"]`**, capacity **200** entries | Gated by 11.4. Credentials are stripped from logged URLs (claimed in copy; not independently verified) |
| 11.6 | Read the docs | "Read the docs" — "Step-by-step guides for sign-in, external players, the keyboard and D-pad bindings, and the most common things people get stuck on." | Links: "Open documentation" (`/docs`) + "Quick start" (`/docs?p=getting-started`) | In-app navigation to the docs page | — | — |
| 11.7 | Found a bug / Send feedback | "Found a bug or have a suggestion?" — "Bug reports, feature requests, questions, and general feedback all go to GitHub — search existing issues first, or pick a template and open a new one." | Links: "Report a bug" (GitHub issues/new/choose) + "Send feedback" (GitHub discussions/new/choose) | Opens GitHub externally | — | — |
| 11.8 | Export diagnostics | "Export diagnostics" — "Save a single file with app and device details, recent network activity, playlist types and the newest log files. Attach it to a bug report so the problem can be traced." + privacy note: "Usernames, passwords and tokens are stripped out. Server names can still appear, so review the file before posting it publicly." | Button "Export diagnostics" (+ result message with path) | Builds a diagnostics snapshot (`diagnostic-snapshot.ts`: app/device details, display-diagnostics line, recent network activity, playlist types, newest log files) and saves it as a file | Output file (user location); display-diagnostics line captured by Settings into `window.__xtDisplayDiagnostics` | Includes server names — user must review before posting publicly |
| 11.9 | Discord community | "Discord community" — "Questions, feedback, and beta chat — come say hi." | Link "Join" → `https://discord.gg/GH5V3AkzfA` | Opens Discord invite externally | — | — |

> Note: the 0.11.1 "purple wash" display-diagnostics line used to render on the About surface; since 0.11.4 it goes into the diagnostics export only (11.8).

---

## 12. Danger zone — `src/pages/settings/danger.astro`

| # | Item | Label / copy | Control | Behaviour | Storage / default | Dependencies / gates |
|---|------|--------------|---------|-----------|-------------------|----------------------|
| 12.1 | Reset everything | "Reset everything" — "Wipes **all** app data: playlists, favorites, recents, watched progress, profiles, app settings and cached lists. A snapshot is saved first — Restore last backup below brings it back, except the TMDb key and cached lists." | Button "Reset everything" → **confirmation dialog** "Reset everything?" (Cancel / Reset everything) | On confirm: (1) saves a backup snapshot first (best-effort, failure only logged); (2) clears catalog + image cache; (3) `localStorage.clear()`; (4) `sessionStorage.clear()`; (5) clears all cookies; (6) on Tauri, deletes **every key** in the plugin-store file `.xtream.creds.json` (credentials + `xt_prefs` blob); (7) hard-reloads to `/` | No setting stored (destructive action) | ⚠️ **The AI key is NOT wiped** — it lives in the OS credential store and Reset never touches the keyring, despite the copy saying "wipes all app data" (see Q9). Whether the followed-series IndexedDB store is wiped is **not verified** (Q9). The pre-reset snapshot is what makes this recoverable |
| 12.2 | Restore last backup | "Restore last backup" — "Restores the snapshot saved automatically at your last export or right before your last reset: playlists, favorites, recents, progress, followed series, profiles and app settings. It does not restore the TMDb key or cached lists." | Button, **hidden until a snapshot exists** | Loads the snapshot and imports it (asks the same Replace-everything confirmation as 9.6 first) | Snapshot file **`last-backup.json` in the app data dir** (`BaseDirectory.AppData`, Tauri desktop + Android only; no-op on web) — same payload as Export (9.5) | Restores everything Export covers; TMDB key + cached lists excluded by design. Football-data key restore status unverified (Q10) |

---

## 13. Open questions & risky items

### Duplicates (redesign must resolve to one home per control)
- **Q1 — "Resume last channel" exists twice** (4.16 Playback + 5.3 Live TV), same store `xt_livetv_resume_last`, kept in sync by `settings-page.js`. The home-page comment claims "every control exactly one home" — this control violates it. Redesign: keep one, deep-link the other location to it.
- **Q2 — Exit button exists twice** (1.3 Settings home + 3.9 Display). Same `ExitAppCard` component in both places.

### Destructive / dangerous
- **Q3 — Reset Everything vs AI key (HIGH).** Reset wipes `localStorage`, cookies, the `.xtream.creds.json` store and caches, but the AI key in the OS credential store (`Nylah Studios` / `ai-discovery-api-key`) is never deleted — the copy "wipes all app data" is therefore inaccurate for the AI key. Decide: delete the keyring entry on reset (needs a Rust call) or change the copy. Also unverified: whether the followed-series IndexedDB store survives reset (`localStorage.clear()` does not touch IndexedDB; no explicit IndexedDB clear was found in the reset path).
- **Q4 — Import replaces everything** (9.6) with only a confirm dialog as guard; a stale/foreign-platform backup can carry a download dir from another OS (mitigated: `downloadDirMatchesPlatform` ignores foreign-shaped paths) and old backups can carry an ignored `tmdbKey` (deliberately dropped on import).
- **Q5 — Followed scheduled task survives uninstall.** The Windows Scheduled Task "NylahBox Studios Followed Series Check" is not removed by uninstalling; the page copy warns about this, but there is no in-app remediation besides turning checks off first.

### Behaviour not determinable from the code (needs a runtime check or a code owner)
- **Q6 — "Add from website" visibility (2.4).** Button is `hidden` by default; the condition that unhides it was not traced in this audit.
- **Q7 — Playlist row actions (2.1).** `renderPlaylistRow` (playlist-rows.js) was not fully traced — per-row switch/refresh/edit/remove affordances need confirming against the live UI.
- **Q8 — Screensaver row show condition (8.9).** `settings-receiver-screensaver-hint` is hidden by default; what unhides it was not traced.
- **Q9 — Rendering mode storage (3.10).** Mode lives in Rust (`compositing.rs`, via `compositing_state` / `compositing_set`); the on-disk file/key was not identified. The "Faster" trial revert-on-next-launch mechanism was not traced to its Rust implementation.
- **Q10 — Football-data key in backups.** TMDB key exclusion is explicit in `backup.js`; whether `xt_football_data_key` is exported/restored was not verified. The Danger-zone copy mentions only the TMDb key, which suggests the football-data key *is* backed up — confirm before the redesign repeats that copy.
- **Q11 — TMDB enabled legacy migration.** `xt_tmdb_enabled_v2` one-shot migration rewrites pre-1.9 semantics; behaviour for a user who never launched 1.9+ until now is edge-casey but code-covered. No action, just don't "simplify" it away without understanding it.
- **Q12 — Clear viewing history vs profiles.** `clearViewingHistory()` clears progress in the prefs blob; whether per-profile history (`nylah_profile_data_*`) is also cleared was not verified.
- **Q13 — "Account expires" (10.1).** Populated via `data-account-expiration` from provider `user_info`; the exact writer was not traced.
- **Q14 — Network-log "Include image requests" default.** `xt_netlog_images` read path was confirmed; the default when absent was not pinned down in this pass (treat as off until verified).
- **Q15 — Keys onboarding entry points.** Within Settings, only the TMDB card links into onboarding (7.2). Where the dialog is triggered at first launch / from Discover is outside Settings and was not inventoried here.

### Settings that exist in code but have NO Settings UI (redesign must decide: expose, keep hidden, or remove)
- **Q16 — Accent colour.** `xt_accent` (13 presets + `random`, default burgundy; `xt_accent_roll` in sessionStorage) has full getter/setter/event plumbing and is referenced by `docs.astro`, but **no control in any Settings page**. Layout forces dark + burgundy, and `backup.js` notes exporting it is "dead weight".
- **Q17 — Haptics** (`xt_haptics`, default on), **Mono audio** (`xt_mono_audio`, default off), **Video scale / display mode** (`xt_video_scale`, default `fit`), **Discord client id + per-playlist mute** (`xt_discord_client_id`, default `1499717588073058344`; `xt_discord_muted`), **Receiver engine** (`xt_receiver_engine`, default `auto`) — all have getters/setters, none appear in Settings UI. (Discord *community link* on 11.9 is unrelated to Discord Rich Presence.)
- **Q18 — Pre-0.11.14 Cursor Mode disables are lost** (3.6) and **pre-0.11.4 Close-to-Tray encoding flipped** (3.8). Both are documented in code comments; a redesign that migrates/renames these keys must preserve the migration behaviour.

### Privacy / security notes
- **Q19 — Key storage is inconsistent by design, and the UI copy is honest about it:** AI key in the OS credential store (never shown back, never exported); TMDB + football-data keys in **plaintext `localStorage`**, filled back into their fields, and (TMDB) deliberately excluded from backups. Any redesign must not "unify" these into one store without understanding why they differ — and must not add a reveal button for the AI key (deliberately absent: "a secret must never render in clear text on a living-room screen").
- **Q20 — Pair code (8.5) is shown in clear text** by design (pairing UX), and the **network log (11.5) and diagnostics export (11.8) can contain server names** — both are called out in copy; keep those warnings.
- **Q21 — Conditional visibility is load-bearing.** Rendering (Linux only), HEVC (Windows only), Close-to-tray (desktop only), Write-NFO / audio-transcode / Open-log-folders (desktop only), Share-logs (Android only), Android player cards (Android only), TV receiver (desktop only), Play on TV (desktop + Android), Update channel/auto-update rows (hidden on store/sandboxed builds), "Get it on GitHub" target (build-dependent). A redesign that flattens these into one static list will show dead controls on the wrong platforms.

---

## 14. Storage-key master list

### localStorage `xt_*` (global, single WebView store — NOT profile-scoped)
| Key | Used by | Default (absent) |
|-----|---------|------------------|
| `xt_locale` | 3.1 Language | absent = System |
| `xt_locale_messages_v3` | 3.1 cached locale messages | — |
| `xt_font_scale` | 3.2 Font scale | absent/1 = Default |
| `xt_density` | 3.3 Density | absent = Cozy |
| `xt_perf_mode` | 3.4 Performance mode | off |
| `xt_ui_sounds` | 3.5 Interface sounds | on (off if reduced-motion + never set) |
| `xt_cursor_mode` | 3.6 Cursor Mode | **on** (absent = on) |
| `xt_tv_overscan` | 3.7 TV safe area | 0 |
| `xt_close_to_tray` | 3.8 Close behaviour | Quit |
| `xt_hub_strips` | 3.11 Home sections | `["favorites","continue-watching","watchlist","recently-added","because-watched"]` |
| `xt_accent` | (no UI — Q16) | burgundy |
| `xt_haptics` | (no UI — Q17) | on |
| `xt_mono_audio` | (no UI — Q17) | off |
| `xt_video_scale` | (no UI — Q17) | `fit` |
| `xt_discord_client_id` / `xt_discord_muted` | (no UI — Q17) | `1499717588073058344` / none muted |
| `xt_livetv_resume_last` | 4.16 + 5.3 Resume last channel | off |
| `xt_channels_w` | 5.1 Channel column width | 28 |
| `xt_progress_retention_days` | 4.1 Continue watching | 90 |
| `xt_captions_auto` | 4.15 Captions | off |
| `xt_player_backend` | 4.2 Player backend | `artplayer` |
| `xt_player_path_mpv` / `xt_player_path_vlc` | 4.3 / 4.4 Player paths | empty (auto-detect) |
| `xt_player_args_mpv` / `xt_player_args_vlc` | 4.5 / 4.6 Extra args | empty |
| `xt_player_reuse_mpv` / `xt_player_reuse_vlc` | 4.7 / 4.8 Reuse window | off |
| `xt_player_detected_mpv` / `xt_player_detected_vlc` | 4.3 / 4.4 detection cache | — |
| `xt_player_detect_status_mpv` / `xt_player_detect_status_vlc` | 4.3 / 4.4 detection status | — |
| `xt_external_player_pref` | 4.9 Preferred external player | `mpv` |
| `xt_audio_transcode_auto` | 4.10 Fix audio automatically | off |
| `xt_ffmpeg_path` | 4.11 FFmpeg path | empty (bundled → PATH) |
| `xt_android_native_player` | 4.17 Android native player | off |
| `xt_android_remembered_player` | 4.18 Remembered Android player | none |
| `xt_lang_grouping` | 4.12 Group language variants | on |
| `xt_content_lang` | 4.13 Preferred audio language | empty (Auto) |
| `xt_epg_offset:<playlistId>` | 5.2 EPG time zone (manual) | auto |
| `xt_epg_offset_inferred:<playlistId>` | 5.2 inferred offset cache | — |
| `xt_epg_http:<playlistId>` | 5.2 EPG HTTP metadata | — |
| `xt_m3u_epg:<playlistId>` | M3U EPG URL override | — |
| `xt_followed_check_enabled` | 6.1 Scheduled checks | **on** |
| `xt_followed_check_interval_hours` | 6.2 Check interval | 6 |
| `xt_tmdb_key` | 7.3 TMDB key (**plaintext**) | none |
| `xt_tmdb_enabled` (+ `xt_tmdb_enabled_v2` migration marker) | 7.2 TMDB enrichment | on |
| `xt_tvdb_enabled` | 7.1 TheTVDB metadata | on |
| `xt_football_data_key` | 7.5 football-data key (**plaintext**) | none |
| `xt_ai_enabled` | 7.7 Enable AI Discovery | off |
| `xt_ai_endpoint` | 7.9 Provider endpoint | `https://api.openai.com/v1` |
| `xt_ai_model` | 7.10 Model | none |
| `xt_ai_provider` | 7.8 Provider | `openai` |
| `xt_ai_share_taste` | 7.12 Share taste summary | off |
| `xt_ai_auto_requests` | 7.13 When AI is asked | manual |
| `xt_ai_home_auto_refresh` | 7.14 Home auto-refresh | off |
| `xt_ai_last_test_v1` | 7.6 / 7.15 last AI test record | none |
| `xt_user_agent` | 11.1 / 11.2 User-Agent | empty (browser default) |
| `xt_network_timeout_s` | 11.3 Request timeout | 20 |
| `xt_dev_mode` | 11.4 Developer mode | off |
| `xt_netlog_images` | 11.5 Include image requests | off (unverified, Q14) |
| `xt_download_dir` | 9.1 Save to | empty |
| `xt_download_concurrency` | 9.3 Concurrent downloads | 1 |
| `xt_write_nfo` | 9.4 Write Kodi metadata | off |
| `xt_update_channel` | 10.3 Update channel | `stable` (beta on prerelease builds) |
| `xt_auto_update` | 10.2 Automatic updates | on |
| `xt_receiver_mode` | 8.1 Allow casting | off |
| `xt_receiver_boot` | 8.8 Start on receiver screen | off |
| `xt_receiver_name` | 8.2 Device name | empty (device/hostname fallback) |
| `xt_receiver_id` | Receiver identity (16-byte hex, generated once) | generated on first read |
| `xt_receiver_engine` | (no UI — Q17) | `auto` |
| `xt_tv_devices` | 8.11 Paired TVs | none |
| `xt_cast_session` / `xt_cast_session_backup_v1` | 8.10 Cast session | none |
| `xt_playlists` | 2.1 Playlist list + selectedId | `{"selectedId":""}` |
| `xt_prefs` | 5.4 / 5.5 / 5.6 + progress + per-playlist prefs blob (also cookie-mirrored ≤3.5 KB, and mirrored into the `.xtream.creds.json` plugin store under key `"xt_prefs"`) | — |
| `xt_last_seen_version` | Version tracking (TMDB migration + whats-new) | — |
| `rs-ai-onboarding-dismissed-v1` | Legacy AI onboarding dismissal | — |
| `xt_console_signed` | (sessionStorage) devtools easter egg, once per session | — |

### sessionStorage
| Key | Used by |
|-----|---------|
| `rs-keys-onboarding-dismissed-v1` | Keys onboarding skip (session-scoped; recurs next session) |
| `xt_netlog_v1` | 11.5 Network log entries (capacity 200; cleared on app close) |
| `xt_accent_roll` | Accent `random` roll cache for the session |
| `xt_console_signed` | Devtools console message, once per session |

### OS credential store (not localStorage)
| Entry | Used by |
|-------|---------|
| Service `"Nylah Studios"`, username `"ai-discovery-api-key"` (Windows Credential Manager / macOS Keychain / Linux Secret Service; stub on mobile) | 7.11 AI API key |

### Tauri plugin-store file `.xtream.creds.json`
| Key inside file | Used by |
|-----------------|---------|
| Playlist credentials (entries) | Sign-in / Xtream auth |
| `"xt_prefs"` | 5.4 / 5.5 / 5.6 + progress (mirror of `localStorage["xt_prefs"]`) |

### Rust-side / other stores
| Store | Used by |
|-------|---------|
| `compositing.rs` state (file/key not identified — Q9) | 3.10 Rendering mode |
| Receiver state (pair code, paired devices, addresses) | 8.3 / 8.5 / 8.6 |
| Followed-series IndexedDB store (metadata `lastCheckAt`, unread counts) | 6.3 status |
| AppData `last-backup.json` (Tauri desktop + Android) | 12.2 Restore last backup |

### Profiles (`nylah_*` — NOT settings, listed so the redesign doesn't conflate them)
| Key | Used by |
|-----|---------|
| `nylah_profiles_v1` (registry) | Profile list (Ciaran / Aisling / Everyone are hard-coded choices in `ProfileSwitcher`) |
| `nylah_profile_active_v1` | Active profile |
| `nylah_profile_data_<id>_v1` | Per-profile watch history / favorites / progress / suggestions |

---

## 15. Redesign contract (what must survive)

1. **Every one of the 107 items above** must exist in the redesign with the same behaviour and the same storage key/default — or an explicit, user-approved decision to remove/merge it (Q1/Q2 duplicates are the only pre-approved merges, and only after the user picks the surviving home).
2. **No storage key may be renamed, re-encoded, or re-defaulted** without a migration — several keys carry legacy migrations (`xt_tmdb_enabled_v2`, cursor-mode absent-means-on, close-to-tray inversion) that break silently if "cleaned up".
3. **Key storage split must stay:** AI key in the OS keyring (never shown, never exported, never in a backup file); TMDB + football-data keys in plaintext localStorage (filled back, excluded from backup for TMDB — confirm football-data, Q10); all other settings in localStorage / prefs blob.
4. **Conditional visibility must stay** (Q21): platform-gated rows (Linux/Windows/Android/desktop-only) and build-gated rows (store/sandboxed) must not become always-visible dead controls.
5. **Danger-zone semantics must stay:** Reset saves a snapshot first, wipes the documented stores, and offers Restore last backup — with the AI-key gap (Q3) resolved explicitly, not silently.
6. **The search index (`settings-index.ts`) must be re-synced** to the redesigned labels/keywords/anchors, or cross-page search breaks.
7. **The honest-state lines must stay:** TMDB on-no-key, football-data no-key, AI connection status/last-tested, provider concurrency cap, EPG auto-detected vs manual, receiver firewall warning. These exist because the toggles alone lie about whether a feature actually works.
