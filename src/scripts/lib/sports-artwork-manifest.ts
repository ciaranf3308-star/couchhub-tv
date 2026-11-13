// SHIM-0112 — stub manifest. W2 writes the REAL manifest (verified
// Wikimedia Commons sport photographs, bundled, with creator/licence/
// licence URL in every entry); integration takes W2's file wholesale.
// This stub exports the same names and entry shape with an empty list,
// so the hierarchy falls through to channel branding until then.
//
// The `sport` keys MUST be SportId values from livetv-sports-classifier.ts
// (that enum is the contract); `path` is the bundled asset path used
// verbatim as the artwork URL.
import type { SportId } from "@/scripts/lib/livetv-sports-classifier.ts"

export interface SportsArtworkEntry {
  sport: SportId
  path: string
  orientation: "landscape" | "portrait" | "square"
  width: number
  height: number
  creator: string
  sourcePage: string
  licence: string
  licenceUrl: string
  attribution: string
}

export const SPORT_ARTWORK_MANIFEST: SportsArtworkEntry[] = []
