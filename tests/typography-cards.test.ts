// W1 typography + poster cards (RedSilk Home production pass).
//
// Guards: Manrope vendored locally and wired as the ONLY Couch font
// (zero CDN), the shared type scale in couch.css, the poster-card
// hierarchy / truncation / focus behaviour, and the TvRail large
// density. Source-level guards in the brand.test.ts style: they read
// the files the browser actually loads, so a regression in any of
// them fails here before it reaches the projector.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const css = read("src/styles/couch.css");
const tvCard = read("src/components/couch/TvCard.astro");
const tvRail = read("src/components/couch/TvRail.astro");

// The declaration block for the first rule whose selector list
// contains `selector` (selectors are matched literally, so pass the
// full selector as written in couch.css).
function ruleBlock(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `missing selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThanOrEqual(0);
  return css.slice(open + 1, close);
}

const MANROPE_WEIGHTS = [400, 500, 600, 700, 800];

// ── woff2 name-table reader (dependency-free) ────────────────────
// Parses the WOFF2 header + table directory, Brotli-decompresses the
// font data block, and returns the raw `name` table bytes. The
// directory rules mirror fontTools' WOFF2Reader: glyf/loca carry a
// transformLength unless their transform version is 3; every other
// table carries one iff its transform version is non-zero.
const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

function readBase128(buf: Buffer, off: number): [number, number] {
  let value = 0;
  let i = off;
  for (;;) {
    const b = buf[i++];
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [value, i];
}

function woff2NameTable(buf: Buffer): Buffer {
  expect(buf.subarray(0, 4).toString("latin1")).toBe("wOF2");
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  let off = 48;
  const tables: { tag: string; origLength: number; storedLength: number }[] = [];
  for (let t = 0; t < numTables; t++) {
    const flags = buf[off++];
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 0x3f) {
      tag = buf.subarray(off, off + 4).toString("latin1");
      off += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[idx];
    }
    const [origLength, o2] = readBase128(buf, off);
    off = o2;
    const transformed =
      tag === "glyf" || tag === "loca" ? (flags >> 6) !== 3 : (flags >> 6) !== 0;
    let storedLength = origLength;
    if (transformed) {
      const [tl, o3] = readBase128(buf, off);
      off = o3;
      storedLength = tl;
    }
    tables.push({ tag, origLength, storedLength });
  }
  const raw = brotliDecompressSync(buf.subarray(off, off + totalCompressedSize));
  let pos = 0;
  for (const table of tables) {
    if (table.tag === "name") return raw.subarray(pos, pos + table.origLength);
    pos += table.storedLength;
  }
  throw new Error("no name table in woff2");
}

const utf16 = (s: string) =>
  Buffer.from(s.split("").flatMap((c) => [0, c.charCodeAt(0)]));

describe("Manrope, vendored locally (W1)", () => {
  it("all five latin weights exist as real woff2 files", () => {
    for (const weight of MANROPE_WEIGHTS) {
      const rel = `public/fonts/manrope/manrope-latin-${weight}-normal.woff2`;
      const abs = join(root, rel);
      expect(existsSync(abs), rel).toBe(true);
      const buf = readFileSync(abs);
      expect(buf.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(statSync(abs).size).toBeGreaterThan(10_000);
    }
  });

  it("every vendored file's name table says Manrope (not just the filename)", () => {
    for (const weight of MANROPE_WEIGHTS) {
      const buf = readFileSync(
        join(root, `public/fonts/manrope/manrope-latin-${weight}-normal.woff2`),
      );
      const name = woff2NameTable(buf);
      expect(name.includes(utf16("Manrope"))).toBe(true);
      expect(name.includes(utf16("Copyright 2019 The Manrope Project Authors"))).toBe(true);
      expect(name.includes(utf16("http://scripts.sil.org/OFL"))).toBe(true);
    }
  });

  it("the OFL license text ships with the fonts", () => {
    const license = read("public/fonts/manrope/OFL.txt");
    expect(license).toContain("Manrope");
    expect(license).toContain("SIL Open Font License");
  });

  it("@font-face loads each weight from the local bundle, never a CDN", () => {
    for (const weight of MANROPE_WEIGHTS) {
      expect(css).toMatch(
        new RegExp(
          `@font-face\\s*\\{[^}]*font-weight:\\s*${weight};[^}]*url\\("/fonts/manrope/manrope-latin-${weight}-normal\\.woff2"\\)\\s*format\\("woff2"\\)`,
        ),
      );
    }
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it("both Couch font tokens are Manrope; no legacy family is referenced", () => {
    const display = /--rs-font-display:\s*"Manrope"/.test(css);
    const body = /--rs-font-body:\s*"Manrope"/.test(css);
    expect(display).toBe(true);
    expect(body).toBe(true);
    // Any font-family declaration must not name the old families
    // (comment mentions of them are fine — this is declaration-only).
    for (const match of css.matchAll(/font-family:\s*([^;]+);/g)) {
      expect(match[1]).not.toMatch(/Instrument Serif|Geist Variable/);
    }
  });
});

describe("shared type scale (W1)", () => {
  it("hero title is 54px Manrope 800", () => {
    const block = ruleBlock(".rs-hero-title");
    expect(block).toMatch(/font-size:\s*3\.375rem/);
    expect(block).toMatch(/font-weight:\s*800/);
  });

  it("section heading is 32px Manrope 700", () => {
    const block = ruleBlock(".rs-section-title");
    expect(block).toMatch(/font-size:\s*2rem/);
    expect(block).toMatch(/font-weight:\s*700/);
  });

  it("primary nav is 24px via the shared nav token, weight 600", () => {
    expect(ruleBlock("html[data-couch] {")).toMatch(/--rs-nav-size:\s*1\.5rem/);
    const block = ruleBlock("html[data-couch] .rs-nav__link {");
    expect(block).toMatch(/font-size:\s*var\(--rs-nav-size\)/);
    expect(block).toMatch(/font-weight:\s*600/);
  });

  it("card title / description / meta sizes are shared tokens at the specified px", () => {
    const tokens = ruleBlock("html[data-couch] {");
    expect(tokens).toMatch(/--rs-card-title-size:\s*1\.25rem/); // 20px
    expect(tokens).toMatch(/--rs-description-size:\s*1\.375rem/); // 22px
    expect(tokens).toMatch(/--rs-meta-size:\s*1\.125rem/); // 18px
    expect(ruleBlock(".rs-card__title")).toMatch(
      /font-size:\s*var\(--rs-card-title-size\)/,
    );
    expect(ruleBlock(".rs-hero__description")).toMatch(
      /font-size:\s*var\(--rs-description-size\)/,
    );
    expect(ruleBlock(".rs-card__subtitle")).toMatch(
      /font-size:\s*var\(--rs-meta-size\)/,
    );
  });
});

describe("poster cards (W1)", () => {
  it("TvCard renders images only through TvImage — never a raw <img>", () => {
    expect(tvCard).toContain('import TvImage from "./TvImage.astro"');
    expect(tvCard).not.toMatch(/<img[\s>]/);
    expect(tvCard).toContain("<TvImage");
  });

  it("a broken image can never render: fallback hides the img", () => {
    expect(ruleBlock(".rs-image.is-fallback img")).toMatch(/display:\s*none/);
    expect(ruleBlock(".rs-image.is-fallback .rs-image__fallback")).toMatch(
      /display:\s*flex/,
    );
  });

  it("rs-image is a block box, so span usage (HomeView) still gets aspect + fallback", () => {
    expect(ruleBlock("html[data-couch] .rs-image {")).toMatch(/display:\s*block/);
  });

  it("poster media holds a 2:3 box with cover art", () => {
    expect(ruleBlock(".rs-card--poster .rs-card__media")).toMatch(
      /aspect-ratio:\s*2\s*\/\s*3/,
    );
    expect(ruleBlock(".rs-image--poster")).toMatch(/aspect-ratio:\s*2\s*\/\s*3/);
    expect(ruleBlock(".rs-image img")).toMatch(/object-fit:\s*cover/);
  });

  it("titles and secondary lines truncate with an ellipsis, never overflow", () => {
    for (const selector of [".rs-card__title", ".rs-card__subtitle"]) {
      const block = ruleBlock(selector);
      expect(block).toMatch(/white-space:\s*nowrap/);
      expect(block).toMatch(/overflow:\s*hidden/);
      expect(block).toMatch(/text-overflow:\s*ellipsis/);
    }
  });

  it("poster cards show title + one secondary line, not detail spam", () => {
    expect(css).toContain(
      ".rs-card--poster .rs-card__body:has(.rs-card__subtitle) .rs-card__meta",
    );
    expect(
      ruleBlock(
        ".rs-card--poster .rs-card__body:has(.rs-card__subtitle) .rs-card__meta",
      ),
    ).toMatch(/display:\s*none/);
  });

  it("TvCard offers an optional focus-only detail (prop and/or slot)", () => {
    expect(tvCard).toContain("detail?: string");
    expect(tvCard).toContain('slot name="detail"');
    expect(tvCard).toContain("rs-card__detail");
  });

  it("focus enlarges by transform only — no layout-affecting size change", () => {
    const block = ruleBlock(".rs-card:focus-visible");
    expect(block).toMatch(/transform:\s*scale\(1\.05\)/);
    expect(block).not.toMatch(/^\s*(width|height)\s*:/m);
    // The focus detail overlay is opacity/transform only too.
    const detail = ruleBlock(".rs-card__detail");
    expect(detail).toMatch(/opacity:\s*0/);
    expect(detail).toMatch(/transform:\s*translateY\(/);
    expect(detail).not.toMatch(/^\s*(width|height)\s*:/m);
    expect(css).toContain(".rs-card:focus-visible .rs-card__detail");
    expect(ruleBlock(".rs-card:focus-visible .rs-card__detail")).toMatch(
      /opacity:\s*1/,
    );
  });
});

describe("rail density (W1)", () => {
  it("TvRail takes an optional density prop, defaulting to current behaviour", () => {
    expect(tvRail).toContain('density?: TvRailDensity');
    expect(tvRail).toContain('density = "default"');
    expect(tvRail).toContain("rs-rail--large");
  });

  it("default poster sizing is unchanged", () => {
    expect(ruleBlock(".rs-rail__row > .rs-card--poster")).toMatch(
      /flex:\s*0 0 clamp\(9rem, 11\.5vw, 13rem\)/,
    );
  });

  it("large density sizes ~5-6 substantial cards per rail at 1080p", () => {
    expect(
      ruleBlock(".rs-rail--large .rs-rail__row > .rs-card--poster"),
    ).toMatch(/flex:\s*0 0 clamp\(15rem, 16\.4vw, 19rem\)/);
  });
});
