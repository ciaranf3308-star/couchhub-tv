// Live TV 2.0 (0.11.7) — deterministic catalogue fixtures (W5).
//
// Realistic Xtream-style catalogues at 200 / 2,000 / 5,000 / 10,000+
// channels. No network, no real provider data: every name, category
// and programme below is generated from a fixed seed, so two builds
// of the same spec are identical. Channel objects use the REAL
// LivetvChannel shape and the REAL normaliseCategoryLabel /
// normalize helpers from src, so fixtures exercise the same seams
// production code does.
//
// Shapes deliberately included (user brief §9):
//   - large Sports groups with multiple real-looking provider
//     subcategories ("UK | Sports | Football", "US | Sports | NFL",
//     ...), split across regions so the same display label ("Football")
//     names DISTINCT provider categories;
//   - duplicate display labels: the same display name on distinct
//     provider ids in different categories (never merged);
//   - sparse EPG: only a fixed fraction of channels carry programmes;
//   - a single enormous provider category with no subcategories
//     (buildEnormousCategoryFixture), plus bare single-segment
//     categories (buildFlatCategoryFixture).
//
// The oracle helpers at the bottom (rawCategoryCounts,
// channelsInRawCategory, distinctRawCategories) count straight from
// the raw categoryId strings with NO grouping logic of their own, so
// tests can assert index membership without trusting the index's
// parser: subcategory membership must be exactly raw-category
// equality.

import { normaliseCategoryLabel } from "@/scripts/lib/livetv-data";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";
import type { GuideProgramme } from "@/scripts/lib/livetv-guide";
import { normalize } from "@/scripts/lib/text";

export type { LivetvChannel, GuideProgramme };

/** Fixed "now" for every EPG fixture: Thu 12 Nov 2026, 12:00 UTC. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 10, 12, 12, 0, 0);
export const FIXTURE_SEED = 0xc0ffee;

/** The four mandatory catalogue sizes. */
export const FIXTURE_SIZES = [200, 2000, 5000, 10000] as const;

export const FIXTURE_REGIONS = ["UK", "US", "IE"] as const;

/** Provider subcategories under Sports (the segment after "Sports"). */
export const SPORTS_SUBCATEGORIES = [
  "Football",
  "F1",
  "Cricket",
  "Rugby",
  "Golf",
  "Tennis",
  "NFL",
  "NBA",
  "Darts",
  "Boxing",
] as const;

/** Non-Sports groups: one segment after the region prefix. */
export const OTHER_GROUPS = [
  "Entertainment",
  "News",
  "Movies",
  "Documentaries",
  "Kids",
  "Music",
] as const;

/** Share of the catalogue per group (Sports dominates, as in life). */
const GROUP_SHARES: ReadonlyArray<{ group: string; share: number }> = [
  { group: "Sports", share: 0.6 },
  { group: "Entertainment", share: 0.12 },
  { group: "News", share: 0.08 },
  { group: "Movies", share: 0.08 },
  { group: "Documentaries", share: 0.05 },
  { group: "Kids", share: 0.04 },
  { group: "Music", share: 0.03 },
];

/** Display names deliberately reused across distinct provider ids. */
export const DUPLICATE_DISPLAY_NAMES = [
  "Sky Sports Main Event",
  "BBC One",
  "TNT Sports 1",
  "Sky Sports News",
  "RTÉ One",
] as const;

const BRANDS: Record<string, readonly string[]> = {
  Sports: ["Sky Sports", "TNT Sports", "Premier Sports", "DAZN", "ESPN", "beIN Sports"],
  Entertainment: ["BBC", "ITV", "Channel 4", "Virgin Media", "RTÉ", "Sky"],
  News: ["Sky News", "BBC News", "CNN", "RTÉ News", "GB News", "Al Jazeera"],
  Movies: ["Sky Cinema", "Film4", "TCM", "Paramount Movies", "Great! Movies", "Legend"],
  Documentaries: ["Discovery", "National Geographic", "History", "Animal Planet", "Sky Documentaries", "PBS"],
  Kids: ["CBBC", "CBeebies", "Cartoon Network", "Nickelodeon", "Disney Junior", "RTÉjr"],
  Music: ["MTV", "Sky Music", "VH1", "Trace", "Vevo", "CMT"],
  International: ["World TV", "Global", "Euro", "Continental", "Overseas", "Panorama"],
};

const VARIANTS: readonly string[] = [
  "HD", "1", "2", "3", "Plus", "Extra", "Action", "Premier", "Gold", "Live",
];

/** Deterministic 32-bit hash (FNV-1a) — stable across runs/platforms. */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG: deterministic for a fixed seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureChannelSpec {
  id: number;
  name: string;
  rawCategory: string;
}

function makeChannel(spec: FixtureChannelSpec): LivetvChannel {
  const categoryLabel = normaliseCategoryLabel(spec.rawCategory);
  const tvgId = spec.id % 11 === 0 ? null : `ch${spec.id}.fixture.example`;
  return {
    id: spec.id,
    name: spec.name,
    displayName: spec.name,
    logo: null,
    category: spec.rawCategory,
    categoryId: spec.rawCategory,
    categoryLabel,
    streamUrl: null,
    tvgId,
    chno: spec.id,
    catchup: spec.id % 5 === 0,
    favourite: spec.id % 17 === 0,
    hidden: false,
    norm: normalize(`${spec.name} ${categoryLabel} ${tvgId ?? ""}`),
  };
}

function rawCategoriesForGroup(group: string): string[] {
  if (group === "Sports") {
    const out: string[] = [];
    for (const region of FIXTURE_REGIONS) {
      for (const sub of SPORTS_SUBCATEGORIES) {
        out.push(`${region} | Sports | ${sub}`);
      }
    }
    return out;
  }
  return FIXTURE_REGIONS.map((region) => `${region} | ${group}`);
}

/**
 * Build exactly `total` channels. Allocation follows GROUP_SHARES;
 * within a group, channels round-robin across its raw provider
 * categories; the final list interleaves categories round-robin so
 * source order mixes groups (adversarial for grouping code that
 * assumes sorted input). Deterministic: same total → same array.
 */
export function buildFixtureChannels(total: number): LivetvChannel[] {
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`buildFixtureChannels: total must be a positive integer, got ${total}`);
  }
  const rand = mulberry32(FIXTURE_SEED + total);
  const counts = GROUP_SHARES.map(({ share }) => Math.floor(total * share));
  // Fix rounding drift on the largest group so the total is exact.
  counts[0] += total - counts.reduce((a, b) => a + b, 0);

  const queues: LivetvChannel[][] = [];
  let nextId = 1;
  GROUP_SHARES.forEach(({ group }, groupIndex) => {
    const raws = rawCategoriesForGroup(group);
    const brands = BRANDS[group] ?? BRANDS.International;
    const queue: LivetvChannel[] = [];
    for (let i = 0; i < counts[groupIndex]!; i++) {
      const rawCategory = raws[i % raws.length]!;
      const id = nextId++;
      let name: string;
      if (id % 53 === 0) {
        // Deliberate duplicate display label, distinct provider id.
        name = DUPLICATE_DISPLAY_NAMES[(id / 53) % DUPLICATE_DISPLAY_NAMES.length]!;
      } else {
        const brand = brands[Math.floor(rand() * brands.length)]!;
        const variant = VARIANTS[Math.floor(rand() * VARIANTS.length)]!;
        name = `${brand} ${variant} ${id}`;
      }
      queue.push(makeChannel({ id, name, rawCategory }));
    }
    queues.push(queue);
  });

  // Round-robin interleave across groups.
  const out: LivetvChannel[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (next) {
        out.push(next);
        progress = true;
      }
    }
  }
  return out;
}

export function fixture200(): LivetvChannel[] {
  return buildFixtureChannels(200);
}
export function fixture2000(): LivetvChannel[] {
  return buildFixtureChannels(2000);
}
export function fixture5000(): LivetvChannel[] {
  return buildFixtureChannels(5000);
}
export function fixture10000(): LivetvChannel[] {
  return buildFixtureChannels(10000);
}

/**
 * One enormous provider category with NO subcategories: every
 * channel shares a single raw category whose remainder after the
 * region prefix is one segment. The index must keep it fully
 * navigable as a flat list (test 8), not drop it for having no
 * subcategory structure.
 */
export function buildEnormousCategoryFixture(
  total = 3000,
  rawCategory = "UK | International",
): LivetvChannel[] {
  const rand = mulberry32(FIXTURE_SEED + total + 7);
  const brands = BRANDS.International;
  const out: LivetvChannel[] = [];
  for (let i = 1; i <= total; i++) {
    const brand = brands[Math.floor(rand() * brands.length)]!;
    out.push(makeChannel({ id: i, name: `${brand} ${i}`, rawCategory }));
  }
  return out;
}

/** Bare single-segment raw categories (no region, no separator). */
export function buildFlatCategoryFixture(): LivetvChannel[] {
  const out: LivetvChannel[] = [];
  let id = 1;
  for (const raw of ["Sports", "News", "Movies"]) {
    for (let i = 1; i <= 12; i++) {
      out.push(makeChannel({ id: id++, name: `${raw} Channel ${i}`, rawCategory: raw }));
    }
  }
  return out;
}

// ── EPG fixtures ────────────────────────────────────────────────

export interface FixtureProgrammesOptions {
  /** Fraction of channels carrying programmes, 0..1. Default 0.3 (sparse). */
  coverage?: number;
  /** "Now" the programmes must span. Default FIXTURE_NOW_MS. */
  nowMs?: number;
  /** Programme length in ms. Default 1 hour. */
  slotMs?: number;
  /** Slots per covered channel (2 before now, rest after). Default 8. */
  slotsPerChannel?: number;
}

const PROGRAMME_KINDS = [
  "Live Coverage",
  "Highlights",
  "Documentary",
  "News Bulletin",
  "Movie Premiere",
  "Talk Show",
] as const;

/**
 * Deterministic programmes per channel. A channel is covered when
 * hash32(id) falls under the coverage fraction — stable, and
 * independent of list order. Covered channels get `slotsPerChannel`
 * consecutive slots with slot index 2 spanning `nowMs`, so every
 * covered channel has a genuine current programme and a next one.
 * Uncovered channels get no entry at all (sparse EPG, as in life).
 */
export function buildFixtureProgrammes(
  channels: readonly LivetvChannel[],
  opts: FixtureProgrammesOptions = {},
): Map<string, GuideProgramme[]> {
  const coverage = opts.coverage ?? 0.3;
  const nowMs = opts.nowMs ?? FIXTURE_NOW_MS;
  const slotMs = opts.slotMs ?? 3_600_000;
  const slots = opts.slotsPerChannel ?? 8;
  const firstStart = Math.floor(nowMs / slotMs) * slotMs - 2 * slotMs;
  const out = new Map<string, GuideProgramme[]>();
  for (const channel of channels) {
    if (hash32(String(channel.id)) % 1000 >= Math.round(coverage * 1000)) continue;
    const kind = PROGRAMME_KINDS[hash32(String(channel.id)) % PROGRAMME_KINDS.length]!;
    const programmes: GuideProgramme[] = [];
    for (let s = 0; s < slots; s++) {
      const startMs = firstStart + s * slotMs;
      programmes.push({
        channelId: String(channel.id),
        startMs,
        stopMs: startMs + slotMs,
        title: `${kind}: ${channel.displayName} ${s + 1}`,
        desc: `Fixture programme ${s + 1} for ${channel.displayName}.`,
        rawStartMs: startMs,
        rawStopMs: startMs + slotMs,
      });
    }
    out.set(String(channel.id), programmes);
  }
  return out;
}

/**
 * Guide-scale fixture: every channel has a current programme, so
 * On Now yields one row per channel (2,000+ rows for test 7).
 */
export function buildGuideFixture(total = 2500): {
  channels: LivetvChannel[];
  programmes: Map<string, GuideProgramme[]>;
} {
  const channels = buildFixtureChannels(total);
  const programmes = buildFixtureProgrammes(channels, { coverage: 1 });
  return { channels, programmes };
}

// ── Parser-free oracles (count raw strings, group nothing) ──────

/** Count channels per verbatim raw categoryId. No parsing. */
export function rawCategoryCounts(
  channels: readonly LivetvChannel[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const channel of channels) {
    counts.set(channel.categoryId, (counts.get(channel.categoryId) ?? 0) + 1);
  }
  return counts;
}

/** Distinct verbatim raw categoryIds, first-seen order. */
export function distinctRawCategories(
  channels: readonly LivetvChannel[],
): string[] {
  return [...rawCategoryCounts(channels).keys()];
}

/** Channels whose raw categoryId is exactly `raw` (string equality). */
export function channelsInRawCategory(
  channels: readonly LivetvChannel[],
  raw: string,
): LivetvChannel[] {
  return channels.filter((channel) => channel.categoryId === raw);
}

/** Channels whose raw category names Sports (region prefix + "Sports" segment). */
export function sportsChannelsOracle(
  channels: readonly LivetvChannel[],
): LivetvChannel[] {
  return channels.filter((channel) =>
    /(^|\|\s*)Sports(\s*\||$)/.test(channel.categoryId),
  );
}
