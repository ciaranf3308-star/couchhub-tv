// Series Home rendering (0.11.8, W4) — DOM builders for the Series
// Home shelves. All provider/user text goes through textContent, never
// innerHTML. Cards reuse the existing buildCouchCard builder (same
// markup, focus hooks and branded image fallback as every other Couch
// VOD screen); genre tiles and the Browse Everything entry are the
// only new card shapes, and they live here, in W4-owned code.
//
// CONTROLLER CONTRACT (brief §16, 0.11.10 §20–§22): every shelf
// is a `section[data-nylah-rail]` and every card's primary
// focusable carries `data-nylah-item` + a stable `data-couch-key`,
// so the existing gamepad rail model (gamepad.ts) and focus
// memory (couch-focus.ts) drive Series Home. D-pad L/R moves
// within a shelf, U/D moves between shelves, A activates the
// card's own action (Continue cards resume the exact episode
// named by the progress record — never episode 1). X opens the
// title context menu, Y opens Search Series, B goes back —
// through the Home controller keys in couch-series-home.ts
// (W1 routes the gamepad buttons as keys; see the note there).
// Menu opens Settings (no page-options surface exists yet).
//
// METADATA DISCIPLINE (brief §1.8/§15.6): season counts come ONLY
// from already-cached series info (getCachedSeasonCount — a sync
// cache read). This module never resolves, requests or observes
// series info, so rendering a shelf can never enqueue provider
// requests for offscreen series. Cards are built fresh on every
// render; no async callback ever writes into a reused card.

import { buildCouchCard } from "@/scripts/movies/couch-cards.ts";
import { armTvImageFallbacks, fallbackMarkFor } from "@/scripts/lib/couch-image.ts";
import { getCachedSeasonCount } from "@/scripts/lib/series-seasons.ts";
import { modeToSearchParams } from "@/scripts/lib/home-browse-modes.ts";
import type { BrowseSortId } from "@/scripts/lib/browse-state.ts";
import {
  seriesDetailHref,
  seriesHomeCardMeta,
  type ContinueWatchingItem,
  type FollowedShelfItem,
  type NewEpisodeItem,
  type SeriesGenreTile,
  type SeriesHomeSection,
} from "@/scripts/series/series-home-model.ts";
import { seriesMetaLine, type SeriesRow } from "@/scripts/series/couch-series.ts";

export interface SeriesHomeRenderContext {
  playlistId: string;
}

/** Mode-switch params the controller reads from data attributes (genre family id / sort id). */
export interface SeriesHomeModeParams {
  genre?: string;
  sort?: string;
}

/** Browse Everything URL for one mode (W2 URL contract). */
function seriesBrowseUrl(opts: { genre?: string; sort?: BrowseSortId }): string {
  const params = modeToSearchParams({
    view: "browse",
    kind: "series",
    category: opts.genre ? `genre:${opts.genre}` : undefined,
    sort: opts.sort,
  });
  return `/series?${params.toString()}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Shelf shell: rail section + head (title + optional subtitle). */
function shelfSection(
  section: SeriesHomeSection,
  subtitle?: string,
): { sectionEl: HTMLElement; rowEl: HTMLElement } {
  const sectionEl = el("section", "rs-rail rs-rail--variant-series rs-series-home-shelf");
  sectionEl.setAttribute("data-nylah-rail", section.id);
  sectionEl.setAttribute("data-series-home-section", section.kind);
  sectionEl.setAttribute("aria-label", section.title);
  const head = el("div", "rs-rail__head");
  const h2 = el("h2", "rs-section-title");
  h2.textContent = section.title;
  head.appendChild(h2);
  if (subtitle) {
    const sub = el("p", "rs-meta rs-series-home-subtitle");
    sub.textContent = subtitle;
    head.appendChild(sub);
  }
  sectionEl.appendChild(head);
  const rowEl = el("div", "rs-rail__row");
  sectionEl.appendChild(rowEl);
  return { sectionEl, rowEl };
}

/** Series poster card for Worth Starting / Recently Added / Followed. */
function seriesCard(
  row: SeriesRow,
  playlistId: string,
  opts: { href?: string; itemKey?: string; meta?: string } = {},
): HTMLElement {
  const cachedCount = playlistId ? getCachedSeasonCount(playlistId, row.id) : null;
  const card = buildCouchCard(
    {
      title: row.name,
      meta: opts.meta ?? seriesHomeCardMeta(row, cachedCount),
      image: row.logo,
      kind: "poster",
      href: opts.href ?? seriesDetailHref(row.id),
      itemKey: opts.itemKey ?? `series-${row.id}`,
    },
    false,
  );
  return card;
}

function continueCard(item: ContinueWatchingItem): HTMLElement {
  const card = buildCouchCard(
    {
      title: item.row.name,
      // The subtitle is the ONE visible secondary line on a poster
      // card (shared CSS hides meta when a subtitle exists) — the
      // model already composes action + episode + progress into it.
      subtitle: item.subtitle,
      meta: item.meta || seriesMetaLine(item.row, null),
      image: item.row.logo,
      kind: "poster",
      progress: item.progressFraction,
      badge: item.episodeLabel || undefined,
      href: item.href,
      itemKey: item.key,
    },
    false,
  );
  card.setAttribute("data-series-home-action", item.actionLabel);
  card.setAttribute(
    "aria-label",
    `${item.row.name}, ${item.subtitle}${item.episodeTitle ? `, ${item.episodeTitle}` : ""}, ${item.actionLabel}`,
  );
  return card;
}

function newEpisodeCard(item: NewEpisodeItem): HTMLElement {
  const card = buildCouchCard(
    {
      title: item.seriesTitle,
      subtitle: item.subtitle,
      meta: item.detectedLabel,
      image: item.posterUrl,
      kind: "poster",
      // Badge carries status + detection date: the one secondary
      // line holds S/E + episode title, so the date must live here
      // to stay visible.
      badge: item.badgeLabel,
      href: item.watchHref,
      itemKey: item.key,
    },
    false,
  );
  card.setAttribute("data-series-home-action", "Watch Episode");
  card.setAttribute("data-detected-at", item.detectedAt);
  card.setAttribute(
    "aria-label",
    `${item.seriesTitle}, ${item.subtitle}, new episode, ${item.detectedLabel}, Watch Episode`,
  );
  return card;
}

function followedCard(item: FollowedShelfItem): HTMLElement {
  const card = buildCouchCard(
    {
      title: item.title,
      meta: item.meta || undefined,
      image: item.posterUrl,
      kind: "poster",
      href: item.href,
      itemKey: item.key,
    },
    false,
  );
  card.setAttribute("data-series-home-action", "Open series");
  return card;
}

/**
 * Trailing "view all" tile inside a rail row — reachable by D-pad
 * L/R like any other card, so controller users can reach the
 * overflow destination without a mouse. Plain navigation (href)
 * unless mode params are given, in which case the mount intercepts
 * the click for an in-page mode switch.
 */
function viewAllTile(
  label: string,
  href: string,
  itemKey: string,
  modeParams?: SeriesHomeModeParams,
): HTMLElement {
  const tile = el("a", "rs-series-home-viewall");
  tile.setAttribute("data-nylah-item", "");
  tile.setAttribute("data-couch-key", itemKey);
  (tile as HTMLAnchorElement).href = href;
  if (modeParams) {
    tile.setAttribute("data-series-home-mode", "browse");
    if (modeParams.genre) tile.setAttribute("data-series-home-genre", modeParams.genre);
    if (modeParams.sort) tile.setAttribute("data-series-home-sort", modeParams.sort);
  }
  const labelEl = el("span", "rs-series-home-viewall__label");
  labelEl.textContent = label;
  tile.appendChild(labelEl);
  const arrow = el("span", "rs-series-home-viewall__arrow");
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");
  tile.appendChild(arrow);
  return tile;
}

/** Genre tile: real catalogue artwork when a member has it, else typographic. */
function genreTile(tile: SeriesGenreTile): HTMLElement {
  const link = el("a", "rs-series-home-genre");
  link.setAttribute("data-nylah-item", "");
  link.setAttribute("data-couch-key", `genre-${tile.family.id}`);
  (link as HTMLAnchorElement).href = seriesBrowseUrl({ genre: tile.browseGenreParam });
  link.setAttribute("data-series-home-mode", "browse");
  link.setAttribute("data-series-home-genre", tile.browseGenreParam);
  link.setAttribute(
    "aria-label",
    `${tile.family.label}, ${tile.count.toLocaleString()} ${tile.count === 1 ? "series" : "series"}`,
  );
  if (tile.artworkUrl) {
    const media = el("span", "rs-series-home-genre__media");
    const imageWrap = el("span", "rs-image rs-image--backdrop");
    imageWrap.setAttribute("data-tv-image", "");
    imageWrap.setAttribute("data-kind", "backdrop");
    const img = el("img", "");
    img.setAttribute("src", tile.artworkUrl);
    // Decorative: the tile's text label names the genre; the artwork
    // belongs to one member series and must not pose as genre art.
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("data-tv-image-img", "");
    imageWrap.appendChild(img);
    const fallback = el("span", "rs-image__fallback");
    fallback.setAttribute("aria-hidden", "true");
    const mark = el("span", "rs-image__fallback-mark");
    mark.textContent = fallbackMarkFor("backdrop", tile.family.label);
    fallback.appendChild(mark);
    imageWrap.appendChild(fallback);
    media.appendChild(imageWrap);
    link.appendChild(media);
  } else {
    link.classList.add("rs-series-home-genre--no-art");
  }
  const body = el("span", "rs-series-home-genre__body");
  const name = el("span", "rs-series-home-genre__name");
  name.textContent = tile.family.label;
  body.appendChild(name);
  const count = el("span", "rs-series-home-genre__count");
  count.textContent = `${tile.count.toLocaleString()} ${tile.count === 1 ? "series" : "series"}`;
  body.appendChild(count);
  link.appendChild(body);
  return link;
}

function browseEntrySection(section: Extract<SeriesHomeSection, { kind: "browse-entry" }>): HTMLElement {
  const sectionEl = el("section", "rs-rail rs-series-home-shelf rs-series-home-browse-section");
  sectionEl.setAttribute("data-nylah-rail", section.id);
  sectionEl.setAttribute("data-series-home-section", section.kind);
  sectionEl.setAttribute("aria-label", section.title);
  const link = el("a", "rs-series-home-browse-entry");
  link.setAttribute("data-nylah-item", "");
  link.setAttribute("data-couch-key", "browse-everything");
  (link as HTMLAnchorElement).href = seriesBrowseUrl({});
  link.setAttribute("data-series-home-mode", "browse");
  const title = el("span", "rs-series-home-browse-entry__title");
  title.textContent = "Browse Everything";
  link.appendChild(title);
  const meta = el("span", "rs-series-home-browse-entry__meta");
  meta.textContent =
    `${section.totalCount.toLocaleString()} ${section.totalCount === 1 ? "series" : "series"}` +
    " · search, filters and sorting";
  link.appendChild(meta);
  sectionEl.appendChild(link);
  return sectionEl;
}

/**
 * Render the full home shelf stack into `root`, replacing any
 * previous content. Fresh nodes every render — nothing is reused
 * across renders, so no stale callback can write into a live card.
 */
export function renderSeriesHome(
  root: HTMLElement,
  sections: SeriesHomeSection[],
  ctx: SeriesHomeRenderContext,
): void {
  armTvImageFallbacks(document);
  const frag = document.createDocumentFragment();
  for (const section of sections) {
    if (section.kind === "browse-entry") {
      frag.appendChild(browseEntrySection(section));
      continue;
    }
    if (section.kind === "genres") {
      const { sectionEl, rowEl } = shelfSection(section);
      rowEl.classList.add("rs-series-home-genre-grid");
      for (const tile of section.items) rowEl.appendChild(genreTile(tile));
      frag.appendChild(sectionEl);
      continue;
    }
    if (section.kind === "continue") {
      const { sectionEl, rowEl } = shelfSection(section);
      for (const item of section.items) rowEl.appendChild(continueCard(item));
      frag.appendChild(sectionEl);
      continue;
    }
    if (section.kind === "new-episodes") {
      const { sectionEl, rowEl } = shelfSection(section, section.subtitle);
      for (const item of section.items) rowEl.appendChild(newEpisodeCard(item));
      rowEl.appendChild(viewAllTile("All followed", "/followed", "viewall-followed"));
      frag.appendChild(sectionEl);
      continue;
    }
    if (section.kind === "followed") {
      const { sectionEl, rowEl } = shelfSection(section);
      for (const item of section.items) rowEl.appendChild(followedCard(item));
      rowEl.appendChild(viewAllTile("All followed", "/followed", "viewall-followed"));
      frag.appendChild(sectionEl);
      continue;
    }
    if (section.kind === "worth-starting") {
      const { sectionEl, rowEl } = shelfSection(section, section.subtitle);
      for (const row of section.items) rowEl.appendChild(seriesCard(row, ctx.playlistId));
      frag.appendChild(sectionEl);
      continue;
    }
    // recently-added
    const { sectionEl, rowEl } = shelfSection(section);
    for (const row of section.items) rowEl.appendChild(seriesCard(row, ctx.playlistId));
    rowEl.appendChild(
      viewAllTile(
        "View all",
        seriesBrowseUrl({ sort: "added" }),
        "viewall-recently-added",
        { sort: "added" },
      ),
    );
    frag.appendChild(sectionEl);
  }
  root.replaceChildren(frag);
}

// ---------------------------------------------------------------------------
// Home states (§18) — loading / no playlist / empty / error
// ---------------------------------------------------------------------------

export type SeriesHomeStateKind = "loading" | "no-playlist" | "empty" | "error";

export interface SeriesHomeStateOptions {
  /** Error detail for the error state (provider failure wording). */
  message?: string;
}

function stateBlock(
  title: string,
  message: string,
  action?: { label: string; href?: string; retry?: boolean },
): HTMLElement {
  const block = el("div", "rs-series-home-state");
  block.setAttribute("role", "status");
  const h2 = el("h2", "rs-empty__title");
  h2.textContent = title;
  block.appendChild(h2);
  const p = el("p", "rs-empty__message");
  p.textContent = message;
  block.appendChild(p);
  if (action) {
    if (action.retry) {
      const btn = el("button", "rs-hero__action rs-hero__action--secondary");
      btn.type = "button";
      btn.textContent = action.label;
      btn.setAttribute("data-series-home-retry", "");
      block.appendChild(btn);
    } else if (action.href) {
      const link = el("a", "rs-hero__action rs-hero__action--secondary");
      (link as HTMLAnchorElement).href = action.href;
      link.textContent = action.label;
      block.appendChild(link);
    }
  }
  return block;
}

/**
 * Render a full-page home state. Loading shows restrained skeleton
 * rows (no fake titles); the error state never calls a failed
 * connection an empty catalogue.
 */
export function renderSeriesHomeState(
  root: HTMLElement,
  kind: SeriesHomeStateKind,
  opts: SeriesHomeStateOptions = {},
): void {
  if (kind === "loading") {
    const wrap = el("div", "rs-series-home-loading");
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-busy", "true");
    const label = el("p", "rs-meta");
    label.textContent = "Loading your series…";
    wrap.appendChild(label);
    for (let i = 0; i < 3; i++) {
      const row = el("div", "rs-series-home-skeleton-row");
      row.setAttribute("aria-hidden", "true");
      for (let j = 0; j < 5; j++) row.appendChild(el("div", "rs-series-home-skeleton-card"));
      wrap.appendChild(row);
    }
    root.replaceChildren(wrap);
    return;
  }
  if (kind === "no-playlist") {
    root.replaceChildren(
      stateBlock(
        "No playlist yet",
        "Add a playlist in Settings to browse your series.",
        { label: "Open Settings", href: "/settings" },
      ),
    );
    return;
  }
  if (kind === "empty") {
    root.replaceChildren(
      stateBlock(
        "No series yet",
        "This playlist has no series. Add a playlist with series in Settings, or check the provider connection.",
        { label: "Open Settings", href: "/settings" },
      ),
    );
    return;
  }
  root.replaceChildren(
    stateBlock(
      "Could not load your series",
      opts.message ||
        "The provider could not be reached. Your library may be fine — this is a connection problem, not an empty catalogue.",
      { label: "Try again", retry: true },
    ),
  );
}
