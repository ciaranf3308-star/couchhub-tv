// 0.11.9 — the VOD play-source resolver: a provider stream_url
// override wins; a missing container extension is probed from the
// first bytes instead of trusting the blind .mp4 default; a failed
// probe keeps the built URL.

import { describe, it, expect, vi, beforeEach } from "vitest";

const probeMock = vi.fn();

vi.mock("@/scripts/lib/vod-container-probe.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/vod-container-probe.ts")>();
  return {
    ...actual,
    probeVodContainerAlternative: (...args: unknown[]) => probeMock(...args),
  };
});

import {
  resolveVodStreamUrlOverride,
  resolveVodPlaySrc,
} from "@/scripts/lib/stream-urls.ts";

const CREDS = { host: "https://provider.invalid", port: "8080", user: "u", pass: "p" };

beforeEach(() => {
  probeMock.mockReset();
});

describe("resolveVodStreamUrlOverride", () => {
  it("uses an absolute provider URL as-is", () => {
    expect(
      resolveVodStreamUrlOverride(CREDS, "https://cdn.invalid/files/42.mkv")
    ).toBe("https://cdn.invalid/files/42.mkv");
  });

  it("joins a relative path to the provider base", () => {
    expect(resolveVodStreamUrlOverride(CREDS, "/files/42.mkv")).toBe(
      "https://provider.invalid:8080/files/42.mkv"
    );
    expect(resolveVodStreamUrlOverride(CREDS, "files/42.mkv")).toBe(
      "https://provider.invalid:8080/files/42.mkv"
    );
  });

  it("returns null when there is no override", () => {
    expect(resolveVodStreamUrlOverride(CREDS, null)).toBeNull();
    expect(resolveVodStreamUrlOverride(CREDS, undefined)).toBeNull();
    expect(resolveVodStreamUrlOverride(CREDS, "")).toBeNull();
    expect(resolveVodStreamUrlOverride(CREDS, "   ")).toBeNull();
  });
});

describe("resolveVodPlaySrc", () => {
  it("honours the stream_url override without probing", async () => {
    const resolved = await resolveVodPlaySrc({
      creds: CREDS,
      kind: "movie",
      id: 42,
      containerExt: "mkv",
      streamUrl: "https://cdn.invalid/files/42.mkv",
    });
    expect(resolved.src).toBe("https://cdn.invalid/files/42.mkv");
    expect(resolved.probedContainer).toBeNull();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("builds the canonical URL and skips the probe when the extension is known", async () => {
    const resolved = await resolveVodPlaySrc({
      creds: CREDS,
      kind: "movie",
      id: 42,
      containerExt: "mkv",
      streamUrl: null,
    });
    expect(resolved.src).toBe(
      "https://provider.invalid:8080/movie/u/p/42.mkv"
    );
    expect(resolved.probedContainer).toBeNull();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("probes when the extension is missing and swaps to the verified container", async () => {
    probeMock.mockResolvedValue({
      url: "https://provider.invalid:8080/movie/u/p/42.mp4",
      container: "mkv",
    });
    const resolved = await resolveVodPlaySrc({
      creds: CREDS,
      kind: "movie",
      id: 42,
      containerExt: null,
      streamUrl: null,
    });
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(probeMock).toHaveBeenCalledWith(
      "https://provider.invalid:8080/movie/u/p/42.mp4"
    );
    // The verified container is reflected in the URL so every
    // downstream sniffer (plan, tee proxy, MIME) sees the real one.
    expect(resolved.src).toBe(
      "https://provider.invalid:8080/movie/u/p/42.mkv"
    );
    expect(resolved.probedContainer).toBe("mkv");
  });

  it("keeps the built URL when the probe finds nothing", async () => {
    probeMock.mockResolvedValue(null);
    const resolved = await resolveVodPlaySrc({
      creds: CREDS,
      kind: "episode",
      id: 7,
      containerExt: null,
      streamUrl: null,
    });
    expect(resolved.src).toBe(
      "https://provider.invalid:8080/series/u/p/7.mp4"
    );
    expect(resolved.probedContainer).toBeNull();
  });

  it("keeps the built URL when the probe throws", async () => {
    probeMock.mockRejectedValue(new Error("network down"));
    const resolved = await resolveVodPlaySrc({
      creds: CREDS,
      kind: "episode",
      id: 7,
      containerExt: null,
      streamUrl: null,
    });
    expect(resolved.src).toBe(
      "https://provider.invalid:8080/series/u/p/7.mp4"
    );
    expect(resolved.probedContainer).toBeNull();
  });
});
