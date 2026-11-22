/**
 * @vitest-environment jsdom
 */
// W5 — Controller Experience 2.0 (0.11.10) §34: Settings search Back
// hierarchy, one step per press (merged coordinator semantics):
//   1. B/Escape while a keyboard session is open closes the session
//      (Contract E — the keyboard layer owns the press, as on every
//      screen; Settings mounts no OSK grid, so the session is
//      grid-less and closing it only releases the hints override).
//   2. Escape with text clears ONLY the text (input keeps focus) —
//      the input's own keydown handler, reached once no session is
//      open (the coordinator falls through to the migration bridge,
//      which dispatches the Escape to the focused input).
//   3. B with an empty input while editing exits search and restores
//      the previously focused setting (editing layer).
//   4. B with an unfocused, non-empty search clears the search and
//      restores the previous focus (active-search layer).
// Y focuses the input; Enter commits to the first result. There is
// no trailing-Escape window in the merged tree: the coordinator
// resolves each press exactly once, so no second Escape exists to
// swallow — a press after leaving the input to nowhere closes the
// keyboard session and the query survives.
// Back presses go through resolveBack(): jsdom events are
// untrusted and never reach the coordinator's capture listener.
//
// 0.11.24: the jump-to menu the search used to filter is gone — the
// fixture mirrors the new page: a .settings-stack of section cards
// plus the relocated Exit action row. Search marks the cards (and
// the Exit row) in place; the rail is never filtered.
import { describe, it, expect, beforeAll } from "vitest"
import { resolveBack } from "../src/scripts/lib/back-handler"
import { isCouchKeyboardOpen } from "../src/scripts/lib/couch-keyboard"

const INPUT_ID = "settings-search-input"

function buildFixture(): {
  input: HTMLInputElement
  rows: HTMLButtonElement[]
  cards: HTMLElement[]
  exitRow: HTMLElement
  clearBtn: HTMLButtonElement
} {
  document.body.innerHTML = `
    <div class="settings-search">
      <input id="${INPUT_ID}" type="search" value="" />
      <button id="settings-search-clear" type="button" hidden>Clear</button>
      <p id="settings-search-empty" hidden>No results</p>
      <div id="settings-search-xpage" hidden></div>
    </div>
    <div class="settings-stack">
      <div id="settings-exit-row" data-search-text="exit quit the app completely.">
        <div data-settings-item><button type="button">Exit</button></div>
      </div>
      <section class="settings-group" id="playlists">
        <h2 class="settings-group__title">Playlists</h2>
        <div data-settings-item><button type="button">Add playlist</button><p>m3u xtream sources</p></div>
      </section>
      <section class="settings-group" id="display">
        <h2 class="settings-group__title">Display</h2>
        <div data-settings-item><button type="button">Font scale</button><p>display font scale density</p></div>
      </section>
      <section class="settings-group" id="playback">
        <h2 class="settings-group__title">Playback</h2>
        <div data-settings-item><button type="button">Player</button><p>playback player audio captions</p></div>
      </section>
    </div>
  `
  const input = document.getElementById(INPUT_ID) as HTMLInputElement
  const cards = [...document.querySelectorAll<HTMLElement>("section [data-settings-item]")]
  const rows = cards.map(
    (card) => card.querySelector("button") as HTMLButtonElement,
  )
  const exitRow = document.getElementById("settings-exit-row") as HTMLElement
  const clearBtn = document.getElementById(
    "settings-search-clear",
  ) as HTMLButtonElement
  return { input, rows, cards, exitRow, clearBtn }
}

function keydown(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe("settings search (§34)", () => {
  let input: HTMLInputElement
  let rows: HTMLButtonElement[]
  let cards: HTMLElement[]
  let exitRow: HTMLElement

  beforeAll(async () => {
    // The module wires itself on import; the fixture must exist first.
    // Point jsdom at /settings first: applyPageFilter drops cross-page
    // hits whose path is the current page, and on the real page the
    // path is /settings — without this the index hits leak into the
    // (normally empty) xpage box and steal Enter focus.
    window.history.replaceState({}, "", "/settings")
    const fixture = buildFixture()
    input = fixture.input
    rows = fixture.rows
    cards = fixture.cards
    exitRow = fixture.exitRow
    await import("../src/scripts/settings/settings_search")
  })

  it("Y focuses the input from a setting row", () => {
    rows[0].focus()
    expect(document.activeElement).toBe(rows[0])
    keydown(rows[0], "y")
    expect(document.activeElement).toBe(input)
  })

  it("Escape with text clears only the text; input keeps focus", () => {
    input.focus()
    // "m3u" matches only the Playlists card ("play" would also
    // match "display").
    input.value = "m3u"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(cards[0].dataset.search).toBe("match")
    expect(cards[1].dataset.search).toBe("miss")

    const event = keydown(input, "Escape")
    expect(event.defaultPrevented).toBe(true)
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
    expect(cards[1].dataset.search).toBeUndefined()
  })

  it("B with an empty input while editing closes the keyboard, then exits search and restores previous focus", () => {
    rows[1].focus()
    input.focus()
    expect(input.value).toBe("")
    expect(isCouchKeyboardOpen()).toBe(true)
    // First press: the keyboard layer closes the session; focus
    // returns to the input (the close-refocus contract) and the
    // search is untouched.
    expect(resolveBack()).toBe(true)
    expect(isCouchKeyboardOpen()).toBe(false)
    expect(document.activeElement).toBe(input)
    // Second press: the editing layer exits search and restores
    // the setting focused before search was entered.
    expect(resolveBack()).toBe(true)
    expect(document.activeElement).toBe(rows[1])
    expect(input.value).toBe("")
  })

  it("B with an unfocused non-empty search clears it without moving focus", () => {
    rows[2].focus()
    input.focus()
    input.value = "display"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    rows[1].focus()
    expect(document.activeElement).toBe(rows[1])
    // Blur to a real element ends the keyboard session silently,
    // so the active-search layer owns the press outright.
    expect(isCouchKeyboardOpen()).toBe(false)
    expect(resolveBack()).toBe(true)
    expect(input.value).toBe("")
    // Focus was already on a live setting row; exiting search
    // leaves it there and un-filters the list.
    expect(document.activeElement).toBe(rows[1])
    expect(cards[0].dataset.search).toBeUndefined()
  })

  it("Enter in the input commits to the first matching row", () => {
    input.focus()
    input.value = "playback"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    keydown(input, "Enter")
    expect(document.activeElement).toBe(rows[2])
  })

  it("Enter with an 'exit' query commits to the Exit action row", () => {
    input.focus()
    input.value = "exit"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(exitRow.dataset.search).toBe("match")
    expect(cards[0].dataset.search).toBe("miss")
    keydown(input, "Enter")
    expect(document.activeElement).toBe(
      exitRow.querySelector("button"),
    )
    // Clean up for later tests in this file.
    input.value = ""
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

  it("B after leaving the input to nowhere closes the keyboard; the query survives", () => {
    input.focus()
    input.value = "play"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }))
    input.blur()
    expect(document.activeElement).toBe(document.body)
    // Blur to nowhere keeps the session: the keyboard layer owns
    // the press, so B closes the session (focus returns to the
    // input per the close-refocus contract) and the query and
    // the filter survive — no page step, no clear.
    expect(isCouchKeyboardOpen()).toBe(true)
    expect(resolveBack()).toBe(true)
    expect(isCouchKeyboardOpen()).toBe(false)
    expect(input.value).toBe("play")
    expect(document.activeElement).toBe(input)
    // "play" matches every card (Display contains "play"), so the
    // filter surviving means the cards stay marked as matches.
    expect(cards[1].dataset.search).toBe("match")
    // Clean up for later tests in this file.
    input.value = ""
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
})
