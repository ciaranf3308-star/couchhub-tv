/**
 * Live TV 0.9.0 — shared row components (TvChannelRow, TvProgrammeRow).
 *
 * Fidelity contract, tested at the source level the way
 * couch-visual-identity.test.ts does: the row markup (hooks +
 * classes) is the contract Quick Surf / the OSD / the Guide paint
 * against, so these tests pin it. The visual match against the
 * mockups is verified by the 1920x1080 render check (see the
 * report), not by these assertions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

const channelRow = read("src/components/couch/TvChannelRow.astro");
const programmeRow = read("src/components/couch/TvProgrammeRow.astro");
const quickSurf = read("src/components/couch/TvQuickSurf.astro");
const osd = read("src/components/couch/TvOsd.astro");
const shell = read("src/components/couch/TvPlaybackShell.astro");
const couchCss = read("src/styles/couch.css");
const cssNoComments = couchCss.replace(/\/\*[\s\S]*?\*\//g, "");

describe("TvChannelRow (mockup 1 — Quick Surf channel rows)", () => {
  it("renders a button row with the painting hooks", () => {
    for (const hook of [
      "data-channel-row",
      "data-channel-id",
      "data-row-num",
      "data-row-logo",
      "data-row-name",
      "data-row-now",
      "data-row-next",
      "data-row-progress",
      "data-row-fav",
    ]) {
      expect(channelRow).toContain(hook);
    }
    expect(channelRow).toContain('role="option"');
    expect(channelRow).toContain("rs-channel-row--highlighted");
  });

  it("shows Next + progress only on the highlighted row, like the mockup", () => {
    expect(channelRow).toContain("highlighted && nextTitle");
    expect(channelRow).toContain("highlighted && pct !== null");
  });

  it("never invents a logo: bare img when one exists, initial tile when not", () => {
    expect(channelRow).toContain("logo ? (");
    expect(channelRow).toContain("rs-channel-row__initial");
    expect(channelRow).toContain('`Now: ${nowTitle}`');
  });
});

describe("TvProgrammeRow (mockup 3 — Guide Now & Next rows)", () => {
  it("renders the three-column row with the painting hooks", () => {
    for (const hook of [
      "data-programme-row",
      "data-programme-channel",
      "data-programme-logo",
      "data-programme-now-title",
      "data-programme-now-time",
      "data-programme-progress",
      "data-programme-next-title",
      "data-programme-next-time",
    ]) {
      expect(programmeRow).toContain(hook);
    }
    expect(programmeRow).toContain("rs-programme-row--highlighted");
  });

  it("shows the bare logo lockup — or the initial tile with no logo; the lockup IS the name (mockup 3)", () => {
    expect(programmeRow).toContain("data-programme-logo");
    expect(programmeRow).toContain("rs-programme-row__initial");
    expect(programmeRow).not.toContain("data-programme-channel-name");
  });

  it("supports the OSD's channel-less form (Now | Next only)", () => {
    expect(programmeRow).toContain("showChannel");
    expect(programmeRow).toContain("rs-programme-row--no-channel");
  });

  it("computes progress and time labels from the EPG, never invents them", () => {
    expect(programmeRow).toContain("programmeProgress");
    expect(programmeRow).toContain("epgTimeRangeLabel");
  });
});

describe("Quick Surf uses the shared channel row (single source of truth)", () => {
  it("renders one TvChannelRow inside a template and clones it", () => {
    expect(quickSurf).toContain('import TvChannelRow from "./TvChannelRow.astro"');
    expect(quickSurf).toContain("data-qs-row-template");
    expect(quickSurf).toContain("cloneNode(true)");
    expect(quickSurf).toContain("[data-channel-row]");
  });

  it("fills the row hooks and drops Next/progress off non-highlighted rows", () => {
    expect(quickSurf).toContain("[data-row-num]");
    expect(quickSurf).toContain("[data-row-name]");
    expect(quickSurf).toContain("[data-row-now]");
    expect(quickSurf).toContain("[data-row-next]");
    expect(quickSurf).toContain("[data-row-progress]");
    expect(quickSurf).toContain("nextEl?.remove()");
  });

  it("has the mockup's step chevrons above and below the list", () => {
    expect(quickSurf).toContain("data-qs-step");
    expect(quickSurf).toContain("rs-livetv-play-quicksurf__step");
  });

  it("no longer builds row markup by hand (no divider-row classes)", () => {
    expect(quickSurf).not.toContain("rs-livetv-play-quicksurf__row");
    expect(quickSurf).not.toContain("rs-livetv-play-quicksurf__num");
    expect(quickSurf).not.toContain("rs-livetv-play-quicksurf__logo");
  });
});

describe("OSD programme zone is the shared programme row", () => {
  it("embeds TvProgrammeRow without its channel column", () => {
    expect(osd).toContain('import TvProgrammeRow from "./TvProgrammeRow.astro"');
    expect(osd).toContain("showChannel={false}");
    expect(osd).toContain('nextLabel="Up Next"');
  });

  it("the shell paints the programme-row hooks, not the old OSD hooks", () => {
    for (const hook of [
      "[data-programme-now-title]",
      "[data-programme-now-time]",
      "[data-programme-progress]",
      "[data-programme-next-title]",
      "[data-programme-next-time]",
    ]) {
      expect(shell).toContain(hook);
    }
    expect(shell).not.toContain("[data-osd-now-title]");
    expect(shell).not.toContain("[data-osd-next-title]");
    expect(shell).not.toContain("[data-osd-progress]");
  });
});

describe("row styles (couch.css, Live TV 0.9.0 section)", () => {
  it("styles channel rows as tiles with a glowing-border highlight", () => {
    for (const rule of [
      ".rs-channel-row {",
      ".rs-channel-row--highlighted {",
      ".rs-channel-row__num {",
      ".rs-channel-row__logo {",
      ".rs-channel-row__name {",
      ".rs-channel-row__progress {",
    ]) {
      expect(couchCss).toContain(rule);
    }
    expect(cssNoComments).not.toContain(".rs-livetv-play-quicksurf__row {");
  });

  it("styles programme rows as a three-column grid with a red highlight", () => {
    for (const rule of [
      ".rs-programme-row {",
      ".rs-programme-row--highlighted {",
      ".rs-programme-row--no-channel {",
      ".rs-programme-row__title {",
      ".rs-programme-row__progress {",
    ]) {
      expect(couchCss).toContain(rule);
    }
  });

  it("keeps the Quick Surf list gapped like the mockup's tiles", () => {
    expect(couchCss).toContain(".rs-livetv-play-quicksurf__list {");
  });
});
