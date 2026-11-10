<!-- TvSeasonPicker — season selection for the Series detail page (W4).
  A Svelte component mounted by the Series detail page script once the
  provider's `get_series_info` payload arrives. Fully D-pad
  controllable: every season is a real focusable button in one rail
  (data-nylah-rail="series-seasons"), A selects, and the pressed state
  shows the current season. No mouse-only affordance, no hidden select.

  Props:
    seasons: number[] — season numbers present, ascending (0 = Specials).
    current: number | null — the season currently shown.
    counts?: Record<number, { watched: number; total: number }> —
      per-season watched progress, shown as "3/8" when supplied.
    onSelect(season: number) — called when the viewer picks a season. -->
<script>
  let { seasons = [], current = null, counts = {}, onSelect } = $props();

  function label(season) {
    return season === 0 ? "Specials" : `Season ${season}`;
  }
</script>

<div
  class="rs-season-picker"
  data-nylah-rail="series-seasons"
  role="group"
  aria-label="Seasons"
>
  {#each seasons as season (season)}
    {@const count = counts?.[season]}
    <button
      type="button"
      class="rs-season-picker__btn"
      data-nylah-item
      data-season={season}
      aria-pressed={season === current ? "true" : "false"}
      onclick={() => onSelect?.(season)}
    >
      <span>{label(season)}</span>
      {#if count && count.total > 0}
        <span class="rs-season-picker__count">{count.watched}/{count.total}</span>
      {/if}
    </button>
  {/each}
  {#if seasons.length === 0}
    <span class="rs-meta">No seasons listed for this series yet.</span>
  {/if}
</div>

<style>
  .rs-season-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .rs-season-picker__btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3rem;
    padding: 0.5rem 1.25rem;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--rs-focus) 35%, transparent);
    background: var(--rs-surface);
    color: var(--rs-text);
    font-size: 1.125rem;
    cursor: pointer;
  }
  .rs-season-picker__btn[aria-pressed="true"] {
    background: var(--rs-accent);
    border-color: var(--rs-focus);
    color: #fff;
    box-shadow: 0 0 24px 2px rgba(229, 166, 189, 0.35);
  }
  .rs-season-picker__count {
    font-size: 0.95rem;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }
</style>
