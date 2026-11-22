// Keys onboarding — feature-entry + launch gate (one shared entry point).
//
// Every prompt for a missing key goes through `maybeOpenKeysOnboarding()`:
// the launch gate (reason "launch"), Discover AI ("ai"), TMDB enrichment
// ("tmdb") and Sports Corner ("football-data"). It is the ONLY place
// outside keys-onboarding-ui.ts that decides to open the dialog, so the
// no-double-prompt rule has exactly one enforcement point:
//
// - It opens only when `shouldShowKeysOnboarding()` is true: a key is
//   missing AND the prompt was not skipped this session. A launch skip
//   therefore suppresses the Discover / Sports / Settings entries for
//   the rest of the session, and a feature-entry skip suppresses the
//   next entry the same way — the dialog never stacks on top of itself
//   and never re-appears twice in one session.
// - `openKeysOnboarding()` itself dedupes in-flight mounts (a second
//   call returns the same promise), so a launch dialog still open when
//   the user enters Discover cannot produce a second dialog.
// - It never throws and never blocks the caller: a store error in the
//   status check resolves to "do not show", and an open failure resolves
//   to null. The app behind the gate always stays usable.
//   FAIL-SAFE (0.11.22, per-key since settings-polish-95 w3): the
//   status check itself now treats an unreadable key as saved and
//   still evaluates the others, so this catch is a backstop for
//   anything else that throws — a failed check can never re-prompt
//   for a key that is saved, and one unreadable key never silences
//   the prompt for a key that is genuinely missing.

import {
  shouldShowKeysOnboarding,
  type KeysOnboardingDeps,
  type KeysOnboardingReason,
} from "@/scripts/lib/keys-onboarding.js"
import {
  openKeysOnboarding,
  type KeysOnboardingResult,
} from "@/scripts/lib/keys-onboarding-ui.js"

/** Injectable seams for tests. Defaults are the real status check and
 *  the real dialog opener; tests inject fakes and never open a dialog. */
export interface KeysFeatureEntryDeps extends KeysOnboardingDeps {
  shouldShow?: (deps?: KeysOnboardingDeps) => Promise<boolean>
  open?: (options: {
    reason: KeysOnboardingReason
    deps?: KeysOnboardingDeps
  }) => Promise<KeysOnboardingResult>
}

/**
 * Open the unified keys onboarding for one reason, or null when it
 * must not show (all keys saved, skipped this session, or the status
 * check / open failed). Never throws.
 */
export async function maybeOpenKeysOnboarding(
  reason: KeysOnboardingReason,
  deps: KeysFeatureEntryDeps = {},
): Promise<KeysOnboardingResult | null> {
  try {
    const check = deps.shouldShow ?? shouldShowKeysOnboarding
    if (!(await check(deps))) return null
    const open = deps.open ?? openKeysOnboarding
    return await open({ reason, deps })
  } catch {
    return null
  }
}

/**
 * First-run launch gate (reason "launch"). Call once at startup; it
 * resolves to the dialog result when keys are missing, or null when
 * there is nothing to ask for. Never throws, never blocks the app.
 */
export async function runKeysLaunchGate(
  deps: KeysFeatureEntryDeps = {},
): Promise<KeysOnboardingResult | null> {
  return maybeOpenKeysOnboarding("launch", deps)
}
