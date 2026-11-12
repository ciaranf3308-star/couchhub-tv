/**
 * @vitest-environment jsdom
 */
// Controller 2.0 (0.11.10), W2 — Movie detail Back wiring (§18):
// B with the player CLOSED performs the Back button's navigation.
// The page module is imported with fixtures in place and creds /
// i18n mocked (no network, no playlist); the detail load exits
// early (no ?id=) so only the navigation wiring is exercised.
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

function buildFixture(): { backLink: HTMLAnchorElement; moreBtn: HTMLButtonElement } {
  document.body.innerHTML = `
    <a id="movie-detail-back" href="/movies">‹ Movies</a>
    <div id="movie-detail-skeleton"></div>
    <section id="movie-detail-hero" hidden>
      <div id="movie-detail-backdrop"></div>
      <h1 id="movie-detail-title"></h1>
      <div id="movie-detail-meta"></div>
      <p id="movie-detail-plot"></p>
      <div id="movie-detail-poster"></div>
      <div id="movie-detail-progress" hidden></div>
      <button id="movie-detail-play" type="button"><span id="movie-detail-play-label">Play</span><span id="movie-detail-play-sub"></span></button>
      <button id="movie-detail-fav" type="button">Favourite</button>
      <button id="movie-detail-watch" type="button">Watch Later</button>
      <button id="movie-detail-trailer" type="button" hidden>Trailer</button>
      <button id="movie-detail-more" type="button">More</button>
    </section>
    <p id="movie-detail-status"></p>
    <div id="movie-detail-player-wrap" hidden><video id="movie-player"></video></div>
    <section id="movie-detail-variants" hidden><div id="movie-detail-variants-list"></div></section>
    <section id="movie-detail-cast" hidden><div id="movie-detail-cast-list"></div></section>
    <section id="movie-detail-similar" hidden><div id="movie-detail-similar-list"></div></section>
    <dialog id="movie-trailer-dialog"><iframe id="movie-detail-trailer-frame"></iframe></dialog>
  `;
  return {
    backLink: document.getElementById("movie-detail-back") as HTMLAnchorElement,
    moreBtn: document.getElementById("movie-detail-more") as HTMLButtonElement,
  };
}

describe("movie detail Back (player closed)", () => {
  let backLink: HTMLAnchorElement;
  let moreBtn: HTMLButtonElement;
  const clicked = vi.fn();

  beforeAll(async () => {
    const fixture = buildFixture();
    backLink = fixture.backLink;
    moreBtn = fixture.moreBtn;
    backLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      clicked();
    });
    await import("@/scripts/movies/couch-detail.ts");
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

  it("B performs the Back button navigation without focus on the button", () => {
    expect(document.activeElement).not.toBe(backLink);
    pressEscape();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("X opens the More options surface while browsing", () => {
    const moreClicked = vi.fn();
    moreBtn.addEventListener("click", moreClicked);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
    );
    expect(moreClicked).toHaveBeenCalledTimes(1);
  });

  it("B does not navigate while a dialog owns input", () => {
    const dlg = document.getElementById("movie-trailer-dialog") as HTMLDialogElement;
    dlg.setAttribute("open", "");
    const before = clicked.mock.calls.length;
    pressEscape();
    expect(clicked.mock.calls.length).toBe(before);
    dlg.removeAttribute("open");
  });
});
