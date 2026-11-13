// SHIM-0112 — stub provider. W4 writes the REAL provider (or an honest
// documented no-op); integration takes W4's file wholesale. This stub
// exports the same names and signature and always resolves null, so the
// hierarchy falls through to the generic sport-photo fallback until then.
//
// Signature contract (W4's file must keep it): the hierarchy calls this
// ONLY for sport classifications with high/medium confidence, with a
// timeout and failure isolation — a provider failure must never break
// resolution. A non-null result is VERIFIED event artwork: the hierarchy
// maps it to artworkKind "exact-sports-event" with the event name as the
// matched title. `rightsBasis` is the provider's per-image rights signal
// and is carried into the artwork provenance; a provider that cannot
// supply an honest rights basis must return null, never an image.
import type { SportsClassification } from "@/scripts/lib/livetv-sports-classifier.ts"

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
  return null
}
