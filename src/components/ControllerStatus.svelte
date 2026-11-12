<script lang="ts">
  // Controller diagnostics (0.11.4, W6) — the proof the native-input
  // release rests on. This is how a dead controller stops being
  // silent: the card shows the connected pad by name, the input path
  // actually delivering presses, and the last button pressed with a
  // timestamp, live. If the pad is connected but nothing registers
  // here, input is broken — no guessing, no "fixed" claim without it.
  //
  // Sources:
  // - Native XInput: `xinput_status` (one-shot snapshot, re-polled
  //   every 2 s so a missed event can't leave a stale card) plus the
  //   `xinput-status` / `xinput-button` / `xinput-direction` events
  //   the Rust poll thread emits. A rejected xinput_status invoke
  //   (e.g. a missing ACL grant) is shown verbatim, not swallowed —
  //   that exact failure hid the 0.11.1 key defect for a day.
  // - Browser Gamepad API: scanned every second as a cross-check. It
  //   names pads XInput cannot (XInput reports no friendly name —
  //   the native label is "<subtype> (XInput Player N)"), and it is
  //   the fallback path for non-XInput pads.
  // Outside Tauri (browser preview) the native side reports
  // "not available" and only the browser line can show anything.
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";

  interface XInputSlot {
    slot: number;
    connected: boolean;
    subtype: string;
    display_name: string;
  }

  interface XInputStatus {
    available: boolean;
    slots: XInputSlot[];
  }

  interface XInputButtonEvent {
    slot: number;
    button: string;
    pressed: boolean;
  }

  interface XInputDirectionEvent {
    slot: number;
    direction: string;
    phase: string;
  }

  const isTauri =
    typeof window !== "undefined" &&
    (!!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
      !!(window as unknown as Record<string, unknown>).__TAURI__);

  let native = $state<XInputStatus | null>(null);
  let nativeError = $state<string | null>(null);
  let lastInput = $state<{ label: string; at: Date } | null>(null);
  let eventCount = $state(0);
  let browserPad = $state<string | null>(null);

  const connectedSlots = $derived(
    (native?.slots ?? []).filter((slot) => slot.connected),
  );
  const nativeLive = $derived(connectedSlots.length > 0);
  const pathLabel = $derived(
    !isTauri
      ? "Browser preview — no native path"
      : nativeError
        ? "Native path error"
        : !native
          ? "Checking…"
          : !native.available
            ? "Native XInput unavailable"
            : nativeLive
              ? "Native XInput — LIVE"
              : "Native XInput — no pad",
  );

  function stamp(): string {
    return new Date().toLocaleTimeString([], { hour12: false });
  }

  function recordInput(label: string): void {
    lastInput = { label, at: new Date() };
    eventCount += 1;
  }

  async function refreshNative(): Promise<void> {
    if (!isTauri) return;
    try {
      native = await invoke<XInputStatus>("xinput_status");
      nativeError = null;
    } catch (error) {
      // Shown verbatim on purpose: a rejected invoke is the defect,
      // and the message names it (e.g. "not allowed by ACL").
      nativeError = error instanceof Error ? error.message : String(error);
    }
  }

  function refreshBrowserPad(): void {
    if (typeof navigator === "undefined" || !navigator.getGamepads) {
      browserPad = null;
      return;
    }
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (pad && pad.connected) {
        browserPad = pad.id || `Gamepad ${pad.index}`;
        return;
      }
    }
    browserPad = null;
  }

  onMount(() => {
    void refreshNative();
    refreshBrowserPad();
    const nativeTimer = window.setInterval(() => void refreshNative(), 2000);
    const browserTimer = window.setInterval(refreshBrowserPad, 1000);
    let unlisten: Array<() => void> = [];
    if (isTauri) {
      void listen<XInputStatus>("xinput-status", (event) => {
        native = event.payload;
        nativeError = null;
      }).then((fn) => unlisten.push(fn));
      void listen<XInputButtonEvent>("xinput-button", (event) => {
        if (event.payload.pressed) {
          recordInput(
            `Player ${event.payload.slot + 1} — ${event.payload.button.toUpperCase()}`,
          );
        }
      }).then((fn) => unlisten.push(fn));
      void listen<XInputDirectionEvent>("xinput-direction", (event) => {
        if (event.payload.phase === "start") {
          recordInput(
            `Player ${event.payload.slot + 1} — ${event.payload.direction.toUpperCase()} (D-pad / stick)`,
          );
        }
      }).then((fn) => unlisten.push(fn));
    }
    return () => {
      window.clearInterval(nativeTimer);
      window.clearInterval(browserTimer);
      for (const fn of unlisten) fn();
    };
  });
</script>

<section
  class="controller-status rounded-lg border border-line bg-surface p-4 sm:p-5"
  aria-label="Controller status">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-base font-semibold text-fg">Controller</h2>
    <span
      class="rounded-full border px-2 py-0.5 text-xs font-semibold"
      class:border-ok={nativeLive && !nativeError}
      class:text-ok={nativeLive && !nativeError}
      class:border-line={!nativeLive || nativeError}
      class:text-fg-2={!nativeLive || nativeError}>
      {pathLabel}
    </span>
  </div>

  {#if nativeError}
    <p class="mt-3 text-sm text-danger" role="alert">
      Native controller check failed: {nativeError}
    </p>
  {:else if !isTauri}
    <p class="mt-3 text-sm text-fg-2">
      Opened in a browser preview, so the native XInput path is not
      available here. On the TV app this line shows the XInput pad.
    </p>
  {:else if !native}
    <p class="mt-3 text-sm text-fg-2">Checking the controller…</p>
  {:else if !native.available}
    <p class="mt-3 text-sm text-fg-2">
      Native XInput is unavailable on this machine. The browser
      Gamepad API is the fallback — press a button and watch the
      browser line below.
    </p>
  {:else if connectedSlots.length === 0}
    <p class="mt-3 text-sm text-fg-2">
      No controller found on XInput. Connect a controller, then press
      any button — it should appear here without restarting the app.
    </p>
  {:else}
    <ul class="mt-3 space-y-1">
      {#each connectedSlots as slot (slot.slot)}
        <li class="text-sm text-fg">
          <span class="font-semibold">{slot.display_name}</span>
          <span class="text-fg-2"> — {slot.subtype}, Player {slot.slot + 1}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <dl class="mt-4 space-y-1 text-sm">
    <div class="flex gap-2">
      <dt class="shrink-0 font-semibold text-fg-2">Last input</dt>
      <dd class="text-fg">
        {#if lastInput}
          {lastInput.label} · {lastInput.at.toLocaleTimeString([], { hour12: false })}
        {:else}
          Nothing yet — press any button on the controller.
        {/if}
      </dd>
    </div>
    <div class="flex gap-2">
      <dt class="shrink-0 font-semibold text-fg-2">Presses seen</dt>
      <dd class="text-fg tabular-nums">{eventCount}</dd>
    </div>
    <div class="flex gap-2">
      <dt class="shrink-0 font-semibold text-fg-2">Browser pad</dt>
      <dd class="text-fg">
        {#if browserPad}
          {browserPad} <span class="text-fg-2">(fallback path — XInput cannot report a friendly name)</span>
        {:else}
          None detected
        {/if}
      </dd>
    </div>
  </dl>

  <p class="mt-3 text-xs text-fg-3">
    Checked {stamp()} · Native status refreshes every 2 s. If the pad
    is connected but presses never land here, controller input is
    broken — the app must not claim otherwise.
  </p>
</section>

<style>
  .controller-status {
    /* RedSilk: the live state reads as a lit edge, not a flat tint. */
    box-shadow: 0 0 24px color-mix(in oklch, var(--color-accent) 12%, transparent);
  }
  .controller-status :global(.text-danger) {
    color: var(--color-danger, #ff6b6b);
  }
</style>
