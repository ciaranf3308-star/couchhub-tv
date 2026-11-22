// Settings polish 95, worker 3 — real-browser e2e (production build + Playwright).
//
//   R1  Save the football-data key in onboarding, skip the AI step —
//       the Settings football card shows "Feed active" with NO reload.
//   R2  Fail-closed in the real app: storage reads that throw for the
//       TMDB / football-data keys never prompt for a saved key — the
//       launch gate stays closed, and Settings shows the "couldn't
//       check" line with a Check-again retest control instead of the
//       "Set up key" prompt. One unreadable key (AI store failing)
//       never blocks the prompt for a genuinely missing key.
//   R3  Locales de / fr / es / ja: the Settings page renders the
//       friendly 0.11.23 copy translated (page sub, danger + backup
//       helpers). Section-head one-liners are keyed by this worker but
//       their data-i18n wiring is worker 1's file, so they are NOT
//       asserted here yet.
//
// RUN:  pnpm build && npx playwright test --project=e2e tests/e2e/settings-polish-95-w3.spec.ts
import { test, expect, type Page } from "@playwright/test"

test.use({ viewport: { width: 1672, height: 941 } })

// Serial in this file: one Chromium at a time. Parallel workers in this
// sandbox OOM the renderer ("Page crashed" on plain navigations) and two
// full page loads + the 3 s gate settle can exceed the 30 s default.
test.describe.configure({ mode: "serial" })
test.setTimeout(120_000)

const DIALOG_ID = "xt-keys-onboarding-dialog"
const SHOTS =
  "/home/hatch/workspace/goals/couchhub-tv-controller-first-iptv-app/hidden_files/settings-polish-95"
const FD_KEY = "synthetic-football-data-key-for-e2e-only"

async function gotoSettings(page: Page) {
  await page.goto("/settings#discover-ai", { waitUntil: "domcontentloaded" })
  await page.waitForSelector("#card-football-data")
  await page.waitForSelector("#settings-football-data-state")
}

/** Minimal Tauri IPC stub (same shape as keys-onboarding-gate.spec.ts):
 *  answers ai_key_* against an in-memory flag; every other command throws. */
function installKeyStoreStub(options: { seedAiKey: boolean; failPresenceCheck: boolean }): void {
  const store = { hasAiKey: options.seedAiKey }
  const win = window as unknown as { __TAURI_INTERNALS__: unknown }
  let callbackId = 0
  win.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "ai_key_has") {
        if (options.failPresenceCheck) throw new Error("STORE:credential store unavailable")
        return store.hasAiKey
      }
      if (cmd === "ai_key_get") return store.hasAiKey ? "synthetic-ai-key-for-e2e-only" : null
      if (cmd === "ai_key_set") {
        store.hasAiKey = true
        return true
      }
      if (cmd === "ai_key_delete") {
        const had = store.hasAiKey
        store.hasAiKey = false
        return had
      }
      if (cmd === "plugin:event|listen") return args.handler
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null
      if (cmd === "plugin:log|log") return null
      throw new Error(`e2e stub: unhandled invoke ${cmd}`)
    },
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  }
}

/** Break localStorage reads for the two localStorage-backed keys only.
 *  `window.__breakKeyReads` flips the break off again (retest path). */
function installBreakingKeyReads(): void {
  const win = window as unknown as { __breakKeyReads: boolean }
  win.__breakKeyReads = true
  const rawGetItem = Storage.prototype.getItem
  Storage.prototype.getItem = function (key: string) {
    if (
      (window as unknown as { __breakKeyReads?: boolean }).__breakKeyReads &&
      (key === "xt_tmdb_key" || key === "xt_football_data_key")
    ) {
      throw new Error("e2e: storage locked")
    }
    return rawGetItem.call(this, key)
  }
}

test.describe("R1: keys-card refresh on skip-after-save (real browser)", () => {
  test("saving the football-data key then skipping AI refreshes the card without a reload", async ({
    page,
  }) => {
    await gotoSettings(page)
    const setupBtn = page.locator("#settings-football-data-setup-key")
    await expect(setupBtn).toBeVisible()
    await expect(page.locator("#settings-football-data-state")).toContainText("No key")

    await setupBtn.click()
    const dialog = page.locator(`#${DIALOG_ID}`)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("Step 1 of 3")

    await dialog.locator('[data-role="key-input"]').fill(FD_KEY)
    await dialog.locator('[data-role="save-without-test"]').click()
    // Saved — the dialog advances to the next missing step (AI).
    await expect(dialog.locator("h3")).toHaveText("AI key")

    await dialog.locator('[data-role="skip"]').click()
    await expect(dialog).toHaveCount(0)

    // No reload: the card re-read its storage and shows the save.
    await expect(page.locator("#settings-football-data-state")).toContainText("Feed active")
    await expect(page.locator("#settings-football-data-key")).toHaveValue(FD_KEY)
    await expect(page.locator("#settings-football-data-setup-key")).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem("xt_football_data_key"))).toBe(FD_KEY)
    await page.screenshot({ path: `${SHOTS}/r1-football-card-after-skip.png` })
  })
})

test.describe("R2: fail-closed presence in the real app", () => {
  test("AI store failing + other keys saved — launch gate stays closed", async ({ page }) => {
    await page.context().addInitScript(installKeyStoreStub, {
      seedAiKey: true,
      failPresenceCheck: true,
    })
    await page.context().addInitScript(() => {
      try {
        localStorage.setItem("xt_tmdb_key", "synthetic-tmdb-key-for-e2e-only")
        localStorage.setItem("xt_football_data_key", "synthetic-football-data-key-for-e2e-only")
      } catch {}
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3000)
    await expect(page.locator(`#${DIALOG_ID}`)).toHaveCount(0)
  })

  test("AI store failing + TMDB genuinely missing — gate opens at TMDB, never at AI", async ({
    page,
  }) => {
    await page.context().addInitScript(installKeyStoreStub, {
      seedAiKey: true,
      failPresenceCheck: true,
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    const dialog = page.locator(`#${DIALOG_ID}`)
    await expect(dialog).toBeVisible()
    // Per-key rule: the unreadable AI key counts as saved, so the
    // first missing key — TMDB — is the first step. The dialog counts
    // only the missing steps (2: TMDB + football-data) and shows the
    // saved AI key as a done row, never as a step to re-enter.
    await expect(dialog.locator("h3")).toHaveText("TMDB key")
    await expect(dialog).toContainText("Step 1 of 2")
    await expect(dialog).toContainText("AI key — saved in the OS credential store")
  })

  test("TMDB / football-data reads throwing — Settings shows unknown + retest, never a prompt", async ({
    page,
  }) => {
    await page.context().addInitScript(installKeyStoreStub, {
      seedAiKey: true,
      failPresenceCheck: false,
    })
    await page.context().addInitScript(installBreakingKeyReads)
    await page.context().addInitScript(() => {
      try {
        // Values are stored (the test would pass vacuously if the
        // keys were simply absent — the break makes reads throw).
        localStorage.setItem("xt_tmdb_key", "synthetic-tmdb-key-for-e2e-only")
        localStorage.setItem("xt_football_data_key", "synthetic-football-data-key-for-e2e-only")
      } catch {}
    })
    // The gate must stay quiet: both localStorage keys are unreadable
    // (counted saved) and the AI key is saved.
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3000)
    await expect(page.locator(`#${DIALOG_ID}`)).toHaveCount(0)

    await gotoSettings(page)
    await expect(page.locator("#settings-tmdb-state")).toContainText(
      "Couldn't check whether a key is saved",
    )
    await expect(page.locator("#settings-tmdb-setup-key")).toBeHidden()
    await expect(page.locator("#settings-tmdb-recheck")).toBeVisible()
    await expect(page.locator("#settings-football-data-state")).toContainText(
      "Couldn't check whether a key is saved",
    )
    await expect(page.locator("#settings-football-data-setup-key")).toBeHidden()
    await expect(page.locator("#settings-football-data-recheck")).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/r2-keys-unreadable.png` })

    // Retest: un-break the reads, Check again shows the real state.
    await page.evaluate(() => {
      ;(window as unknown as { __breakKeyReads: boolean }).__breakKeyReads = false
    })
    await page.locator("#settings-tmdb-recheck").click()
    await expect(page.locator("#settings-tmdb-state")).toContainText("Enrichment active.")
    await expect(page.locator("#settings-tmdb-recheck")).toBeHidden()
    await page.locator("#settings-football-data-recheck").click()
    await expect(page.locator("#settings-football-data-state")).toContainText("Feed active")
    await expect(page.locator("#settings-football-data-recheck")).toBeHidden()
    await expect(page.locator("#settings-football-data-key")).toHaveValue(
      "synthetic-football-data-key-for-e2e-only",
    )
    await page.screenshot({ path: `${SHOTS}/r2-keys-after-recheck.png` })
  })
})

test.describe("R3: locales render the friendly copy (real browser)", () => {
  const cases = [
    {
      code: "de",
      sub: "Alles darüber, wie die App aussieht, abspielt und sich verbindet — an einem Ort. Springe oben zu einem Bereich oder scrolle einfach.",
      danger: "fast alle",
      backup: "football-data-Schlüssel",
    },
    {
      code: "fr",
      sub: "Tout sur l'apparence, la lecture et les connexions de l'app — au même endroit. Allez à une section ci-dessus, ou faites simplement défiler.",
      danger: "presque toutes",
      backup: "clé football-data",
    },
    {
      code: "es",
      sub: "Todo sobre cómo se ve, suena y se conecta la app — en un solo lugar. Salta a una sección arriba, o simplemente desplázate.",
      danger: "casi todos",
      backup: "clave de football-data",
    },
    {
      code: "ja",
      sub: "アプリの見た目、再生、接続について、すべてここに。上のセクションへ移動するか、そのままスクロールしてください。",
      danger: "ほぼすべて",
      backup: "football-dataキー",
    },
  ] as const

  for (const { code, sub, danger, backup } of cases) {
    test(`Settings renders the friendly copy in ${code}`, async ({ page }) => {
      await page.context().addInitScript((locale) => {
        try {
          localStorage.setItem("xt_locale", locale)
        } catch {}
      }, code)
      await page.goto("/settings", { waitUntil: "domcontentloaded" })
      await page.waitForSelector(".route-hero__sub")
      await expect(page.locator(".route-hero__sub")).toHaveText(sub, { timeout: 10_000 })
      await expect(page.locator('[data-i18n-html="settings.danger.helperLong"]')).toContainText(
        danger,
      )
      await expect(page.locator('[data-i18n="settings.backup.helperLong"]')).toContainText(backup)
      await page.screenshot({ path: `${SHOTS}/r3-settings-${code}.png` })
    })
  }
})
