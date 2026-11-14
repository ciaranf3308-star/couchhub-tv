/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§24) — withPreservedListFocus: grid re-renders keep
// focus on the same control, or the same card, and never steal it.

import { describe, it, expect, beforeEach } from "vitest";
import { withPreservedListFocus } from "@/scripts/lib/couch-list-focus";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("withPreservedListFocus", () => {
  it("restores the exact control after a wholesale re-render", () => {
    document.body.innerHTML = `
      <div id="grid">
        <button id="b1" data-couch-key="movie:1:play">Play 1</button>
        <button id="b2" data-couch-key="movie:2:play">Play 2</button>
      </div>`;
    const grid = document.getElementById("grid") as HTMLElement;
    (document.getElementById("b2") as HTMLElement).focus();
    const result = withPreservedListFocus(document, [grid], () => {
      grid.innerHTML = `
        <button id="n1" data-couch-key="movie:1:play">Play 1</button>
        <button id="n2" data-couch-key="movie:2:play">Play 2</button>`;
      return "done";
    });
    expect(result).toBe("done");
    expect((document.activeElement as HTMLElement).id).toBe("n2");
  });

  it("falls back to the same card's first surviving control", () => {
    document.body.innerHTML = `
      <div id="grid">
        <button id="b1" data-couch-key="movie:2:play">Play</button>
        <button id="b2" data-couch-key="movie:2:info">Info</button>
      </div>`;
    const grid = document.getElementById("grid") as HTMLElement;
    (document.getElementById("b2") as HTMLElement).focus();
    withPreservedListFocus(document, [grid], () => {
      grid.innerHTML = `<button id="n1" data-couch-key="movie:2:play">Play</button>`;
    });
    expect((document.activeElement as HTMLElement).id).toBe("n1");
  });

  it("never steals focus from a live element, and ignores focus outside the containers", () => {
    document.body.innerHTML = `
      <div id="grid"><button id="b1" data-couch-key="movie:1:play">Play</button></div>
      <button id="outside">Outside</button>`;
    const grid = document.getElementById("grid") as HTMLElement;
    (document.getElementById("outside") as HTMLElement).focus();
    withPreservedListFocus(document, [grid], () => {
      grid.innerHTML = `<button id="n1" data-couch-key="movie:1:play">Play</button>`;
    });
    expect((document.activeElement as HTMLElement).id).toBe("outside");
  });

  it("restores focus even when the mutation throws, and rethrows", () => {
    document.body.innerHTML = `
      <div id="grid"><button id="b1" data-couch-key="movie:1:play">Play</button></div>`;
    const grid = document.getElementById("grid") as HTMLElement;
    (document.getElementById("b1") as HTMLElement).focus();
    expect(() =>
      withPreservedListFocus(document, [grid], () => {
        grid.innerHTML = `<button id="n1" data-couch-key="movie:1:play">Play</button>`;
        throw new Error("render failed");
      }),
    ).toThrow("render failed");
    expect((document.activeElement as HTMLElement).id).toBe("n1");
  });
});
