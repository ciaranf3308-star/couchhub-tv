/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONNECTION_LIMIT_RETRY_DELAY_MS,
  dispatchRelease,
  shouldAutoRetryConnectionLimit,
  shouldReleaseHeldStreamOnModeLeave,
  shouldReleaseStreamOnModeLeave,
  switchChannel,
  tuneToChannel,
  type PlaybackEngine,
} from "@/scripts/lib/livetv-playback";

// 0.11.4 W5 — playback release on EVERY tune path + connection-limit
// auto-recovery.
//
// The reported defect (0.11.2, user's photo): every tune refused
// with "This channel isn't playing right now. Your previous channel
// keeps playing underneath." — playback FULLY STUCK, not a transient
// failure. The 0.11.2 exit release did not cover his flow. The
// enumeration found four bypasses, all fixed here:
//
//   1. Raw-event tunes never released. The Guide, browser, landing
//      Watch Live / hero, deep link (?channel=) and resume-last
//      auto-tune dispatch the raw `livetv:tune` event, and only the
//      shell's switchChannel callers released first. The engine's
//      `livetv:tune` listener is now the one release-before-tune
//      gate for every path.
//   2. Guide detour swallowed the exit release. The 0.11.2 shell
//      gate required the document mode to still read "playback"
//      when leaving for landing — but playback → Guide had already
//      rewritten it to "guide", so Guide → Landing never released
//      and the channel kept playing hidden.
//   3. The release itself was incomplete: it never stopped the
//      audio-proxy ffmpeg session, so the provider slot stayed held
//      after every exit / switch on proxy channels.
//   4. Window hides without release: return-home minimise only
//      paused the <video>, and an OS-level minimise / lock had no
//      listener at all (W3 covers tray-hide via its Tauri event).
//
// And when a tune is STILL refused as connection-limit, the engine
// now releases the stale session itself and retries once, instead
// of sitting stuck on the error overlay. The old
// "previous channel keeps playing underneath" copy is gone: the
// error says what actually failed, not the app's session state.
//
// Headless cannot play a real stream; the fake provider below
// models the one-stream guard exactly, and the wiring assertions
// pin the engine/shell/return-home code to the contract.

function recordingEngine(): PlaybackEngine & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    release: () => {
      calls.push("release");
    },
    tune: () => {
      calls.push("tune");
    },
  };
}

/** Fake provider slot: one connection max, like the Xtream panel. */
function oneStreamProvider() {
  let heldBy: string | number | null = null;
  return {
    heldBy: () => heldBy,
    /** Tune refused while another session is held. */
    tune(id: string | number): boolean {
      if (heldBy !== null && heldBy !== id) return false;
      heldBy = id;
      return true;
    },
    release() {
      heldBy = null;
    },
  };
}

describe("tuneToChannel releases before tuning", () => {
  it("calls release before tune, exactly once each", () => {
    const engine = recordingEngine();
    expect(tuneToChannel(engine, 102)).toBe(true);
    expect(engine.calls).toEqual(["release", "tune"]);
  });

  it("still tunes when the engine has no release hook (fakes / legacy engines)", () => {
    const tune = vi.fn();
    expect(tuneToChannel({ tune }, 102)).toBe(true);
    expect(tune).toHaveBeenCalledTimes(1);
    expect(tune).toHaveBeenCalledWith(102);
  });

  it("a null id tunes nothing and releases nothing", () => {
    const engine = recordingEngine();
    expect(tuneToChannel(engine, null)).toBe(false);
    expect(tuneToChannel(engine, undefined)).toBe(false);
    expect(engine.calls).toEqual([]);
  });
});

describe("switchChannel releases before tuning", () => {
  it("orders release before tune", () => {
    const engine = recordingEngine();
    expect(switchChannel(engine, 101, 102)).toBe(true);
    expect(engine.calls).toEqual(["release", "tune"]);
  });
});

describe("every tune path goes through the release-before-tune gate", () => {
  // Each row is one tune entry point in the app and the helper it
  // tunes through. The engine's `livetv:tune` listener releases
  // again before play(), so even a caller that dispatches the raw
  // event is covered — but the helper itself must already order
  // release-before-tune, or a path using it alone would bypass.
  const tunePaths: Array<{
    path: string;
    run: (engine: PlaybackEngine) => boolean;
  }> = [
    {
      path: "channel browser Watch (dispatchLivetvTune -> tune)",
      run: (engine) => tuneToChannel(engine, 102),
    },
    {
      path: "Guide Watch (Guide tuneToChannel -> tune)",
      run: (engine) => tuneToChannel(engine, 102),
    },
    {
      path: "landing hero Watch Live (dispatchLivetvTune -> tune)",
      run: (engine) => tuneToChannel(engine, 102),
    },
    {
      path: "Quick Surf confirm (switchChannel)",
      run: (engine) => switchChannel(engine, 101, 102),
    },
    {
      path: "OSD / options previous channel (switchChannel)",
      run: (engine) => switchChannel(engine, 101, 100),
    },
    {
      path: "error overlay retry (switchChannel)",
      run: (engine) => switchChannel(engine, 102, 102),
    },
    {
      path: "favourites / resume tune (tune)",
      run: (engine) => tuneToChannel(engine, 102),
    },
    {
      path: "deep link ?channel= (tune)",
      run: (engine) => tuneToChannel(engine, 102),
    },
    {
      path: "resume-last auto-tune on launch (tune)",
      run: (engine) => tuneToChannel(engine, 102),
    },
  ];

  it.each(tunePaths)("$path releases before tuning", ({ run }) => {
    const engine = recordingEngine();
    expect(run(engine)).toBe(true);
    expect(engine.calls[0]).toBe("release");
    expect(engine.calls).toContain("tune");
    expect(engine.calls.indexOf("release")).toBeLessThan(
      engine.calls.indexOf("tune"),
    );
  });
});

describe("shouldReleaseHeldStreamOnModeLeave — the Guide detour", () => {
  it("releases on landing / home while a channel is tuned", () => {
    expect(shouldReleaseHeldStreamOnModeLeave("landing", 101)).toBe(true);
    expect(shouldReleaseHeldStreamOnModeLeave("home", 101)).toBe(true);
  });

  it("never releases when nothing is tuned", () => {
    expect(shouldReleaseHeldStreamOnModeLeave("landing", null)).toBe(false);
    expect(shouldReleaseHeldStreamOnModeLeave("home", undefined)).toBe(false);
  });

  it("keeps the session for guide / browser / playback, tuned or not", () => {
    expect(shouldReleaseHeldStreamOnModeLeave("guide", 101)).toBe(false);
    expect(shouldReleaseHeldStreamOnModeLeave("browser", 101)).toBe(false);
    expect(shouldReleaseHeldStreamOnModeLeave("playback", 101)).toBe(false);
  });

  it("agrees with shouldReleaseStreamOnModeLeave on the mode half", () => {
    for (const mode of ["landing", "home", "guide", "browser", "playback"]) {
      expect(shouldReleaseHeldStreamOnModeLeave(mode, 101)).toBe(
        shouldReleaseStreamOnModeLeave(mode),
      );
    }
  });
});

describe("shouldAutoRetryConnectionLimit — one automatic retry, connection-limit only", () => {
  it("retries a first connection-limit refusal", () => {
    expect(shouldAutoRetryConnectionLimit("connection-limit", false)).toBe(
      true,
    );
  });

  it("never retries twice for the same user tune", () => {
    expect(shouldAutoRetryConnectionLimit("connection-limit", true)).toBe(
      false,
    );
  });

  it("never auto-retries any other failure kind", () => {
    for (const kind of ["hevc", "hevc-likely", "codec", "audio", "parse", "unknown", null, undefined]) {
      expect(shouldAutoRetryConnectionLimit(kind, false)).toBe(false);
    }
  });

  it("the retry delay is a real settle, not a race (2 s)", () => {
    expect(CONNECTION_LIMIT_RETRY_DELAY_MS).toBe(2000);
    expect(CONNECTION_LIMIT_RETRY_DELAY_MS).toBeGreaterThan(600);
  });
});

describe("harness: the Guide detour blocks the next tune without the held-stream release", () => {
  it("playback -> Guide -> Landing without a release leaves the slot held", () => {
    const provider = oneStreamProvider();
    expect(provider.tune(101)).toBe(true);
    // Guide entry keeps the session by design; the 0.11.2 shell
    // gate then saw mode "guide" on the landing leave and released
    // nothing — the channel kept playing hidden.
    expect(shouldReleaseStreamOnModeLeave("guide")).toBe(false);
    expect(shouldReleaseHeldStreamOnModeLeave("guide", 101)).toBe(false);
    // The old landing-leave gate (mode must still read "playback"):
    // after the Guide detour it reads "guide", so no release fired.
    expect(provider.tune(102)).toBe(false);
    expect(provider.heldBy()).toBe(101);
  });

  it("playback -> Guide -> Landing WITH the held-stream release frees the slot", () => {
    const provider = oneStreamProvider();
    const onRelease = () => provider.release();
    window.addEventListener("livetv:release", onRelease);
    try {
      expect(provider.tune(101)).toBe(true);
      // Leaving the Guide for landing while 101 is tuned releases.
      expect(shouldReleaseHeldStreamOnModeLeave("landing", 101)).toBe(true);
      dispatchRelease(101);
      expect(provider.heldBy()).toBeNull();
      expect(provider.tune(102)).toBe(true);
      expect(provider.heldBy()).toBe(102);
    } finally {
      window.removeEventListener("livetv:release", onRelease);
    }
  });
});

describe("harness: connection-limit auto-recovery unblocks a stuck tune", () => {
  it("a stale held session is released and the retry succeeds", () => {
    const provider = oneStreamProvider();
    // A stale session the app no longer owns (hidden window /
    // orphaned proxy / provider linger) holds the single slot.
    expect(provider.tune(999)).toBe(true);
    // The user's tune is refused.
    expect(provider.tune(101)).toBe(false);
    // First refusal: the app retries automatically after releasing.
    expect(shouldAutoRetryConnectionLimit("connection-limit", false)).toBe(
      true,
    );
    provider.release();
    expect(provider.tune(101)).toBe(true);
    expect(provider.heldBy()).toBe(101);
  });

  it("a second refusal is NOT retried — the honest error shows instead", () => {
    const provider = oneStreamProvider();
    expect(provider.tune(999)).toBe(true);
    expect(provider.tune(101)).toBe(false);
    // Budget spent by the first automatic retry.
    expect(shouldAutoRetryConnectionLimit("connection-limit", true)).toBe(
      false,
    );
    expect(provider.heldBy()).toBe(999);
  });
});

describe("wiring — the gate, the complete release, and the recovery are in the engine", () => {
  const stream = readFileSync("src/scripts/stream/stream.ts", "utf8");

  it("the livetv:tune listener releases before play()", () => {
    const start = stream.indexOf('window.addEventListener("livetv:tune"');
    expect(start).toBeGreaterThan(-1);
    const slice = stream.slice(start, stream.indexOf("window.addEventListener", start + 10));
    expect(slice).toContain("releaseLocalPlaybackForHandoff()");
    expect(slice).toContain("void play(");
    expect(slice.indexOf("releaseLocalPlaybackForHandoff()")).toBeLessThan(
      slice.indexOf("void play("),
    );
  });

  it("releaseLocalPlaybackForHandoff stops the audio proxy (no orphaned ffmpeg holding the slot)", () => {
    const start = stream.indexOf("function releaseLocalPlaybackForHandoff()");
    expect(start).toBeGreaterThan(-1);
    const slice = stream.slice(start, stream.indexOf("async function play(", start));
    expect(slice).toContain("void stopAudioTranscode()");
    expect(slice).toContain("clearRadioMode()");
  });

  it("hiding the window releases (visibilitychange backstop for minimise / lock)", () => {
    const start = stream.indexOf('document.addEventListener("visibilitychange"');
    expect(start).toBeGreaterThan(-1);
    const slice = stream.slice(start, start + 500);
    expect(slice).toContain('document.visibilityState === "hidden"');
    expect(slice).toContain("releaseLocalPlaybackForHandoff()");
  });

  it("a connection-limit failure schedules one automatic release-and-retry", () => {
    expect(stream).toContain("shouldAutoRetryConnectionLimit(");
    expect(stream).toContain('"auto:connection-limit-retry"');
    expect(stream).toContain("CONNECTION_LIMIT_RETRY_DELAY_MS");
    expect(stream).toContain("connectionLimitAutoRetrySet");
  });
});

describe("wiring — the shell no longer gates the exit release on the document mode", () => {
  const shell = readFileSync(
    "src/components/couch/TvPlaybackShell.astro",
    "utf8",
  );

  it("releases on landing leave whenever a channel is tuned", () => {
    expect(shell).toContain("tunedId !== null &&");
    expect(shell).toContain("shouldReleaseStreamOnModeLeave(mode)");
    expect(shell).toContain("dispatchRelease(tunedId)");
  });

  it("is not gated on the document mode still reading playback", () => {
    // The 0.11.2 gate used a wasPlayback flag; the mode read is
    // still used elsewhere (isPlaybackActive), so pin the release
    // gate itself: tuned-channel + mode predicate, before the release.
    expect(shell).not.toContain("wasPlayback");
    const gateAt = shell.indexOf("tunedId !== null &&");
    const releaseAt = shell.indexOf("dispatchRelease(tunedId)");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(releaseAt);
  });

  it("never tells the user a previous channel keeps playing underneath", () => {
    expect(shell).not.toContain("keeps playing underneath");
    expect(shell).toContain("The channel didn't start.");
  });
});

describe("wiring — return-home releases instead of only pausing", () => {
  const returnHome = readFileSync(
    "src/scripts/lib/return-home.ts",
    "utf8",
  );

  it("dispatches the engine release before minimising", () => {
    expect(returnHome).toContain("livetv:release");
    expect(returnHome.indexOf("livetv:release")).toBeLessThan(
      returnHome.indexOf("minimize()"),
    );
  });
});

describe("copy — the error never blames a previous channel", () => {
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<
    string,
    string
  >;

  it("connection-limit copy says what failed and what to do", () => {
    expect(en["stream.failure.connectionLimit"]).not.toContain(
      "Something else may still be playing",
    );
    expect(en["stream.failure.connectionLimit"]).toContain("try again");
    expect(en["receiver.error.connectionLimit"]).not.toContain(
      "Something else may still be playing",
    );
  });

  it("the automatic-retry toast exists", () => {
    expect(en["stream.failure.connectionLimitRetrying"]).toContain("retrying");
  });
});
