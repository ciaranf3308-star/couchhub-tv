// Settings search, single-page edition (0.11.23; jump grid removed
// in 0.11.24).
//
// Settings is one page now, so search filters IN PLACE — nothing ever
// yanks the view to the top — across both layers at once:
//
//  * Every section's own [data-settings-item] rows (same AND-token
//    index as before), so matching cards stay visible in place while
//    the rest of the page hides.
//  * The Exit action row at the top of the page: it carries
//    data-search-text ("exit quit the app completely.") and is filtered
//    the same way, so a query that doesn't match it hides it.
//  * The cross-page hits box from the split era stays wired but empty:
//    every index hit is a same-page anchor now, so it filters itself
//    out — the in-place matches above are the results.
//
// The old scroll-spy/nav-link miss marking is gone with the spy: the
// section nav is anchor-based now and always stays usable while searching.
// (0.11.24: the jump-to menu the search used to filter is gone — the
// rail is the one navigation and is never filtered.)

import { LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { searchSettingsIndex } from "@/scripts/settings/settings-index.ts"
import {
  registerBackLayer,
  BACK_PRIORITY,
} from "@/scripts/lib/back-handler.js"
import {
  COUCH_KEYBOARD_CLOSED_EVENT,
  openCouchKeyboard,
  closeCouchKeyboard,
  endCouchKeyboardSession,
} from "@/scripts/lib/couch-keyboard.js"
import { setControllerHints } from "@/scripts/lib/couch-button-hints.js"
import { isTitleContextMenuOpen } from "@/scripts/lib/poster-menu.js"
import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.js"

const INPUT_ID = "settings-search-input"
const CLEAR_ID = "settings-search-clear"
const EMPTY_ID = "settings-search-empty"
const XPAGE_ID = "settings-search-xpage"
const EXIT_ROW_ID = "settings-exit-row"

interface CardEntry {
  card: HTMLElement
  key: string
}
interface SectionEntry {
  section: HTMLElement
  cards: CardEntry[]
}

let sections: SectionEntry[] = []
const indexByCardKey = new Map<string, string>()

function findCardsInSection(section: HTMLElement): HTMLElement[] {
  const candidates = section.querySelectorAll<HTMLElement>(
    "[data-settings-item], article, details.changelog-outer"
  )
  const cards: HTMLElement[] = []
  for (const candidate of candidates) {
    const hasAncestorCard = cards.some((existing) => existing.contains(candidate))
    if (!hasAncestorCard) cards.push(candidate)
  }
  return cards
}

function buildStructure(stack: HTMLElement): void {
  sections = []
  const sectionEls = stack.querySelectorAll<HTMLElement>(
    "section.settings-group[id]"
  )
  for (const section of sectionEls) {
    const cardEls = findCardsInSection(section)
    const cards: CardEntry[] = cardEls.map((card, index) => ({
      card,
      key: card.id || `${section.id}__card-${index}`,
    }))
    sections.push({ section, cards })
  }
}

function buildIndex(): void {
  indexByCardKey.clear()
  for (const sectionEntry of sections) {
    const heading = sectionEntry.section.querySelector(".settings-group__title")
    const sectionTitle = heading?.textContent ?? ""
    if (sectionEntry.cards.length === 0) {
      const text = `${sectionTitle} ${sectionEntry.section.textContent ?? ""}`
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim()
      indexByCardKey.set(`${sectionEntry.section.id}__self`, text)
      continue
    }
    for (const cardEntry of sectionEntry.cards) {
      const text = `${sectionTitle} ${cardEntry.card.textContent ?? ""}`
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim()
      indexByCardKey.set(cardEntry.key, text)
    }
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function applyPageFilter(
  query: string,
  stack: HTMLElement,
  xpageEl: HTMLElement | null
): { visibleCount: number; xpageCount: number } {
  const tokens = tokenize(query)
  const active = tokens.length > 0

  if (active) stack.setAttribute("data-search-active", "true")
  else stack.removeAttribute("data-search-active")

  if (!active) {
    for (const sectionEntry of sections) {
      delete sectionEntry.section.dataset.search
      for (const cardEntry of sectionEntry.cards) {
        delete cardEntry.card.dataset.search
      }
    }
    // Search cleared: every section head comes back with its section.
    for (const head of stack.querySelectorAll<HTMLElement>(".settings-section-head")) {
      head.style.display = ""
    }
    if (xpageEl) {
      xpageEl.hidden = true
      xpageEl.replaceChildren()
    }
    return { visibleCount: 0, xpageCount: 0 }
  }

  let visibleCount = 0
  for (const sectionEntry of sections) {
    let sectionHasMatch = false

    if (sectionEntry.cards.length === 0) {
      const indexText = indexByCardKey.get(`${sectionEntry.section.id}__self`) ?? ""
      sectionHasMatch = tokens.every((token) => indexText.includes(token))
      if (sectionHasMatch) visibleCount++
    } else {
      for (const cardEntry of sectionEntry.cards) {
        const { card } = cardEntry
        if (card.classList.contains("hidden")) {
          delete card.dataset.search
          continue
        }
        const indexText = indexByCardKey.get(cardEntry.key) ?? ""
        const matches = tokens.every((token) => indexText.includes(token))
        card.dataset.search = matches ? "match" : "miss"
        if (matches) {
          sectionHasMatch = true
          visibleCount++
          if (card instanceof HTMLDetailsElement) card.open = true
        }
      }
    }

    sectionEntry.section.dataset.search = sectionHasMatch ? "match" : "miss"
  }

  // Section heads are not sections themselves: a head with no matching
  // section below it (up to the next head — Help has two sections)
  // would be an orphan, so hide it alongside its sections.
  for (const head of stack.querySelectorAll<HTMLElement>(".settings-section-head")) {
    let el: Element | null = head.nextElementSibling
    let anyVisible = false
    while (el && !el.classList.contains("settings-section-head")) {
      if (el instanceof HTMLElement && el.tagName === "SECTION" && el.dataset.search !== "miss") {
        anyVisible = true
        break
      }
      el = el.nextElementSibling
    }
    head.style.display = anyVisible ? "" : "none"
  }

  // Cross-page hits (0.11.23: Settings is one page, so every index hit
  // is a same-page anchor — the filter below yields none and the box
  // stays hidden; in-place filtering above already shows the matches.
  // The block stays so a future split page gets its hits back for free.)
  let xpageCount = 0
  if (xpageEl) {
    xpageEl.replaceChildren()
    const here = window.location.pathname.replace(/\/+$/, "") || "/"
    const hits = searchSettingsIndex(query).filter(
      (hit) => hit.href.split("#")[0] !== here
    )
    xpageCount = hits.length
    if (hits.length > 0) {
      const label = document.createElement("div")
      label.className = "settings-xpage__label"
      label.textContent = "Also in other sections"
      xpageEl.appendChild(label)
      for (const hit of hits) {
        const a = document.createElement("a")
        a.className = "settings-xpage__hit"
        a.href = hit.href
        const name = document.createElement("span")
        name.textContent = hit.label
        const where = document.createElement("span")
        where.className = "settings-xpage__hit-section"
        where.textContent = hit.sectionTitle
        a.append(name, where)
        xpageEl.appendChild(a)
      }
      const all = document.createElement("a")
      all.className = "settings-xpage__hit"
      all.href = `/settings?q=${encodeURIComponent(query)}`
      const allName = document.createElement("span")
      allName.textContent = "See all results in All settings"
      all.appendChild(allName)
      xpageEl.appendChild(all)
      xpageEl.hidden = false
    } else {
      xpageEl.hidden = true
    }
  }

  return { visibleCount, xpageCount }
}

// The Exit action row at the top of the page (0.11.24: the jump-to
// menu it used to sit in is gone). Same AND-token match against its
// data-search-text; the row hides in place when it misses, like every
// card. Returns 1 when the row counts as a visible result.
function applyExitFilter(
  query: string,
  row: HTMLElement | null
): number {
  if (!row) return 0
  const tokens = tokenize(query)
  const active = tokens.length > 0
  if (!active) {
    delete row.dataset.search
    return 1
  }
  const hay = (row.dataset.searchText ?? "").toLowerCase()
  const matches = tokens.every((token) => hay.includes(token))
  row.dataset.search = matches ? "match" : "miss"
  return matches ? 1 : 0
}

function init(): void {
  const input = document.getElementById(INPUT_ID) as HTMLInputElement | null
  const clearBtn = document.getElementById(CLEAR_ID) as HTMLButtonElement | null
  const emptyEl = document.getElementById(EMPTY_ID)
  const xpageEl = document.getElementById(XPAGE_ID)
  if (!input) return

  const exitRow = document.getElementById(EXIT_ROW_ID)
  const stack = document.querySelector<HTMLElement>(".settings-stack")
  // Single page (0.11.23): all sections live on this page, so search
  // filters the cards in place — plus the Exit action row at the top —
  // with one shared empty state.
  if (stack) {
    buildStructure(stack)
    buildIndex()
  }

  const apply = (): void => {
    const active = tokenize(input.value).length > 0
    let visible = 0
    let xpage = 0
    if (stack) {
      const page = applyPageFilter(input.value, stack, xpageEl)
      visible += page.visibleCount
      xpage += page.xpageCount
    }
    visible += applyExitFilter(input.value, exitRow)
    if (emptyEl) emptyEl.hidden = !active || visible > 0 || xpage > 0
  }
  const syncClearVisibility = (): void => {
    if (clearBtn) clearBtn.hidden = input.value.length === 0
  }

  // ── Controller Experience 2.0 (§34) ──────────────────────────────
  // Back hierarchy for search, one step per press:
  //   1. Escape with text in the input clears ONLY the text (the
  //      input's own keydown handler below, which preventDefaults —
  //      the Back dispatcher skips default-prevented presses, so
  //      one press never clears text AND leaves the page).
  //   2. Escape/B with an empty input while editing exits search
  //      and restores the setting focused before search was
  //      entered (editing layer). The gamepad path blurs the field
  //      and resolves Back through the coordinator, whose keyboard
  //      layer owns the press, so B exits editing without
  //      navigating.
  //   3. B with a query but focus elsewhere clears the query and
  //      restores the previous setting focus (active-search layer).
  //   4. Then the shell's section/home layers navigate normally.
  // Y focuses the search input: the gamepad layer dispatches the
  // "y" key first and this handler claims it, so controller Y
  // reaches Settings search instead of the global goSearch
  // fallback. Enter in the input commits to the first result.
  let lastNonSearchFocus: HTMLElement | null = null
  document.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement | null
    if (!target || target === input) return
    if (target === clearBtn) return
    if (target.closest?.("#settings-search-xpage")) return
    lastNonSearchFocus = target
  })

  const restorePreviousFocus = (): void => {
    if (lastNonSearchFocus && lastNonSearchFocus.isConnected) {
      lastNonSearchFocus.focus({ preventScroll: true })
      try {
        lastNonSearchFocus.scrollIntoView({ block: "nearest", inline: "nearest" })
      } catch {
        // Scroll failure never blocks the focus restore.
      }
    } else {
      input.blur()
    }
  }

  const focusFirstResult = (): void => {
    const firstHit = xpageEl?.querySelector<HTMLElement>("a.settings-xpage__hit")
    if (firstHit) {
      firstHit.focus({ preventScroll: true })
      return
    }
    // The Exit action row is the first result on the page when the
    // active query matches it — but only then: with no query (or a
    // miss) Enter must land on a real setting, never on Exit.
    if (exitRow && input.value.trim() && exitRow.dataset.search === "match") {
      const exitBtn = exitRow.querySelector<HTMLElement>("button:not([disabled])")
      if (exitBtn) {
        exitBtn.focus({ preventScroll: true })
        return
      }
    }
    const controls = stack?.querySelectorAll<HTMLElement>(
      "[data-settings-item]:not([data-search='miss']) a[href], " +
        "[data-settings-item]:not([data-search='miss']) button:not([disabled]), " +
        "[data-settings-item]:not([data-search='miss']) input:not([disabled]), " +
        "[data-settings-item]:not([data-search='miss']) select:not([disabled])",
    )
    // The Exit card itself carries data-settings-item, so its button
    // is the first control in DOM order — skip anything inside the
    // exit row here; the branch above owns it.
    const firstControl = [...(controls ?? [])].find(
      (el) => !el.closest("#settings-exit-row"),
    )
    firstControl?.focus({ preventScroll: true })
  }

  const exitSearch = (): void => {
    input.value = ""
    syncClearVisibility()
    apply()
    closeCouchKeyboard(false)
    restorePreviousFocus()
  }

  // Reopen suppression: closeCouchKeyboard re-focuses the input,
  // and the focus handler would immediately reopen the session —
  // B could never exit editing. The closed event fires before the
  // refocus, so it arms a one-shot suppress for the next focus.
  let suppressKeyboardReopen = false
  input.addEventListener(COUCH_KEYBOARD_CLOSED_EVENT, () => {
    suppressKeyboardReopen = true
    // Expire at the end of the task: the refocus (if it fires a
    // focus event at all — none fires when the input was already
    // focused) is synchronous inside closeCouchKeyboard, so a
    // lingering flag must never eat a later, deliberate focus.
    queueMicrotask(() => {
      suppressKeyboardReopen = false
    })
  })
  input.addEventListener("focus", () => {
    if (suppressKeyboardReopen) {
      suppressKeyboardReopen = false
      return
    }
    openCouchKeyboard(input, focusFirstResult)
  })
  input.addEventListener("blur", (event) => {
    // Blur to nowhere (gamepad B) keeps the session: the keyboard
    // Back layer owns that press. Blur to a real element ends it
    // silently (closeCouchKeyboard would refocus the input and
    // fight the focus move) and releases the hints override.
    const next = (event as FocusEvent).relatedTarget
    if (!(next instanceof Element)) return
    endCouchKeyboardSession()
    setControllerHints(null)
  })

  registerBackLayer({
    id: "settings-search-editing",
    priority: BACK_PRIORITY.KEYBOARD,
    isActive: () =>
      document.activeElement === input &&
      input.value === "" &&
      !findOpenModal() &&
      !isTitleContextMenuOpen(),
    handle: () => {
      exitSearch()
      return true
    },
  })
  registerBackLayer({
    id: "settings-search-active",
    priority: BACK_PRIORITY.DRAWER,
    isActive: () =>
      document.activeElement !== input &&
      input.value !== "" &&
      !findOpenModal() &&
      !isTitleContextMenuOpen(),
    handle: () => {
      exitSearch()
      return true
    },
  })

  document.addEventListener("keydown", (event) => {
    if (event.key !== "y" && event.key !== "Y") return
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target as Element | null
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return
    }
    if (findOpenModal() || isTitleContextMenuOpen()) return
    event.preventDefault()
    input.focus()
    input.select()
  })

  let reindexQueued = false
  const scheduleReindex = (): void => {
    if (reindexQueued) return
    reindexQueued = true
    requestAnimationFrame(() => {
      reindexQueued = false
      buildIndex()
      if (input.value) apply()
    })
  }
  if (stack) {
    try {
      const hydrationObserver = new MutationObserver(scheduleReindex)
      hydrationObserver.observe(stack, { childList: true, subtree: true })
      window.setTimeout(() => {
        try { hydrationObserver.disconnect() } catch {}
      }, 3000)
    } catch {
      window.setTimeout(buildIndex, 600)
    }
  }

  input.addEventListener("input", () => {
    syncClearVisibility()
    apply()
  })

  clearBtn?.addEventListener("click", () => {
    input.value = ""
    syncClearVisibility()
    apply()
    input.focus()
  })

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      closeCouchKeyboard(true)
      return
    }
    if (event.key === "Escape" && input.value) {
      // Clear text ONLY — preventDefault keeps the Back dispatcher
      // from also treating this press as a navigation step.
      event.preventDefault()
      input.value = ""
      syncClearVisibility()
      apply()
    }
  })

  // Global `/` focuses the search input when the user is not already typing
  // somewhere else. Doesn't fight Ctrl+F / Cmd+F - the browser keeps those.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
    const target = event.target as Element | null
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return
    }
    event.preventDefault()
    input.focus()
    input.select()
  })

  document.addEventListener(LOCALE_EVENT, () => {
    buildIndex()
    if (input.value) apply()
  })

  // Deep-link a query (?q=) from a section page's "See all results" link.
  try {
    const q = new URLSearchParams(window.location.search).get("q")
    if (q && !input.value) {
      input.value = q
      apply()
    }
  } catch {}

  syncClearVisibility()
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init)
} else {
  init()
}

export {}
