<script>
  // Controller-navigable on-screen keyboard for /search.
  //
  // The search input is a physical keyboard control; on the TV there is
  // no keyboard, so this QWERTY grid is the controller path to typing.
  // Keys are plain <button>s, so D-pad / spatial navigation moves between
  // them and A (click) types — no new navigation system is invented.
  //
  // Controller mapping (0.11.10, Controller 2.0 §28 — B NEVER deletes):
  //   A / Enter .......... type the focused character
  //   B / Escape ......... CLOSE the keyboard, focus returns to the
  //                        input (the shared lifecycle: closeCouchKeyboard;
  //                        the dismiss fallback is the onDismiss prop).
  //                        Deletion is the ⌫ KEY's job, never B's.
  //   Backspace (physical)  delete one character (as before).
  //   X (controller) ..... NO shortcut: the old rAF Gamepad API poll
  //                        (slot-0-only, invisible to the native XInput
  //                        path) was removed in 0.11.10 — the Clear KEY
  //                        below is the clear path. The gamepad layer
  //                        maps X to details/play-pause elsewhere and
  //                        never emits a key for it on search surfaces.
  //   D-pad / stick ...... move between keys (spatial navigation)
  //
  // The value is bound to the parent search query, so typing here and
  // typing in the physical input stay in sync.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    closeCouchKeyboard,
    isCouchKeyboardOpen,
    oskKeyAction,
  } from "@/scripts/lib/couch-keyboard.ts"

  /** @type {{ value?: string, onInput?: (value: string) => void, onCommit?: () => void, onDismiss?: () => void }} */
  let { value = $bindable(""), onInput, onCommit, onDismiss } = $props()

  const ROWS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]

  let locale = $state(0)
  const tr = (key, params) => (locale, t(key, params))

  function emit(next) {
    value = next
    onInput?.(next)
  }
  function typeChar(ch) {
    emit((value || "") + ch)
  }
  function backspace() {
    emit((value || "").slice(0, -1))
  }
  function clearAll() {
    emit("")
  }

  function dismiss() {
    // Shared lifecycle first (it owns the Back layer + focus return);
    // owners without a session fall back to the dismiss prop.
    if (isCouchKeyboardOpen()) closeCouchKeyboard(false)
    else onDismiss?.()
  }

  function onKeyDown(ev) {
    // B (Escape) dismisses; physical Backspace deletes. Never let
    // either reach the search view's clear-query handler.
    const action = oskKeyAction(ev.key)
    if (action === "dismiss") {
      ev.preventDefault()
      ev.stopPropagation()
      dismiss()
    } else if (action === "backspace") {
      ev.preventDefault()
      ev.stopPropagation()
      backspace()
    }
  }

  onMount(() => {
    const onLocale = () => {
      locale++
    }
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener(LOCALE_EVENT, onLocale)
    }
  })
</script>

<div
  data-osk
  onkeydown={onKeyDown}
  class="osk shrink-0 rounded-xl border border-line bg-surface p-2 sm:p-3 flex flex-col gap-1.5">
  {#each ROWS as row (row)}
    <div class="flex gap-1.5 justify-center" role="group">
      {#each row as ch (ch)}
        <button
          type="button"
          data-osk-key={ch}
          onclick={() => typeChar(ch)}
          aria-label={ch}
          class="osk-key flex-1 min-h-11 sm:min-h-12 rounded-lg border border-line bg-surface-2
            text-fg text-base sm:text-lg font-medium
            hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors">
          {ch}
        </button>
      {/each}
      {#if row === "ZXCVBNM"}
        <button
          type="button"
          data-osk-action="backspace"
          onclick={backspace}
          aria-label={tr("search.keyboard.backspace")}
          class="osk-key flex-[2] min-h-11 sm:min-h-12 rounded-lg border border-line bg-surface-2
            text-fg text-base sm:text-lg font-medium
            hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors">
          ⌫
        </button>
      {/if}
    </div>
  {/each}
  <div class="flex gap-1.5 justify-center">
    <button
      type="button"
      data-osk-action="space"
      onclick={() => typeChar(" ")}
      aria-label={tr("search.keyboard.space")}
      class="osk-key flex-[5] min-h-11 sm:min-h-12 rounded-lg border border-line bg-surface-2
        text-fg-2 text-base sm:text-lg font-medium
        hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors">
      {tr("search.keyboard.space")}
    </button>
    <button
      type="button"
      data-osk-action="clear"
      onclick={clearAll}
      aria-label={tr("search.keyboard.clear")}
      class="osk-key flex-[2] min-h-11 sm:min-h-12 rounded-lg border border-accent/40 bg-accent-soft
        text-accent text-base sm:text-lg font-medium
        hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors">
      {tr("search.keyboard.clear")}
    </button>
    <button
      type="button"
      data-osk-action="search"
      onclick={() => onCommit?.()}
      aria-label={tr("search.keyboard.search")}
      class="osk-key flex-[2] min-h-11 sm:min-h-12 rounded-lg border border-accent bg-accent
        text-white text-base sm:text-lg font-semibold
        hover:brightness-110 focus-visible:brightness-110 outline-none transition-colors">
      {tr("search.keyboard.search")}
    </button>
  </div>
  <p class="text-center text-2xs text-fg-3 pt-0.5">{tr("search.keyboardHint")}</p>
</div>

<style>
  /* Nylah Studios v0.3.0 (w7) — RedSilk keyboard: warm gradient keys +
     tray, wine focus glow, lit Search key. */
  .osk {
    background: linear-gradient(180deg, var(--nylah-surface-warm, var(--color-surface)), var(--nylah-surface-2-warm, var(--color-surface-2)));
    box-shadow: var(--nylah-card-shadow, 0 10px 28px -14px var(--nylah-focus-glow));
  }
  .osk-key[data-osk-key],
  .osk-key[data-osk-action="backspace"],
  .osk-key[data-osk-action="space"] {
    background: linear-gradient(180deg, var(--nylah-surface-warm, var(--color-surface-2)), var(--nylah-surface-2-warm, var(--color-surface-3)));
  }
  .osk-key[data-osk-action="clear"] {
    box-shadow: 0 0 14px -2px var(--nylah-focus-glow, var(--color-accent-soft));
  }
  .osk-key[data-osk-action="search"] {
    background: linear-gradient(180deg, var(--nylah-wine, var(--color-accent)), var(--nylah-wine-deep, var(--color-accent)));
    box-shadow: var(--nylah-focus-glow-strong, 0 0 24px 2px var(--nylah-focus-glow));
  }
  /* Glowing focus ring, same language as the poster cards: accent ring
     plus a soft accent halo so the focused key reads from the couch. */
  .osk-key:focus-visible {
    border-color: var(--nylah-focus-ring, var(--color-accent));
    box-shadow:
      0 0 0 2px var(--nylah-focus-ring, var(--color-accent)),
      0 0 18px 2px var(--nylah-focus-glow, var(--color-accent-soft));
  }
  .osk-key:active {
    background: var(--color-accent-soft);
  }
  @media (prefers-reduced-motion: reduce) {
    .osk-key { transition: none; }
    .osk,
    .osk-key[data-osk-action="clear"],
    .osk-key[data-osk-action="search"] {
      box-shadow: none;
    }
  }
</style>
