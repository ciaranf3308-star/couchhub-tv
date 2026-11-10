<script>
  import { onMount } from "svelte"
  import {
    getActiveLocale,
    getAvailableLocales,
    setLocale,
    t,
    LOCALE_EVENT,
  } from "@/scripts/lib/i18n.js"

  let active = $state(getActiveLocale())
  let locales = $state(getAvailableLocales())
  let label = $state(t("settings.language.label"))
  let systemOption = $state(t("settings.language.system"))

  function onChange(event) {
    const next = event.target.value
    if (next === "__system") {
      setLocale(null)
    } else {
      setLocale(next)
    }
  }

  function refresh() {
    active = getActiveLocale()
    locales = getAvailableLocales()
    label = t("settings.language.label")
    systemOption = t("settings.language.system")
  }

  onMount(() => {
    // The $state initializers above run synchronously when the component is
    // hydrated. If initI18n() is still in flight (race on first paint), they
    // snapshot English. Re-read once on mount so we land on the resolved
    // locale without waiting for the next LOCALE_EVENT fire.
    refresh()
    document.addEventListener(LOCALE_EVENT, refresh)
    return () => document.removeEventListener(LOCALE_EVENT, refresh)
  })
</script>

<select
  onchange={onChange}
  value={active}
  aria-label={label}
  class="field-input w-full">
  <option value="__system">{systemOption}</option>
  {#each locales as locale (locale.code)}
    <option value={locale.code}>{locale.nativeName} ({locale.code})</option>
  {/each}
</select>

<style>
  /* RedSilk: the language select focuses with a wine glow, matching the
     other selects on the Settings page (this island sits outside the
     page's scoped styles, so the rule lives here). */
  select.field-input:focus {
    border-color: var(--nylah-focus-ring, var(--color-accent));
    box-shadow:
      0 0 0 2px var(--nylah-focus-halo),
      0 0 18px var(--nylah-focus-glow);
  }
</style>
