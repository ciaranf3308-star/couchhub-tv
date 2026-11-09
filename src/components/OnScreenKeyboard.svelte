<script>
  // Controller-navigable on-screen keyboard for /search.
  //
  // The search input is a physical keyboard control; on the TV there is
  // no keyboard, so this QWERTY grid is the controller path to typing.
  // Keys are plain <button>s, so D-pad / spatial navigation moves between
  // them and A (click) types — no new navigation system is invented.
  //
  // Controller mapping (the gamepad layer turns buttons into the events
  // below; physical keys do the same thing):
  //   A / Enter .......... type the focused character
  //   B / Escape ......... backspace (the keydown handler below; the
  //                        search view skips its own Escape handling while
  //                        focus is inside [data-osk])
  //   X (controller) ..... clear — polled here, because the gamepad layer
  //                        maps X to play/pause and never emits a key for
  //                        it. There is no video on /search, so hijacking
  //                        X while the search view owns focus is safe.
  //   D-pad / stick ...... move between keys (spatial navigation)
  //
  // The value is bound to the parent search query, so typing here and
  // typing in the physical input stay in sync.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"

  /** @type {{ value?: string, onInput?: (value: string) => void, onCommit?: () => void }} */
  let { value = $bindable(""), onInput, onCommit } = $props()

  const ROWS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
  // Standard-mapping X button index (see gamepad.ts).
  const BTN_X = 2

  let locale = $state(0)
  const tr = (key, params) => (locale, t(key, params))

  let rafId = 0
  let prevX = false

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

  function onKeyDown(ev) {
    // B on the controller arrives as Escape; physical Backspace does the
    // same. Never let it reach the search view's clear-query handler.
    if (ev.key === "Escape" || ev.key === "Backspace") {
      ev.preventDefault()
      ev.stopPropagation()
      backspace()
    }
  }

  function pollGamepadX() {
    rafId = requestAnimationFrame(pollGamepadX)
    if (document.hidden) return
    let pressed = false
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const gp = pads ? pads[0] ?? null : null
      pressed = !!(gp?.connected && gp.buttons?.[BTN_X]?.pressed)
    } catch {
      pressed = false
    }
    if (pressed && !prevX) {
      const active = document.activeElement
      if (active?.closest?.(".search-view")) clearAll()
    }
    prevX = pressed
  }

  onMount(() => {
    const onLocale = () => {
      locale++
    }
    document.addEventListener(LOCALE_EVENT, onLocale)
    rafId = requestAnimationFrame(pollGamepadX)
    return () => {
      document.removeEventListener(LOCALE_EVENT, onLocale)
      cancelAnimationFrame(rafId)
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
        text-bg text-base sm:text-lg font-semibold
        hover:brightness-110 focus-visible:brightness-110 outline-none transition-colors">
      {tr("search.keyboard.search")}
    </button>
  </div>
  <p class="text-center text-2xs text-fg-3 pt-0.5">{tr("search.keyboardHint")}</p>
</div>

<style>
  /* Glowing focus ring, same language as the poster cards: accent ring
     plus a soft accent halo so the focused key reads from the couch. */
  .osk-key:focus-visible {
    border-color: var(--color-accent);
    box-shadow:
      0 0 0 2px var(--color-accent-soft),
      0 0 18px var(--color-accent-soft);
  }
  .osk-key:active {
    background: var(--color-accent-soft);
  }
  @media (prefers-reduced-motion: reduce) {
    .osk-key { transition: none; }
  }
</style>
