/**
 * @vitest-environment jsdom
 */
// W5 — Controller Experience 2.0 (0.11.10) §34: Settings search Back
// hierarchy, one step per press:
//   1. Escape with text clears ONLY the text (input keeps focus).
//   2. Escape/B with an empty input while editing exits search and
//      restores the previously focused setting.
//   3. Escape/B with an unfocused, non-empty search clears the
//      search and restores the previous focus.
// Y focuses the input; Enter commits to the first result. The
// trailing Escape after leaving the input is swallowed, never a
// page step.
import { describe, it, expect, beforeAll } from "vitest"

const INPUT_ID = "settings-search-input"

function buildFixture(): {
  input: HTMLInputElement
  rows: HTMLElement[]
  clearBtn: HTMLButtonElement
} {
  document.body.innerHTML = `
    <div class="settings-search">
      <input id="${INPUT_ID}" type="search" value="" />
      <button id="settings-search-clear" type="button" hidden>Clear</button>
      <p id="settings-search-empty" hidden>No results</p>
      <div id="settings-search-xpage" hidden></div>
    </div>
    <div id="settings-home-list">
      <a class="settings-home-row" href="/settings/playlists" data-search-text="playlists sources xtream m3u">Playlists</a>
      <a class="settings-home-row" href="/settings/display" data-search-text="display font scale density">Display</a>
      <a class="settings-home-row" href="/settings/playback" data-search-text="playback player audio captions">Playback</a>
    </div>
  `
  const input = document.getElementById(INPUT_ID) as HTMLInputElement
  const rows = [...document.querySelectorAll<HTMLElement>(".settings-home-row")]
  const clearBtn = document.getElementById(
    "settings-search-clear",
  ) as HTMLButtonElement
  return { input, rows, clearBtn }
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
  let rows: HTMLElement[]

  beforeAll(async () => {
    // The module wires itself on import; the fixture must exist first.
    const fixture = buildFixture()
    input = fixture.input
    rows = fixture.rows
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
    // "m3u" matches only the Playlists row ("play" would also
    // match "display").
    input.value = "m3u"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(rows[0].dataset.search).toBe("match")
    expect(rows[1].dataset.search).toBe("miss")

    const event = keydown(input, "Escape")
    expect(event.defaultPrevented).toBe(true)
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
    expect(rows[1].dataset.search).toBeUndefined()
  })

  it("Escape with an empty input while editing exits search and restores previous focus", () => {
    rows[1].focus()
    input.focus()
    expect(input.value).toBe("")
    keydown(input, "Escape")
    expect(document.activeElement).toBe(rows[1])
    expect(input.value).toBe("")
  })

  it("Escape with an unfocused non-empty search clears it without moving focus", async () => {
    rows[2].focus()
    input.focus()
    input.value = "display"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    rows[1].focus()
    expect(document.activeElement).toBe(rows[1])
    // Leaving the input starts the 500ms trailing-Escape window;
    // a B press right after navigating away is swallowed by
    // design, so wait it out like a real second press would.
    await new Promise((resolve) => setTimeout(resolve, 600))
    keydown(rows[1], "Escape")
    expect(input.value).toBe("")
    // Focus was already on a live setting row; exiting search
    // leaves it there and un-filters the list.
    expect(document.activeElement).toBe(rows[1])
    expect(rows[0].dataset.search).toBeUndefined()
  })

  it("Enter in the input commits to the first matching row", () => {
    input.focus()
    input.value = "playback"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    keydown(input, "Enter")
    expect(document.activeElement).toBe(rows[2])
  })

  it("the trailing Escape after leaving the input is swallowed", () => {
    input.focus()
    input.value = "play"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }))
    input.blur()
    expect(document.activeElement).toBe(document.body)
    keydown(document.body, "Escape")
    // The swallow is silent: nothing ran — the query survives, the
    // active-search layer did not clear it, focus stays put.
    expect(input.value).toBe("play")
    expect(document.activeElement).toBe(document.body)
    // Clean up for later tests in this file.
    input.value = ""
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
})
