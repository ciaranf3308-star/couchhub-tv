// @vitest-environment jsdom
// Regression test for the v0.2.1 modal navigation trap (Nylah Studios):
// with a modal dialog open, D-pad / arrow input must stay inside the
// dialog — it must never fall through to the home rails behind it.
// What this covers is the contract the gamepad layer relies on:
// findOpenModal() detects an open modal, and modalFocusTarget() names
// the element stray focus must be pulled to (or null when navigation
// may proceed inside the dialog). The spatial-nav section trapping
// itself belongs to dialog-spatial-nav.ts, which every dialog in the
// app already uses; the picker and keyboard-help dialog were the two
// surfaces that never registered one.
import { describe, it, expect, beforeEach } from "vitest"
import {
  findOpenModal,
  firstFocusableInModal,
} from "../src/scripts/lib/dialog-spatial-nav.ts"
import { modalFocusTarget } from "../src/scripts/lib/gamepad.ts"

// jsdom has no layout engine, so every element reports an empty client
// rect: stub a box onto the elements the test treats as visible.
function makeVisible(el: HTMLElement): void {
  Object.defineProperty(el, "getClientRects", {
    value: () =>
      [
        {
          width: 100,
          height: 40,
          top: 0,
          left: 0,
          right: 100,
          bottom: 40,
          x: 0,
          y: 0,
        },
      ] as unknown as DOMRectList,
    configurable: true,
  })
}

function renderPage(): {
  picker: HTMLElement
  railCard: HTMLElement
} {
  document.body.innerHTML = `
    <section data-nylah-rail="continue-watching">
      <a href="/watch/1" data-nylah-item>Card one</a>
      <a href="/watch/2" data-nylah-item>Card two</a>
    </section>
    <div data-profile-picker data-nylah-dialog hidden>
      <button type="button" data-profile-pick="ciaran">Ciaran</button>
      <button type="button" data-profile-pick="aisling">Aisling</button>
      <button type="button" data-profile-pick="shared">Everyone</button>
      <button type="button" data-profile-pick-later>Ask me later</button>
    </div>
  `
  const picker = document.querySelector<HTMLElement>("[data-profile-picker]")!
  const railCard = document.querySelector<HTMLElement>("[data-nylah-item]")!
  return { picker, railCard }
}

describe("modal navigation trap", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("finds no modal when the picker is hidden", () => {
    const { picker } = renderPage()
    makeVisible(picker)
    expect(findOpenModal()).toBeNull()
    expect(modalFocusTarget()).toBeNull()
  })

  it("finds the picker once shown, and pulls stray focus into it", () => {
    const { picker, railCard } = renderPage()
    picker.hidden = false
    makeVisible(picker)
    picker.querySelectorAll("button").forEach(makeVisible)
    expect(findOpenModal()).toBe(picker)
    // Focus sitting on a rail card behind the dialog: navigation
    // must be pulled into the dialog, not left on the rail.
    railCard.focus()
    expect(modalFocusTarget()).toBe(
      picker.querySelector('[data-profile-pick="ciaran"]'),
    )
  })

  it("lets navigation proceed once focus is inside the dialog", () => {
    const { picker } = renderPage()
    picker.hidden = false
    makeVisible(picker)
    picker.querySelectorAll("button").forEach(makeVisible)
    const first = picker.querySelector<HTMLElement>(
      '[data-profile-pick="ciaran"]',
    )!
    first.focus()
    expect(modalFocusTarget()).toBeNull()
  })

  it("finds a native <dialog open> and ignores a closed one", () => {
    document.body.innerHTML = `
      <dialog id="a"><button>One</button></dialog>
      <dialog id="b" open><button>Two</button></dialog>
    `
    const b = document.querySelector<HTMLElement>("#b")!
    makeVisible(b)
    expect(findOpenModal()).toBe(b)
  })

  it("returns the topmost modal when several are open", () => {
    document.body.innerHTML = `
      <div data-nylah-dialog><button>First</button></div>
      <div data-nylah-dialog><button>Second</button></div>
    `
    document
      .querySelectorAll<HTMLElement>("[data-nylah-dialog]")
      .forEach(makeVisible)
    const modals = document.querySelectorAll("[data-nylah-dialog]")
    expect(findOpenModal()).toBe(modals[1])
  })

  it("firstFocusableInModal skips disabled buttons", () => {
    document.body.innerHTML = `
      <div data-nylah-dialog>
        <button disabled>Off</button>
        <button>On</button>
      </div>
    `
    const modal = document.querySelector<HTMLElement>("[data-nylah-dialog]")!
    makeVisible(modal)
    modal.querySelectorAll("button").forEach(makeVisible)
    expect(firstFocusableInModal(modal)?.textContent).toBe("On")
  })
})
