# Live TV 0.11.0 — Root-cause audit (W1)

Base: main @ 287376b (0.10.1). Audited: `src/pages/livetv.astro`
(691 lines), `TvLiveLanding` / `TvLiveHero` / `TvCategoryTile` /
`TvChannelBrowser` / `TvGuideView` (2,166 lines) / `TvPlaybackShell` /
`TvQuickSurf`, `livetv-landing.ts` / `livetv-browser.ts` /
`livetv-data.ts` / `livetv-state.ts` / `livetv-keys.ts` /
`livetv-guide.ts` / `livetv-tonight.ts` / `livetv-playback.ts`,
`src/styles/couch.css` (3,697 lines), and the 0.9.0 integration merges
(W1–W5 workstreams). No prolonged exploration: the causes below were
identified, then fixed where the fix belongs to W1's scope.

## Root causes

**R1 — The mode lived in three places with no single writer.**
`livetv.astro` keeps a local `currentMode`, `html[data-livetv-mode]`
(the gamepad layer reads it), and `sessionStorage`
(`redsilk:livetv:state`, via `livetv-state.ts`) each held a copy of
the mode, and only `TvGuideView` ever persisted — so a mode change
made anywhere else was lost on reload, and the stored mode could
disagree with the mode on screen. The state module itself was a
parallel universe: the shell never used `enterPlayback` /
`enterGuide` / `exitGuide`, it re-implemented mode normalisation
(`"home"` → `"landing"`) inline. *Fix (W1):* the shell is now the
single writer of the mode — `setMode` persists it through the new
`persistLivetvMode()` helper, which replaces only the mode in the
stored state and preserves tuned / previous / guide date.

**R2 — `guideReturnTo` was write-only decoration.**
`LivetvState.guideReturnTo` existed, but `enterGuide()` never wrote
it — `TvGuideView` set it with an object spread *after* calling
`enterGuide`, and `leaveGuide()` read a caller-local `enteredFrom`
instead. The field's only reader was the test suite. *Fix (W1):*
`enterGuide()` takes an optional 4th `guideReturnTo` argument and
`exitGuide()` defaults to the recorded value when called without an
explicit mode; explicit callers still win. `TvGuideView`'s spread
is now redundant (W6 may drop it).

**R3 — Cascade-order styling: 35 duplicated selector groups.**
`couch.css` defined the same Live TV selectors twice (sometimes
three times): the 0.7.0 W2/W3 blocks, the W1 "shared" block appended
after them *on purpose* ("win by cascade order"), and the 0.9.0
W5 overrides later still. `.rs-livetv-channel-card` had 3
definitions, `.rs-livetv-play-osd` / `__btn` / `__row`,
`.rs-livetv-play-quicksurf` / `__panel` / `__chip` / `__actions`,
`.rs-livetv-browser__row` / `__search` / `__list` / `__num` /
`__progress` had 2 each; `#player-wrap`'s fullscreen rule needed a
second, later rule to clear the scoped cap it forgot. Nothing in
the file said which definition was canonical, so every later pass
had to guess — and guessed by adding a third. *Fix (W1):* every
duplicated group is folded into ONE canonical definition carrying
the exact computed union (later block wins per property); the file
is 236 lines shorter and a duplicate-selector scan now finds zero
Live TV groups (the single remaining repeat,
`.rs-livetv-browser__head`, is two complementary rules — grid, then
padding — not a conflict). Verified by a headless computed-style
equivalence check over all merged selectors (see Verification).

**R4 — The channel card was a cascade chimera, and its 16/9 logo
never rendered.** The two card definitions disagreed on *every*
property (horizontal row with a 4rem square logo vs vertical card
with a 16/9 logo). The rendered card took `display: flex` + padding
from the first and width / gradient / radius from the second — and
`height: 4rem` from the first survived unopposed, so
`aspect-ratio: 16 / 9` never applied: the live logo is a 64px strip,
not a 16/9 tile. The equivalence check caught this during the merge
(the first merge attempt rendered the logo at 180px). *Fix (W1):*
merged definition preserves the real computed output, with a NOTE
comment marking the 4rem height load-bearing. Whether the card
*should* be 16/9 is a design decision for a later pass, not this
merge — and note `TvChannelCard` / `buildChannelCardElement` are
currently rendered by no screen at all (only `livetv-home.test.ts`
exercises the builder), so the card CSS styles an unmounted
component.

**R5 — The retired 0.7.0 Home interior still shipped its CSS.**
`livetv.astro` carried ~90 lines of scoped + global rules for
`.rs-livetv-home-hero*`, `.rs-livetv-home-collections__grid`,
`.rs-livetv-home-collection-card*`, `.rs-livetv-home-browser*` —
markup nothing has rendered since `TvLiveLanding` replaced the Home
interior in 0.9.0 (verified: the classes occur nowhere else in
`src/`). *Fix (W1):* deleted, with a pointer comment left in place.
`TvSkeleton` was imported by the shell and never used — removed.

**R6 — Dead mounts and bindings.** The `[data-livetv-legend]` div in
the shell head was never filled by anything (the real legend is the
layout-level `TvButtonHints`; the file's own tail comment already
said so) and the `[data-livetv-guide]` click binding bound to zero
elements (no screen carries that attribute; the hero Guide button
is `[data-hero-guide]`, handled in `livetv-landing.ts`). *Fix (W1):*
both deleted; the tail comment in `couch.css` updated.

**R7 — `LIVETV_BACK_EVENT` is defined twice.**
`livetv-keys.ts` and `livetv-landing.ts` each export
`LIVETV_BACK_EVENT = "livetv:back"` — two sources of truth for one
constant, free to drift. *Not fixed by W1:* `livetv-landing.ts` is
W3-owned; W3 should re-export from `livetv-keys.ts`.

**R8 — Four parallel data loaders, four B handlers, three row
systems.** Landing and browser both call `loadLivetvHomeData`;
the Guide has its own inline `loadChannels()` reading the cache
directly; the playback shell has `loadLivetvChannels` /
`loadLivetvProgrammes`. All are cache-only reads, so this costs
duplication, not network — but each mode re-derives favourites /
recents / now-next on its own. Likewise B is handled in four places
(landing / browser / playback shell / guide) with three different
guard styles — the Guide's `livetv:back` handler is the only one
with no context check (it relies on its internal `active` flag) —
and the browser/playback code carries dedupe windows against the
gamepad layer dispatching both `livetv:back` and Escape for one
press. And channels are rendered three ways: `.rs-channel-row`
(`TvChannelRow`, Quick Surf), `.rs-livetv-browser__row` (virtual
rows, browser), `.rs-livetv-channel-card` (unmounted, R4). *Not
fixed by W1:* these are W3/W4/W5/W6-owned files; the spine now at
least gives them one mode writer (R1), one return-target field
(R2) and one CSS definition per selector (R3) to build on.

**R9 — The Guide writes the mode behind the shell's back.**
`TvGuideView` sets `document.documentElement.dataset.livetvMode`
directly on activation and `delete`s it on exit, bypassing the
shell's `setMode` (whose local `currentMode` then goes stale until
the next `livetv:mode` event). It converges today only because the
Guide also dispatches `requestLivetvMode()` on exit. *Not fixed by
W1:* `TvGuideView.astro` is W6-owned; the shell now persists the
mode on every `livetv:mode` event, so the stored mode follows the
screen even when the Guide writes the attribute directly.

**R10 — Dead rules from superseded markup.**
`__main` / `__now` / `__time` / `__next` / `__progress` of the OSD
(the 0.9.0 OSD renders now/next/progress through
`TvProgrammeRow`), `__desc` / `__actions` of Quick Surf
(`__actions` is pinned *absent* by `livetv-quicksurf.test.ts`),
`__body` / `__catchup` / `__watch` of the browser (the builder
emits `__detail-*` and `__watch-live` instead). Each was verified
unreferenced in `src/` markup and in tests before deletion.
Kept deliberately: `.rs-tv-row-list` (no screen renders it, but
`livetv-shared-090.test.ts` pins its presence in CSS) and the
`--v0..v5` category-tile variants (built dynamically as
`` `...--v${variant}` ``).

**R11 — Stale comments contradicting the file.**
The 0.7.0 merge note ("wins by cascade order"), the Mockup-2 note
("the OSD pill and Quick Surf panel … are NOT restyled here" —
the 0.9.0 section below it does exactly that), the W2 channel-card
header crediting Quick Surf (which renders `TvChannelRow`), and
the shell's "W6 fills `[data-livetv-legend]`" note. *Fix (W1):*
updated or removed with the code they described.

**R12 — No shared loading/error pattern, only a shared copy table.**
`LIVETV_STATE_COPY` (7 keys) existed in `livetv-data.ts`, but the
shell, the landing and the playback error overlay each restated its
strings inline, and loading states were bare text lines
(`.rs-livetv-browser-host__loading`, guide panel-empty) rather than
`TvSkeleton`. *Fix (W1):* `livetvEmptyProps(key)` returns the shared
copy for `TvEmpty` props; the shell's provider-empty now uses it
(identical strings). Pattern for W3–W6: pick a key → `TvEmpty`,
loading → `TvSkeleton`, never restate the copy, never invent a
programme title/time/rating.

## What W1 changed

- `src/pages/livetv.astro` — dead 0.7.0 CSS deleted (~90 lines
  scoped + global); unused `TvSkeleton` import removed; empty
  legend mount and dead `[data-livetv-guide]` binding deleted;
  provider-empty uses `livetvEmptyProps("provider-lost")`; `setMode`
  persists the mode (`persistLivetvMode`) and clears the stale
  guide-mode mirror on leaving the guide. All
  `livetv-shared-090.test.ts` shell pins preserved verbatim
  (mount ids, `"home"` alias line, `dataset.livetvMode`,
  `toggleAttribute`, `parseLivetvModeParam` import).
- `src/scripts/lib/livetv-state.ts` — `enterGuide()` records
  `guideReturnTo` (new optional 4th arg); `exitGuide()` defaults to
  it; new `persistLivetvMode()` (mode-only persist). Exports stable;
  `exitPlaybackToHome` alias kept.
- `src/scripts/lib/livetv-data.ts` — new `livetvEmptyProps(key)`.
  No export-surface change to anything Home's Tonight's Picks uses.
- `src/styles/couch.css` — 3,697 → 3,461 lines: 35 duplicated
  selector groups folded to one canonical definition each; dead
  rules deleted (R10); `#player-wrap` fullscreen is one rule again.
  Tokens untouched (burgundy 346–351°, near-black, Manrope); no new
  colour literals.
- `tests/livetv-state.test.ts` (+7 tests), `tests/livetv-data.test.ts`
  (+2 tests) for the new behaviour.
- `docs/livetv-011-audit.md` — this file.

## What W1 deliberately did NOT change

- No other worker's files: `livetv-landing.ts` / `TvLiveLanding` /
  `TvLiveHero` / `TvCategoryTile` (W3), `livetv-browser.ts` /
  `TvChannelBrowser` (W4), `TvPlaybackShell` / `TvQuickSurf` /
  playback OSD scripts (W5), `TvGuideView` (W6), `gamepad.ts`,
  `livetv-keys.ts`, `stream.ts`, `couch-livetv-epg.ts`, Home /
  Movies / Series / Discover.
- No version bump; no behaviour change to B per mode, View+Menu 2s
  return-home, the four mounts, or the `livetv:mode` / `livetv:tune` /
  `livetv:overlay` / `livetv:programme` / `livetv:release` contracts.
- The card logo's 4rem-vs-16/9 question (R4) and the three row
  systems / four loaders (R8) are flagged, not redesigned.

## Verification

- Computed-style equivalence (headless Chrome, 1920×1080):
  `/tmp/css-equiv-011.mjs` — fixture DOM exercising every merged
  selector (both channel-card branches, OSD, Quick Surf, programme
  meta, browser grid, fullscreen `#player-wrap`), old CSS vs new
  CSS, all `getComputedStyle` properties diffed. Result: **zero
  differences** (first run caught the missing `height: 4rem` and a
  dropped `row-gap` — both fixed, re-run clean).
- Vitest: 19 Live TV files, **568 tests, all passing** (includes the
  9 new W1 tests: 7 in `livetv-state.test.ts`, 2 in
  `livetv-data.test.ts`). Baseline before the change: 80 tests
  across the 3 directly-affected files, all passing.
- tsc: **50 errors, byte-identical to the 0.10.1 baseline** measured
  at 287376b (contracts quote 39; the repo's own `tsc --noEmit`
  reports 50 — 45 in `src/`, 5 in `tests/` — zero in touched
  files either way; the count discrepancy is recorded, not hidden).
- Astro build: clean, 30 pages in 1m 34s.
- Headless renders at 1920×1080 (own build on port 4391, marker
  verified — fellow workers hold 4321/4341 with their previews):
  `~/workspace/couchhub-tv-011-fidelity/render-landing.png` (hero
  "News One / Afternoon Matinee", 3 category tiles, 5 quick
  buttons, legend mount confirmed absent) and
  `render-browser.png` (9 rows, 4-column grid, highlighted row,
  detail panel). Both looked at; the merge changes nothing visible.
  The landing hero logo area is a solid fixture colour and the
  category tiles still show giant initials — pre-existing 0.9.0
  design, W3's enrichment work to replace, not this pass.
