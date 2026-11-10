<script>
  // "Use native Android video player" card - Android Tauri only. Stays hidden
  // on desktop / web / iOS where the bridge isn't available.
  //
  // When enabled, /movies, /series, and /livetv hand the entire playback
  // session over to VideoActivity (ExoPlayer + Media3 PlayerView). Trade-off:
  // proper PiP (just the video, not the whole WebView), MediaSession
  // lock-screen + Bluetooth controls, hardened HLS decoding.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    getAndroidNativePlayerEnabled,
    setAndroidNativePlayerEnabled,
    ANDROID_NATIVE_PLAYER_EVENT,
  } from "@/scripts/lib/app-settings.js"

  let available = $state(false)
  let enabled = $state(getAndroidNativePlayerEnabled())
  let locale = $state(0)
  const tr = (key) => (locale, t(key))

  function pick(value) {
    setAndroidNativePlayerEnabled(value)
  }

  onMount(() => {
    available =
      !!(window.__TAURI_INTERNALS__ || window.__TAURI__) &&
      /Android/i.test(navigator.userAgent || "") &&
      !!window.AndroidVideo?.launchVod
    const onChange = (event) => {
      const next = event?.detail?.value
      enabled = typeof next === "boolean" ? next : getAndroidNativePlayerEnabled()
    }
    const onLocale = () => { locale++ }
    document.addEventListener(ANDROID_NATIVE_PLAYER_EVENT, onChange)
    document.addEventListener(LOCALE_EVENT, onLocale)
    return () => {
      document.removeEventListener(ANDROID_NATIVE_PLAYER_EVENT, onChange)
      document.removeEventListener(LOCALE_EVENT, onLocale)
    }
  })
</script>

{#if available}
  <div
    id="android-native-player-section"
    data-settings-item
    class="settings-row scroll-mt-6 lg:scroll-mt-20 border-t border-line/60">
    <div class="settings-row__text">
      <div class="flex items-center gap-2 flex-wrap">
        <h3 class="text-sm font-medium leading-snug">{tr("settings.androidNativePlayer.title")}</h3>
        <span class="android-exp-pill inline-flex shrink-0 items-center px-2 py-0.5 rounded-full border border-line bg-surface-2 text-fg-3 text-2xs font-medium">
          {tr("settings.androidNativePlayer.experimental")}
        </span>
      </div>
      <p id="android-native-player-helper" class="text-xs text-fg-3">{tr("settings.androidNativePlayer.helper")}</p>
    </div>
    <div class="settings-row__control">
      <div
        class="settings-seg"
        role="radiogroup"
        aria-label={tr("settings.androidNativePlayer.label")}
        aria-describedby="android-native-player-helper">
        <button
          type="button"
          role="radio"
          class="btn"
          aria-checked={enabled ? "true" : "false"}
          onclick={() => pick(true)}>
          {tr("settings.androidNativePlayer.on")}
        </button>
        <button
          type="button"
          role="radio"
          class="btn"
          aria-checked={!enabled ? "true" : "false"}
          onclick={() => pick(false)}>
          {tr("settings.androidNativePlayer.off")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Nylah Studios v0.3.0 (w6) — RedSilk treatment, code-grade only:
     this card only renders on Android Tauri, unverifiable on desktop.
     Brass-tinted experimental pill; the active seg button glows wine. -->
<style>
  .android-exp-pill {
    background: linear-gradient(
      90deg,
      color-mix(in oklch, var(--nylah-gold, oklch(0.85 0.16 90)) 16%, transparent),
      color-mix(in oklch, var(--color-accent) 10%, transparent)
    );
    border-color: color-mix(in oklch, var(--nylah-gold, oklch(0.85 0.16 90)) 45%, transparent);
    box-shadow: 0 0 12px 1px color-mix(in oklch, var(--nylah-gold, oklch(0.85 0.16 90)) 18%, transparent);
  }
  #android-native-player-section .settings-seg > .btn[aria-checked="true"] {
    box-shadow:
      0 0 0 1px color-mix(in oklch, var(--color-accent) 40%, transparent),
      0 0 18px 2px var(--nylah-focus-glow, oklch(0.72 0.17 350 / 0.5));
  }
  #android-native-player-section .settings-seg > .btn:focus-visible {
    box-shadow:
      0 0 0 2px var(--color-accent),
      var(--nylah-focus-glow-strong, 0 0 32px 4px oklch(0.72 0.17 350 / 0.5));
  }
</style>
