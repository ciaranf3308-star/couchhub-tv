// AI Discovery bootstrap for the coordinator's Discover page.
//
// `initAI()` performs the one async check this layer needs — whether a key
// is present in the OS credential store — and caches the answer.
// `isAIConfigured()` is the sync gate the Discover page reads: enabled +
// endpoint + model from settings, plus the cached key presence.
//
// Deliberately does NOT import `../discover` (the seam module lives with
// the coordinator) and does NOT register anything itself — registration
// stays with the coordinator. After the user saves or clears a key in
// Settings, the Settings page calls `initAI()` again so the cached
// presence reflects the change without a restart.

import { getAiEnabled, getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import { hasAiKey } from "./keystore.js"

let keyPresent = false

export function isAIConfigured(): boolean {
  return getAiEnabled() && !!getAiEndpoint().trim() && !!getAiModel().trim() && keyPresent
}

export async function initAI(): Promise<void> {
  try {
    keyPresent = await hasAiKey()
  } catch {
    keyPresent = false
  }
}
