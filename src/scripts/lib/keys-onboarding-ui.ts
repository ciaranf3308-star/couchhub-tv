// Keys onboarding — UI (programmatic dialog, no page markup needed).
//
// The hooks worker mounts this at launch and from key-dependent
// features via `openKeysOnboarding({ reason })`. One step per MISSING
// key only, in canonical order (AI → TMDB → football-data); a saved
// key shows as a done row (masked) and is never re-asked. Each step:
// what the key is for, where to get it, a paste field, a LIVE Test
// button (existing validators via keys-onboarding.ts — a bad key is
// caught here with a clear error), then Save.
//
// - AI step: endpoint (defaults to the OpenAI default) + model
//   (Settings' select + Custom pairing via resolveAiModelControl —
//   no saved model pre-fills the default `gpt-4o-mini`, so the step
//   can always reach a testable state: the key test requires a model
//   and an empty model fails as `invalid_model`) + "Turn on AI
//   Discovery" (checked). The AI test saves the typed key first,
//   exactly like Settings' Test button, because the Rust test reads
//   the STORED key; after a passed AI test the button is "Continue"
//   (the key is already stored). TMDB / football-data.org keys are
//   only saved by their Save button, after a passing test.
// - "Save without testing" is the offline escape hatch: it saves the
//   typed key unverified and moves on. A bad key saved this way is an
//   error state, never a re-prompt (see validateSavedKey).
// - B / Escape / Close / "I'll do it later" = skip: session-scoped
//   dismissal, never a trap, focus returns to the invoker via
//   closeCouchDialog. The dialog can never trap: every close path
//   resolves the promise.
// - Completion state: all three keys as done rows (masked; AI says
//   "saved in the OS credential store"), a "Check saved keys" button
//   that validates the STORED keys and marks failures inline with a
//   link to Settings (an error state, not a re-prompt), and Done.
// - Text entry uses the Settings plain password-field pattern
//   (type=password, never filled back for AI, autocomplete off).
//   The on-screen TvKeyboard is not wired here — a later pass can
//   mount it for controller-only typing; physical keyboard / chatpad
//   entry works today.
// - Keys are never logged and never shown in full. The typed key
//   lives only in the input + one local variable, cleared on advance
//   and on close.

import {
  dismissKeysOnboarding,
  getKeysOnboardingStatus,
  maskKeyForDisplay,
  resolveFirstStep,
  saveOnboardingKey,
  testOnboardingKey,
  validateSavedKey,
  KEY_ONBOARDING_DEFS,
  KEY_ONBOARDING_ORDER,
  type KeyOnboardingEntry,
  type KeyOnboardingId,
  type KeysOnboardingDeps,
  type KeysOnboardingReason,
  type KeysOnboardingStatus,
} from "@/scripts/lib/keys-onboarding.js"
import { getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import {
  DEFAULT_AI_MODEL,
  SUPPORTED_MODELS,
  resolveAiModelControl,
} from "@/scripts/lib/ai/status.ts"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import {
  closeCouchDialog,
  openCouchDialog,
} from "@/scripts/lib/couch-focus.js"

export interface OpenKeysOnboardingOptions {
  reason?: KeysOnboardingReason
  deps?: KeysOnboardingDeps
  /** Element focus returns to on close (defaults to activeElement). */
  invoker?: HTMLElement | null
}

export interface KeysOnboardingResult {
  outcome: "completed" | "skipped"
  /** Keys saved during this mount. */
  saved: KeyOnboardingId[]
  reason: KeysOnboardingReason
}

const DIALOG_ID = "xt-keys-onboarding-dialog"

const BUTTON_CLASS_PRIMARY =
  "rounded-xl px-4 py-2 text-sm font-semibold bg-accent text-bg " +
  "hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent " +
  "focus-visible:shadow-[0_0_20px_var(--nylah-focus-glow)]"

const BUTTON_CLASS_SECONDARY =
  "rounded-xl border border-line px-4 py-2 text-sm hover:bg-surface-2 " +
  "focus-visible:bg-surface-2 focus-visible:border-accent " +
  "focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"

/** One mount at a time: a second call while open returns the same promise. */
let activeMount: Promise<KeysOnboardingResult> | null = null

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export async function mountKeysOnboarding(
  options: OpenKeysOnboardingOptions = {},
): Promise<KeysOnboardingResult> {
  if (activeMount) return activeMount
  const reason: KeysOnboardingReason = options.reason ?? "launch"
  const deps = options.deps ?? {}
  activeMount = runMount(reason, deps, options.invoker ?? null)
  try {
    return await activeMount
  } finally {
    activeMount = null
  }
}

/** The launch gate / feature-entry hook. Same function, friendlier name. */
export const openKeysOnboarding = mountKeysOnboarding

async function runMount(
  reason: KeysOnboardingReason,
  deps: KeysOnboardingDeps,
  invoker: HTMLElement | null,
): Promise<KeysOnboardingResult> {
  const status = await getKeysOnboardingStatus(deps)
  const savedDuringSession: KeyOnboardingId[] = []
  /** Masked display for keys saved in this mount (status predates them). */
  const savedMasked = new Map<KeyOnboardingId, string | null>()
  let outcome: "completed" | "skipped" = "skipped"

  // Steps: missing keys in canonical order, starting at the reason's
  // key when it is missing (feature-entry hook).
  const firstStep = resolveFirstStep(reason, status)
  const queue: KeyOnboardingId[] =
    firstStep === null
      ? []
      : [
          firstStep,
          ...status.missing.filter((id) => id !== firstStep),
        ]
  let stepIndex = 0

  // A stale dialog from an earlier mount that never closed cleanly.
  document.getElementById(DIALOG_ID)?.remove()

  const dlg = document.createElement("dialog")
  dlg.id = DIALOG_ID
  dlg.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  dlg.className = "rs-dialog"
  dlg.innerHTML = `
    <div class="rs-dialog__inner">
      <div class="rs-dialog__head">
        <h2 class="rs-dialog__title" id="${DIALOG_ID}-title">Set up your keys</h2>
        <button type="button" class="rs-dialog__close" data-role="close">Close</button>
      </div>
      <div class="rs-dialog__body" data-role="body"></div>
    </div>
  `
  document.body.appendChild(dlg)
  const body = dlg.querySelector<HTMLElement>('[data-role="body"]')!

  let resolveResult: ((value: KeysOnboardingResult) => void) | null = null
  const resultPromise = new Promise<KeysOnboardingResult>((resolve) => {
    resolveResult = resolve
  })
  let settled = false

  function finish(): void {
    if (settled) return
    settled = true
    if (outcome !== "completed") {
      // Every non-completion close is a skip: session-scoped only.
      dismissKeysOnboarding()
      outcome = "skipped"
    }
    resolveResult?.({ outcome, saved: [...savedDuringSession], reason })
    dlg.remove()
  }

  dlg.addEventListener("close", () => finish())
  // A body swap or a removeAttribute("open") close (jsdom has no
  // showModal/close at all) never fires "close" — watch the attribute
  // too, so the promise always settles and the dialog never leaks.
  const openObserver = new MutationObserver(() => {
    if (!dlg.hasAttribute("open")) finish()
  })
  openObserver.observe(dlg, { attributes: true, attributeFilter: ["open"] })
  dlg
    .querySelector('[data-role="close"]')
    ?.addEventListener("click", () => closeCouchDialog(DIALOG_ID))

  attachDialogSpatialNav(dlg, {
    defaultElement: `#${DIALOG_ID} [data-role="key-input"]`,
  })

  function doneRows(entries: KeyOnboardingEntry[]): string {
    const done = entries.filter((entry) => entry.saved)
    if (done.length === 0) return ""
    return `
      <div class="flex flex-col gap-1.5" data-role="done-rows">
        ${done
          .map((entry) => {
            const detail =
              entry.id === "ai"
                ? "saved in the OS credential store"
                : entry.masked
                  ? `saved · ${escapeHtml(entry.masked)}`
                  : "saved"
            const note = entry.setupNote
              ? `<span class="block text-xs text-fg-3">${escapeHtml(entry.setupNote)}</span>`
              : ""
            return `<p class="text-sm text-fg-2">✓ ${escapeHtml(entry.name)} — ${detail}${note}</p>`
          })
          .join("")}
      </div>
    `
  }

  function renderStep(): void {
    const id = queue[stepIndex]
    const def = KEY_ONBOARDING_DEFS[id]
    const total = queue.length
    const currentStatus: KeysOnboardingStatus = {
      ...status,
      entries: status.entries.map((entry) =>
        savedDuringSession.includes(entry.id)
          ? {
              ...entry,
              saved: true,
              masked:
                entry.id === "ai"
                  ? null
                  : (savedMasked.get(entry.id) ?? entry.masked),
            }
          : entry,
      ),
    }
    // AI step state lives in locals until Test/Save applies it — a
    // skip must not half-write endpoint/model/enabled to Settings.
    // No saved model pre-fills the default (gpt-4o-mini): the key
    // test requires a model, and "Custom…" with an empty box cannot
    // pass — the step would not be completable with a valid key.
    let aiEndpoint = getAiEndpoint()
    let aiModel = getAiModel() || DEFAULT_AI_MODEL
    let aiEnable = true
    let testedOk = false

    const aiFields =
      id === "ai"
        ? `
      <div class="flex flex-col gap-1">
        <label for="${DIALOG_ID}-endpoint" class="text-sm font-medium">Endpoint</label>
        <input id="${DIALOG_ID}-endpoint" data-role="endpoint-input" type="text"
          autocomplete="off" spellcheck="false"
          class="field-input font-mono w-full" value="${escapeHtml(aiEndpoint)}" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="${DIALOG_ID}-model" class="text-sm font-medium">Model</label>
        <select id="${DIALOG_ID}-model" data-role="model-select" class="field-input w-full">
          ${SUPPORTED_MODELS.map(
            (model) =>
              `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`,
          ).join("")}
          <option value="custom">Custom…</option>
        </select>
        <input id="${DIALOG_ID}-model-custom" data-role="model-custom-input" type="text"
          autocomplete="off" spellcheck="false" placeholder="Type a model id"
          class="field-input font-mono w-full hidden" />
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" data-role="enable-input" checked />
        Turn on AI Discovery when the key is saved
      </label>
    `
        : ""

    body.innerHTML = `
      <div class="flex flex-col gap-4">
        ${doneRows(currentStatus.entries)}
        <p class="text-xs text-fg-3">Step ${stepIndex + 1} of ${total}</p>
        <div class="flex flex-col gap-1.5">
          <h3 class="font-semibold">${escapeHtml(def.name)}</h3>
          <p class="text-sm text-fg-2">${escapeHtml(def.unlocks)}</p>
          <a href="${escapeHtml(def.getKeyUrl)}" target="_blank" rel="noopener noreferrer"
            data-external class="self-start text-sm font-medium text-accent hover:underline focus-visible:underline focus-visible:outline-none">${escapeHtml(def.getKeyLabel)}</a>
        </div>
        <div class="flex flex-col gap-3">
          ${aiFields}
          <div class="flex flex-col gap-1">
            <label for="${DIALOG_ID}-key" class="text-sm font-medium">Paste your key</label>
            <div class="flex gap-2">
              <input id="${DIALOG_ID}-key" data-role="key-input" type="password"
                autocomplete="off" spellcheck="false"
                class="field-input font-mono flex-1 min-w-0" />
              <button type="button" data-role="test" class="${BUTTON_CLASS_SECONDARY} flex-none">Test key</button>
            </div>
            <p data-role="message" aria-live="polite" class="text-xs text-fg-3 empty:hidden"></p>
          </div>
        </div>
        <div class="flex gap-2 justify-end flex-wrap">
          <button type="button" data-role="skip" class="${BUTTON_CLASS_SECONDARY}">I&rsquo;ll do it later</button>
          <button type="button" data-role="save-without-test" class="self-center text-xs text-fg-3 underline hover:text-fg-2 focus-visible:text-fg-2 focus-visible:outline-none">Save without testing</button>
          <button type="button" data-role="save" disabled class="${BUTTON_CLASS_PRIMARY} disabled:opacity-40">${id === "ai" ? "Continue" : "Save key"}</button>
        </div>
      </div>
    `

    const keyInput = body.querySelector<HTMLInputElement>('[data-role="key-input"]')!
    const testBtn = body.querySelector<HTMLButtonElement>('[data-role="test"]')!
    const saveBtn = body.querySelector<HTMLButtonElement>('[data-role="save"]')!
    const skipBtn = body.querySelector<HTMLButtonElement>('[data-role="skip"]')!
    const saveWithoutTestBtn = body.querySelector<HTMLButtonElement>(
      '[data-role="save-without-test"]',
    )!
    const messageEl = body.querySelector<HTMLElement>('[data-role="message"]')!

    function showMessage(text: string): void {
      messageEl.textContent = text
    }

    // AI model control: Settings' select + Custom pairing. Kept in
    // locals until Test/Save — see the note above renderStep.
    const modelSelect = body.querySelector<HTMLSelectElement>(
      '[data-role="model-select"]',
    )
    const modelCustomInput = body.querySelector<HTMLInputElement>(
      '[data-role="model-custom-input"]',
    )
    const endpointInput = body.querySelector<HTMLInputElement>(
      '[data-role="endpoint-input"]',
    )
    const enableInput = body.querySelector<HTMLInputElement>(
      '[data-role="enable-input"]',
    )
    if (modelSelect && modelCustomInput) {
      const syncModelControl = () => {
        const { selectValue, showCustom, customValue } =
          resolveAiModelControl(aiModel)
        modelSelect.value = selectValue
        modelCustomInput.classList.toggle("hidden", !showCustom)
        if (showCustom) modelCustomInput.value = customValue
      }
      syncModelControl()
      modelSelect.addEventListener("change", () => {
        if (modelSelect.value === "custom") {
          modelCustomInput.classList.remove("hidden")
          modelCustomInput.focus()
          aiModel = modelCustomInput.value
          return
        }
        modelCustomInput.classList.add("hidden")
        aiModel = modelSelect.value
      })
      modelCustomInput.addEventListener("input", () => {
        aiModel = modelCustomInput.value
      })
    }
    endpointInput?.addEventListener("input", () => {
      aiEndpoint = endpointInput.value
    })
    enableInput?.addEventListener("change", () => {
      aiEnable = enableInput.checked
    })

    keyInput.addEventListener("input", () => {
      testBtn.disabled = !keyInput.value.trim()
      if (testedOk) {
        // The key changed after a pass — the pass no longer applies.
        testedOk = false
        saveBtn.disabled = true
      }
    })
    testBtn.disabled = true

    async function runTest(): Promise<boolean> {
      const value = keyInput.value
      if (!value.trim()) {
        showMessage("Enter a key first.")
        return false
      }
      testBtn.disabled = true
      showMessage("Testing…")
      try {
        const result = await testOnboardingKey(
          id,
          value,
          id === "ai"
            ? { endpoint: aiEndpoint, model: aiModel, enableAi: aiEnable }
            : {},
          deps,
        )
        if (result.ok) {
          testedOk = true
          saveBtn.disabled = false
          showMessage(
            id === "ai"
              ? result.modelVerified
                ? "Key verified — endpoint, key and model all check out."
                : "Key verified — endpoint and key check out."
              : "Key verified.",
          )
          saveBtn.focus({ preventScroll: true })
          return true
        }
        showMessage(result.message ?? "That key didn't work. Check the key and try again.")
        return false
      } finally {
        testBtn.disabled = !keyInput.value.trim()
      }
    }

    async function saveAndAdvance(verified: boolean): Promise<void> {
      const value = keyInput.value
      if (!value.trim()) {
        showMessage("Enter a key first.")
        return
      }
      saveBtn.disabled = true
      showMessage("Saving…")
      // AI after a passed test is already stored (the test saves it);
      // Save is a no-op confirmation. Everything else saves now.
      const result =
        id === "ai" && verified
          ? { ok: true as const }
          : await saveOnboardingKey(
              id,
              value,
              id === "ai"
                ? { endpoint: aiEndpoint, model: aiModel, enableAi: aiEnable }
                : {},
              deps,
            )
      if (!result.ok) {
        showMessage(
          result.message ?? "Could not save the key. Try again.",
        )
        saveBtn.disabled = false
        return
      }
      savedDuringSession.push(id)
      if (id !== "ai") savedMasked.set(id, maskKeyForDisplay(value))
      keyInput.value = ""
      stepIndex += 1
      if (stepIndex >= queue.length) renderCompletion()
      else renderStep()
    }

    testBtn.addEventListener("click", () => void runTest())
    saveBtn.addEventListener("click", () => void saveAndAdvance(true))
    saveWithoutTestBtn.addEventListener("click", () =>
      void saveAndAdvance(false),
    )
    skipBtn.addEventListener("click", () => {
      closeCouchDialog(DIALOG_ID)
    })
    keyInput.focus({ preventScroll: true })
  }

  function renderCompletion(): void {
    void getKeysOnboardingStatus(deps).then((fresh) => {
      // The dialog may have been skipped while the status was loading.
      if (!dlg.isConnected) return
      body.innerHTML = `
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <h3 class="font-semibold">All set</h3>
            <p class="text-sm text-fg-2">All three keys are saved. You won't be asked for them again.</p>
          </div>
          ${doneRows(fresh.entries)}
          <p data-role="check-message" aria-live="polite" class="text-xs text-fg-3 empty:hidden"></p>
          <div class="flex gap-2 justify-end flex-wrap">
            <button type="button" data-role="check-saved" class="${BUTTON_CLASS_SECONDARY}">Check saved keys</button>
            <button type="button" data-role="done" class="${BUTTON_CLASS_PRIMARY}">Done</button>
          </div>
        </div>
      `
      const doneBtn = body.querySelector<HTMLButtonElement>('[data-role="done"]')!
      const checkBtn = body.querySelector<HTMLButtonElement>(
        '[data-role="check-saved"]',
      )!
      const checkMessageEl = body.querySelector<HTMLElement>(
        '[data-role="check-message"]',
      )!
      doneBtn.addEventListener("click", () => {
        outcome = "completed"
        closeCouchDialog(DIALOG_ID)
      })
      checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true
        checkMessageEl.textContent = "Checking saved keys…"
        const rows = body.querySelectorAll("[data-role='done-rows'] p")
        for (const entryId of KEY_ONBOARDING_ORDER) {
          const checked = await validateSavedKey(entryId, deps)
          if (checked.ok) continue
          const row = [...rows].find((el) =>
            el.textContent?.includes(KEY_ONBOARDING_DEFS[entryId].name),
          )
          if (row) {
            const warn = document.createElement("span")
            warn.className = "block text-xs"
            warn.textContent = ` — ${checked.message ?? "That saved key didn't work."} Fix it in Settings.`
            row.appendChild(warn)
          }
        }
        checkMessageEl.textContent =
          "Checked. A key that failed is an error to fix in Settings — it won't re-open this setup."
        checkBtn.disabled = false
      })
      doneBtn.focus({ preventScroll: true })
    })
  }

  if (queue.length === 0) renderCompletion()
  else renderStep()

  openCouchDialog(DIALOG_ID, invoker)
  // openCouchDialog focuses the first focusable (Close); the step
  // focuses its key input itself on render. Re-assert after open in
  // case render ran first.
  dlg.querySelector<HTMLElement>('[data-role="key-input"]')?.focus({
    preventScroll: true,
  })

  return resultPromise
}
