// RedSilk Couch — full programme Guide pure helpers (W3).
//
// The testable core of TvGuideView: programme sanitising, day
// navigation over the days EPG actually exists for, Jump-to-Now
// window math, selection stability across EPG refreshes, and the
// display-label cleanup. Pure and DOM-free — no fetching, no
// invented data. The rendering half lives in TvGuideView.astro;
// the EPG engine (fetching/parsing) stays in epg-data.js.
//
// Time inputs are display-shifted ms (the same clock the EPG cache
// stores); catch-up URLs need the raw XMLTV time, which travels on
// `rawStartMs` and is never recomputed here.

import {
  catchupActionForProgramme,
  catchupBadgeLabel,
  programmeProgress,
  programmeState,
} from "./couch-livetv-epg";
import type { CatchupAction } from "./couch-livetv-epg";
import { guideProgrammeKey, startOfLocalDayMs } from "./livetv-state";

export { guideProgrammeKey };

export const GUIDE_DAY_MS = 24 * 3_600_000;
export const GUIDE_DEFAULT_WINDOW_HOURS = 6;
/** How far back the Guide offers days (catch-up archive depth). */
export const GUIDE_MAX_PAST_DAYS = 7;
/** How far ahead the Guide offers days. */
export const GUIDE_MAX_FUTURE_DAYS = 14;

/** One programme, normalised for the Guide grid. */
export interface GuideProgramme {
  channelId: string;
  /** Display-shifted start (ms epoch). */
  startMs: number;
  /** Display-shifted stop (ms epoch). */
  stopMs: number;
  title: string;
  desc?: string;
  /** Raw XMLTV start for catch-up URLs (never display-shifted). */
  rawStartMs?: number;
  /** Raw XMLTV stop for catch-up window math. */
  rawStopMs?: number;
}

/** Raw programme shape as stored by epg-data.js (start/stop ms). */
export interface RawGuideProgramme {
  start?: unknown;
  stop?: unknown;
  title?: unknown;
  desc?: unknown;
  description?: unknown;
  rawStart?: unknown;
  rawStop?: unknown;
}

/**
 * Clean a channel's raw programme list for the grid. Drops entries
 * with missing / non-finite / inverted times (never crash, never
 * invent a duration or a title — an untitled programme renders as
 * "No programme information"). Exact duplicates (same start, stop
 * and title — the same listing twice in one EPG file) collapse to
 * one entry; programmes that merely share a start time are kept.
 * Non-array input (a corrupt cached row) yields [] instead of
 * throwing out of the for...of. Result is sorted by start, then stop.
 */
export function sanitiseGuideProgrammes(
  channelId: string,
  programmes: ReadonlyArray<RawGuideProgramme> | null | undefined,
): GuideProgramme[] {
  if (!Array.isArray(programmes)) return [];
  const cleaned: GuideProgramme[] = [];
  for (const raw of programmes) {
    if (!raw || typeof raw !== "object") continue;
    const startMs = Number(raw.start);
    const stopMs = Number(raw.stop);
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) continue;
    if (!(stopMs > startMs)) continue;
    const title =
      typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title.trim()
        : "No programme information";
    const desc =
      typeof raw.desc === "string"
        ? raw.desc
        : typeof raw.description === "string"
          ? raw.description
          : undefined;
    const rawStart = Number(raw.rawStart);
    const rawStop = Number(raw.rawStop);
    cleaned.push({
      channelId,
      startMs,
      stopMs,
      title,
      desc,
      rawStartMs: Number.isFinite(rawStart) ? rawStart : undefined,
      rawStopMs: Number.isFinite(rawStop) ? rawStop : undefined,
    });
  }
  cleaned.sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
  // Exact duplicates are adjacent after the sort (same start + stop
  // sorts together); drop the repeats, keep everything else.
  const deduped: GuideProgramme[] = [];
  for (const programme of cleaned) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.startMs === programme.startMs &&
      prev.stopMs === programme.stopMs &&
      prev.title === programme.title
    ) {
      continue;
    }
    deduped.push(programme);
  }
  return deduped;
}

/**
 * Programmes overlapping one local day [dayStartMs, dayStartMs+24h).
 * A programme spanning midnight belongs to both days it touches.
 */
export function programmesForGuideDay(
  programmes: ReadonlyArray<GuideProgramme>,
  dayStartMs: number,
): GuideProgramme[] {
  const dayEndMs = dayStartMs + GUIDE_DAY_MS;
  return programmes.filter(
    (programme) =>
      programme.startMs < dayEndMs && programme.stopMs > dayStartMs,
  );
}

/**
 * Local-midnight starts of the days that have at least one programme
 * anywhere in the guide, within [today - maxPastDays, today +
 * maxFutureDays]. The Guide only offers day navigation where EPG
 * exists — days with no data are never offered.
 *
 * Performance (0.11.11 W3): the old loop constructed two Dates per
 * programme — ~900ms at 15k channels x 150 programmes on every EPG
 * load. Sanitised lists are sorted by start, so within one channel
 * consecutive programmes almost always share a local day: the
 * current day and its exact next-midnight boundary are reused
 * while programme starts stay monotonic and inside the boundary.
 * The reuse is exact, not approximate — the boundary comes from
 * the real calendar (a local day is 23, 24 or 25 hours), and any
 * programme outside [dayStart, nextMidnight), or any list that is
 * not sorted, falls back to the exact per-programme computation.
 * Output is identical to the naive loop for every input order.
 */
export function availableGuideDays(
  programmesByChannel: ReadonlyMap<string, ReadonlyArray<GuideProgramme>>,
  nowMs: number = Date.now(),
  maxPastDays: number = GUIDE_MAX_PAST_DAYS,
  maxFutureDays: number = GUIDE_MAX_FUTURE_DAYS,
): number[] {
  const earliest = startOfLocalDayMs(nowMs) - maxPastDays * GUIDE_DAY_MS;
  const latest = startOfLocalDayMs(nowMs) + maxFutureDays * GUIDE_DAY_MS;
  const days = new Set<number>();
  for (const programmes of programmesByChannel.values()) {
    let runDayStart: number | null = null;
    let runNextMidnight = 0;
    let prevStartMs: number | null = null;
    for (const programme of programmes) {
      let day: number;
      if (
        runDayStart !== null &&
        prevStartMs !== null &&
        programme.startMs >= prevStartMs &&
        programme.startMs < runNextMidnight
      ) {
        day = runDayStart;
      } else {
        day = startOfLocalDayMs(programme.startMs);
        runDayStart = day;
        runNextMidnight = startOfLocalDayMs(day + GUIDE_DAY_MS);
        if (runNextMidnight <= day) {
          // 25-hour day: day + 24h is still this day; step further.
          runNextMidnight = startOfLocalDayMs(day + GUIDE_DAY_MS + 3_600_000);
        }
      }
      prevStartMs = programme.startMs;
      if (day >= earliest && day <= latest) days.add(day);
      const endMs = programme.stopMs - 1;
      const endDay =
        endMs >= day && endMs < runNextMidnight
          ? day
          : startOfLocalDayMs(endMs);
      if (endDay >= earliest && endDay <= latest) days.add(endDay);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** Local-midnight `n` days after `dayStartMs` (negative goes back). */
export function addGuideDays(dayStartMs: number, n: number): number {
  return startOfLocalDayMs(dayStartMs) + n * GUIDE_DAY_MS;
}

/**
 * The time window Jump to Now lands on: the current hour minus one
 * hour, so "now" sits one hour into a `windowHours` window with the
 * current programme already visible. Start is hour-aligned.
 */
export function jumpToNowWindow(
  nowMs: number,
  windowHours: number = GUIDE_DEFAULT_WINDOW_HOURS,
): { viewStartMs: number; viewEndMs: number } {
  const hourMs = 3_600_000;
  const viewStartMs =
    Math.floor(nowMs / hourMs) * hourMs - hourMs;
  return { viewStartMs, viewEndMs: viewStartMs + windowHours * hourMs };
}

/**
 * Keep the Guide's selection stable across an EPG refresh: the
 * previously selected programme when it still exists, else the
 * programme on now, else the first programme of the day, else null.
 * The key is `guideProgrammeKey(channelId, startMs)`.
 */
export function stableGuideSelection(
  previousKey: string | null,
  programmes: ReadonlyArray<GuideProgramme>,
  nowMs: number = Date.now(),
): string | null {
  if (programmes.length === 0) return null;
  if (previousKey) {
    const kept = programmes.find(
      (programme) =>
        guideProgrammeKey(programme.channelId, programme.startMs) ===
        previousKey,
    );
    if (kept) return previousKey;
  }
  const current = programmes.find(
    (programme) =>
      programmeState(programme.startMs, programme.stopMs, nowMs) === "now",
  );
  if (current) {
    return guideProgrammeKey(current.channelId, current.startMs);
  }
  return guideProgrammeKey(programmes[0]!.channelId, programmes[0]!.startMs);
}

/**
 * Display-label cleanup for provider category names — canonical
 * version lives in livetv-data.ts (W1); re-exported here so the
 * Guide keeps a single import surface. Integration 0.7.0 deleted
 * the narrower local mirror (trim + collapse only, "ALL" →
 * "All categories") in favour of the canonical rule.
 */
export { normaliseCategoryLabel } from "./livetv-data";

// ── Guide modes (Live TV 0.9.0) ──────────────────────────────────
//
// The timeline grid is no longer the Guide's default — it is the
// secondary "Full Guide" tab. The shared state model is expected to
// gain `guideMode` (W5 owns livetv-state.ts); until it lands, the
// Guide keeps a local guideMode of exactly this shape and reads
// `detail.guideMode` off `livetv:mode` events, so the seam is one
// field, not a second model.

export type GuideMode = "now" | "tonight" | "channel" | "grid";

export const DEFAULT_GUIDE_MODE: GuideMode = "now";

export const GUIDE_MODES: ReadonlyArray<GuideMode> = [
  "now",
  "tonight",
  "channel",
  "grid",
];

export const GUIDE_MODE_TABS: ReadonlyArray<{
  id: GuideMode;
  label: string;
}> = [
  { id: "now", label: "On Now" },
  { id: "tonight", label: "Tonight" },
  { id: "channel", label: "By Channel" },
  { id: "grid", label: "Full Guide" },
];

/** True for exactly the four contracted mode ids. */
export function isGuideMode(value: unknown): value is GuideMode {
  return (
    value === "now" ||
    value === "tonight" ||
    value === "channel" ||
    value === "grid"
  );
}

/**
 * Read a guide mode off a `livetv:mode` event detail (or any unknown
 * value): a valid mode passes through, anything else falls back to
 * `fallback` (default "now"). Never throws, never invents a mode.
 */
export function parseGuideMode(
  value: unknown,
  fallback: GuideMode = DEFAULT_GUIDE_MODE,
): GuideMode {
  return isGuideMode(value) ? value : fallback;
}

// ── On Now rows ──────────────────────────────────────────────────

export interface GuideNowRow {
  channelId: string;
  /** Programme on now (null when the channel has no EPG now — such
   *  channels never produce a row; see nowNextRows). */
  current: GuideProgramme;
  /** Next programme, or null when the EPG ends after the current one. */
  next: GuideProgramme | null;
  /** Fraction of the current programme elapsed, 0..1. */
  progress: number;
}

/**
 * On Now rows: one per channel that genuinely has a programme on
 * air at `nowMs`, each with its next programme. Channels with no
 * current programme are omitted — an On Now list must never show a
 * channel with nothing on. Rows are ordered by current programme
 * start, then channel id (stable, deterministic).
 */
export function nowNextRows(
  programmesByChannel: ReadonlyMap<string, ReadonlyArray<GuideProgramme>>,
  nowMs: number = Date.now(),
): GuideNowRow[] {
  const rows: GuideNowRow[] = [];
  for (const [channelId, programmes] of programmesByChannel) {
    if (!programmes || programmes.length === 0) continue;
    let current: GuideProgramme | null = null;
    let next: GuideProgramme | null = null;
    for (const programme of programmes) {
      if (programmeState(programme.startMs, programme.stopMs, nowMs) === "now") {
        current = programme;
      } else if (
        programme.startMs > nowMs &&
        (next === null || programme.startMs < next.startMs)
      ) {
        next = programme;
      }
    }
    if (!current) continue;
    rows.push({
      channelId,
      current,
      next,
      progress: programmeProgress(current.startMs, current.stopMs, nowMs),
    });
  }
  rows.sort(
    (a, b) =>
      a.current.startMs - b.current.startMs ||
      a.channelId.localeCompare(b.channelId),
  );
  return rows;
}

// ── On Now featured programme (Live TV 0.11.0, W6) ──────────────
//
// The On Now composition is featured-left + Now/Next list-right
// (mockup 3's Guide panel). The featured slot follows the user's
// selection: the row whose current programme matches `selectedKey`
// (the programme the user is focused on), else the first row.
// Never invents a programme — null when there is nothing on now.

/**
 * Pick the On Now row whose current programme is the featured one:
 * the selected programme when it is on now, else the first row.
 * Returns null when there are no rows.
 */
export function pickNowFeatured(
  rows: ReadonlyArray<GuideNowRow>,
  selectedKey: string | null,
): GuideNowRow | null {
  if (rows.length === 0) return null;
  if (selectedKey) {
    const match = rows.find(
      (row) =>
        guideProgrammeKey(row.channelId, row.current.startMs) === selectedKey,
    );
    if (match) return match;
  }
  return rows[0]!;
}

// ── By Channel day navigation ────────────────────────────────────

/** Day-offset bounds for By Channel LB/RB navigation (days from today). */
export const GUIDE_DAY_OFFSET_MIN = -GUIDE_MAX_PAST_DAYS;
export const GUIDE_DAY_OFFSET_MAX = GUIDE_MAX_FUTURE_DAYS;

/** Clamp a day offset to [-7, +14]. Out-of-range input never escapes. */
export function clampGuideDayOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(
    GUIDE_DAY_OFFSET_MIN,
    Math.min(GUIDE_DAY_OFFSET_MAX, Math.trunc(offset)),
  );
}

/** Whole-day offset of `dayStartMs` from today (local midnights). */
export function guideDayOffset(
  dayStartMs: number,
  nowMs: number = Date.now(),
): number {
  return Math.round(
    (startOfLocalDayMs(dayStartMs) - startOfLocalDayMs(nowMs)) / GUIDE_DAY_MS,
  );
}

/** Local-midnight ms `offset` days from today, clamped to [-7, +14]. */
export function guideDayForOffset(
  offset: number,
  nowMs: number = Date.now(),
): number {
  return startOfLocalDayMs(nowMs) + clampGuideDayOffset(offset) * GUIDE_DAY_MS;
}

// ── Guide search ─────────────────────────────────────────────────

/**
 * Filter On Now / Tonight / By Channel rows by a free-text query
 * over channel name + programme title + description. Empty query
 * returns the list untouched. Substring, case-insensitive — only
 * real metadata is searched, nothing is invented to match.
 */
export function filterGuideRows<T extends {
  channelName: string;
  programmeTitle: string;
  programmeDesc?: string;
}>(rows: ReadonlyArray<T>, query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...rows];
  return rows.filter((row) =>
    `${row.channelName} ${row.programmeTitle} ${row.programmeDesc ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
}

// ── Guide exit ───────────────────────────────────────────────────

/**
 * The mode the Guide returns to on B: "playback" when it was entered
 * from fullscreen playback, "home" otherwise. The shared state
 * tracks the entry mode (enterGuide records the caller's mode);
 * until W5 wires `guideMode`/`returnTo` into the state model, the
 * Guide passes its own `enteredFrom` ("home" | "playback") here.
 */
export function guideReturnMode(
  enteredFrom: string | null | undefined,
): "home" | "playback" {
  return enteredFrom === "playback" ? "playback" : "home";
}

// ── Guide cell view model ───────────────────────────────────────

export interface GuideCellViewModel {
  key: string;
  state: "now" | "past" | "upcoming";
  progress: number;
  catchupAction: CatchupAction;
  /** Badge text or null — never a badge where no catch-up exists. */
  badge: "Catch-up" | "Restart" | null;
  /** True when the cell can be tuned live right now. */
  watchLive: boolean;
  /** True when the cell offers a catch-up action. */
  canCatchup: boolean;
}

/**
 * Everything one Guide cell needs to render: live/past/upcoming
 * state, progress, and the honestly-gated catch-up action. Catch-up
 * comes only from `catchupActionForProgramme` — an unsupported
 * channel yields action "none" and no badge, whatever the programme.
 */
export function guideCellViewModel(
  programme: GuideProgramme,
  channel: { tvArchive?: number; tvArchiveDuration?: number; catchup?: string | null; catchupDays?: number | null; catchupSource?: string | null; url?: string },
  nowMs: number = Date.now(),
): GuideCellViewModel {
  const state = programmeState(programme.startMs, programme.stopMs, nowMs);
  const action = catchupActionForProgramme({
    channel,
    startMs: programme.rawStartMs ?? programme.startMs,
    stopMs: programme.rawStopMs ?? programme.stopMs,
    nowMs,
  });
  return {
    key: guideProgrammeKey(programme.channelId, programme.startMs),
    state,
    progress: programmeProgress(programme.startMs, programme.stopMs, nowMs),
    catchupAction: action,
    badge: catchupBadgeLabel(action),
    watchLive: state === "now",
    canCatchup: action !== "none",
  };
}
