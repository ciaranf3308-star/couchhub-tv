// 0.11.9 — view-model plumbing for the provider stream-URL override:
// the movie detail view model carries movie_data.stream_url, and the
// episode mapping carries direct_source / stream_url, so playback can
// honour the override exactly like the legacy detail page.

import { describe, it, expect } from "vitest";
import { movieDetailViewModel } from "@/scripts/movies/couch-movies.ts";
import { mapEpisode } from "@/scripts/series/couch-series.ts";

describe("movieDetailViewModel streamUrl", () => {
  it("carries movie_data.stream_url", () => {
    const detail = movieDetailViewModel(
      {
        info: { name: "Test" },
        movie_data: { stream_url: "https://cdn.invalid/files/42.mkv" },
      },
      null
    );
    expect(detail.streamUrl).toBe("https://cdn.invalid/files/42.mkv");
  });

  it("falls back to info.stream_url", () => {
    const detail = movieDetailViewModel(
      { info: { name: "Test", stream_url: "https://cdn.invalid/other.mkv" } },
      null
    );
    expect(detail.streamUrl).toBe("https://cdn.invalid/other.mkv");
  });

  it("is null when the provider supplies no override", () => {
    const detail = movieDetailViewModel({ info: { name: "Test" } }, null);
    expect(detail.streamUrl).toBeNull();
    expect(movieDetailViewModel(null, null).streamUrl).toBeNull();
  });
});

describe("mapEpisode directUrl", () => {
  it("carries direct_source", () => {
    const episode = mapEpisode({
      id: 7,
      title: "Pilot",
      direct_source: "https://cdn.invalid/ep7.mkv",
      info: {},
    });
    expect(episode?.directUrl).toBe("https://cdn.invalid/ep7.mkv");
  });

  it("falls back to stream_url", () => {
    const episode = mapEpisode({
      id: 7,
      title: "Pilot",
      stream_url: "https://cdn.invalid/ep7b.mkv",
      info: {},
    });
    expect(episode?.directUrl).toBe("https://cdn.invalid/ep7b.mkv");
  });

  it("is null when the episode carries no override", () => {
    const episode = mapEpisode({ id: 7, title: "Pilot", info: {} });
    expect(episode?.directUrl).toBeNull();
  });
});
