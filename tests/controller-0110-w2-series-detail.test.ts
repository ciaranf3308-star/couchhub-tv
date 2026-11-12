/**
 * @vitest-environment jsdom
 */
// Controller 2.0 (0.11.10), W2 — Series detail Back wiring (§23–
// §24): B steps episodes → primary actions → origin; playback
// return focuses the episode card's Play button (the article
// itself is not focusable). Fixtures + mocks as in the movie
// detail test; the detail load exits early (no ?id=).
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/scripts/lib/creds.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getActiveEntry: async () => null,
    loadCreds: async () => ({ host: "", user: "", pass: "" }),
  };
});

vi.mock("@/scripts/lib/i18n.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, initI18n: async () => {} };
});

// The page mounts Svelte components (never exercised: no ?id=, so
// loadDetail exits early). Vitest has no Svelte transform, so stub
// the components; mount() itself is never called in these tests.
vi.mock("@/components/couch/TvSeasonPicker.svelte", () => ({ default: {} }));
vi.mock("@/components/couch/TvEpisodeCard.svelte", () => ({ default: {} }));

function buildFixture(): {
  backLink: HTMLAnchorElement;
  resumeBtn: HTMLButtonElement;
  episodeList: HTMLElement;
  playBtn: HTMLElement;
} {
  document.body.innerHTML = `
    <a id="series-detail-back" href="/series">‹ Series</a>
    <div id="series-detail-skeleton"></div>
    <div id="series-detail-body">
      <section id="series-detail-hero" hidden>
        <div id="series-detail-backdrop"></div>
        <h1 id="series-detail-title"></h1>
        <div id="series-detail-meta"></div>
        <p id="series-detail-plot"></p>
        <div id="series-detail-poster"></div>
        <div id="series-detail-progress" hidden></div>
        <button id="series-detail-resume" type="button"><span id="series-detail-resume-label">Next</span><span id="series-detail-resume-sub"></span></button>
        <button id="series-detail-follow" type="button">Follow</button>
        <button id="series-detail-fav" type="button">Favourite</button>
        <button id="series-detail-watch" type="button">Watch Later</button>
        <button id="series-detail-more" type="button">More</button>
      </section>
      <p id="series-detail-status"></p>
      <section id="series-detail-variants" hidden><div id="series-detail-variants-list"></div></section>
      <section id="series-episodes-section" hidden>
        <p id="series-episodes-summary"></p>
        <div id="series-season-picker"></div>
        <div id="series-episode-list">
          <article data-couch-key="episode-5" data-ep-id="5">
            <button type="button" class="rs-episode__play">Play S1 E5</button>
            <span class="rs-episode__actions"><button type="button">Mark watched</button></span>
          </article>
        </div>
      </section>
      <section id="series-detail-cast" hidden><div id="series-detail-cast-list"></div></section>
      <section id="series-detail-similar" hidden><div id="series-detail-similar-list"></div></section>
    </div>
    <div id="series-detail-player-wrap" hidden><video id="series-player"></video></div>
  `;
  return {
    backLink: document.getElementById("series-detail-back") as HTMLAnchorElement,
    resumeBtn: document.getElementById("series-detail-resume") as HTMLButtonElement,
    episodeList: document.getElementById("series-episode-list") as HTMLElement,
    playBtn: document.querySelector(".rs-episode__play") as HTMLElement,
  };
}

describe("series detail Back + episode focus", () => {
  let backLink: HTMLAnchorElement;
  let resumeBtn: HTMLButtonElement;
  let episodeList: HTMLElement;
  let playBtn: HTMLElement;
  let focusEpisodeCard: (list: HTMLElement | null, id: number) => boolean;
  const clicked = vi.fn();

  beforeAll(async () => {
    const fixture = buildFixture();
    backLink = fixture.backLink;
    resumeBtn = fixture.resumeBtn;
    episodeList = fixture.episodeList;
    playBtn = fixture.playBtn;
    backLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      clicked();
    });
    ({ focusEpisodeCard } = await import("@/scripts/series/couch-detail.ts"));
    await new Promise((r) => setTimeout(r, 20));
  }, 60000);

  afterAll(() => {
    document.body.replaceChildren();
  });

  function pressEscape(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  }

  it("focusEpisodeCard focuses the Play button, not the unfocusable article", () => {
    expect(focusEpisodeCard(episodeList, 5)).toBe(true);
    expect(document.activeElement).toBe(playBtn);
    expect(focusEpisodeCard(episodeList, 999)).toBe(false);
  });

  it("B from the episode list steps to primary actions, then to origin", () => {
    playBtn.focus();
    expect(document.activeElement).toBe(playBtn);
    pressEscape();
    expect(document.activeElement).toBe(resumeBtn);
    expect(clicked).not.toHaveBeenCalled();
    pressEscape();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("B with focus outside episodes goes straight to origin", () => {
    resumeBtn.focus();
    const before = clicked.mock.calls.length;
    pressEscape();
    expect(clicked.mock.calls.length).toBe(before + 1);
  });
});
