// 0.11.8 W2 — Browse category drawer (brief §7).
//
// ONE dedicated controller-friendly Categories drawer — NO
// horizontal pill strip. Structure per §7.1 exactly:
//
//   MOVIES: All Movies; Genres (18 canonical); Collections
//     (Recently Added, Highest Rated, Unwatched, Continue
//     Watching, Favourites, Watch Later + metadata-supported
//     extras); Provider Categories (real labels); Uncategorised.
//   SERIES: All Series; Genres (15 families); Collections
//     (Recently Added, Followed Series, New Episodes, Continue
//     Watching, Unwatched, Highest Rated, Favourites, Watch
//     Later + evidence-supported extras); Provider Categories;
//     Uncategorised.
//
// Only meaningful populated categories render — or clearly
// explained unavailable ones (a collection with no backing data
// renders disabled WITH its reason, never silently absent and
// never with an invented count).
//
// ── Reuse (0.11.7) ─────────────────────────────────────────────
// This module GENERALISES the Live TV drawer pattern, it does not
// fork it: the two-level reducer (families → items), clamped
// focus, paintFocus-without-rebuild, scrim-click = back, and the
// B-layer rule (B from items → families, B again → close) are
// ported from src/scripts/lib/livetv-category-drawer.ts, and the
// DOM mount emits the SAME rs-tv-category-drawer classes so the
// 0.11.7 drawer CSS styles it (plus a small browse section-header
// addition in couch.css). The Live TV module itself is untouched:
// its DrawerGroup/DrawerSelection shapes are Live TV-specific
// (group/subcategory), while browse categories are
// BrowseCategorySelection — a shared module would need a third
// shape and a migration of Live TV callers, which is out of
// scope for this branch (flagged for integration if wanted).
//
// ── Semantics ──────────────────────────────────────────────────
//   - Selection REPLACES (browse-state.ts selectCategory): the
//     drawer fires ONE selection; the controller applies it.
//   - The drawer opens on the selected category's family (and,
//     when the selection is inside a family, opens AT that item
//     — see initial state). Close-without-select restores the
//     previous result focus (the controller owns that; the
//     drawer fires onBack and never touches grid focus).
//   - No focus behind overlays: the focused item holds real DOM
//     focus (roving tabindex pattern via focusCurrent), and the
//     controller's layer stack makes the grid deaf while the
//     drawer is the top layer.

import type {
  BrowseCategorySelection,
  BrowseKind,
} from "@/scripts/lib/browse-state.ts";

/** One selectable row inside a drawer family. */
export interface BrowseDrawerItem {
  /** Stable id within the family (genre id, collection id, provider id). */
  id: string;
  label: string;
  /** Real count, rendered verbatim. 0 only with an unavailableReason. */
  count: number;
  category: BrowseCategorySelection;
  /** When set, the row renders disabled with this explanation. */
  unavailableReason?: string;
}

/** One drawer family (§7.1 section). */
export interface BrowseDrawerFamily {
  /** Stable family id: "all" | "genres" | "collections" | "provider" | "uncategorised". */
  id: string;
  label: string;
  /** Small text glyph for the row. Optional. */
  icon?: string;
  items: BrowseDrawerItem[];
  /** Total count across items (the family row's count). */
  count: number;
}

export type BrowseDrawerLevel = "families" | "items";

export interface BrowseDrawerNavState {
  level: BrowseDrawerLevel;
  familyIndex: number;
  itemIndex: number;
}

/** Input stats for building drawer families (counts from the catalog index). */
export interface BrowseDrawerStats {
  kind: BrowseKind;
  totalGroups: number;
  genres: Array<{ id: string; label: string; count: number }>;
  collections: Array<{
    id: string;
    label: string;
    count: number;
    available: boolean;
    unavailableReason?: string;
  }>;
  providerCategories: Array<{ id: string; label: string; count: number }>;
  uncategorisedCount: number;
  // Family counts are DISTINCT-group unions — the number of
  // titles reachable through the family — never sums of item
  // counts (genres, collections and provider categories all
  // overlap, so a sum can exceed the catalogue and lie).
  genreUnionCount: number;
  collectionUnionCount: number;
  providerUnionCount: number;
}

const MOVIE_COLLECTION_ORDER = [
  "recent",
  "highest-rated",
  "unwatched",
  "continue",
  "favourites",
  "watchlater",
];

const SERIES_COLLECTION_ORDER = [
  "recent",
  "followed",
  "new-episodes",
  "continue",
  "unwatched",
  "highest-rated",
  "favourites",
  "watchlater",
];

/**
 * Build drawer families in §7.1 order. Genres and provider
 * categories render only when populated (count > 0). Collections
 * render in the brief's order: populated ones first, then
 * unavailable ones WITH their reason (disabled). A collection
 * with count 0 but available backing data (e.g. no favourites
 * yet) renders enabled with count 0 — selecting it shows the
 * honest empty state, not a dead row. Extras beyond the brief's
 * list keep their input order after the known ones.
 * Uncategorised renders only when non-empty.
 */
export function buildBrowseDrawerFamilies(
  stats: BrowseDrawerStats,
): BrowseDrawerFamily[] {
  const allLabel = stats.kind === "movie" ? "All Movies" : "All Series";
  const families: BrowseDrawerFamily[] = [
    {
      id: "all",
      label: allLabel,
      icon: "▦",
      count: stats.totalGroups,
      items: [
        {
          id: "all",
          label: allLabel,
          count: stats.totalGroups,
          category: { kind: "all", id: "all", label: allLabel },
        },
      ],
    },
  ];

  const genreItems: BrowseDrawerItem[] = stats.genres
    .filter((g) => g.count > 0)
    .map((g) => ({
      id: g.id,
      label: g.label,
      count: g.count,
      category: { kind: "genre" as const, id: g.id, label: g.label },
    }));
  if (genreItems.length > 0) {
    families.push({
      id: "genres",
      label: "Genres",
      icon: "◆",
      count: stats.genreUnionCount,
      items: genreItems,
    });
  }

  const order =
    stats.kind === "movie" ? MOVIE_COLLECTION_ORDER : SERIES_COLLECTION_ORDER;
  const ordered = [...stats.collections].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
  const collectionItems: BrowseDrawerItem[] = ordered.map((c) => ({
    id: c.id,
    label: c.label,
    count: c.available ? c.count : 0,
    category: { kind: "collection" as const, id: c.id, label: c.label },
    unavailableReason: c.available ? undefined : (c.unavailableReason ?? "Not available for this catalogue."),
  }));
  if (collectionItems.length > 0) {
    families.push({
      id: "collections",
      label: "Collections",
      icon: "★",
      count: stats.collectionUnionCount,
      items: collectionItems,
    });
  }

  const providerItems: BrowseDrawerItem[] = stats.providerCategories
    .filter((p) => p.count > 0)
    .map((p) => ({
      id: p.id,
      label: p.label,
      count: p.count,
      category: { kind: "provider" as const, id: p.id, label: p.label },
    }));
  if (providerItems.length > 0) {
    families.push({
      id: "provider",
      label: "Provider Categories",
      icon: "▤",
      count: stats.providerUnionCount,
      items: providerItems,
    });
  }

  if (stats.uncategorisedCount > 0) {
    families.push({
      id: "uncategorised",
      label: "Uncategorised",
      icon: "?",
      count: stats.uncategorisedCount,
      items: [
        {
          id: "uncategorised",
          label: "Uncategorised",
          count: stats.uncategorisedCount,
          category: {
            kind: "uncategorised",
            id: "uncategorised",
            label: "Uncategorised",
          },
        },
      ],
    });
  }

  return families;
}

/** Find the family + item index holding a category selection, or null. */
export function findBrowseDrawerSelection(
  families: readonly BrowseDrawerFamily[],
  category: BrowseCategorySelection | null | undefined,
): { familyIndex: number; itemIndex: number } | null {
  if (!category) return null;
  for (let fi = 0; fi < families.length; fi++) {
    const at = families[fi].items.findIndex(
      (item) =>
        item.category.kind === category.kind && item.category.id === category.id,
    );
    if (at >= 0) return { familyIndex: fi, itemIndex: at };
  }
  return null;
}

/**
 * Pure: initial nav state — open ON the selected category: the
 * family level focuses the selected category's family, and when
 * the selection sits inside a multi-item family the drawer opens
 * directly at the items level on that item (one less press to
 * re-pick a neighbour). Single-item families (All, Uncategorised)
 * stay at the family level. Unknown selections → first family.
 */
export function browseDrawerInitialState(
  families: readonly BrowseDrawerFamily[],
  selected: BrowseCategorySelection | null | undefined,
): BrowseDrawerNavState {
  const found = findBrowseDrawerSelection(families, selected);
  if (!found) return { level: "families", familyIndex: 0, itemIndex: 0 };
  const family = families[found.familyIndex];
  if (family.items.length > 1) {
    return { level: "items", familyIndex: found.familyIndex, itemIndex: found.itemIndex };
  }
  return { level: "families", familyIndex: found.familyIndex, itemIndex: 0 };
}

export function browseDrawerLevelCount(
  state: BrowseDrawerNavState,
  families: readonly BrowseDrawerFamily[],
): number {
  if (state.level === "items") {
    return families[state.familyIndex]?.items.length ?? 0;
  }
  return families.length;
}

/** Pure: move focus one step within the current level (clamped, never wrapped). */
export function browseDrawerMove(
  state: BrowseDrawerNavState,
  families: readonly BrowseDrawerFamily[],
  delta: number,
): BrowseDrawerNavState {
  const count = browseDrawerLevelCount(state, families);
  if (count === 0) return state;
  if (state.level === "items") {
    return {
      ...state,
      itemIndex: Math.max(0, Math.min(count - 1, state.itemIndex + delta)),
    };
  }
  return {
    ...state,
    familyIndex: Math.max(0, Math.min(count - 1, state.familyIndex + delta)),
  };
}

export type BrowseDrawerActivateResult =
  | { action: "open-items"; state: BrowseDrawerNavState }
  | {
      action: "select";
      state: BrowseDrawerNavState;
      selection: BrowseCategorySelection;
    }
  | { action: "none"; state: BrowseDrawerNavState };

/**
 * Pure: activate the focused row. A multi-item family opens its
 * items (focus on the first item, or the selected item when the
 * family holds the current selection). A single-item family
 * selects immediately. At the items level, A selects — except
 * unavailable rows, which do nothing (they are disabled).
 */
export function browseDrawerActivate(
  state: BrowseDrawerNavState,
  families: readonly BrowseDrawerFamily[],
  selected?: BrowseCategorySelection | null,
): BrowseDrawerActivateResult {
  if (state.level === "items") {
    const item = families[state.familyIndex]?.items[state.itemIndex];
    if (!item || item.unavailableReason) return { action: "none", state };
    return { action: "select", state, selection: item.category };
  }
  const family = families[state.familyIndex];
  if (!family) return { action: "none", state };
  if (family.items.length === 1) {
    const only = family.items[0];
    if (only.unavailableReason) return { action: "none", state };
    return { action: "select", state, selection: only.category };
  }
  // Open on the selected item when this family holds it.
  let itemIndex = 0;
  if (selected) {
    const at = family.items.findIndex(
      (item) =>
        item.category.kind === selected.kind && item.category.id === selected.id,
    );
    if (at >= 0) itemIndex = at;
  }
  return {
    action: "open-items",
    state: { ...state, level: "items", itemIndex },
  };
}

export type BrowseDrawerBackResult =
  | { action: "to-families"; state: BrowseDrawerNavState }
  | { action: "close"; state: BrowseDrawerNavState };

/** Pure: one Back press. Items → families; families → close. One layer per press. */
export function browseDrawerBack(
  state: BrowseDrawerNavState,
): BrowseDrawerBackResult {
  if (state.level === "items") {
    return { action: "to-families", state: { ...state, level: "families" } };
  }
  return { action: "close", state };
}

/** Pure: breadcrumb — applied selection on families, "Categories / <Family>" on items. */
export function browseDrawerBreadcrumb(
  state: BrowseDrawerNavState,
  families: readonly BrowseDrawerFamily[],
  selectedLabel: string,
): string {
  if (state.level === "items") {
    const family = families[state.familyIndex];
    return family ? `Categories / ${family.label}` : "Categories";
  }
  return `Now showing: ${selectedLabel}`;
}

// ── DOM mount ───────────────────────────────────────────────────

export interface BrowseCategoryDrawerOptions {
  families: BrowseDrawerFamily[];
  selected?: BrowseCategorySelection | null;
  /** Accessible label for the drawer region. */
  label?: string;
  onSelect: (selection: BrowseCategorySelection) => void;
  onBack: () => void;
}

export interface BrowseCategoryDrawerHandle {
  root: HTMLElement;
  getLevel(): BrowseDrawerLevel;
  getState(): BrowseDrawerNavState;
  /** Route one key event; true when the drawer consumed it. */
  handleKey(event: KeyboardEvent): boolean;
  /** One Back press (B / Escape via the controller's layer handler). */
  pressBack(): void;
  focusCurrent(): void;
  /** Refresh families/counts, keeping nav state by id where possible. */
  updateFamilies(families: BrowseDrawerFamily[]): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function mountBrowseCategoryDrawer(
  container: HTMLElement,
  opts: BrowseCategoryDrawerOptions,
): BrowseCategoryDrawerHandle {
  let families: BrowseDrawerFamily[] = [...opts.families];
  let selected = opts.selected ?? null;
  let state = browseDrawerInitialState(families, selected);
  let destroyed = false;
  // Hover guard (0.11.8 integration fix, brief §7.3): Chromium fires
  // mouseenter when the drawer opens under a stationary pointer, and
  // the hover handler moves state + DOM focus — a parked mouse stole
  // focus off the selected row on open (screenshot gate). Hover only
  // takes effect after real mouse movement; every render re-arms the
  // guard so a re-render under a stationary pointer cannot steal
  // focus either. Clicks are unaffected.
  let hoverEnabled = false;
  const onMouseMove = (): void => {
    hoverEnabled = true;
  };

  // Same classes as the 0.11.7 Live TV drawer (shared drawer
  // chrome) + a browse marker for the section-header addition.
  const root = el("div", "rs-tv-category-drawer rs-browse-category-drawer");
  root.setAttribute("data-browse-category-drawer", "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", opts.label ?? "Categories");
  root.addEventListener("mousemove", onMouseMove);

  const scrim = el("div", "rs-tv-category-drawer__scrim");
  scrim.setAttribute("data-category-drawer-scrim", "");
  scrim.setAttribute("aria-hidden", "true");

  const panel = el("div", "rs-tv-category-drawer__panel");
  panel.setAttribute("data-category-drawer-panel", "");
  root.appendChild(panel);
  root.appendChild(scrim);

  const header = el("div", "rs-tv-category-drawer__header");
  const breadcrumb = el("p", "rs-tv-category-drawer__breadcrumb");
  breadcrumb.setAttribute("data-category-drawer-breadcrumb", "");
  header.appendChild(breadcrumb);
  const title = el("h2", "rs-tv-category-drawer__title");
  title.setAttribute("data-category-drawer-title", "");
  header.appendChild(title);
  panel.appendChild(header);

  const list = el("div", "rs-tv-category-drawer__list");
  list.setAttribute("data-category-drawer-list", "");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Categories");
  panel.appendChild(list);

  const hints = el("p", "rs-tv-category-drawer__hints");
  hints.setAttribute("aria-hidden", "true");
  hints.textContent = "A Select · B Back · ◀ ▶ List";
  panel.appendChild(hints);

  container.appendChild(root);

  interface RowView {
    key: string;
    label: string;
    count: number;
    icon: string;
    chevron: boolean;
    selected: boolean;
    disabled: boolean;
    reason?: string;
  }

  function currentRows(): RowView[] {
    if (state.level === "items") {
      const family = families[state.familyIndex];
      if (!family) return [];
      return family.items.map((item) => ({
        key: `item:${family.id}:${item.id}`,
        label: item.label,
        count: item.count,
        icon: "",
        chevron: false,
        selected:
          selected?.kind === item.category.kind && selected?.id === item.category.id,
        disabled: Boolean(item.unavailableReason),
        reason: item.unavailableReason,
      }));
    }
    return families.map((family) => ({
      key: `family:${family.id}`,
      label: family.label,
      count: family.count,
      icon: family.icon ?? "",
      chevron: family.items.length > 1,
      selected:
        selected != null &&
        family.items.some(
          (item) =>
            item.category.kind === selected!.kind && item.category.id === selected!.id,
        ),
      disabled: false,
    }));
  }

  function focusedIndex(): number {
    return state.level === "items" ? state.itemIndex : state.familyIndex;
  }

  function selectedLabel(): string {
    return selected?.label ?? "Categories";
  }

  function render(): void {
    if (destroyed) return;
    // Re-arm the hover guard: nodes replaced under a stationary
    // pointer must not steal focus via mouseenter (see above).
    hoverEnabled = false;
    breadcrumb.textContent = browseDrawerBreadcrumb(state, families, selectedLabel());
    title.textContent =
      state.level === "items"
        ? (families[state.familyIndex]?.label ?? "Categories")
        : "Categories";
    const rows = currentRows();
    const focusAt = focusedIndex();
    list.replaceChildren();
    if (rows.length === 0) {
      const empty = el("p", "rs-tv-category-drawer__empty");
      empty.textContent = "No categories available.";
      list.appendChild(empty);
      return;
    }
    rows.forEach((row, index) => {
      const button = el("button", "rs-tv-category-drawer__item") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("data-category-drawer-item", "");
      button.setAttribute("data-drawer-item-key", row.key);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(row.selected));
      button.tabIndex = -1;
      button.disabled = row.disabled;
      if (row.disabled && row.reason) button.title = row.reason;
      if (index === focusAt) button.classList.add("is-focused");
      if (row.selected) button.classList.add("is-selected");
      const icon = el("span", "rs-tv-category-drawer__item-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = row.icon;
      button.appendChild(icon);
      const label = el("span", "rs-tv-category-drawer__item-label");
      label.textContent = row.label;
      button.appendChild(label);
      if (row.disabled && row.reason) {
        const reason = el("span", "rs-browse-drawer__item-reason");
        reason.textContent = row.reason;
        button.appendChild(reason);
      }
      const count = el("span", "rs-tv-category-drawer__item-count");
      count.textContent = row.count.toLocaleString();
      button.appendChild(count);
      if (row.chevron) {
        const chevron = el("span", "rs-tv-category-drawer__item-chevron");
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "›";
        button.appendChild(chevron);
      }
      button.addEventListener("click", () => {
        if (destroyed || row.disabled) return;
        state =
          state.level === "items"
            ? { ...state, itemIndex: index }
            : { ...state, familyIndex: index };
        activate();
      });
      button.addEventListener("mouseenter", () => {
        if (destroyed || !hoverEnabled) return;
        state =
          state.level === "items"
            ? { ...state, itemIndex: index }
            : { ...state, familyIndex: index };
        // paintFocus only — a full render() here replaces the node
        // under the pointer and Chromium re-fires mouseenter on the
        // replacement (the 0.11.7 feedback-loop fix, kept here).
        paintFocus();
      });
      list.appendChild(button);
    });
  }

  function focusCurrent(): void {
    const items = list.querySelectorAll<HTMLElement>("[data-category-drawer-item]");
    const target = items[focusedIndex()];
    if (!target) return;
    target.focus({ preventScroll: true });
    try {
      target.scrollIntoView?.({ block: "nearest" });
    } catch {
      // Focus still lands; scroll just doesn't follow.
    }
  }

  function paintFocus(): void {
    if (destroyed) return;
    const items = list.querySelectorAll<HTMLElement>("[data-category-drawer-item]");
    const focusAt = focusedIndex();
    items.forEach((item, index) =>
      item.classList.toggle("is-focused", index === focusAt),
    );
    focusCurrent();
  }

  function activate(): void {
    const result = browseDrawerActivate(state, families, selected);
    state = result.state;
    if (result.action === "open-items") {
      render();
      focusCurrent();
      return;
    }
    if (result.action === "select") {
      selected = result.selection;
      opts.onSelect(result.selection);
    }
  }

  function pressBack(): void {
    const result = browseDrawerBack(state);
    state = result.state;
    if (result.action === "to-families") {
      render();
      focusCurrent();
      return;
    }
    opts.onBack();
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (destroyed) return false;
    switch (event.key) {
      case "ArrowUp":
        state = browseDrawerMove(state, families, -1);
        paintFocus();
        return true;
      case "ArrowDown":
        state = browseDrawerMove(state, families, 1);
        paintFocus();
        return true;
      case "ArrowLeft":
        if (state.level === "items") {
          pressBack();
          return true;
        }
        return false;
      case "ArrowRight":
        opts.onBack();
        return true;
      case "Enter":
      case " ":
        activate();
        return true;
      case "Escape":
        pressBack();
        return true;
      case "[":
        state = browseDrawerMove(state, families, -1);
        paintFocus();
        return true;
      case "]":
        state = browseDrawerMove(state, families, 1);
        paintFocus();
        return true;
      default:
        return false;
    }
  }

  scrim.addEventListener("click", () => {
    if (!destroyed) opts.onBack();
  });

  render();

  return {
    root,
    getLevel: () => state.level,
    getState: () => ({ ...state }),
    handleKey,
    pressBack,
    focusCurrent,
    updateFamilies(next: BrowseDrawerFamily[]): void {
      if (destroyed) return;
      const focusedFamilyId = families[state.familyIndex]?.id;
      const focusedItemId =
        state.level === "items"
          ? families[state.familyIndex]?.items[state.itemIndex]?.id
          : undefined;
      families = [...next];
      const familyAt = focusedFamilyId
        ? families.findIndex((f) => f.id === focusedFamilyId)
        : -1;
      state = { ...state, familyIndex: familyAt >= 0 ? familyAt : 0, itemIndex: 0 };
      if (state.level === "items") {
        const family = families[state.familyIndex];
        if (!family || family.items.length <= 1) {
          state = { ...state, level: "families" };
        } else if (focusedItemId) {
          const itemAt = family.items.findIndex((item) => item.id === focusedItemId);
          state = { ...state, itemIndex: itemAt >= 0 ? itemAt : 0 };
        }
      }
      render();
    },
    destroy(): void {
      destroyed = true;
      root.removeEventListener("mousemove", onMouseMove);
      root.remove();
    },
  };
}
