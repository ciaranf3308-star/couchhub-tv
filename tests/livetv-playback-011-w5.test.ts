/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  OSD_ACTION_IDS,
  recoveryActionsForFailureKind,
  artworkUrlForSurf,
  switchChannel,
  stepHighlight,
  confirmHighlight,
  surfWindow,
  type PlaybackChannel,
  type PlaybackEngine,
  type SurfProgrammeArtwork,
} from "@/scripts/lib/livetv-playback";

const channels: PlaybackChannel[] = [
  { id: 101, name: "RTE One", chno: 101 },
  { id: 102, name: "RTE 2", chno: 102 },
  { id: 103, name: "TG4", chno: 103 },
  { id: 104, name: "Virgin One", chno: 104 },
  { id: 105, name: "Sky Sports", chno: 105 },
];

interface RecordingEngine extends PlaybackEngine {
  calls: Array<"release" | "tune">;
  released: Array<string | number | null | undefined>;
  tuned: Array<string | number>;
}

function recordingEngine(): RecordingEngine {
  const engine: RecordingEngine = {
    calls: [],
    released: [],
    tuned: [],
    tune(id) {
      this.calls.push("tune");
      this.tuned.push(id);
    },
    release(id) {
      this.calls.push("release");
      this.released.push(id);
    },
  };
  return engine;
}

describe("OSD action row — the mockup's seven icon actions", () => {
  it("is exactly Channels / Guide / Info / Favourite / Subtitles / Audio / Settings, in order", () => {
    expect([...OSD_ACTION_IDS]).toEqual([
      "browser",
      "guide",
      "info",
      "favourite",
      "subtitles",
      "audio",
      "settings",
    ]);
  });

  it("has no transport on the row — Pause / Mute / Previous live in the Options overlay", () => {
    // The 0.9.0 row carried eleven text actions (Pause, Mute,
    // Previous, Restart, Back among them); the 0.11.0 row is the
    // mockup's seven only.
    expect(OSD_ACTION_IDS).toHaveLength(7);
    for (const id of ["pause", "mute", "previous", "restart", "back", "home"]) {
      expect(OSD_ACTION_IDS).not.toContain(id);
    }
  });
});

describe("kind-aware failure recovery — the legacy panel's actions, reachable again", () => {
  it("HEVC failures offer HEVC install + external player", () => {
    expect(recoveryActionsForFailureKind("hevc")).toEqual({ hevc: true, external: true });
    expect(recoveryActionsForFailureKind("hevc-likely")).toEqual({
      hevc: true,
      external: true,
    });
  });

  it("codec failures offer the external player, not HEVC install", () => {
    expect(recoveryActionsForFailureKind("codec")).toEqual({ hevc: false, external: true });
  });

  it("audio failures offer the external player only — the engine already auto-attempted its audio fix", () => {
    expect(recoveryActionsForFailureKind("audio")).toEqual({ hevc: false, external: true });
  });

  it("parse / connection-limit / unknown offer neither — Retry / Previous / Home only", () => {
    for (const kind of ["parse", "connection-limit", "unknown", null, undefined]) {
      expect(recoveryActionsForFailureKind(kind)).toEqual({ hevc: false, external: false });
    }
  });

  it("resolving the recovery actions never tunes", () => {
    const engine = recordingEngine();
    recoveryActionsForFailureKind("hevc");
    expect(engine.calls).toEqual([]);
  });
});

describe("Quick Surf highlighted-row artwork — still first, never a placeholder", () => {
  const art = (over: Partial<SurfProgrammeArtwork>): SurfProgrammeArtwork => ({
    backdropUrl: null,
    posterUrl: null,
    stillUrl: null,
    source: "tmdb-episode",
    ...over,
  });

  it("prefers the episode still, then backdrop, then poster", () => {
    expect(
      artworkUrlForSurf(
        art({ stillUrl: "s.jpg", backdropUrl: "b.jpg", posterUrl: "p.jpg" }),
      ),
    ).toBe("s.jpg");
    expect(artworkUrlForSurf(art({ backdropUrl: "b.jpg", posterUrl: "p.jpg" }))).toBe(
      "b.jpg",
    );
    expect(artworkUrlForSurf(art({ posterUrl: "p.jpg" }))).toBe("p.jpg");
  });

  it("returns null when the enrichment has nothing usable — the row shows no thumb at all", () => {
    expect(artworkUrlForSurf(art({}))).toBeNull();
    expect(artworkUrlForSurf(null)).toBeNull();
    expect(artworkUrlForSurf(undefined)).toBeNull();
  });
});

describe("Quick Surf — highlight never tunes, confirm tunes once with release first", () => {  it("stepping the highlight across the whole window performs no tune", () => {
    const engine = recordingEngine();
    let highlighted: string | number | null = 103;
    for (let i = 0; i < 5; i++) {
      highlighted = stepHighlight(channels, highlighted, 1);
      surfWindow(channels, highlighted, 5);
    }
    expect(engine.calls).toEqual([]);
  });

  it("confirming the highlight releases the current stream before tuning", () => {
    const engine = recordingEngine();
    const highlighted = stepHighlight(channels, 102, 1); // 103
    const target = confirmHighlight(highlighted);
    expect(switchChannel(engine, 102, target)).toBe(true);
    expect(engine.calls).toEqual(["release", "tune"]);
    expect(engine.released).toEqual([102]);
    expect(engine.tuned).toEqual([103]);
  });

  it("a null highlight confirms to nothing — B-dismiss territory, never a tune", () => {
    const engine = recordingEngine();
    expect(confirmHighlight(null)).toBeNull();
    expect(switchChannel(engine, 102, confirmHighlight(null))).toBe(false);
    expect(engine.calls).toEqual([]);
  });
});

// Source contracts for the components this pass owns: the OSD row
// is the mockup's seven icon actions (no transport text buttons),
// the error overlay carries the kind-aware recovery buttons, and
// Quick Surf enriches only the highlighted row through W2's API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

describe("playback markup contracts (0.11.0 W5)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const osd = readFileSync(join(root, "src/components/couch/TvOsd.astro"), "utf8");
  const shell = readFileSync(
    join(root, "src/components/couch/TvPlaybackShell.astro"),
    "utf8",
  );
  const surf = readFileSync(
    join(root, "src/components/couch/TvQuickSurf.astro"),
    "utf8",
  );

  it("the OSD renders the seven mockup actions as icon buttons and no transport text buttons", () => {
    for (const id of OSD_ACTION_IDS) {
      expect(osd).toContain(`id: "${id}"`);
    }
    expect(osd).not.toContain('data-osd-key=" "');
    expect(osd).not.toContain("⏸ Pause");
    expect(osd).not.toContain(">Previous<");
    expect(osd).not.toContain('data-osd-action="back"');
    expect(osd).not.toContain("rs-livetv-play-osd__shortcuts");
  });

  it("the shell error overlay offers HEVC + external-player recovery and a reason line", () => {
    expect(shell).toContain('data-error-action="hevc"');
    expect(shell).toContain('data-error-action="external"');
    expect(shell).toContain("[data-error-reason]");
    expect(shell).toContain("ensureHevcDecodable");
    expect(shell).toContain("external-launch-btn");
  });

  it("the shell Options overlay carries the transport the OSD trimmed (Previous + Restart)", () => {
    expect(shell).toContain('data-play-action="previous"');
    expect(shell).toContain('data-play-action="restart"');
    // No double-backslash synthetic key: the 0.9.0 OSD Previous
    // button dispatched data-osd-key="\\" (two backslashes at
    // runtime) and never matched the engine's single-backslash
    // check — the 0.11.0 button goes through previousChannelTarget.
    expect(shell).not.toContain('data-play-key="\\\\"');
  });

  it("Quick Surf enriches the highlighted row only, via the W2 module when it exists", () => {
    expect(surf).toContain("import.meta.glob");
    expect(surf).toContain("livetv-enrichment");
    expect(surf).toContain("scheduleHighlightedArt");
    expect(surf).toContain("artworkUrlForSurf");
    // No whole-list enrichment: the call site is the highlight-only
    // scheduler, not the row painter.
    expect(surf).not.toContain("prefetchProgrammes");
  });
});
