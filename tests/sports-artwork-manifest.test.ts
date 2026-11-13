// 0.11.12 W2 — sports artwork manifest audit.
//
// Every bundled sport photo must be a real, licence-verified Wikimedia Commons
// image: the manifest entry must exist on disk, carry complete licence evidence,
// and match the actual bundled file (format + dimensions + orientation). An entry
// without licence evidence FAILS the release gate, and no unattributed image may
// sit in public/art/sports/ unreferenced by the manifest.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  SPORT_ARTWORK_MANIFEST,
  type SportsArtworkEntry,
} from "@/scripts/lib/sports-artwork-manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type SportId = SportsArtworkEntry["sport"];

const SPORT_IDS: ReadonlySet<SportId> = new Set([
  "football",
  "ice-hockey",
  "snooker",
  "rugby",
  "motorsport",
  "darts",
  "tennis",
  "golf",
  "cricket",
  "basketball",
  "american-football",
  "baseball",
  "boxing",
  "mma",
  "cycling",
  "athletics",
  "other-sport",
]);

// Minimal JPEG dimension reader: walks markers to the first Start-of-Frame
// segment (SOF0/1/2) and returns its width/height. Throws on anything that is
// not a well-formed JPEG, so a corrupt or mislabelled bundle file fails loudly.
function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("not a JPEG (missing SOI marker)");
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new Error(`not a JPEG (expected marker at offset ${offset})`);
    }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("not a JPEG (no SOF segment found)");
}

describe("sports artwork manifest (0.11.12)", () => {
  it("covers every sport id in the classifier contract", () => {
    expect(SPORT_ARTWORK_MANIFEST.length).toBeGreaterThan(0);
    const covered = new Set(SPORT_ARTWORK_MANIFEST.map((entry) => entry.sport));
    for (const sport of SPORT_IDS) {
      expect(covered.has(sport), `sport ${sport} has no bundled photo`).toBe(true);
    }
  });

  it("uses only contract sport ids, with complete licence evidence", () => {
    for (const entry of SPORT_ARTWORK_MANIFEST) {
      expect(SPORT_IDS.has(entry.sport), `unknown sport id ${entry.sport}`).toBe(true);
      expect(entry.path.startsWith("/art/sports/"), `bad path ${entry.path}`).toBe(true);
      expect(entry.path.endsWith(".jpg"), `bad path ${entry.path}`).toBe(true);
      expect(entry.creator.trim().length, `${entry.path} creator`).toBeGreaterThan(0);
      expect(entry.sourcePage.trim().length, `${entry.path} sourcePage`).toBeGreaterThan(0);
      expect(entry.sourcePage, `${entry.path} sourcePage`).toMatch(
        /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/,
      );
      expect(entry.licence.trim().length, `${entry.path} licence`).toBeGreaterThan(0);
      expect(entry.licenceUrl.trim().length, `${entry.path} licenceUrl`).toBeGreaterThan(0);
      expect(entry.licenceUrl, `${entry.path} licenceUrl`).toMatch(/^https?:\/\//);
      expect(entry.attribution.trim().length, `${entry.path} attribution`).toBeGreaterThan(0);
      expect(entry.attribution, `${entry.path} attribution names creator`).toContain(entry.creator);
    }
  });

  it("has no duplicate paths", () => {
    const paths = SPORT_ARTWORK_MANIFEST.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("every entry resolves to a valid JPEG whose dimensions match the manifest", () => {
    for (const entry of SPORT_ARTWORK_MANIFEST) {
      const diskPath = join(root, "public", entry.path.replace(/^\//, ""));
      expect(existsSync(diskPath), `missing bundled file ${entry.path}`).toBe(true);
      const dimensions = jpegDimensions(readFileSync(diskPath));
      expect(dimensions.width, `${entry.path} width`).toBe(entry.width);
      expect(dimensions.height, `${entry.path} height`).toBe(entry.height);
      const expected =
        entry.width > entry.height
          ? "landscape"
          : entry.height > entry.width
            ? "portrait"
            : "square";
      expect(entry.orientation, `${entry.path} orientation`).toBe(expected);
    }
  });

  it("no unattributed image sits in public/art/sports/ outside the manifest", () => {
    const referenced = new Set(
      SPORT_ARTWORK_MANIFEST.map((entry) => entry.path.replace("/art/sports/", "")),
    );
    const onDisk = readdirSync(join(root, "public", "art", "sports"));
    expect(onDisk.length).toBeGreaterThan(0);
    for (const file of onDisk) {
      expect(referenced.has(file), `unattributed file public/art/sports/${file}`).toBe(true);
    }
  });

  it("the Settings Licenses section renders credits from this manifest", () => {
    const page = readFileSync(join(root, "src", "pages", "settings", "app-updates.astro"), "utf8");
    expect(page).toContain("sports-artwork-manifest");
    expect(page).toContain("SPORT_ARTWORK_MANIFEST");
    expect(page).toContain("Sports photography");
  });

  it("subjects, where present, are well-formed normalised match keys", () => {
    const keyPattern = /^[a-z0-9]+( [a-z0-9]+)*$/;
    for (const entry of SPORT_ARTWORK_MANIFEST) {
      if (entry.subjects === undefined) continue;
      expect(Array.isArray(entry.subjects), `${entry.path} subjects`).toBe(true);
      expect(entry.subjects.length, `${entry.path} subjects non-empty`).toBeGreaterThan(0);
      expect(new Set(entry.subjects).size, `${entry.path} subjects unique`).toBe(entry.subjects.length);
      for (const key of entry.subjects) {
        expect(key, `${entry.path} subject ${JSON.stringify(key)}`).toMatch(keyPattern);
      }
    }
  });

  it("team/venue coverage (0.11.12 W5): every Premier League club, the Original Six, and the key venues", () => {
    const covered = new Set(SPORT_ARTWORK_MANIFEST.flatMap((entry) => entry.subjects ?? []));
    const withSubjects = SPORT_ARTWORK_MANIFEST.filter(
      (entry) => entry.subjects && entry.subjects.length > 0,
    ).length;
    expect(withSubjects).toBeGreaterThanOrEqual(40);
    const required = [
      // Premier League (canonical names).
      "arsenal",
      "aston villa",
      "bournemouth",
      "brentford",
      "brighton and hove albion",
      "burnley",
      "chelsea",
      "crystal palace",
      "everton",
      "fulham",
      "leeds united",
      "liverpool",
      "manchester city",
      "manchester united",
      "newcastle united",
      "nottingham forest",
      "sunderland",
      "tottenham hotspur",
      "west ham united",
      "wolverhampton wanderers",
      // NHL Original Six.
      "toronto maple leafs",
      "boston bruins",
      "chicago blackhawks",
      "detroit red wings",
      "montreal canadiens",
      "new york rangers",
      // Venues / competitions.
      "world snooker championship",
      "crucible theatre",
      "premier league darts",
      "pdc world darts championship",
      "monaco grand prix",
      "british grand prix",
      "wimbledon",
      "motogp",
      "six nations",
      "twickenham",
    ];
    for (const key of required) {
      expect(covered.has(key), `no entry depicts ${key}`).toBe(true);
    }
  });
});
