// Movies Home mount — DOM assembly + loading for the 0.11.8 Movies
// Home screen (brief §3, §16, §18 Home parts).
//
// The router (couch-index.ts) mounts EITHER this OR Browse
// Everything per page load, from the mode URL. This module:
//
//   - loads the catalogue through the existing loader
//     (loadCouchCatalog + the movies adapter spec — no new network
//     code, no new cache),
//   - builds the curated model (movies-home.ts — pure, W1 selectors),
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
  setLogicalView,
} from "@/scripts/lib/couch-focus.ts";
import {
  BACK_PRIORITY,
  registerBackLayer,
} from "@/scripts/lib/back-handler.ts";
import {
  RETURN_HOME_HINT,
  setControllerHints,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints.ts";
import { recordRouteOrigin } from "@/scripts/lib/route-origin.ts";
import {
  isTitleContextMenuOpen,
  openTitleContextMenu,
  titleContextActionsForEntry,
} from "@/scripts/lib/poster-menu.ts";
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
  type HomeShelfItem,
  type MoviesHomeModel,
  type MoviesHomeProgress,
  type ProgressById,
} from "@/scripts/movies/movies-home.ts";
import type { MovieRow } from "@/scripts/movies/couch-movies.ts";
import { getCatalogIndex } from "@/scripts/lib/catalog-index.ts";
import { getAiEnabled, getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js";
import { getAiShareTaste } from "@/scripts/lib/ai/status.ts";
import {
  catalogueFingerprintFor,
  groundedReasonForAiCard,
  homeAiSourceNote,
  maybeAutoRefreshHomeAiPicks,
  readCachedHomeAiPicks,
  requestHomeAiPicks,
  tasteRevisionFor,
  type HomeAiPick,
  type HomeAiSource,
} from "@/scripts/lib/home-ai-picks.ts";
import {
  discoverPromptRequestType,
  discoverPromptsFor,
  discoverUrlForPrompt,
  type DiscoverEntryPrompt,
} from "@/scripts/lib/home-discover-entries.ts";
import {
  buildPromptShortlist,
  localPromptRankedIds,
  picksToEntries,
  resolvePromptItems,
} from "@/scripts/lib/home-prompt-results.ts";
import { hasCredibleRating, normaliseRating } from "@/scripts/lib/rating-evidence.ts";
import { genreLabelForId, genresForEntry } from "@/scripts/lib/genres.ts";

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
  ai: "movies-home-ai",
  discover: "movies-home-discover",
  discoverResults: "movies-home-discover-results",
  worth: "movies-home-worth",
  different: "movies-home-different",
  gems: "movies-home-gems",
  recent: "movies-home-recent",
  genres: "movies-home-genres",
  browseEntry: "movies-home-browse-entry",
  browseCount: "movies-home-browse-count",
} as const;

/** On-page Discover entry-point results (brief §21), resolved to movie rows by the mount. */
export interface MoviesDiscoverResults {
  prompt: DiscoverEntryPrompt;
  items: HomeShelfItem[];
  source: HomeAiSource;
  note: string;
  discoverHref: string;
}

const PICKS_SEED_KEY_PREFIX = "movies-home-picks-seed:";

/** One-shot return focus: Browse exit records the genre tile to land on. */
const HOME_RETURN_KEY = "rs_movies_home_return_key";

export function recordMoviesHomeReturnFocus(key: string): void {
  try {
    sessionStorage.setItem(HOME_RETURN_KEY, key);
  } catch {
    // Return focus is a nicety.
  }
}

function consumeMoviesHomeReturnFocus(): string | null {
  try {
    const raw = sessionStorage.getItem(HOME_RETURN_KEY);
    sessionStorage.removeItem(HOME_RETURN_KEY);
    return raw || null;
  } catch {
    return null;
  }
}

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
  /** Called when Generate / Request-fresh AI picks is pressed (explicit user action). */
  onAiAction?: () => void;
  /** True while an AI request is in flight — the AI action disables without moving focus. */
  aiBusy?: boolean;
  /** Called when a Discover entry-point chip is tapped (explicit user action). */
  onDiscoverPrompt?: (prompt: DiscoverEntryPrompt) => void;
  /** Id of the prompt whose results are showing (chip stays marked active). */
  activeDiscoverPromptId?: string | null;
  /** On-page Discover results to show, when the viewer tapped a prompt. */
  discoverResults?: MoviesDiscoverResults | null;
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

  paintAiShelf($(ID.ai, root), model, opts);
  paintDiscoverEntries($(ID.discover, root), opts);
  paintDiscoverResults($(ID.discoverResults, root), opts.discoverResults ?? null);

  paintShelf($(ID.worth, root), {
    railId: MOVIES_HOME_RAILS.worth,
    title: model.worthWatching.label,
    cardViews: model.worthWatching.items.map((row) =>
      movieHomeCardView(row, null, { detail: model.worthWatching.reasons[String(row.id)] ?? null }),
    ),
    viewAll:
      model.worthWatching.items.length > 0
        ? {
            label: "Browse more",
            sub: "Highest rated in Browse Everything",
            href: MOVIES_HOME_BROWSE_URLS.worthWatching,
            key: "movies-viewall-worth",
            ariaLabel: "Browse more worth watching films",
          }
        : undefined,
  });

  paintShelf($(ID.different, root), {
    railId: MOVIES_HOME_RAILS.different,
    title: "Something Different",
    note: "Good films outside your usual genres",
    cardViews: model.somethingDifferent.items.map((item) =>
      movieHomeCardView(item.row, null, { detail: item.reason }),
    ),
    viewAll:
      model.somethingDifferent.items.length > 0
        ? {
            label: "Browse more",
            sub: "Recommended in Browse Everything",
            href: MOVIES_HOME_BROWSE_URLS.somethingDifferent,
            key: "movies-viewall-different",
            ariaLabel: "Browse more different films",
          }
        : undefined,
  });

  paintShelf($(ID.gems, root), {
    railId: MOVIES_HOME_RAILS.gems,
    title: "Hidden Gems",
    note: "Well-rated films that rarely get surfaced",
    cardViews: model.hiddenGems.items.map((item) =>
      movieHomeCardView(item.row, null, { detail: item.reason }),
    ),
    viewAll:
      model.hiddenGems.items.length > 0
        ? {
            label: "Browse more",
            sub: "Highest rated in Browse Everything",
            href: MOVIES_HOME_BROWSE_URLS.hiddenGems,
            key: "movies-viewall-gems",
            ariaLabel: "Browse more hidden gems",
          }
        : undefined,
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
  /** Optional head action (e.g. Request fresh AI picks) — rendered as a focusable button. */
  headAction?: {
    label: string;
    hint: string;
    key: string;
    busy?: boolean;
    onClick?: () => void;
  };
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
  if (spec.headAction) {
    const action = el("button", "rs-hero__action rs-hero__action--secondary mh-shelf__action");
    action.type = "button";
    action.setAttribute("data-nylah-item", "");
    action.setAttribute("data-couch-key", spec.headAction.key);
    action.setAttribute("aria-label", `${spec.headAction.label}. ${spec.headAction.hint}`);
    action.textContent = spec.headAction.busy ? "Asking AI…" : spec.headAction.label;
    action.disabled = spec.headAction.busy === true;
    action.addEventListener("click", () => spec.headAction?.onClick?.());
    head.appendChild(action);
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

/** AI Picks shelf — verified picks only, or the Generate prompt banner, or nothing (AI off). */
function paintAiShelf(
  mount: HTMLElement | null,
  model: MoviesHomeModel,
  opts: PaintMoviesHomeOptions,
): void {
  if (!mount) return;
  mount.replaceChildren();
  if (model.aiPicks.items.length > 0) {
    paintShelf(mount, {
      railId: MOVIES_HOME_RAILS.ai,
      title: model.aiPicks.label,
      note: model.aiPicks.note || undefined,
      cardViews: model.aiPicks.items.map((item) =>
        movieHomeCardView(item.row, null, { detail: item.reason }),
      ),
      headAction:
        model.aiAction.kind === "request-fresh"
          ? {
              label: model.aiAction.label,
              hint: model.aiAction.hint,
              key: "movies-ai-refresh",
              busy: opts.aiBusy,
              onClick: opts.onAiAction,
            }
          : undefined,
      viewAll: {
        label: "Browse more",
        sub: "Recommended in Browse Everything",
        href: MOVIES_HOME_BROWSE_URLS.aiPicks,
        key: "movies-viewall-ai",
        ariaLabel: "Browse more recommended films",
      },
    });
    return;
  }
  if (model.aiAction.kind === "generate") {
    mount.hidden = false;
    const section = el("section", "rs-rail rs-rail--large mh-shelf mh-ai-prompt");
    section.setAttribute("data-nylah-rail", MOVIES_HOME_RAILS.ai);
    section.setAttribute("aria-label", model.aiPicks.label);
    const head = el("div", "rs-rail__head");
    const h2 = el("h2", "rs-section-title");
    h2.textContent = model.aiPicks.label;
    head.appendChild(h2);
    section.appendChild(head);
    const sub = el("p", "rs-meta mh-ai-prompt__sub");
    sub.textContent = "AI-ranked films from your own library";
    section.appendChild(sub);
    const button = el("button", "rs-hero__action rs-hero__action--secondary");
    button.type = "button";
    button.setAttribute("data-nylah-item", "");
    button.setAttribute("data-couch-key", "movies-ai-generate");
    button.setAttribute("aria-label", `${model.aiAction.label}. ${model.aiAction.hint}`);
    button.textContent = opts.aiBusy ? "Asking AI…" : model.aiAction.label;
    button.disabled = opts.aiBusy === true;
    button.addEventListener("click", () => opts.onAiAction?.());
    section.appendChild(button);
    const hint = el("p", "rs-meta mh-ai-prompt__hint");
    hint.textContent = model.aiAction.hint;
    section.appendChild(hint);
    if (model.aiNote) {
      const note = el("p", "rs-meta mh-ai-prompt__note");
      note.textContent = model.aiNote;
      section.appendChild(note);
    }
    mount.appendChild(section);
    return;
  }
  // AI not configured: no AI shelf, no AI button — local shelves carry the page.
  mount.hidden = true;
}

/** Discover entry-point chips (§21): pre-scoped prompts, one explicit request per tap. */
function paintDiscoverEntries(
  mount: HTMLElement | null,
  opts: PaintMoviesHomeOptions,
): void {
  if (!mount) return;
  mount.replaceChildren();
  mount.hidden = false;
  const section = el("section", "rs-rail rs-rail--large mh-shelf mh-discover");
  section.setAttribute("data-nylah-rail", MOVIES_HOME_RAILS.discover);
  section.setAttribute("aria-label", "Find something with AI");
  const head = el("div", "rs-rail__head");
  const h2 = el("h2", "rs-section-title");
  h2.textContent = "Find something with AI";
  head.appendChild(h2);
  section.appendChild(head);
  const sub = el("p", "rs-meta mh-discover__sub");
  sub.textContent = "Ask AI for in-library picks, right here — one request per tap";
  section.appendChild(sub);
  const rowEl = el("div", "mh-chips");
  for (const prompt of discoverPromptsFor("movie")) {
    const chip = el("button", "mh-chip");
    chip.type = "button";
    chip.setAttribute("data-nylah-item", "");
    chip.setAttribute("data-couch-key", `movies-discover-${prompt.id}`);
    chip.setAttribute("data-discover-prompt-id", prompt.id);
    chip.setAttribute("aria-label", `Ask AI: ${prompt.label}`);
    if (opts.activeDiscoverPromptId === prompt.id) chip.setAttribute("aria-pressed", "true");
    chip.textContent = prompt.label;
    chip.addEventListener("click", () => opts.onDiscoverPrompt?.(prompt));
    rowEl.appendChild(chip);
  }
  section.appendChild(rowEl);
  mount.appendChild(section);
}

/** On-page Discover results shelf (§21): AI-ranked in-library results, browsable here. */
function paintDiscoverResults(
  mount: HTMLElement | null,
  results: MoviesDiscoverResults | null,
): void {
  if (!mount) return;
  mount.replaceChildren();
  if (!results || results.items.length === 0) {
    mount.hidden = true;
    return;
  }
  mount.hidden = false;
  paintShelf(mount, {
    railId: "movies-discover-results",
    title: `Results for “${results.prompt.label}”`,
    note: results.note || undefined,
    cardViews: results.items.map((item) =>
      movieHomeCardView(item.row, null, { detail: item.reason }),
    ),
    viewAll: {
      label: "Open in Discover",
      sub: "Refine in Discover",
      href: results.discoverHref,
      key: "movies-viewall-discover",
      ariaLabel: "Open in Discover",
    },
  });
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
  // Honest label (§19): this rotates LOCAL selections only — it never
  // calls the AI provider. Fresh AI picks have their own action.
  refresh.setAttribute("aria-label", "Refresh local picks — rotates local selections, no AI request");
  refresh.textContent = "↻ Refresh local picks";
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

/** Repaint featured + recommendation shelves after Refresh Picks (focus/scroll-safe). */
export function repaintPicks(
  root: HTMLElement,
  model: MoviesHomeModel,
  onRefreshPicks: () => void,
): void {
  repaintHomeShelves(root, model, { onRefreshPicks });
}

/**
 * Focus/scroll preservation for shelf repaints (§24, W1 contract):
 * capture the focused card (rail + couch key), the page scroll, and
 * every rail row's horizontal scroll; repaint; restore all three.
 * Focus lands on the same card when it survives, the nearest
 * surviving card in the same rail when it doesn't, and never jumps
 * to an unrelated control. Builds on the shared couch-focus memory
 * (data-couch-key / rail) — no parallel focus mechanism.
 */
export function preserveFocusAndScroll(root: HTMLElement, repaint: () => void): void {
  const doc = root.ownerDocument ?? document;
  const active = doc.activeElement as HTMLElement | null;
  const focusedKey =
    active && root.contains(active) ? active.getAttribute("data-couch-key") : null;
  const focusedRail = active?.closest?.("[data-nylah-rail]")?.getAttribute("data-nylah-rail") ?? null;
  const pageScrollY = typeof window !== "undefined" ? window.scrollY : 0;
  const railScrolls = new Map<string, number>();
  for (const row of root.querySelectorAll("[data-nylah-rail] .rs-rail__row")) {
    const rail = row.closest("[data-nylah-rail]")?.getAttribute("data-nylah-rail");
    if (rail) railScrolls.set(rail, (row as HTMLElement).scrollLeft || 0);
  }
  const focusedIndex = (() => {
    if (!active || !focusedRail) return -1;
    const railEl = root.querySelector(`[data-nylah-rail="${escapeAttr(focusedRail)}"]`);
    if (!railEl) return -1;
    return couchRailItems(railEl).indexOf(active);
  })();

  repaint();

  for (const [rail, left] of railScrolls) {
    const row = root.querySelector(
      `[data-nylah-rail="${escapeAttr(rail)}"] .rs-rail__row`,
    ) as HTMLElement | null;
    if (row) row.scrollLeft = left;
  }
  if (typeof window !== "undefined" && window.scrollY !== pageScrollY) {
    window.scrollTo(0, pageScrollY);
  }
  if (!focusedKey) return;
  const after = doc.activeElement as HTMLElement | null;
  if (after && after !== doc.body && after.isConnected && root.contains(after)) return;
  let target: HTMLElement | null = null;
  if (focusedRail) {
    const railEl = root.querySelector(`[data-nylah-rail="${escapeAttr(focusedRail)}"]`);
    if (railEl) {
      const items = couchRailItems(railEl);
      target =
        items.find((item) => item.getAttribute("data-couch-key") === focusedKey) ??
        items[Math.min(Math.max(focusedIndex, 0), items.length - 1)] ??
        null;
    }
  }
  target ??= root.querySelector<HTMLElement>(`[data-couch-key="${escapeAttr(focusedKey)}"]`);
  if (target) {
    target.focus({ preventScroll: true });
    scrollFocusedIntoView(target);
  }
}

/** Repaint the recommendation shelves + featured from a rebuilt model, preserving focus/scroll. */
export function repaintHomeShelves(
  root: HTMLElement,
  model: MoviesHomeModel,
  opts: PaintMoviesHomeOptions = {},
): void {
  preserveFocusAndScroll(root, () => {
    paintFeatured($(ID.featured, root), model.featured, opts.onRefreshPicks);
    paintAiShelf($(ID.ai, root), model, opts);
    paintDiscoverEntries($(ID.discover, root), opts);
    paintDiscoverResults($(ID.discoverResults, root), opts.discoverResults ?? null);
    paintShelf($(ID.worth, root), {
      railId: MOVIES_HOME_RAILS.worth,
      title: model.worthWatching.label,
      cardViews: model.worthWatching.items.map((row) =>
        movieHomeCardView(row, null, { detail: model.worthWatching.reasons[String(row.id)] ?? null }),
      ),
      viewAll:
        model.worthWatching.items.length > 0
          ? {
              label: "Browse more",
              sub: "Highest rated in Browse Everything",
              href: MOVIES_HOME_BROWSE_URLS.worthWatching,
              key: "movies-viewall-worth",
              ariaLabel: "Browse more worth watching films",
            }
          : undefined,
    });
    paintShelf($(ID.different, root), {
      railId: MOVIES_HOME_RAILS.different,
      title: "Something Different",
      note: "Good films outside your usual genres",
      cardViews: model.somethingDifferent.items.map((item) =>
        movieHomeCardView(item.row, null, { detail: item.reason }),
      ),
      viewAll:
        model.somethingDifferent.items.length > 0
          ? {
              label: "Browse more",
              sub: "Recommended in Browse Everything",
              href: MOVIES_HOME_BROWSE_URLS.somethingDifferent,
              key: "movies-viewall-different",
              ariaLabel: "Browse more different films",
            }
          : undefined,
    });
    paintShelf($(ID.gems, root), {
      railId: MOVIES_HOME_RAILS.gems,
      title: "Hidden Gems",
      note: "Well-rated films that rarely get surfaced",
      cardViews: model.hiddenGems.items.map((item) =>
        movieHomeCardView(item.row, null, { detail: item.reason }),
      ),
      viewAll:
        model.hiddenGems.items.length > 0
          ? {
              label: "Browse more",
              sub: "Highest rated in Browse Everything",
              href: MOVIES_HOME_BROWSE_URLS.hiddenGems,
              key: "movies-viewall-gems",
              ariaLabel: "Browse more hidden gems",
            }
          : undefined,
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
    try {
      armTvImageFallbacks(document);
    } catch {
      // ignore — non-DOM runtimes
    }
  });
}

/** Repaint ONLY the AI shelf (async AI arrival must not touch other shelves, scroll or focus). */
export function repaintAiShelf(
  root: HTMLElement,
  model: MoviesHomeModel,
  opts: PaintMoviesHomeOptions = {},
): void {
  preserveFocusAndScroll(root, () => {
    paintAiShelf($(ID.ai, root), model, opts);
    try {
      armTvImageFallbacks(document);
    } catch {
      // ignore — non-DOM runtimes
    }
  });
}

/** Repaint ONLY the Discover results shelf. Returns the first result card (focus target for a user-initiated prompt). */
export function repaintDiscoverResults(
  root: HTMLElement,
  results: MoviesDiscoverResults | null,
): HTMLElement | null {
  preserveFocusAndScroll(root, () => {
    paintDiscoverResults($(ID.discoverResults, root), results);
    try {
      armTvImageFallbacks(document);
    } catch {
      // ignore — non-DOM runtimes
    }
  });
  return root.querySelector<HTMLElement>(
    '[data-nylah-rail="movies-discover-results"] [data-nylah-item]',
  );
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
  const contentIds = [ID.featured, ID.continue, ID.ai, ID.discover, ID.discoverResults, ID.worth, ID.different, ID.gems, ID.recent, ID.genres, ID.browseEntry];
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
  // Browse-exit return focus wins: the genre tile the viewer came
  // from (recorded by the router's onExit), consumed once.
  const returnKey = consumeMoviesHomeReturnFocus();
  if (returnKey) {
    const tile = doc.querySelector<HTMLElement>(
      `[data-couch-key="${escapeAttr(returnKey)}"]`,
    );
    if (tile && tile.isConnected) {
      tile.focus({ preventScroll: true });
      scrollFocusedIntoView(tile);
      return tile;
    }
  }
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

export const MOVIES_HOME_HINTS: HintConfig = {
  id: "movies-home",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Play / Select" },
    { glyph: "b", label: "Home" },
    { glyph: "x", label: "Options" },
    { glyph: "y", label: "Search Movies" },
    { glyph: "lb", label: "Prev shelf" },
    { glyph: "rb", label: "Next shelf" },
    { glyph: "menu", label: "Settings" },
    RETURN_HOME_HINT,
  ],
};

function homeOwnsInput(root: HTMLElement): boolean {
  if (root.hidden || root.closest("[hidden]")) return false;
  if (document.querySelector("dialog[open]")) return false;
  if (isTitleContextMenuOpen()) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return true;
  if (isEditingTarget(active)) return false;
  if (root.contains(active)) return true;
  return !!active.closest?.("[data-couch-nav]");
}

/** Card identity from a focused Home card element (no URL parsing). */
export function moviesHomeCardIdentity(
  anchor: HTMLElement,
): { id: number; name: string; logo: string | null } | null {
  const key = anchor.getAttribute("data-couch-key") ?? "";
  const match = /^vod-(\d+)$/.exec(key);
  if (!match) return null;
  const titleEl = anchor.querySelector(".rs-card__title, .mh-featured__title");
  const img = anchor.querySelector<HTMLImageElement>("img");
  return {
    id: Number(match[1]),
    name: titleEl?.textContent?.trim() || anchor.getAttribute("aria-label") || "",
    logo: img?.getAttribute("src") || null,
  };
}

export interface MoviesHomeControllerKeysOptions {
  getPlaylistId: () => string;
  navigate: (url: string) => void;
}

/**
 * Controller keys for Movies Home (0.11.10 §13): B → NylahBox
 * Home (Back layer, ROUTE), Y → Search Movies (the scoped header
 * entry, never global search), X → the title context menu for the
 * focused film (Contract F). D-pad/LB/RB stay with spatial nav +
 * shelf-jump. gamepad.ts dispatches "y"/"x" keys here first
 * (dispatch-first routing — the global-search / autoplay-strip
 * fallbacks run only when no handler claims the key), so the
 * controller reaches these handlers. Keyboard X/Y work too.
 * Returns an unregister function.
 */
export function installMoviesHomeControllerKeys(
  root: HTMLElement,
  opts: MoviesHomeControllerKeysOptions,
): () => void {
  setControllerHints(MOVIES_HOME_HINTS);

  const unregisterBack = registerBackLayer({
    id: "movies-home-route",
    priority: BACK_PRIORITY.ROUTE,
    isActive: () => homeOwnsInput(root),
    handle: () => {
      opts.navigate("/");
      return true;
    },
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.repeat) return;
    const key = event.key;
    if (key !== "x" && key !== "X" && key !== "y" && key !== "Y") return;
    if (!homeOwnsInput(root)) return;
    if (key === "y" || key === "Y") {
      event.preventDefault();
      event.stopPropagation();
      opts.navigate(MOVIES_HOME_BROWSE_URLS.search);
      return;
    }
    // X: context menu for the focused film card.
    const active = document.activeElement as HTMLElement | null;
    const card = active?.closest?.("[data-couch-key]") as HTMLElement | null;
    if (!card || !root.contains(card)) return;
    const identity = moviesHomeCardIdentity(card);
    if (!identity) return;
    event.preventDefault();
    event.stopPropagation();
    const playlistId = opts.getPlaylistId();
    const detailHref = card.getAttribute("href") || `/movies/detail?id=${identity.id}`;
    void titleContextActionsForEntry({
      kind: "vod",
      entryId: identity.id,
      name: identity.name,
      logo: identity.logo,
      playlistId,
      includeFollow: false,
      onOpen: () => opts.navigate(detailHref),
    }).then((actions) => {
      if (!card.isConnected) return;
      openTitleContextMenu(card, actions);
    });
  };
  document.addEventListener("keydown", onKeyDown);

  // Provenance: any Home link click records Movies Home as the
  // detail's origin, so B on the detail returns here.
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!link || !root.contains(link)) return;
    recordRouteOrigin({
      route: window.location.pathname + window.location.search,
      label: "Movies Home",
    });
  };
  root.addEventListener("click", onClick);

  return () => {
    unregisterBack();
    document.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("click", onClick);
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

let listenersInstalled = false;
let bootRunId = 0;
let currentPlaylistId = "";

// --- Home AI state (0.11.14, W5) --------------------------------------
// Picks are cached AI answers or fresh verified results; local
// shelves render regardless. No request leaves on load, focus or
// scroll — only from the explicit Generate action, a prompt tap, or
// the optional auto-refresh preference (default off).
let homeAiPicks: HomeAiPick[] | null = null;
let homeAiSource: HomeAiSource = "local";
let homeAiModel: string | undefined;
let homeAiNote: string | null = null;
let homeAiBusy = false;
let discoverResults: MoviesDiscoverResults | null = null;
let activeDiscoverPromptId: string | null = null;

/** Sync "an AI request could run" check: enabled + endpoint + model. */
function aiConfiguredSync(): boolean {
  try {
    return getAiEnabled() && !!getAiEndpoint().trim() && !!getAiModel().trim();
  } catch {
    return false;
  }
}

function movieAiReason(row: MovieRow, modelReason: string | null): string | null {
  const rating = normaliseRating(row);
  const genres = genresForEntry(row, "vod")
    .slice(0, 2)
    .map((id) => genreLabelForId(id, "vod"));
  return groundedReasonForAiCard({
    modelReason,
    genres,
    ratingLabel: hasCredibleRating(rating) ? `★ ${rating!.score10.toFixed(1)}` : "",
    year: row.year ? String(row.year) : "",
  });
}

export function mountMoviesHome(): void {
  if (typeof document === "undefined") return;
  const root = $(ID.root);
  if (!root) return;
  setLogicalView("movies-home");

  if (!listenersInstalled) {
    listenersInstalled = true;
    installHomeShelfJump(root);
    installMoviesHomeControllerKeys(root, {
      getPlaylistId: () => currentPlaylistId,
      navigate: (url) => window.location.assign(url),
    });
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
  currentPlaylistId = playlistId;
  // A new catalogue invalidates Home AI state: cached picks are
  // re-read against the new index fingerprint below.
  homeAiPicks = null;
  homeAiSource = "local";
  homeAiModel = undefined;
  homeAiNote = null;
  homeAiBusy = false;
  discoverResults = null;
  activeDiscoverPromptId = null;
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

  const index = getCatalogIndex("vod", rows, `${playlistId}:${rows.length}`, {
    playlistId,
  });
  const profileId = (() => {
    try {
      return getActiveProfileId() ?? SHARED_PROFILE_ID;
    } catch {
      return SHARED_PROFILE_ID;
    }
  })();

  // Cached AI picks paint immediately (sync, zero requests).
  try {
    let shareTaste = false;
    try {
      shareTaste = getAiShareTaste();
    } catch {
      shareTaste = false;
    }
    const cached = readCachedHomeAiPicks({
      profileId,
      playlistId,
      kind: "movie",
      catalogueFingerprint: catalogueFingerprintFor(index),
      tasteRevision: tasteRevisionFor(taste, shareTaste),
      requestType: "home-picks",
    });
    if (cached) {
      homeAiPicks = cached.picks;
      homeAiSource = "cached-ai";
      homeAiModel = cached.model || undefined;
    }
  } catch {
    // Cache unreadable: local shelves carry the page.
  }

  const completedIds = new Set<string>();
  for (const [id, progress] of progressById as Map<number, MoviesHomeProgress>) {
    if (progress.completed) completedIds.add(String(id));
  }

  const paintOpts = (): PaintMoviesHomeOptions => ({
    onRefreshPicks,
    onAiAction: () => void onAiAction(),
    aiBusy: homeAiBusy,
    onDiscoverPrompt: (prompt) => void onDiscoverPrompt(prompt),
    activeDiscoverPromptId,
    discoverResults,
  });

  const rebuild = (): MoviesHomeModel =>
    buildMoviesHomeModel({
      rows,
      playlistId,
      taste,
      progressById,
      rotationSeed: readPicksSeed(playlistId),
      nowMs: Date.now(),
      aiPicks: homeAiPicks,
      aiAllowed: homeAiPicks != null && homeAiPicks.length > 0,
      aiSource: homeAiSource,
      aiModel: homeAiModel,
      aiNote: homeAiNote,
      aiConfigured: aiConfiguredSync(),
    });

  const onRefreshPicks = (): void => {
    // Local only: rotates the seed. AI picks (cached answers) are
    // untouched, and no request leaves — the button says so.
    writePicksSeed(playlistId, readPicksSeed(playlistId) + 1);
    repaintHomeShelves(root, rebuild(), paintOpts());
  };

  const onAiAction = async (): Promise<void> => {
    if (homeAiBusy) return;
    const hadPicks = homeAiPicks != null && homeAiPicks.length > 0;
    homeAiBusy = true;
    repaintAiShelf(root, rebuild(), paintOpts());
    try {
      const result = await requestHomeAiPicks(
        {
          index,
          taste,
          kind: "movie",
          profileId,
          playlistId,
          excludeIds: [...completedIds],
          rotationSeed: readPicksSeed(playlistId),
          force: hadPicks,
        },
        {},
      );
      if (result.picks.length > 0) {
        homeAiPicks = result.picks;
        homeAiSource = result.source;
        homeAiModel = result.model;
        homeAiNote = null;
      } else {
        homeAiNote = result.note;
        if (result.source === "not-configured") homeAiPicks = null;
      }
    } catch {
      homeAiNote = "AI couldn't answer just now — showing local picks";
    } finally {
      homeAiBusy = false;
      repaintAiShelf(root, rebuild(), paintOpts());
    }
  };

  const onDiscoverPrompt = async (prompt: DiscoverEntryPrompt): Promise<void> => {
    activeDiscoverPromptId = prompt.id;
    const discoverHref = discoverUrlForPrompt(prompt, "movie");
    const localItems = (): HomeShelfItem[] =>
      resolvePromptItems<MovieRow>(
        index,
        localPromptRankedIds(index, taste, "movie", prompt, playlistId).map((id) => ({ id })),
        (row) => movieAiReason(row, null),
      );
    if (!aiConfiguredSync()) {
      discoverResults = {
        prompt,
        items: localItems(),
        source: "local",
        note: "Local results — AI isn't set up, so no request was sent",
        discoverHref,
      };
      const first = repaintDiscoverResults(root, discoverResults);
      first?.focus({ preventScroll: false });
      paintDiscoverEntries($(ID.discover, root), paintOpts());
      return;
    }
    homeAiBusy = true;
    repaintAiShelf(root, rebuild(), paintOpts());
    try {
      const shortlist = buildPromptShortlist(index, taste, "movie", prompt, playlistId);
      const result = await requestHomeAiPicks(
        {
          index,
          taste,
          kind: "movie",
          profileId,
          playlistId,
          shortlist,
          query: prompt.label,
          constraints: {
            genres: prompt.genres,
            maxRuntimeMinutes: prompt.maxRuntimeMinutes,
            mood: prompt.mood,
          },
          requestType: discoverPromptRequestType(prompt, "movie"),
        },
        {},
      );
      if (result.picks.length > 0) {
        discoverResults = {
          prompt,
          items: resolvePromptItems<MovieRow>(index, picksToEntries(result.picks), movieAiReason),
          source: result.source,
          note: homeAiSourceNote(result.source, result.model),
          discoverHref,
        };
      } else {
        discoverResults = {
          prompt,
          items: localItems(),
          source: "local",
          note: `${result.note} — local results shown instead`,
          discoverHref,
        };
      }
    } catch {
      discoverResults = {
        prompt,
        items: localItems(),
        source: "local",
        note: "AI couldn't answer just now — local results shown instead",
        discoverHref,
      };
    } finally {
      homeAiBusy = false;
      const first = repaintDiscoverResults(root, discoverResults);
      first?.focus({ preventScroll: false });
      paintDiscoverEntries($(ID.discover, root), paintOpts());
    }
  };

  paintMoviesHome(root, rebuild(), paintOpts());
  restoreMoviesHomeFocus(document);

  // Quiet auto-refresh (optional preference, default off): only when
  // no cached picks painted, at most one refresh per 24h via cache.
  if (!homeAiPicks) {
    void maybeAutoRefreshHomeAiPicks({
      index,
      taste,
      kind: "movie",
      profileId,
      playlistId,
      excludeIds: [...completedIds],
      rotationSeed: readPicksSeed(playlistId),
    })
      .then((result) => {
        if (result && result.picks.length > 0 && runId === bootRunId) {
          homeAiPicks = result.picks;
          homeAiSource = result.source;
          homeAiModel = result.model;
          repaintAiShelf(root, rebuild(), paintOpts());
        }
      })
      .catch(() => {
        // Quiet refresh failure: local shelves stay, no note, no retry.
      });
  }
}
