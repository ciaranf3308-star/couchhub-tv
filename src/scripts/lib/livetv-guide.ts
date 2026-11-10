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
 * "No programme information"). Result is sorted by start, then stop.
 */
export function sanitiseGuideProgrammes(
  channelId: string,
  programmes: ReadonlyArray<RawGuideProgramme> | null | undefined,
): GuideProgramme[] {
  if (!programmes) return [];
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
  return cleaned;
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
    for (const programme of programmes) {
      const day = startOfLocalDayMs(programme.startMs);
      if (day >= earliest && day <= latest) days.add(day);
      const endDay = startOfLocalDayMs(programme.stopMs - 1);
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
 * Display-label cleanup for provider category names. Provider data
 * is never modified — this only affects what is shown. Conservative
 * on purpose: trim + collapse whitespace, and the provider "ALL"
 * bucket reads as "All categories". Anything else passes through
 * unchanged, so no channel can be mislabelled by a clever rule.
 *
 * NOTE: W1's `normaliseCategoryLabel` in livetv-data.ts is the
 * canonical version once it lands; this mirrors its contract so the
 * Guide builds standalone, and integration should re-export from
 * there and delete this copy.
 */
export function normaliseCategoryLabel(raw: unknown): string {
  if (typeof raw !== "string") return "All categories";
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned === "" || cleaned.toUpperCase() === "ALL") {
    return "All categories";
  }
  return cleaned;
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
