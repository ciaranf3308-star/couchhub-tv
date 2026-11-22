// Keys-onboarding launch gate — real-browser e2e (production build + Playwright).
//
// The regression this locks in (22 Nov 2026, fixed in 0.11.22): the launch
// gate asked for the AI key even when it was already saved, because
// `hasAiKey()` swallowed every credential-store failure as "no key" and
// `getKeysOnboardingStatus()` collapsed the error into "missing". The
// 0.11.19 suite only mocked `hasAiKey` in jsdom, so it never saw a real
// store failure. These tests run the REAL production build in a REAL
// browser and assert the gate's observable behaviour on home load:
//
//   A1  all three keys saved, healthy store  -> gate stays closed.
//   A2  AI key saved, but the store presence check FAILS -> gate stays
//       closed (fail closed, never re-prompt for a saved key). THIS is
//       the case that fails on 0.11.21 (the gate opened at the AI step)
//       and passes on 0.11.22.
//   B   no keys saved, healthy empty store  -> gate OPENS at the AI step
//       (canonical order AI -> TMDB -> football-data).
//
// HOW THE AI KEY IS SEEDED — Tauri IPC bridge stub (read this before
// changing the seeding): the e2e runner serves the production WEB build
// (`astro preview`), so there is no Tauri runtime, no WebView and no OS
// credential store. The AI key can therefore never be seeded through
// localStorage — by design it is never written there (see
// src/scripts/lib/ai/keystore.ts). Instead each test installs, via
// `addInitScript` (before any app script runs), a minimal
// `window.__TAURI_INTERNALS__` stub that answers exactly the commands
// the Rust side exposes (`ai_key_has` / `ai_key_get` / `ai_key_set` /
// `ai_key_delete` in src-tauri/src/ai_keyring.rs) against an in-memory
// flag. That keeps the test on the REAL code path — the real `hasAiKey()`
// calls the real `invoke("ai_key_has")`, including its 200ms retry and
// its error classification — with only the IPC transport faked. The
// alternatives were worse: driving the app's own Settings flow to save
// a key needs the same bridge (circular), and a test-only command in
// the Rust backend would ship test surface in the desktop app.
//   - TMDB and football-data.org keys ARE seeded in localStorage
//     (`xt_tmdb_key`, `xt_football_data_key`), exactly as Settings
//     writes them — those keys live in localStorage in production.
//   - The stub also answers `plugin:event|*` and `plugin:log|log`
//     with benign values (a real Tauri runtime succeeds those); every
//     other command throws, so a test never silently fakes a desktop
//     API the app actually needs.
//   - `ai_key_has` failing in case A2 is persistent (every call,
//     including the retry) — that is the user's failure mode: a saved
//     key whose presence check errors.
//   - All key values are SYNTHETIC placeholders. No key value is ever
//     logged: the stub records command NAMES only (`window.__ipcCalls`).
//
// WIRING: no new config and no new CI workflow. This file lives under
// tests/e2e, so the existing `e2e` Playwright project picks it up and
// `pnpm test:e2e` runs it (the visual-regression workflow already runs
// `pnpm test:e2e` after `pnpm build` on PRs).
//
// RUN:  pnpm build && pnpm test:e2e -- tests/e2e/keys-onboarding-gate.spec.ts
// (full suite: pnpm build && pnpm test:e2e)
import { test, expect, type Page } from "@playwright/test"

const DIALOG_ID = "xt-keys-onboarding-dialog"

interface StubOptions {
  /** The stub credential store holds a (synthetic) AI key. */
  seedAiKey: boolean
  /** Every `ai_key_has` call rejects with a STORE error (case A2). */
  failPresenceCheck: boolean
  /** Seed TMDB + football-data.org keys in localStorage (as Settings does). */
  seedLocalStorageKeys: boolean
}

/**
 * Tauri IPC bridge stub + localStorage seeding, installed before any app
 * script runs. Self-contained (Playwright serialises it into the page);
 * takes only booleans, never a key value, as its argument.
 */
function installKeyStoreStub(options: StubOptions): void {
  const store = { hasAiKey: options.seedAiKey }
  const calls: string[] = []
  const win = window as unknown as {
    __ipcCalls: string[]
    __TAURI_INTERNALS__: unknown
  }
  win.__ipcCalls = calls
  let callbackId = 0
  win.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      calls.push(cmd)
      if (cmd === "ai_key_has") {
        if (options.failPresenceCheck) {
          throw new Error("STORE:credential store unavailable")
        }
        return store.hasAiKey
      }
      if (cmd === "ai_key_get") {
        return store.hasAiKey ? "synthetic-ai-key-for-e2e-only" : null
      }
      if (cmd === "ai_key_set") {
        store.hasAiKey = true
        return true
      }
      if (cmd === "ai_key_delete") {
        const had = store.hasAiKey
        store.hasAiKey = false
        return had
      }
      // Event + log plumbing a real Tauri runtime answers successfully.
      if (cmd === "plugin:event|listen") return args.handler
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null
      if (cmd === "plugin:log|log") return null
      throw new Error(`e2e stub: unhandled invoke ${cmd}`)
    },
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  }
  if (options.seedLocalStorageKeys) {
    try {
      // Synthetic values only — Settings writes these exact keys.
      localStorage.setItem("xt_tmdb_key", "synthetic-tmdb-key-for-e2e-only")
      localStorage.setItem("xt_football_data_key", "synthetic-football-data-key-for-e2e-only")
    } catch {
      // Storage unavailable: the test then fails on its assertions,
      // rather than passing vacuously.
    }
  }
}

async function ipcCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as { __ipcCalls?: string[] }
    return [...(win.__ipcCalls ?? [])]
  })
}

test.describe("keys onboarding launch gate (real browser)", () => {
  test("A1: all three keys saved, healthy store — gate stays closed", async ({ page }) => {
    await page.context().addInitScript(installKeyStoreStub, {
      seedAiKey: true,
      failPresenceCheck: false,
      seedLocalStorageKeys: true,
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    // Let the launch gate settle: presence check + its 200ms retry.
    await page.waitForTimeout(3000)
    await expect(page.locator(`#${DIALOG_ID}`)).toHaveCount(0)
    // Anti-vacuous guard: the presence check must actually have run —
    // a gate that never executed would also show no dialog.
    expect(await ipcCalls(page)).toContain("ai_key_has")
  })

  test("A2: AI key saved but store presence check fails — gate stays closed (fail closed)", async ({
    page,
  }) => {
    await page.context().addInitScript(installKeyStoreStub, {
      seedAiKey: true,
      failPresenceCheck: true,
      seedLocalStorageKeys: true,
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    // The retry doubles the check time; give the fail-safe room to engage.
    await page.waitForTimeout(3000)
    await expect(page.locator(`#${DIALOG_ID}`)).toHaveCount(0)
    expect(await ipcCalls(page)).toContain("ai_key_has")
  })

  test("B: no keys saved — gate opens at the AI step first", async ({ page }) => {
    await page.context().addInitScript(installKeyStoreStub, {
      seedAiKey: false,
      failPresenceCheck: false,
      seedLocalStorageKeys: false,
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    const dialog = page.locator(`#${DIALOG_ID}`)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator("h2")).toHaveText("Set up your keys")
    // Canonical order AI -> TMDB -> football-data: the first step is AI.
    await expect(dialog.locator("h3")).toHaveText("AI key")
    await expect(dialog).toContainText("Step 1 of 3")
    await expect(dialog.locator('[data-role="key-input"]')).toBeVisible()
    expect(await ipcCalls(page)).toContain("ai_key_has")
  })
})
