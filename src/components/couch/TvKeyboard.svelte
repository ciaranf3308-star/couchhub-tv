<script>
  // TvKeyboard — couch-sized wrapper around the existing
  // OnScreenKeyboard.svelte (D-pad navigable, A types, B deletes,
  // X clears — see that component). Physical keyboard input goes to
  // the owning view's input as normal; this wrapper only owns the
  // on-screen keys.
  //
  // Two consumption paths, because Astro pages cannot pass callbacks
  // to hydrated components but Svelte views can:
  //   - Svelte parents: bind:value + onInput / onCommit props.
  //   - Astro parents: bind:value is not available — listen for the
  //     `couch-keyboard:input` / `couch-keyboard:commit` CustomEvents
  //     on window (detail: { value }).
  import OnScreenKeyboard from "@/components/OnScreenKeyboard.svelte";

  let {
    value = $bindable(""),
    onInput,
    onCommit,
    label = "On-screen keyboard",
    placeholder = "Type to search…",
  } = $props();

  function handleInput(next) {
    onInput?.(next);
    window.dispatchEvent(
      new CustomEvent("couch-keyboard:input", { detail: { value: next } }),
    );
  }
  function handleCommit() {
    onCommit?.();
    window.dispatchEvent(
      new CustomEvent("couch-keyboard:commit", { detail: { value } }),
    );
  }
</script>

<div class="rs-keyboard" data-couch-keyboard role="group" aria-label={label}>
  <div
    class="rs-keyboard__value"
    data-placeholder={placeholder}
    aria-live="polite"
  >
    {value}
  </div>
  <OnScreenKeyboard
    bind:value
    onInput={handleInput}
    onCommit={handleCommit}
  />
</div>
