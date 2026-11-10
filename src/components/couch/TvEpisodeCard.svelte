<!-- TvEpisodeCard — one episode in the Series detail episode list (W4).
  A Svelte component so the Series detail page can mount one per episode
  from its (client-side, provider-loaded) episode list. The card mirrors
  the W1 TvCard landscape markup (rs-card--landscape, data-nylah-item,
  progress bar, badge) so D-pad focus, focus memory and the RedSilk
  styling treat it like every other Couch card.

  Props:
    episode: { id, season, episodeNum, title, plot, durationLabel,
               released, thumb, progress (0..1), watched, isNext,
               isPlaying, resumeSeconds? }
    onPlay(episode) — Play / Resume.
    onRestart(episode)? — start from the beginning (shown when resumable).
    onToggleWatched(episode)? — mark watched / unwatch. -->
<script>
  let {
    episode,
    onPlay,
    onRestart,
    onToggleWatched,
  } = $props();

  const pct = Math.max(0, Math.min(1, episode.progress ?? 0));
  const initials = (episode.title || "E")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.slice(0, 1).toUpperCase())
    .join("") || "E";
  const badge = episode.isPlaying
    ? "Now Playing"
    : episode.watched
      ? "Watched"
      : episode.isNext
        ? "Up Next"
        : pct > 0
          ? "Resume"
          : null;
  const metaParts = [`S${episode.season} E${episode.episodeNum}`];
  if (episode.durationLabel) metaParts.push(episode.durationLabel);
  if (episode.released) metaParts.push(String(episode.released).slice(0, 10));
</script>

<article
  class="rs-card rs-card--landscape"
  data-nylah-item
  data-couch-key={`episode-${episode.id}`}
  data-ep-id={episode.id}
  aria-label={`${metaParts[0]} — ${episode.title}`}
>
  <button
    type="button"
    class="rs-episode__play"
    onclick={() => onPlay?.(episode)}
    aria-label={pct > 0 && !episode.watched
      ? `Resume ${metaParts[0]} — ${episode.title}`
      : `Play ${metaParts[0]} — ${episode.title}`}
  >
    <span class="rs-card__media">
      <span class="rs-image rs-image--backdrop {episode.thumb ? '' : 'is-fallback'}" data-tv-image data-kind="backdrop">
        {#if episode.thumb}
          <img src={episode.thumb} alt="" loading="lazy" decoding="async" data-tv-image-img />
        {/if}
        <span class="rs-image__fallback" aria-hidden="true">
          <span class="rs-image__fallback-mark">{initials}</span>
          <span class="rs-image__fallback-title">{episode.title}</span>
        </span>
      </span>
      {#if badge}
        <span class="rs-card__badge">{badge}</span>
      {/if}
      {#if pct > 0 && !episode.watched}
        <span class="rs-card__progress" aria-hidden="true">
          <span class="rs-card__progress-fill" style={`width: ${Math.round(pct * 100)}%`}></span>
        </span>
      {/if}
    </span>
    <span class="rs-card__body">
      <span class="rs-card__title">E{episode.episodeNum} · {episode.title}</span>
      <span class="rs-card__meta">{metaParts.join(" · ")}</span>
      {#if episode.plot}
        <span class="rs-card__subtitle rs-episode__plot">{episode.plot}</span>
      {/if}
    </span>
  </button>
  <span class="rs-episode__actions">
    {#if pct > 0 && !episode.watched && onRestart}
      <button
        type="button"
        class="rs-osd__btn"
        onclick={() => onRestart?.(episode)}
        aria-label={`Start ${metaParts[0]} from the beginning`}
      >
        ↺ Start over
      </button>
    {/if}
    {#if onToggleWatched}
      <button
        type="button"
        class="rs-osd__btn"
        onclick={() => onToggleWatched?.(episode)}
        aria-pressed={episode.watched ? "true" : "false"}
        aria-label={episode.watched
          ? `Mark ${metaParts[0]} as not watched`
          : `Mark ${metaParts[0]} as watched`}
      >
        {episode.watched ? "✓ Watched" : "Mark watched"}
      </button>
    {/if}
  </span>
</article>

<style>
  /* Episode card: the whole poster/title area is one big Play target;
     the small actions sit below it. Scoped to this component only. */
  .rs-episode__play {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rs-episode__plot {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rs-episode__actions {
    display: flex;
    gap: 0.5rem;
    padding: 0 0.25rem 0.75rem;
  }
</style>
