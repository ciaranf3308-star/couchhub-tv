// Settings search, multi-page edition (0.11.4 W1).
//
// Settings is split into one short page per section, so search has two
// modes, both filtering IN PLACE — nothing ever yanks the view to the top:
//
//  * Home (/settings): the input filters the section list. Each row
//    carries data-search-text (title + description + keywords from
//    settings-index), so a query matches sections by the controls inside
//    them, not just their names.
//  * Section page (/settings/*): the input filters that page's own
//    [data-settings-item] rows (same AND-token index as before), AND
//    shows cross-page hits from settings-index as links under the box,
//    so the search indexes everything including the section homes.
//
// The old scroll-spy/nav-link miss marking is gone with the spy: the
// section nav is page-based now and always stays usable while searching.

import { LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { searchSettingsIndex } from "@/scripts/settings/settings-index.ts"

const INPUT_ID = "settings-search-input"
const CLEAR_ID = "settings-search-clear"
const EMPTY_ID = "settings-search-empty"
const XPAGE_ID = "settings-search-xpage"
const HOME_LIST_ID = "settings-home-list"

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
  emptyEl: HTMLElement | null,
  xpageEl: HTMLElement | null
): void {
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
    if (emptyEl) emptyEl.hidden = true
    if (xpageEl) {
      xpageEl.hidden = true
      xpageEl.replaceChildren()
    }
    return
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

  // Cross-page hits: same query against every section + headline item,
  // excluding this page (its own matches are already visible above).
  // Rendered in place under the search box; each hit is a link to the
  // section page (and card anchor when known).
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

  if (emptyEl) emptyEl.hidden = visibleCount > 0 || xpageCount > 0
}

function applyHomeFilter(
  query: string,
  list: HTMLElement,
  emptyEl: HTMLElement | null
): void {
  const tokens = tokenize(query)
  const active = tokens.length > 0
  if (active) list.setAttribute("data-search-active", "true")
  else list.removeAttribute("data-search-active")

  const rows = list.querySelectorAll<HTMLElement>("[data-search-text]")
  let visibleCount = 0
  for (const row of rows) {
    if (!active) {
      delete row.dataset.search
      visibleCount++
      continue
    }
    const hay = (row.dataset.searchText ?? "").toLowerCase()
    const matches = tokens.every((token) => hay.includes(token))
    row.dataset.search = matches ? "match" : "miss"
    if (matches) visibleCount++
  }
  if (emptyEl) emptyEl.hidden = !active || visibleCount > 0
}

function init(): void {
  const input = document.getElementById(INPUT_ID) as HTMLInputElement | null
  const clearBtn = document.getElementById(CLEAR_ID) as HTMLButtonElement | null
  const emptyEl = document.getElementById(EMPTY_ID)
  const xpageEl = document.getElementById(XPAGE_ID)
  if (!input) return

  const homeList = document.getElementById(HOME_LIST_ID)
  const stack = document.querySelector<HTMLElement>(".settings-stack")
  if (stack && !homeList) {
    buildStructure(stack)
    buildIndex()
  }

  const apply = (): void => {
    if (homeList) applyHomeFilter(input.value, homeList, emptyEl)
    else if (stack) applyPageFilter(input.value, stack, emptyEl, xpageEl)
  }
  const syncClearVisibility = (): void => {
    if (clearBtn) clearBtn.hidden = input.value.length === 0
  }

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
  if (stack && !homeList) {
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
    if (event.key === "Escape" && input.value) {
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
