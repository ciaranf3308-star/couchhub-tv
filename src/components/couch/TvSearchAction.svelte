<script>
  // TvSearchAction — the Browse landing's one-tap entry to fullscreen
  // search (/search). A plain link, so it navigates even before
  // hydration; when hydrated (client:load — REQUIRED for the focus
  // restore below), the click marks the trip in sessionStorage, and
  // mounting on the return trip restores focus to this action, so B /
  // back from /search lands the user exactly where they left Browse.
  //
  // Integration (W1 / integration): drop
  //   <TvSearchAction client:load />
  // into the Browse header slot. Do not render it without client:load:
  // the link still navigates, but no return focus is restored.
  // Search behaviour itself lives on /search and is untouched here.
  import { onMount } from "svelte";
  import {
    markSearchReturn,
    consumeSearchReturn,
  } from "@/scripts/lib/couch-keyboard.ts";

  let {
    href = "/search",
    label = "Search",
    id = "browse-search-action",
  } = $props();

  /** @type {HTMLAnchorElement | null} */
  let actionEl = null;

  function openSearch() {
    // Mark before the navigation; /search's B/back path is a plain
    // history.back(), so this component's next mount consumes the flag.
    try {
      markSearchReturn(sessionStorage);
    } catch {
      // Focus restore is a nicety, never fatal.
    }
  }

  onMount(() => {
    let returning = false;
    try {
      returning = consumeSearchReturn(sessionStorage);
    } catch {
      returning = false;
    }
    if (returning) actionEl?.focus();
  });
</script>

<a
  {href}
  {id}
  data-tv-search-action
  data-nylah-item
  bind:this={actionEl}
  onclick={openSearch}
  class="rs-search-action"
  aria-label={label}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1.5rem"
    height="1.5rem"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="rs-search-action__icon"
  >
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
  </svg>
  <span>{label}</span>
</a>

<style>
  .rs-search-action {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 3.5rem;
    padding: 0.625rem 1.5rem;
    border-radius: 9999px;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text);
    font-size: 1.375rem;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    outline: none;
    white-space: nowrap;
  }
  .rs-search-action:hover,
  .rs-search-action:focus-visible {
    background: var(--rs-bg-2);
    border-color: var(--rs-focus);
    box-shadow: 0 0 0 2px var(--rs-focus-glow);
  }
  .rs-search-action__icon {
    color: var(--rs-text-2);
    flex-shrink: 0;
  }
</style>
