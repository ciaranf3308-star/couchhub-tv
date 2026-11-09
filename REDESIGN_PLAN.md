# Nylah Studios — Redesign plan

Status: SHIPPED in v0.2.0 (2026-11-09). Built by four worker agents off
main 0220131 (v0.1.5), integrated by the coordinator. What follows is the
record of what was decided and what shipped; the open questions at the
bottom are what is still genuinely undecided or unverified.

## The idea

The TV app stops being a mouse-first web UI on a TV and becomes a
controller-first living-room app, built for two people. Xbox controller
is the primary input. Everything is legible from the couch, every action
is reachable from the controller, nothing is hidden behind a hover.

Look: RedSilk family. Same burgundy, warm beige and serif titles as the
RedSilk LingLing launcher, so the two apps feel like one product.

## Principles

- 10-foot UI: big type, big focus states, readable from 3 m.
- Focus is always visible and never lost: a strong glowing focus ring,
  auto-scroll so the focused item is always in view, no dead ends.
- No hover-only information. Ratings, year, genre and status show on the
  focused card, not on mouse hover.
- No mouse-only controls. Anything that needs typing (search) gets a
  controller-navigable on-screen keyboard.
- Every section that exists today stays reachable. The new rails are
  shortcuts, never the only path to the content.

## Navigation model (controller)

- Home is a vertical stack of rails. Up/down moves between rails,
  left/right moves within a rail.
- A select / play, B back, X details, Y search, Menu settings,
  View+Menu held 2 s return home, LB/RB seek ±10 s in the player.
- Slim left nav with the sections, big items, clear focus. Always
  reachable, never buried.
- Player: big transport controls, clear progress, info overlay on pause.

## Home rails (proposed order)

1. Continue Watching (exists today)
2. Trending on Google this week — most-searched movies that week,
   matched against our own library, so every card is actually playable
3. AI suggestions for Ciaran
4. AI suggestions for Aisling
5. IMDb top-rated
6. Genre / mood rails after those, as now

## Pages that stay (nothing lost, nothing unfindable)

Live TV, Movies, Series, Favorites, Watch Later, Recently Added, EPG,
Downloads, Search, Settings. Movies and Series keep the full grid plus
filters (genre, year, rating) and search, so the whole library is always
one press away even if a title never appears on a rail.

## Data sources — honest notes

- Trending: Google Trends has no official public API. Unofficial routes
  exist but are fragile and can break or get blocked. SHIPPED: Google
  Trends first, TMDB "Trending this week" as fallback, rail labelled by
  the source actually live. TMDB needs the user's own free key
  (Settings → TMDb); with no key that path is skipped and the rail says so.
- IMDb: no public API. Ratings come from the provider's VOD metadata
  (Xtream carries a rating per title, usually IMDb-derived) — the same
  value the app already renders as an IMDb rating elsewhere. SHIPPED:
  8.0 and up, labelled "IMDb Top Rated". No live IMDb lookup exists.
- AI suggestions: needs a taste signal per person. **DECIDED 2026-11-09:
  learn from what each of them watches.** Consequence: the app needs
  per-person profiles (a who-is-watching step), so it can tell their
  histories apart — separate watch history, favorites and Continue
  Watching per profile. V1 is similarity matching (genre, cast,
  director, mood) against the library from that signal. A true LLM call
  is a later step and needs a key and a choice. The rail must be
  labelled by what it actually does. Cold start: suggestions are thin
  until each profile has watched a bit; existing shared history can
  bootstrap it if each claims what's theirs.

## Also in scope

- Launch fullscreen on the TV. The app currently opens windowed with
  the Windows taskbar showing (seen in the user's photo 2026-11-09).

## Open questions

1. Name: "NylahBox Studios" (user's words 2026-11-09 22:32) or
   "Nylah Studios" (shipped in v0.2.0)? A rename is a later string change.
2. Trending source: Google Trends first with TMDB fallback, as shipped.
   TMDB fallback needs the user's own free key (Settings → TMDb).
   Google Trends liveness is unverified until hardware — the rail
   degrades honestly if it fails.
3. AI suggestions: learn from watch history — DECIDED and shipped.
   Per-profile separation is interim: playback/favorite writes still go
   to the shared store; profiles diverge via the one-time claim plus the
   active-profile mirror. True per-profile write routing is a later step.
4. IMDb rail: 8.0 and up, labelled "IMDb Top Rated". The rating is the
   provider-supplied value the app already renders as IMDb elsewhere;
   there is no live IMDb lookup (IMDb has no free official API).
5. Sequencing: whole app at once — DONE in v0.2.0, except the secondary
   `/tv/*` routes, which still show the old UI. The desktop app boots
   at `/`, so this is not visible on the TV; a `/tv/` reskin is a later
   decision, not a v0.2.0 gap.
6. Housekeeping left in place: the HubStrips editor in Settings now edits
   strips the home page no longer renders (left intact, harmless);
   `src/scripts/tv/views/home.ts` (getHubStrips) is the second home
   implementation and was not touched.
