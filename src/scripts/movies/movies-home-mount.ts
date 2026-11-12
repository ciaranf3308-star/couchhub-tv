// Movies Home mount — DOM assembly + loading for the 0.11.8 Movies
// Home screen (brief §3, §16, §18 Home parts).
//
// The router (couch-index.ts) mounts EITHER this OR Browse
// Everything per page load, from the mode URL. This module:
//
//   - loads the catalogue through the existing loader
//     (loadCouchCatalog + the movies adapter spec — no new network
//     code, no new cache),
//   - builds the curated model (movies-home.ts — pure, W1 selectors
//     via the shim until integration),
//   - paints featured / shelves / genre tiles / browse entry into
//     the mount points in src/pages/movies/index.astro,
//   - restores focus after paint via the shared couch-focus memory
//     (rail + data-couch-key), so a detail return lands on the exact
//     poster,
//   - adds keyboard shelf-jump (PageUp/PageDown, [ ]) between Home
//     sections. D-pad movement, A/B/X/Y/Menu all come from the
//     shared XInput → gamepad.ts action pipeline — this module adds
//     NO controller handler and never touches gamepad.ts or
//     couch-focus.ts.
//
// Loading / empty / error states (§18): no playlist → setup message;
// empty catalogue → honest empty state; provider failure → an error
// state that NEVER calls a failed connection an empty catalogue.
// Empty sections are omitted, never rendered blank.

import { loadCouchCatalog } from "@/scripts/movies/couch-catalog.ts";
import { moviesAdapter } from "@/scripts/movies/couch-movies-adapter.ts";
import { buildCouchCard } from "@/scripts/movies/couch-cards.ts";
import {
  armTvImageFallbacks,
  fallbackMarkFor,
  isUsableImageSrc,
} from "@/scripts/lib/couch-image.ts";
import {
  couchRailItems,
  readCouchFocusMemory,
  scrollFocusedIntoView,
} from "@/scripts/lib/couch-focus.ts";
import {
  ensureLoaded as ensurePrefsLoaded,
  getProgress,
} from "@/scripts/lib/preferences.js";
import {
  getActiveProfileId,
  SHARED_PROFILE_ID,
} from "@/scripts/lib/profiles.ts";
import {
  emptyTasteModel,
  loadTaste,
  type TasteModel,
} from "@/scripts/lib/taste.ts";
import {
  GENRE_TILES_PER_ROW,
  MOVIES_HOME_BROWSE_URLS,
  MOVIES_HOME_RAILS,
  buildMoviesHomeModel,
  movieHomeCardView,
  type FeaturedFilm,
  type GenreTile,
  type MoviesHomeModel,
  type MoviesHomeProgress,
  type ProgressById,
} from "@/scripts/movies/movies-home.ts";
import type { MovieRow } from "@/scripts/movies/couch-movies.ts";

// DOM ids provided by src/pages/movies/index.astro (home root).
const ID = {
  root: "movies-home-root",
  count: "movies-home-count",
  skeleton: "movies-home-skeleton",
  nolist: "movies-home-nolist",
  empty: "movies-home-empty",
  error: "movies-home-error",
  errorMessage: "movies-home-error-message",
  retry: "movies-home-retry",
  featured: "movies-home-featured",
  continue: "movies-home-continue",
  worth: "movies-home-worth",
  recent: "movies-home-recent",
  genres: "movies-home-genres",
  browseEntry: "movies-home-browse-entry",
  browseCount: "movies-home-browse-count",
} as const;

const PICKS_SEED_KEY_PREFIX = "movies-home-picks-seed:";

function $(id: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(`#${id}`) as HTMLElement | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function setHidden(node: HTMLElement | null, hidden: boolean): void {
  if (node) node.hidden = hidden;
}

/** Attribute-value escape with a fallback for runtimes without CSS.escape. */
function escapeAttr(value: string): string {
  const css = (globalThis as unknown as { CSS?: { escape?: (s: string) => string } }).CSS;
  return css && typeof css.escape === "function"
    ? css.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/** Refresh-picks rotation seed, persisted per playlist (stable picks). */
export function readPicksSeed(playlistId: string): number {
  try {
    const raw = sessionStorage.getItem(`${PICKS_SEED_KEY_PREFIX}${playlistId}`);
    const seed = Math.floor(Number(raw));
    return Number.isFinite(seed) && seed >= 0 ? seed : 0;
  } catch {
    return 0;
  }
}

export function writePicksSeed(playlistId: string, seed: number): void {
  try {
    sessionStorage.setItem(`${PICKS_SEED_KEY_PREFIX}${playlistId}`, String(seed));
  } catch {
    // Storage unavailable: the seed lives for this load only.
  }
}

// ---------------------------------------------------------------------------
// Painting (exported for jsdom render tests — no loading here)
// ---------------------------------------------------------------------------

export interface PaintMoviesHomeOptions {
  /** Called when Refresh Picks is pressed (the mount rebuilds). */
  onRefreshPicks?: () => void;
}

/** Paint every Home section from a built model. No catalogue grid. */
export function paintMoviesHome(
  root: HTMLElement,
  model: MoviesHomeModel,
  opts: PaintMoviesHomeOptions = {},
): void {
  setHidden($(ID.skeleton, root), true);
  setHidden($(ID.nolist, root), true);
  setHidden($(ID.empty, root), true);
  setHidden($(ID.error, root), true);

  const countEl = $(ID.count, root);
  if (countEl) {
    countEl.textContent = `${model.totalCount.toLocaleString()} ${model.totalCount === 1 ? "movie" : "movies"}`;
  }

  paintFeatured($(ID.featured, root), model.featured, opts.onRefreshPicks);

  paintShelf(
    $(ID.continue, root),
    {
      railId: MOVIES_HOME_RAILS.continue,
      title: "Continue Watching",
      cardViews: model.continueWatching.items.map((item) =>
        movieHomeCardView(item.row, item.progress, {
          metaSuffix: item.remainingLabel || undefined,
        }),
      ),
      viewAll:
        model.continueWatching.total > 0
          ? {
              label: "View all",
              sub: `${model.continueWatching.total} in progress`,
              href: MOVIES_HOME_BROWSE_URLS.continueWatching,
              key: "movies-viewall-continue",
              ariaLabel: "View all continue watching",
            }
          : undefined,
    },
  );

  paintShelf($(ID.worth, root), {
    railId: MOVIES_HOME_RAILS.worth,
    title: model.worthWatching.label,
    cardViews: model.worthWatching.items.map((row) => movieHomeCardView(row, null)),
  });

  paintShelf($(ID.recent, root), {
    railId: MOVIES_HOME_RAILS.recent,
    title: "Recently Added",
    note: model.recentlyAdded.evidence.note,
    cardViews: model.recentlyAdded.items.map((row) => movieHomeCardView(row, null)),
    viewAll:
      model.recentlyAdded.items.length > 0
        ? {
            label: "View all",
            sub: "Sorted by date added",
            href: MOVIES_HOME_BROWSE_URLS.recentlyAdded,
            key: "movies-viewall-recent",
            ariaLabel: "View all recently added",
          }
        : undefined,
  });

  paintGenres($(ID.genres, root), model.genres);

  const browseEntry = $(ID.browseEntry, root);
  setHidden(browseEntry, false);
  const browseCount = $(ID.browseCount, root);
  if (browseCount) {
    browseCount.textContent = `Browse all ${model.totalCount.toLocaleString()} ${model.totalCount === 1 ? "film" : "films"}`;
  }

  try {
    armTvImageFallbacks(document);
  } catch {
    // Non-DOM test runtimes: markup is still correct.
  }
  try {
    (window as unknown as { SpatialNavigation?: { makeFocusable?: () => void } })
      .SpatialNavigation?.makeFocusable?.();
  } catch {
    // Focus engine unavailable: mouse/touch keep working.
  }
}

interface ShelfViewAll {
  label: string;
  sub: string;
  href: string;
  key: string;
  ariaLabel: string;
}

interface ShelfSpec {
  railId: string;
  title: string;
  note?: string;
  cardViews: ReturnType<typeof movieHomeCardView>[];
  viewAll?: ShelfViewAll;
}

/** One shelf section — omitted entirely when it has no cards. */
function paintShelf(mount: HTMLElement | null, spec: ShelfSpec): void {
  if (!mount) return;
  mount.replaceChildren();
  if (spec.cardViews.length === 0 && !spec.viewAll) {
    mount.hidden = true;
    return;
  }
  mount.hidden = false;
  const section = el("section", "rs-rail rs-rail--large mh-shelf");
  section.setAttribute("data-nylah-rail", spec.railId);
  section.setAttribute("aria-label", spec.title);
  const head = el("div", "rs-rail__head");
  const h2 = el("h2", "rs-section-title");
  h2.textContent = spec.title;
  head.appendChild(h2);
  if (spec.note) {
    const note = el("span", "mh-shelf__note");
    note.textContent = spec.note;
    head.appendChild(note);
  }
  section.appendChild(head);
  const rowEl = el("div", "rs-rail__row");
  for (const view of spec.cardViews) {
    rowEl.appendChild(buildCouchCard(view, false));
  }
  if (spec.viewAll) {
    const tile = el("a", "mh-viewall");
    tile.setAttribute("data-nylah-item", "");
    tile.setAttribute("data-couch-key", spec.viewAll.key);
    tile.href = spec.viewAll.href;
    tile.setAttribute("aria-label", spec.viewAll.ariaLabel);
    const label = el("span", "mh-viewall__label");
    label.textContent = `${spec.viewAll.label} →`;
    tile.appendChild(label);
    if (spec.viewAll.sub) {
      const sub = el("span", "mh-viewall__sub");
      sub.textContent = spec.viewAll.sub;
      tile.appendChild(sub);
    }
    rowEl.appendChild(tile);
  }
  section.appendChild(rowEl);
  mount.appendChild(section);
}

/** Featured film — cinematic hero, or the elegant compact fallback. */
function paintFeatured(
  mount: HTMLElement | null,
  featured: FeaturedFilm | null,
  onRefreshPicks?: () => void,
): void {
  if (!mount) return;
  mount.replaceChildren();
  if (!featured) {
    mount.hidden = true;
    return;
  }
  mount.hidden = false;
  const section = el("section", `mh-featured${featured.compact ? " mh-featured--compact" : ""}`);
  section.setAttribute("data-nylah-rail", MOVIES_HOME_RAILS.featured);
  section.setAttribute("aria-label", `Featured film: ${featured.title}`);

  const link = el("a", "mh-featured__link");
  link.setAttribute("data-nylah-item", "");
  link.setAttribute("data-couch-key", `vod-${featured.row.id}`);
  link.href = featured.detailHref;

  const media = el("span", "mh-featured__media");
  const imageKind = featured.compact ? "poster" : "backdrop";
  const imageWrap = el("span", `rs-image rs-image--${imageKind}`);
  imageWrap.setAttribute("data-tv-image", "");
  imageWrap.setAttribute("data-kind", imageKind);
  const usable = isUsableImageSrc(featured.posterSrc);
  if (!usable) imageWrap.classList.add("is-fallback");
  if (usable) {
    const img = el("img", "");
    img.setAttribute("src", featured.posterSrc as string);
    img.setAttribute("alt", "");
    img.setAttribute("decoding", "async");
    img.setAttribute("data-tv-image-img", "");
    imageWrap.appendChild(img);
  }
  const fallback = el("span", "rs-image__fallback");
  fallback.setAttribute("aria-hidden", "true");
  const mark = el("span", "rs-image__fallback-mark");
  mark.textContent = fallbackMarkFor(imageKind, featured.title);
  fallback.appendChild(mark);
  const fbTitle = el("span", "rs-image__fallback-title");
  fbTitle.textContent = featured.title;
  fallback.appendChild(fbTitle);
  imageWrap.appendChild(fallback);
  media.appendChild(imageWrap);
  const scrim = el("span", "mh-featured__scrim");
  scrim.setAttribute("aria-hidden", "true");
  media.appendChild(scrim);
  link.appendChild(media);

  const content = el("span", "mh-featured__content");
  const eyebrow = el("span", "mh-featured__eyebrow");
  eyebrow.textContent = "Featured film";
  content.appendChild(eyebrow);
  const title = document.createElement("h2");
  title.className = "mh-featured__title";
  title.textContent = featured.title;
  content.appendChild(title);
  const metaParts = [
    featured.year,
    featured.runtimeLabel,
    featured.genreSummary,
    featured.ratingLabel,
  ].filter(Boolean);
  if (metaParts.length) {
    const meta = document.createElement("p");
    meta.className = "mh-featured__meta";
    meta.textContent = metaParts.join("  ·  ");
    content.appendChild(meta);
  }
  if (featured.synopsis) {
    const synopsis = document.createElement("p");
    synopsis.className = "mh-featured__synopsis";
    synopsis.textContent = featured.synopsis;
    content.appendChild(synopsis);
  }
  const actions = el("span", "mh-featured__actions");
  const primary = el("span", "rs-hero__action");
  primary.textContent =
    featured.primaryLabel === "Continue Watching"
      ? "▶ Continue Watching"
      : "View Details";
  actions.appendChild(primary);
  content.appendChild(actions);
  if (featured.progressFraction > 0 && featured.progressFraction < 1) {
    const bar = el("span", "mh-featured__progress");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("span", "mh-featured__progress-fill");
    fill.setAttribute("style", `width: ${Math.round(featured.progressFraction * 100)}%`);
    bar.appendChild(fill);
    content.appendChild(bar);
  }
  link.appendChild(content);
  section.appendChild(link);

  const refresh = el("button", "mh-featured__refresh rs-hero__action rs-hero__action--secondary");
  refresh.type = "button";
  refresh.setAttribute("data-nylah-item", "");
  refresh.setAttribute("data-couch-key", "movies-refresh-picks");
  refresh.setAttribute("aria-label", "Refresh picks — choose a different featured film");
  refresh.textContent = "↻ Refresh picks";
  refresh.addEventListener("click", () => {
    onRefreshPicks?.();
  });
  section.appendChild(refresh);

  mount.appendChild(section);
}

/** Explore Genres — compact tile grid, chunked into rail rows. */
function paintGenres(mount: HTMLElement | null, tiles: GenreTile[]): void {
  if (!mount) return;
  mount.replaceChildren();
  if (tiles.length === 0) {
    mount.hidden = true;
    return;
  }
  mount.hidden = false;
  const section = el("section", "mh-genres");
  section.setAttribute("aria-label", "Explore genres");
  const head = el("div", "rs-rail__head");
  const h2 = el("h2", "rs-section-title");
  h2.textContent = "Explore Genres";
  head.appendChild(h2);
  section.appendChild(head);
  const rows: GenreTile[][] = [];
  for (let i = 0; i < tiles.length; i += GENRE_TILES_PER_ROW) {
    rows.push(tiles.slice(i, i + GENRE_TILES_PER_ROW));
  }
  rows.forEach((rowTiles, rowIndex) => {
    const rowEl = el("div", "mh-genres__row");
    rowEl.setAttribute(
      "data-nylah-rail",
      rowIndex === 0 ? MOVIES_HOME_RAILS.genresA : MOVIES_HOME_RAILS.genresB,
    );
    for (const tile of rowTiles) {
      const link = el("a", "mh-genre-tile");
      link.setAttribute("data-nylah-item", "");
      link.setAttribute("data-couch-key", `movies-genre-${tile.id}`);
      link.href = tile.href;
      const name = el("span", "mh-genre-tile__name");
      name.textContent = tile.label;
      link.appendChild(name);
      const count = el("span", "mh-genre-tile__count");
      count.textContent = `${tile.count.toLocaleString()} ${tile.count === 1 ? "film" : "films"}`;
      link.appendChild(count);
      rowEl.appendChild(link);
    }
    section.appendChild(rowEl);
  });
  mount.appendChild(section);
}

/** Repaint featured + worth sections after Refresh Picks (focus-safe). */
export function repaintPicks(
  root: HTMLElement,
  model: MoviesHomeModel,
  onRefreshPicks: () => void,
): void {
  paintFeatured($(ID.featured, root), model.featured, onRefreshPicks);
  paintShelf($(ID.worth, root), {
    railId: MOVIES_HOME_RAILS.worth,
    title: model.worthWatching.label,
    cardViews: model.worthWatching.items.map((row) => movieHomeCardView(row, null)),
  });
  try {
    armTvImageFallbacks(document);
  } catch {
    // ignore — non-DOM runtimes
  }
  // Focus stays on Refresh Picks: the button node was replaced, so
  // land focus on its replacement instead of stranding the viewer.
  const refresh = root.querySelector<HTMLElement>('[data-couch-key="movies-refresh-picks"]');
  refresh?.focus({ preventScroll: true });
  if (refresh) scrollFocusedIntoView(refresh);
}

// ---------------------------------------------------------------------------
// Loading / empty / error states (§18)
// ---------------------------------------------------------------------------

export type MoviesHomeMessageKind = "loading" | "nolist" | "empty" | "error";

/** Show exactly one state block; hide the content sections. */
export function showMoviesHomeMessage(
  root: HTMLElement,
  kind: MoviesHomeMessageKind,
  detail = "",
): void {
  setHidden($(ID.skeleton, root), kind !== "loading");
  setHidden($(ID.nolist, root), kind !== "nolist");
  setHidden($(ID.empty, root), kind !== "empty");
  setHidden($(ID.error, root), kind !== "error");
  const contentIds = [ID.featured, ID.continue, ID.worth, ID.recent, ID.genres, ID.browseEntry];
  for (const id of contentIds) setHidden($(id, root), true);
  const countEl = $(ID.count, root);
  if (countEl) {
    countEl.textContent =
      kind === "loading"
        ? "Loading…"
        : kind === "nolist"
          ? "No playlist selected"
          : kind === "empty"
            ? "0 movies"
            : "Couldn't reach your provider";
  }
  if (kind === "error") {
    const messageEl = $(ID.errorMessage, root);
    if (messageEl) {
      messageEl.textContent =
        detail ||
        "Could not reach the provider. This is a connection problem, not an empty library — check Settings and try again.";
    }
  }
}

// ---------------------------------------------------------------------------
// Focus (§16.5) + shelf jump (keyboard parity for LB/RB)
// ---------------------------------------------------------------------------

/**
 * Restore the remembered Home focus after paint. The shared
 * restoreCouchFocus() only acts when nothing is focused, but the
 * layout seeds top-nav focus on load before the catalogue paints —
 * so this restores whenever focus is still on <body> or in the top
 * nav, and never steals focus the viewer already moved. Prefers the
 * stable data-couch-key, falls back to rail + index (nearest
 * surviving item). Returns the focused element or null.
 */
export function restoreMoviesHomeFocus(doc: Document = document): HTMLElement | null {
  const memory = readCouchFocusMemory();
  if (!memory) return null;
  let route = "";
  try {
    route = doc.defaultView?.location.pathname ?? "";
  } catch {
    route = "";
  }
  if (route !== memory.route) return null;
  const active = doc.activeElement as HTMLElement | null;
  const inNav = !!active?.closest?.("[data-couch-nav]");
  if (active && active !== doc.body && !inNav) return null;
  const rail = doc.querySelector(`[data-nylah-rail="${escapeAttr(memory.rail)}"]`);
  if (!rail) return null;
  const items = couchRailItems(rail);
  if (items.length === 0) return null;
  let target: HTMLElement | undefined;
  if (memory.key) {
    target = items.find((item) => item.getAttribute("data-couch-key") === memory.key);
  }
  if (!target) target = items[Math.min(memory.index, items.length - 1)];
  target.focus({ preventScroll: true });
  scrollFocusedIntoView(target);
  return target;
}

/** Next/previous section id in document order — no wrap (predictable). */
export function adjacentHomeSectionId(
  orderedIds: readonly string[],
  currentId: string,
  direction: "prev" | "next",
): string | null {
  const at = orderedIds.indexOf(currentId);
  if (at === -1) return null;
  const next = direction === "next" ? at + 1 : at - 1;
  if (next < 0 || next >= orderedIds.length) return null;
  return orderedIds[next];
}

function isEditingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

/**
 * Keyboard shelf-jump: PageUp/PageDown (and [ ]) move focus to the
 * first item of the previous/next Home section. Controller LB/RB
 * dispatch no key outside Live TV playback (gamepad.ts seek branch),
 * so this is keyboard parity; the LB/RB seam is flagged for
 * integration (gamepad.ts is read-only for W3). D-pad U/D already
 * moves between sections via the rail model.
 */
export function installHomeShelfJump(root: HTMLElement): void {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const jump =
      event.key === "PageUp" || event.key === "["
        ? "prev"
        : event.key === "PageDown" || event.key === "]"
          ? "next"
          : null;
    if (!jump) return;
    if (document.querySelector("dialog[open]")) return;
    if (isEditingTarget(event.target)) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) return;
    const currentRail = active.closest("[data-nylah-rail]");
    if (!currentRail) return;
    const rails = Array.from(root.querySelectorAll("[data-nylah-rail]"))
      .map((rail) => rail.getAttribute("data-nylah-rail") ?? "")
      .filter(Boolean);
    const currentId = currentRail.getAttribute("data-nylah-rail") ?? "";
    const targetId = adjacentHomeSectionId(rails, currentId, jump);
    if (!targetId) return;
    const targetRail = root.querySelector(`[data-nylah-rail="${escapeAttr(targetId)}"]`);
    if (!targetRail) return;
    const items = couchRailItems(targetRail);
    if (items.length === 0) return;
    event.preventDefault();
    items[0].focus({ preventScroll: true });
    scrollFocusedIntoView(items[0]);
  });
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

let listenersInstalled = false;
let bootRunId = 0;

export function mountMoviesHome(): void {
  if (typeof document === "undefined") return;
  const root = $(ID.root);
  if (!root) return;

  if (!listenersInstalled) {
    listenersInstalled = true;
    installHomeShelfJump(root);
    $(ID.retry)?.addEventListener("click", () => window.location.reload());
    document.addEventListener("xt:active-changed", () => {
      void boot(root);
    });
  }

  void boot(root);
}

async function boot(root: HTMLElement): Promise<void> {
  const runId = ++bootRunId;
  showMoviesHomeMessage(root, "loading");

  await ensurePrefsLoaded().catch(() => {});
  let result;
  try {
    result = await loadCouchCatalog<MovieRow>(moviesAdapter.spec);
  } catch {
    if (runId !== bootRunId) return;
    showMoviesHomeMessage(
      root,
      "error",
      "Could not load the catalogue. This is a connection problem, not an empty library — check the provider connection in Settings.",
    );
    return;
  }
  if (runId !== bootRunId) return;

  if (!result) {
    showMoviesHomeMessage(root, "nolist");
    return;
  }
  if (result.loadError) {
    showMoviesHomeMessage(
      root,
      "error",
      `Could not reach ${result.playlistTitle || "the provider"}. This is a connection problem, not an empty library — check the connection in Settings and try again.`,
    );
    return;
  }
  const rows = result.rows;
  if (rows.length === 0) {
    showMoviesHomeMessage(root, "empty");
    return;
  }

  const playlistId = result.playlistId;
  let taste: TasteModel;
  try {
    const profileId = getActiveProfileId() ?? SHARED_PROFILE_ID;
    taste = loadTaste(profileId, playlistId);
  } catch {
    taste = emptyTasteModel("shared", playlistId);
  }

  const progressById: ProgressById = new Map();
  for (const row of rows) {
    const progress = getProgress(playlistId, "vod", row.id) as MoviesHomeProgress | null;
    if (progress) (progressById as Map<number, MoviesHomeProgress>).set(row.id, progress);
  }

  const rebuild = (): MoviesHomeModel =>
    buildMoviesHomeModel({
      rows,
      playlistId,
      taste,
      progressById,
      rotationSeed: readPicksSeed(playlistId),
      nowMs: Date.now(),
    });

  const onRefreshPicks = (): void => {
    writePicksSeed(playlistId, readPicksSeed(playlistId) + 1);
    repaintPicks(root, rebuild(), onRefreshPicks);
  };

  paintMoviesHome(root, rebuild(), { onRefreshPicks });
  restoreMoviesHomeFocus(document);
}
