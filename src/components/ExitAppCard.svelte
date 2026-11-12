<script>
  // "Exit NylahBox Studios" card (0.11.4 W3) — full-width,
  // controller-focusable button directly under the Close button
  // behavior card. Two-step arm (tap once to arm, again to exit) so
  // a stray D-pad press can never quit the app; never shown on any
  // playback OSD. The exit itself runs requestAppExit(): Live TV
  // release first, then VOD resume flush, download pause, and the
  // `quit_app` Tauri command.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { requestAppExit } from "@/scripts/lib/app-exit.ts"

  let locale = $state(0)
  let armed = $state(false)
  let exiting = $state(false)
  let armTimer = null
  const tr = (key) => (locale, t(key))

  function disarm() {
    armed = false
    if (armTimer) {
      clearTimeout(armTimer)
      armTimer = null
    }
  }

  function onExitClick() {
    if (exiting) return
    if (!armed) {
      armed = true
      armTimer = setTimeout(disarm, 4000)
      return
    }
    disarm()
    exiting = true
    void requestAppExit().finally(() => {
      // If quit did not happen (web preview), re-enable the button.
      exiting = false
    })
  }

  onMount(() => {
    const onLocale = () => { locale++ }
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener(LOCALE_EVENT, onLocale)
      disarm()
    }
  })
</script>

<div
  id="exit-app-section"
  data-settings-item
  data-testid="exit-app-section"
  class="settings-row scroll-mt-6 lg:scroll-mt-20 border-t border-line/60">
  <div class="settings-row__text">
    <h3 class="text-sm font-medium leading-snug">{tr("settings.exit.title")}</h3>
    <p class="text-xs text-fg-3">{tr("settings.exit.helper")}</p>
  </div>
  <div class="settings-row__control">
    <button
      type="button"
      data-testid="exit-app-button"
      class="exit-app-btn btn"
      class:exit-app-btn--armed={armed}
      disabled={exiting}
      aria-live="polite"
      onclick={onExitClick}>
      {#if exiting}
        {tr("settings.exit.exiting")}
      {:else if armed}
        {tr("settings.exit.confirm")}
      {:else}
        {tr("settings.exit.button")}
      {/if}
    </button>
  </div>
</div>

<style>
  /* Full-width exit button; armed state is lit wine, not just text. */
  .exit-app-btn {
    width: 100%;
    justify-content: center;
    border-color: var(--color-accent);
  }
  .exit-app-btn--armed {
    background: linear-gradient(
      180deg,
      var(--color-accent-soft),
      color-mix(in oklch, var(--color-accent) 30%, transparent)
    );
    box-shadow: 0 0 18px var(--nylah-focus-glow);
  }
  .exit-app-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    box-shadow: 0 0 18px var(--nylah-focus-glow);
  }
</style>
