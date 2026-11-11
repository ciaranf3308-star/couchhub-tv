// RedSilk Couch — Tonight aggregation (W4, Live TV 0.9.0).
//
// PURE functions over programme arrays: no fetching, no DOM, no
// invented data. The Tonight mode in TvGuideView hands in real EPG
// programmes (sanitised GuideProgrammes) plus the channel each came
// from; this module groups them into the RTÉ Guide-style evening
// sections. Every section is gated on a DEFENSIBLE signal from real
// metadata only:
//
//   - Starting Soon  — starts within the next 60 minutes.
//   - Tonight's Highlights — on a favourite / recently-watched
//     channel, or carrying a "new" / premiere flag where the EPG
//     provides one ("new series", "premiere", "brand new").
//   - Movies on Tonight — the channel's provider category names
//     movies/film/cinema, or the programme title/desc explicitly
//     says film/movie.
//   - Live Sport — the channel's provider category names sport, or
//     the title/desc names a recognisable sport/event explicitly.
//   - Drama & Entertainment — the channel's provider category names
//     entertainment/drama/comedy/soap, or the title/desc says so.
//   - Later Tonight — the chronological remainder of the evening.
//
// A section with no signal is OMITTED (never an empty heading, never
// a padded list). When no section has a signal at all — poor
// metadata — the caller falls back to one plain chronological list
// of the evening (`chronologicalTonight`), which is always honest.
//
// Evening window: 17:00–23:00 local. If "now" is already past 23:00
// local, the window rolls to tomorrow evening (tonight is over).
//
// Programme artwork: the EPG carries no artwork field, so Tonight
// never claims any — the featured panel uses the channel logo, and
// rows carry no image. Nothing here fabricates times, descriptions
// or recommendations.

import type { GuideProgramme } from "./livetv-guide";
import { startOfLocalDayMs } from "./livetv-state";

export const TONIGHT_START_HOUR = 17;
export const TONIGHT_END_HOUR = 23;
export const TONIGHT_STARTING_SOON_MINUTES = 60;
export const TONIGHT_SECTION_ITEM_CAP = 8;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Minimal channel identity Tonight needs — supplied by the caller. */
export interface TonightChannel {
  id: string;
  displayName: string;
  logo?: string | null;
  /** Normalised provider category label (normaliseCategoryLabel). */
  categoryLabel?: string;
  favourite?: boolean;
  watched?: boolean;
}

/** One programme with the channel it airs on. */
export interface TonightItem {
  programme: GuideProgramme;
  channel: TonightChannel;
}

export type TonightSectionId =
  | "starting-soon"
  | "highlights"
  | "movies"
  | "sport"
  | "drama"
  | "later";

export interface TonightSection {
  id: TonightSectionId;
  title: string;
  items: TonightItem[];
}

export interface TonightSections {
  /** Local 17:00–23:00 window the sections were built from. */
  windowStartMs: number;
  windowEndMs: number;
  /** Sections with a real signal, in directive order. Empty when
   *  there is no evening data at all. */
  sections: TonightSection[];
  /** True when at least one editorial section (highlights / movies /
   *  sport / drama) has a signal. False means: render the plain
   *  chronological fallback instead of section headings. */
  hasEditorialSignal: boolean;
}

/** Local 17:00–23:00 window containing (or following) `nowMs`. */
export function eveningWindowMs(nowMs: number = Date.now()): {
  windowStartMs: number;
  windowEndMs: number;
} {
  const dayStart = startOfLocalDayMs(nowMs);
  let windowStartMs = dayStart + TONIGHT_START_HOUR * HOUR_MS;
  let windowEndMs = dayStart + TONIGHT_END_HOUR * HOUR_MS;
  if (nowMs >= windowEndMs) {
    // Tonight is over — the next evening is tomorrow's.
    windowStartMs += 24 * HOUR_MS;
    windowEndMs += 24 * HOUR_MS;
  }
  return { windowStartMs, windowEndMs };
}

/** Programmes overlapping the evening window, chronological. */
export function programmesForTonight(
  items: ReadonlyArray<TonightItem>,
  nowMs: number = Date.now(),
): TonightItem[] {
  const { windowStartMs, windowEndMs } = eveningWindowMs(nowMs);
  return items
    .filter(
      (item) =>
        item.programme.startMs < windowEndMs &&
        item.programme.stopMs > windowStartMs,
    )
    .sort(
      (a, b) =>
        a.programme.startMs - b.programme.startMs ||
        a.channel.displayName.localeCompare(b.channel.displayName),
    );
}

/** Plain chronological evening listing — the poor-metadata fallback. */
export function chronologicalTonight(
  items: ReadonlyArray<TonightItem>,
  nowMs: number = Date.now(),
): TonightItem[] {
  return programmesForTonight(items, nowMs);
}

function haystack(item: TonightItem): string {
  return `${item.programme.title} ${item.programme.desc ?? ""}`.toLowerCase();
}

function categoryOf(item: TonightItem): string {
  return (item.channel.categoryLabel ?? "").toLowerCase();
}

/** Whole-word match against title + description. */
function mentions(item: TonightItem, ...words: string[]): boolean {
  const text = ` ${haystack(item)} `;
  return words.some((word) => text.includes(` ${word} `) || text.includes(` ${word}s `));
}

function categoryMentions(item: TonightItem, ...words: string[]): boolean {
  const label = categoryOf(item);
  return words.some((word) => label.includes(word));
}

const SPORT_WORDS = [
  "football",
  "soccer",
  "rugby",
  "cricket",
  "tennis",
  "golf",
  "boxing",
  "formula 1",
  "grand prix",
  "motogp",
  "darts",
  "snooker",
  "hurling",
  "gaelic",
  "matchday",
  "premier league",
  "champions league",
];

const MOVIE_WORDS = ["film", "movie", "cinema"];

const DRAMA_WORDS = ["drama", "soap", "comedy", "sitcom", "entertainment"];

/** "sport" when the channel category or the programme itself says so. */
export function isLiveSport(item: TonightItem): boolean {
  return (
    categoryMentions(item, "sport") ||
    mentions(item, ...SPORT_WORDS) ||
    (mentions(item, "live") && mentions(item, "match", "game", "race", "fight"))
  );
}

/** "movie" when the channel category or the programme itself says so. */
export function isMovie(item: TonightItem): boolean {
  return categoryMentions(item, "movi", "film", "cinema") || mentions(item, ...MOVIE_WORDS);
}

/** "drama & entertainment" when the category or programme says so. */
export function isDramaOrEntertainment(item: TonightItem): boolean {
  return (
    categoryMentions(item, "entertainment", "drama", "comedy", "soap") ||
    mentions(item, ...DRAMA_WORDS)
  );
}

/** True when the EPG flags the programme as new / a premiere. */
export function isNewOrPremiere(item: TonightItem): boolean {
  const text = haystack(item);
  return (
    text.includes("new series") ||
    text.includes("brand new") ||
    text.includes("premiere") ||
    text.includes("series premiere") ||
    text.includes("first episode") ||
    /\bnew episode\b/.test(text)
  );
}

/** True when the programme is a defensible "highlight". */
export function isHighlight(item: TonightItem): boolean {
  return Boolean(item.channel.favourite || item.channel.watched) || isNewOrPremiere(item);
}

/**
 * Rank within the highlight signal: a new series / premiere is the
 * strongest pick, then a favourite channel, then a recently-watched
 * channel. Lower is stronger; 3 means "not a highlight at all".
 */
export function highlightRank(item: TonightItem): number {
  if (isNewOrPremiere(item)) return 0;
  if (item.channel.favourite) return 1;
  if (item.channel.watched) return 2;
  return 3;
}

/**
 * Max highlights from any single channel (Live TV 0.11.0, W6).
 * Affinity is a real signal, but one watched channel must not turn
 * its whole evening into "Tonight's Highlights" — the 0.10.1
 * fixture showed exactly that (tune once, every programme on the
 * channel qualifies). Two per channel keeps the section a pick,
 * not a channel listing.
 */
export const TONIGHT_HIGHLIGHT_PER_CHANNEL_CAP = 2;

/**
 * The Tonight's Highlights pick: highlight-signal programmes from
 * the evening, strongest signal first, at most
 * TONIGHT_HIGHLIGHT_PER_CHANNEL_CAP per channel and
 * TONIGHT_SECTION_ITEM_CAP overall, presented chronologically.
 * Returns [] when nothing carries a highlight signal.
 */
export function rankHighlights(
  items: ReadonlyArray<TonightItem>,
  nowMs: number = Date.now(),
): TonightItem[] {
  const evening = programmesForTonight(items, nowMs);
  const ranked = evening
    .filter((item) => isHighlight(item))
    .sort((a, b) => highlightRank(a) - highlightRank(b) || byStart(a, b));
  const perChannel = new Map<string, number>();
  const picked: TonightItem[] = [];
  for (const item of ranked) {
    const count = perChannel.get(item.channel.id) ?? 0;
    if (count >= TONIGHT_HIGHLIGHT_PER_CHANNEL_CAP) continue;
    perChannel.set(item.channel.id, count + 1);
    picked.push(item);
    if (picked.length >= TONIGHT_SECTION_ITEM_CAP) break;
  }
  return picked.sort(byStart);
}

/**
 * The Tonight featured programme: the strongest highlight (a
 * premiere first, then a favourite-channel pick), else the first
 * programme starting soon, else the first programme of the
 * evening. Null when the evening is empty.
 */
export function pickTonightFeatured(
  built: TonightSections,
  evening: ReadonlyArray<TonightItem>,
): TonightItem | null {
  if (evening.length === 0) return null;
  const highlights = built.sections.find((s) => s.id === "highlights")?.items ?? [];
  const premiere = highlights.find((item) => isNewOrPremiere(item));
  if (premiere) return premiere;
  if (highlights.length > 0) return highlights[0]!;
  const startingSoon = built.sections.find((s) => s.id === "starting-soon")?.items ?? [];
  if (startingSoon.length > 0) return startingSoon[0]!;
  return evening[0]!;
}

/** Starts within the next 60 minutes (and has not started yet). */
export function isStartingSoon(
  item: TonightItem,
  nowMs: number = Date.now(),
): boolean {
  return (
    item.programme.startMs >= nowMs &&
    item.programme.startMs < nowMs + TONIGHT_STARTING_SOON_MINUTES * MINUTE_MS
  );
}

function byStart(a: TonightItem, b: TonightItem): number {
  return (
    a.programme.startMs - b.programme.startMs ||
    a.channel.displayName.localeCompare(b.channel.displayName)
  );
}

function capped(items: TonightItem[]): TonightItem[] {
  return items.slice(0, TONIGHT_SECTION_ITEM_CAP);
}

/**
 * Build the Tonight sections. Sections with no signal are omitted;
 * `sections` is empty when there is no evening data at all. Items
 * may appear in more than one section (Starting Soon / Highlights
 * are picks over the same evening); the genre sections and Later
 * Tonight partition the evening so a programme is listed once
 * there. Every section is chronological.
 */
export function buildTonightSections(
  items: ReadonlyArray<TonightItem>,
  nowMs: number = Date.now(),
): TonightSections {
  const { windowStartMs, windowEndMs } = eveningWindowMs(nowMs);
  const evening = programmesForTonight(items, nowMs);
  const sections: TonightSection[] = [];
  if (evening.length === 0) {
    return { windowStartMs, windowEndMs, sections, hasEditorialSignal: false };
  }

  const startingSoon = evening.filter((item) => isStartingSoon(item, nowMs));
  if (startingSoon.length > 0) {
    sections.push({
      id: "starting-soon",
      title: "Starting Soon",
      items: capped([...startingSoon].sort(byStart)),
    });
  }

  const highlights = rankHighlights(items, nowMs);
  if (highlights.length > 0) {
    sections.push({
      id: "highlights",
      title: "Tonight's Highlights",
      items: highlights,
    });
  }

  const movies = evening.filter((item) => isMovie(item));
  if (movies.length > 0) {
    sections.push({
      id: "movies",
      title: "Movies on Tonight",
      items: capped([...movies].sort(byStart)),
    });
  }

  const sport = evening.filter((item) => isLiveSport(item));
  if (sport.length > 0) {
    sections.push({
      id: "sport",
      title: "Live Sport",
      items: capped([...sport].sort(byStart)),
    });
  }

  const drama = evening.filter(
    (item) =>
      isDramaOrEntertainment(item) && !isMovie(item) && !isLiveSport(item),
  );
  if (drama.length > 0) {
    sections.push({
      id: "drama",
      title: "Drama & Entertainment",
      items: capped([...drama].sort(byStart)),
    });
  }

  // Later Tonight: the chronological late evening — programmes
  // starting at or after 21:00 local. Simple and honest: when
  // nothing starts that late, the section is omitted rather than
  // re-listing what the sections above already covered.
  const lateStart = windowStartMs + 4 * HOUR_MS; // 21:00 local.
  const later = evening.filter((item) => item.programme.startMs >= lateStart);
  if (later.length > 0) {
    sections.push({
      id: "later",
      title: "Later Tonight",
      items: capped([...later].sort(byStart)),
    });
  }

  const hasEditorialSignal = sections.some((section) =>
    ["highlights", "movies", "sport", "drama"].includes(section.id),
  );
  return { windowStartMs, windowEndMs, sections, hasEditorialSignal };
}
