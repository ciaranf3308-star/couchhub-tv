/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§4) — focus glide: the ring hides when its target
// scrolls fully out of the viewport, and reappears when a scroll
// brings the target back — never a stale ring over other content.

import { describe, it, expect, beforeAll } from "vitest";
import { initFocusGlide } from "@/scripts/lib/focus-glide";

function stubRect(el: Element, top: number, left: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top,
      bottom: top + 40,
      left,
      right: left + 100,
      width: 100,
      height: 40,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

function indicator(): HTMLElement | null {
  return document.querySelector(".xt-focus-glide");
}

describe("focus glide offscreen behaviour", () => {
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    initFocusGlide();
  });

  it("shows the ring for an onscreen target, hides it offscreen, re-shows on scroll-back", async () => {
    document.body.innerHTML = `<button id="t">Target</button>`;
    const target = document.getElementById("t") as HTMLElement;
    stubRect(target, 100, 100);
    target.focus();
    await flush();
    expect(indicator()?.dataset.visible).toBe("true");

    // Scrolled fully above the viewport.
    stubRect(target, -100, 100);
    window.dispatchEvent(new Event("scroll"));
    await flush();
    expect(indicator()?.dataset.visible).toBe("false");

    // Scrolled back into view: the ring returns without a new focus move.
    stubRect(target, 200, 100);
    window.dispatchEvent(new Event("scroll"));
    await flush();
    expect(indicator()?.dataset.visible).toBe("true");
  });
});
