// RedSilk Couch — TV Category Drawer (0.11.7 W2).
//
// ONE prominent category control opens this drawer; the sprawling
// horizontal pills and category <select> elements are gone. The
// drawer is the only category navigation in Live TV 2.0, and W3's
// Guide reuses this same component (via TvCategoryDrawer.astro or
// this module directly) — keep the props simple:
//
//   Props (mountCategoryDrawer options):
//     groups                  DrawerGroup[] — top-level entries, in
//                             display order. Pseudo-entries
//                             (Favourites / Recents / All) carry
//                             `opensSubcategories: false` and an
//                             empty subcategories list; real groups
//                             carry `opensSubcategories: true` and
//                             their real provider subcategories.
//     selectedGroupId         Currently applied group id (or null).
//     selectedSubcategoryId   Currently applied subcategory id (or
//                             null = whole group).
//     onSelect(selection)     Fired when the user picks a leaf:
//                             a pseudo-entry, "All <Group>", or a
//                             subcategory. selection =
//                             { groupId, subcategoryId } with
//                             subcategoryId null for a whole group.
//     onBack()                Fired when the drawer closes WITHOUT
//                             a selection: B / Escape at the top
//                             level, D-pad Right, or a scrim click.
//
// Behaviour (navigation semantics — see the pure reducer below,
// drawerMove / drawerActivate / drawerBack, which the DOM mount
// and the tests share):
//   - Vertical top-level list. Selecting a group opens its actual
//     subcategories; the first subcategory item is always
//     "All <Group>". Selecting a subcategory (or "All <Group>")
//     fires onSelect — the caller closes the drawer.
//   - Back from subcategories returns to the top level; Back from
//     the top level fires onBack (close). ONE layer per press.
//   - D-pad Left in subcategories returns to the top level; Left
//     at the top level does nothing. D-pad Right returns to the
//     list (onBack) at either level.
//   - Focus is clamped, never wrapped: Up at the first item and
//     Down at the last item stay put. Focus starts on the
//     currently selected group (or the first group), and on
//     re-entering the top level returns to the group that was
//     open. The focused item holds real DOM focus (roving
//     tabindex) so focus is never behind the overlay.
//   - LB/RB ([ / ]) move one item at the current level — the same
//     step as Up/Down — so the bumpers never apply a category the
//     user has not selected while the drawer is open.
//   - Counts are the caller's numbers, rendered verbatim; this
//     module never invents a count. An empty groups list renders
//     the empty note, never a fabricated entry.

import { livetvKeyActionForKey } from "./livetv-keys";

/** One subcategory row inside a group. */
export interface DrawerSubcategory {
  id: string;
  label: string;
  count: number;
  /**
   * Raw provider category (verbatim), when the caller knows it.
   * Carried so hosts can resolve legacy verbatim subcategory
   * references to the canonical id; the drawer never renders it.
   */
  rawName?: string;
}

/** One top-level drawer entry. */
export interface DrawerGroup {
  id: string;
  label: string;
  count: number;
  /** Small text glyph for the row (mockup 1 icons). Optional. */
  icon?: string;
  /** True for real groups: Enter opens the subcategories level. */
  opensSubcategories: boolean;
  /** Real provider subcategories, first-seen order. Empty unless opened. */
  subcategories: DrawerSubcategory[];
}

/** A drawer selection: a group, optionally narrowed to one subcategory. */
export interface DrawerSelection {
  groupId: string;
  /** Null = the whole group ("All <Group>" / pseudo-entry). */
  subcategoryId: string | null;
}

export type DrawerLevel = "groups" | "subcategories";

/** Pure navigation state: level + focused index at each level. */
export interface DrawerNavState {
  level: DrawerLevel;
  /** Focused top-level index. */
  groupIndex: number;
  /** Focused subcategory index (0 = "All <Group>"). */
  subIndex: number;
}

/**
 * Pure: initial nav state — focus the selected group, or the first
 * group when nothing (or an unknown group) is selected. The
 * subcategory level always starts on "All <Group>" (index 0).
 */
export function drawerInitialState(
  groups: readonly DrawerGroup[],
  selectedGroupId: string | null | undefined,
): DrawerNavState {
  const at = selectedGroupId
    ? groups.findIndex((group) => group.id === selectedGroupId)
    : -1;
  return {
    level: "groups",
    groupIndex: at >= 0 ? at : 0,
    subIndex: 0,
  };
}

/** Pure: how many focusable items the current level has. */
export function drawerLevelCount(
  state: DrawerNavState,
  groups: readonly DrawerGroup[],
): number {
  if (state.level === "subcategories") {
    const group = groups[state.groupIndex];
    // "All <Group>" + one row per subcategory.
    return group ? group.subcategories.length + 1 : 0;
  }
  return groups.length;
}

/** Pure: move focus one step within the current level (clamped). */
export function drawerMove(
  state: DrawerNavState,
  groups: readonly DrawerGroup[],
  delta: number,
): DrawerNavState {
  const count = drawerLevelCount(state, groups);
  if (count === 0) return state;
  if (state.level === "subcategories") {
    return {
      ...state,
      subIndex: Math.max(0, Math.min(count - 1, state.subIndex + delta)),
    };
  }
  return {
    ...state,
    groupIndex: Math.max(0, Math.min(count - 1, state.groupIndex + delta)),
  };
}

export type DrawerActivateResult =
  | { action: "open-subcategories"; state: DrawerNavState }
  | { action: "select"; state: DrawerNavState; selection: DrawerSelection }
  | { action: "none"; state: DrawerNavState };

/**
 * Pure: activate the focused item. At the top level a real group
 * opens its subcategories (focus resets to "All <Group>"); a
 * pseudo-entry selects immediately. At the subcategory level,
 * index 0 selects the whole group and any other index selects
 * that subcategory.
 */
export function drawerActivate(
  state: DrawerNavState,
  groups: readonly DrawerGroup[],
): DrawerActivateResult {
  if (state.level === "subcategories") {
    const group = groups[state.groupIndex];
    if (!group) return { action: "none", state };
    if (state.subIndex === 0) {
      return {
        action: "select",
        state,
        selection: { groupId: group.id, subcategoryId: null },
      };
    }
    const sub = group.subcategories[state.subIndex - 1];
    if (!sub) return { action: "none", state };
    return {
      action: "select",
      state,
      selection: { groupId: group.id, subcategoryId: sub.id },
    };
  }
  const group = groups[state.groupIndex];
  if (!group) return { action: "none", state };
  if (group.opensSubcategories) {
    return {
      action: "open-subcategories",
      state: { ...state, level: "subcategories", subIndex: 0 },
    };
  }
  return {
    action: "select",
    state,
    selection: { groupId: group.id, subcategoryId: null },
  };
}

export type DrawerBackResult =
  | { action: "to-groups"; state: DrawerNavState }
  | { action: "close"; state: DrawerNavState };

/**
 * Pure: one Back press. From subcategories, return to the top
 * level (focus stays on the group that was open). From the top
 * level, close. Exactly one layer per press, always.
 */
export function drawerBack(state: DrawerNavState): DrawerBackResult {
  if (state.level === "subcategories") {
    return { action: "to-groups", state: { ...state, level: "groups" } };
  }
  return { action: "close", state };
}

/**
 * Pure: the drawer's breadcrumb for a state — the applied
 * selection ("Now showing: <label>") on the top level, or
 * "Categories / <Group>" on the subcategory level. `selectedLabel`
 * is the caller's applied-selection label (group, or
 * "Group / Subcategory").
 */
export function drawerBreadcrumb(
  state: DrawerNavState,
  groups: readonly DrawerGroup[],
  selectedLabel: string,
): string {
  if (state.level === "subcategories") {
    const group = groups[state.groupIndex];
    return group ? `Categories / ${group.label}` : "Categories";
  }
  return `Now showing: ${selectedLabel}`;
}

// ── DOM mount ───────────────────────────────────────────────────

export interface CategoryDrawerOptions {
  groups: DrawerGroup[];
  selectedGroupId?: string | null;
  selectedSubcategoryId?: string | null;
  /**
   * Group to focus on open, overriding selectedGroupId. The
   * browser passes the last focused group here so reopening the
   * drawer returns to where the user was, not just to the
   * applied selection. Unknown ids fall back to the selection.
   */
  initialFocusGroupId?: string | null;
  /** Accessible label for the drawer region. */
  label?: string;
  onSelect: (selection: DrawerSelection) => void;
  onBack: () => void;
}

export interface CategoryDrawerHandle {
  root: HTMLElement;
  getLevel(): DrawerLevel;
  getState(): DrawerNavState;
  getFocusedGroupId(): string | null;
  /** Route one key event; true when the drawer consumed it. */
  handleKey(event: KeyboardEvent): boolean;
  /** One Back press (B / Escape via the browser's layer handler). */
  pressBack(): void;
  /** Move DOM focus to the currently focused item. */
  focusCurrent(): void;
  /** Refresh groups/counts, keeping the nav state by id where possible. */
  updateGroups(groups: DrawerGroup[]): void;
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

/**
 * Mount the drawer into `container` (which the caller positions
 * and shows/hides). The drawer renders a scrim (click = back/close)
 * plus the panel. The caller owns open/close lifecycle; this
 * handle owns only the drawer's own DOM and nav state.
 */
export function mountCategoryDrawer(
  container: HTMLElement,
  opts: CategoryDrawerOptions,
): CategoryDrawerHandle {
  let groups: DrawerGroup[] = [...opts.groups];
  // Focus the remembered group when it names a real group, else
  // the applied selection (drawerInitialState falls back to the
  // first group for anything unknown).
  const focusGroupId =
    opts.initialFocusGroupId &&
    groups.some((group) => group.id === opts.initialFocusGroupId)
      ? opts.initialFocusGroupId
      : (opts.selectedGroupId ?? null);
  let state = drawerInitialState(groups, focusGroupId);
  let destroyed = false;

  const root = el("div", "rs-tv-category-drawer");
  root.setAttribute("data-category-drawer", "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", opts.label ?? "Categories");

  const scrim = el("div", "rs-tv-category-drawer__scrim");
  scrim.setAttribute("data-category-drawer-scrim", "");
  scrim.setAttribute("aria-hidden", "true");

  const panel = el("div", "rs-tv-category-drawer__panel");
  panel.setAttribute("data-category-drawer-panel", "");
  // Panel FIRST (left side — D-pad Left enters categories), scrim
  // second: flex order is the visual order, and the panel's
  // content precedes the decorative scrim for assistive tech too.
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

  // 0.11.10 W4: no inline hint line — the ONE hints bar
  // (TvLivetvHints, following the nav stack's drawer layer)
  // names the drawer's keys. The old "A Select · B Back" line
  // duplicated it with different wording ("Back" vs the bar's
  // "Close drawer") and never mentioned LB/RB.

  container.appendChild(root);

  /** The rows for the current level, in order. */
  function currentItems(): Array<{
    key: string;
    label: string;
    count: number;
    icon: string;
    chevron: boolean;
    selected: boolean;
  }> {
    if (state.level === "subcategories") {
      const group = groups[state.groupIndex];
      if (!group) return [];
      const items = [
        {
          key: `all:${group.id}`,
          label: `All ${group.label}`,
          count: group.count,
          icon: group.icon ?? "",
          chevron: false,
          selected:
            opts.selectedGroupId === group.id &&
            (opts.selectedSubcategoryId ?? null) === null,
        },
      ];
      for (const sub of group.subcategories) {
        items.push({
          key: `sub:${group.id}:${sub.id}`,
          label: sub.label,
          count: sub.count,
          icon: "",
          chevron: false,
          selected:
            opts.selectedGroupId === group.id &&
            opts.selectedSubcategoryId === sub.id,
        });
      }
      return items;
    }
    return groups.map((group) => ({
      key: `group:${group.id}`,
      label: group.label,
      count: group.count,
      icon: group.icon ?? "",
      chevron: group.opensSubcategories,
      selected:
        opts.selectedGroupId === group.id &&
        (opts.selectedSubcategoryId ?? null) === null,
    }));
  }

  function focusedIndex(): number {
    return state.level === "subcategories" ? state.subIndex : state.groupIndex;
  }

  function selectedLabel(): string {
    const group = groups.find((g) => g.id === opts.selectedGroupId);
    if (!group) return opts.selectedGroupId ?? "Categories";
    if (opts.selectedSubcategoryId == null) return group.label;
    const sub = group.subcategories.find((s) => s.id === opts.selectedSubcategoryId);
    return sub ? `${group.label} / ${sub.label}` : group.label;
  }

  function render(): void {
    if (destroyed) return;
    breadcrumb.textContent = drawerBreadcrumb(state, groups, selectedLabel());
    title.textContent =
      state.level === "subcategories"
        ? (groups[state.groupIndex]?.label ?? "Categories")
        : "Categories";
    const items = currentItems();
    const focusAt = focusedIndex();
    list.replaceChildren();
    if (items.length === 0) {
      const empty = el("p", "rs-tv-category-drawer__empty");
      empty.textContent = "No categories available.";
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const button = el("button", "rs-tv-category-drawer__item") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("data-category-drawer-item", "");
      button.setAttribute("data-drawer-item-key", item.key);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(item.selected));
      button.tabIndex = -1;
      if (index === focusAt) button.classList.add("is-focused");
      if (item.selected) button.classList.add("is-selected");
      // The icon slot is always rendered (empty when the item has
      // no icon) so labels align across rows — "All <Group>" and
      // its subcategories share one label edge.
      const icon = el("span", "rs-tv-category-drawer__item-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = item.icon;
      button.appendChild(icon);
      const label = el("span", "rs-tv-category-drawer__item-label");
      label.textContent = item.label;
      button.appendChild(label);
      const count = el("span", "rs-tv-category-drawer__item-count");
      count.textContent = item.count.toLocaleString();
      button.appendChild(count);
      if (item.chevron) {
        const chevron = el("span", "rs-tv-category-drawer__item-chevron");
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "›";
        button.appendChild(chevron);
      }
      button.addEventListener("click", () => {
        if (destroyed) return;
        // A click focuses then activates, exactly like a keypress.
        state =
          state.level === "subcategories"
            ? { ...state, subIndex: index }
            : { ...state, groupIndex: index };
        activate();
      });
      button.addEventListener("mouseenter", () => {
        if (destroyed) return;
        state =
          state.level === "subcategories"
            ? { ...state, subIndex: index }
            : { ...state, groupIndex: index };
        // paintFocus only: a full render() here replaces the node
        // under the pointer and Chromium re-fires mouseenter on the
        // replacement — a feedback loop (see paintFocus).
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
    // The focused item must be visible: scroll the drawer list
    // (nearest) so a long group list follows focus instead of
    // leaving it below the fold. Guarded for jsdom / old webviews.
    try {
      target.scrollIntoView?.({ block: "nearest" });
    } catch {
      // Focus still lands; scroll just doesn't follow.
    }
  }

  /**
   * Move the focus ring + DOM focus WITHOUT rebuilding the list.
   * Same-level moves and hover change only which item is focused;
   * a full render() here replaces every node, and Chromium re-fires
   * mouseenter on the replacement under a stationary pointer — a
   * hover/render feedback loop that snaps focus back to the hovered
   * item (defeating arrow keys) and swallows mouse clicks (the node
   * under the pointer is replaced between mousedown and mouseup).
   * Level changes still use render(); focus-only changes use this.
   */
  function paintFocus(): void {
    if (destroyed) return;
    const items = list.querySelectorAll<HTMLElement>("[data-category-drawer-item]");
    const focusAt = focusedIndex();
    items.forEach((item, index) => item.classList.toggle("is-focused", index === focusAt));
    focusCurrent();
  }

  function activate(): void {
    const result = drawerActivate(state, groups);
    state = result.state;
    if (result.action === "open-subcategories") {
      render();
      focusCurrent();
      return;
    }
    if (result.action === "select") {
      opts.onSelect(result.selection);
    }
  }

  function pressBack(): void {
    const result = drawerBack(state);
    state = result.state;
    if (result.action === "to-groups") {
      render();
      focusCurrent();
      return;
    }
    opts.onBack();
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (destroyed) return false;
    const action = livetvKeyActionForKey("browser", event.key);
    switch (action) {
      case "move-up":
        state = drawerMove(state, groups, -1);
        paintFocus();
        return true;
      case "move-down":
        state = drawerMove(state, groups, 1);
        paintFocus();
        return true;
      case "move-left":
        if (state.level === "subcategories") {
          pressBack();
          return true;
        }
        return false;
      case "move-right":
        // Right returns to the list without changing the selection.
        opts.onBack();
        return true;
      case "select":
        activate();
        return true;
      case "back":
        pressBack();
        return true;
      case "category-prev":
        state = drawerMove(state, groups, -1);
        paintFocus();
        return true;
      case "category-next":
        state = drawerMove(state, groups, 1);
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
    getFocusedGroupId: () => groups[state.groupIndex]?.id ?? null,
    handleKey,
    pressBack,
    focusCurrent,
    updateGroups(next: DrawerGroup[]): void {
      if (destroyed) return;
      const focusedGroupId = groups[state.groupIndex]?.id;
      const focusedSubId =
        state.level === "subcategories"
          ? groups[state.groupIndex]?.subcategories[state.subIndex - 1]?.id
          : undefined;
      groups = [...next];
      const groupAt = focusedGroupId
        ? groups.findIndex((group) => group.id === focusedGroupId)
        : -1;
      state = {
        ...state,
        groupIndex: groupAt >= 0 ? groupAt : 0,
        subIndex: 0,
      };
      if (state.level === "subcategories") {
        const group = groups[state.groupIndex];
        if (!group || !group.opensSubcategories) {
          state = { ...state, level: "groups" };
        } else if (focusedSubId) {
          const subAt = group.subcategories.findIndex((sub) => sub.id === focusedSubId);
          state = { ...state, subIndex: subAt >= 0 ? subAt + 1 : 0 };
        }
      }
      render();
    },
    destroy(): void {
      destroyed = true;
      root.remove();
    },
  };
}
