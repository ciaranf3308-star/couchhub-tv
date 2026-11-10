<script>
  // TvKeyboard — couch-sized wrapper around the existing
  // OnScreenKeyboard.svelte (D-pad navigable, A types, B deletes,
  // X clears — see that component). Physical keyboard input goes to
  // the owning view's input as normal; this wrapper only owns the
  // on-screen keys.
  //
  // VISIBILITY CONTRACT (Browse consolidation, W2): the keyboard renders
  // ONLY when `open` is true. Svelte owners (Discover mood field,
  // fullscreen Search) own a CouchKeyboardLifecycle and pass
  // open={keyboardOpen} — the keyboard is hidden on landing and opens
  // when the search input receives focus. `open` defaults to true so
  // the Astro dialog usage (Movies / Series search dialogs, where the
  // <dialog> itself gates visibility) keeps working unchanged.
  //
  // DISMISS: B / Escape while focus is inside the key grid is backspace
  // (the OSK's own handler, unchanged). The Hide button below the grid
  // is the keyboard's own dismiss path — controller users D-pad down
  // to it from the bottom row; it calls onDismiss and the owner hides
  // the keyboard and returns focus to the search input. The button only
  // renders when onDismiss is passed, so dialog usage is visually
  // untouched. Escape on the button also dismisses (the wrapper
  // keydown handler below; the grid's handler stops propagation, so
  // this never fires for keys inside the grid).
  //
  // Two consumption paths, because Astro pages cannot pass callbacks
  // to hydrated components but Svelte views can:
  //   - Svelte parents: bind:value + onInput / onCommit / onDismiss props.
  //   - Astro parents: bind:value is not available — listen for the
  //     `couch-keyboard:input` / `couch-keyboard:commit` CustomEvents
  //     on window (detail: { value }).
  import OnScreenKeyboard from "@/components/OnScreenKeyboard.svelte";

  let {
    value = $bindable(""),
    onInput,
    onCommit,
    onDismiss,
    open = true,
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
  function handleDismiss() {
    onDismiss?.();
  }
  function handleKeyDown(ev) {
    // Only reachable from the Hide button (the grid swallows its own
    // Escape as backspace before it can bubble here).
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      handleDismiss();
    }
  }
</script>

{#if open}
  <div
    class="rs-keyboard"
    data-couch-keyboard
    role="group"
    aria-label={label}
    onkeydown={handleKeyDown}
  >
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
    {#if onDismiss}
      <button
        type="button"
        class="rs-keyboard__dismiss"
        data-couch-keyboard-dismiss
        onclick={handleDismiss}
      >
        Hide keyboard
      </button>
    {/if}
  </div>
{/if}

<style>
  .rs-keyboard__dismiss {
    width: 100%;
    min-height: 3.5rem;
    margin-top: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text-2);
    font-size: 1.25rem;
    cursor: pointer;
    outline: none;
  }
  .rs-keyboard__dismiss:hover,
  .rs-keyboard__dismiss:focus-visible {
    color: var(--rs-text);
    background: var(--rs-bg-2);
    border-color: var(--rs-focus);
  }
</style>
