// TheSportsDB exact-event artwork provider — DOCUMENTED NO-OP (0.11.12, W4).
//
// DECISION (2026-11-13, investigated live by W4): do NOT integrate
// TheSportsDB. This module intentionally always returns null and makes no
// network requests. The hierarchy falls through to the generic sport-photo
// fallback (W1/W2/W3), which is complete without this provider.
//
// WHY — the brief's three conditions for implementing were tested against
// the live API and the official terms, and conditions (b) and (c) fail.
// Condition (a) passes only in part, which changes nothing: unusable
// artwork must not be wired in just because the endpoints answer.
//
// (a) ENDPOINTS — PARTIAL. On the free key `123` (V1, 30 req/min shared)
//     searchteams / searchevents / lookupteam / lookupevent / lookupleague
//     all returned HTTP 200 with artwork URLs on 2026-11-13, e.g.
//     searchevents `Manchester_United_vs_Sunderland` returned one event
//     (idEvent 2494170, 2026-12-30) with strThumb/strPoster/strBanner set
//     but strFanart null; `Toronto_Maple_Leafs_vs_Boston_Bruins` returned
//     only strThumb (banner/poster empty, fanart null). Limits observed:
//     tournament-name search returns {"event":null} (World Snooker
//     Championship found nothing); the docs note eventsnext/eventslast
//     show home events only on the free key. V2 is premium-only: no key
//     -> HTTP 400 "Missing API key in header"; free key `123` in the
//     X-API-KEY header -> HTTP 400 "Invalid Premium API key".
//
// (b) IMAGE RIGHTS — FAILS, and this alone disqualifies the integration.
//     TheSportsDB's own Terms of Service
//     (https://www.thesportsdb.com/docs_terms_of_use.php) make artwork
//     reuse depend on a per-record `strCreativeCommons` flag: "Unknown,
//     an empty or missing value, or an unrecognised value: licensing is
//     unverified. Artwork marked unknown must not be used in app store
//     submissions or publicly, including published apps". Across 11 live
//     probes of the exact endpoints this provider would use
//     (searchteams, searchevents with and without a date filter,
//     lookupteam, lookupevent, lookupleague, searchplayers), the
//     `strCreativeCommons` field was ABSENT from every payload — zero
//     occurrences in any response body. The flag exists only on full
//     player records (lookupplayer for Lionel Messi returned
//     strCreativeCommons "Yes" with a Wikimedia Commons attribution),
//     which this provider does not use, and the Terms add that the flag
//     "is a status flag, not the licence text or proof that every image
//     on that record has the same licence". Further: "A paid API
//     subscription does not grant rights to third-party artwork",
//     trademarked logos "must be used 'As is'... This does not grant
//     permission to use a third-party trademark", and "You cannot use
//     third-party content in the API unless you have the owner's
//     permission or are legally permitted to do so." There is therefore
//     no runtime signal from which an honest `rightsBasis` could ever be
//     written for event/team/league artwork — inventing one is forbidden
//     by the brief, so no image may be returned.
//
// (c) PUBLISHED-APP / KEY — FAILS. Terms: "You cannot publish apps to
//     an appstore unless you are a paid subscriber." Pricing (live,
//     2026-11-13, https://www.thesportsdb.com/pricing): Free $0/mo
//     (most queries limited, 30 req/min); Single Developer $9/mo
//     (100 req/min, V2, livescores); Small Business $20/mo (120 req/min).
//     No paid subscription or private key exists for this app, the brief
//     forbids a paid-API requirement and any API-key configuration, and
//     the free key is a shared global test key. A compliant published use
//     would need a paid key the user does not have.
//
// WHAT WOULD HAVE TO CHANGE before anyone revisits this: (1) a paid
// TheSportsDB subscription held for the published app; (2) a per-image
// rights signal actually present on event/team/league payloads (or a
// written permission covering the images used), plus attribution and
// credits plumbing per the Terms; (3) a fresh live re-probe proving
// both, since the API and terms change. Do not flip this file to live
// calls on the basis of this comment alone — re-verify first.
//
// Behaviour contract (unchanged whether or not a live provider ever
// lands): resolve null for every input, never throw, never fetch.
// Failure isolation is total because there is no failure surface.

// SHIM-0112: W1's classifier module
// (src/scripts/lib/livetv-sports-classifier.ts) does not exist on this
// branch yet, so the brief's SportsClassification shape is defined
// locally and identically. Integration reconciles by deleting this shim
// block and importing { SportsClassification, SportId } from W1's
// module; the function signature below must keep accepting W1's type.
export type SportId = string

export type SportsClassification = {
  isSport: boolean
  sport: SportId | null
  kind: "fixture" | "tournament" | "league-broadcast" | "general-sport" | "non-sport"
  teams?: [string, string]
  competition?: string
  confidence: "high" | "medium" | "low"
}

export type ExactSportsArtwork = {
  backdropUrl?: string
  posterUrl?: string
  source: "thesportsdb"
  eventName: string
  rightsBasis: string
}

export async function lookupSportsEventArtwork(
  _classification: SportsClassification,
  _opts: { title: string; broadcastDate?: string }
): Promise<ExactSportsArtwork | null> {
  // Documented no-op: see the investigation record above. No network
  // request is made, so there is no timeout, no dedup state, and no
  // error path — null for sport and non-sport alike, always.
  return null
}
