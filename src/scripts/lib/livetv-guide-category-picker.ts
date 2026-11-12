// SWAP TARGET — Guide category picker (Live TV 0.11.7, W3).
//
// *** INTEGRATION: replace this file's internals with W2's
// *** TvCategoryDrawer.astro in ONE step. ***
//
// This is ONE thin wrapper implementing the drawer contract W2's
// component will expose, so the Guide can be built and verified
// before the drawer lands:
//
//   props: groups, selectedGroupId, selectedSubcategoryId,
//          onSelect, onBack
//
// The Guide (TvGuideView.astro) mounts it through
// `mountGuideCategoryPicker(mount, props)` and talks to it ONLY
// through those props plus open()/close()/update()/handleBack().
// W2's drawer takes the same props; swapping means changing what
// this module renders, not how the Guide calls it. (An Astro
// component cannot take live props from a client script — the
// Guide's groups derive from the loaded catalogue at runtime — so
// the wrapper is a DOM controller with the drawer's prop shape,
// not an .astro file. The .astro side is only the mount point.)
//
// Behaviour (controller-first, drawer concept):
//   - Up/Down moves through groups, then subcategories.
//   - Right drills from a group into its provider subcategories;
//     Left returns to groups. A/Enter on a group selects the whole
//     group; A/Enter on a subcategory selects just it. Selection
//     REPLACES the previous filter (never intersects).
//   - B/Esc is one layer: subcategories → groups → onBack (the
//     Guide closes the drawer and returns focus to the trigger).
//   - The drawer lists categories (tens), not channels — it needs
//     no virtualisation; channel scale is the lists' problem.
//   - No auto-tuning: picking a category only filters the Guide.
//
// Groups carry the adapter's view shape (id / label / channelCount
// / subcategories); pseudo-groups ("All categories", "Favourites",
// "Recently watched") arrive as ordinary groups with the
// GUIDE_CATEGORY_* ids and no subcategories.

import type { GuideCategoryGroupView } from "./livetv-guide-categories";

/** Drawer-contract selection payload. */
export interface GuideCategoryDrawerSelection {
  /** Group id (verbatim, pseudo-ids included), or null for "all". */
  groupId: string | null;
  /** Verbatim provider subcategory id, or null for the whole group. */
  subcategoryId: string | null;
}

/** Drawer-contract props. */
export interface GuideCategoryPickerProps {
  groups: GuideCategoryGroupView[];
  selectedGroupId: string | null;
  selectedSubcategoryId: string | null;
  onSelect: (selection: GuideCategoryDrawerSelection) => void;
  onBack: () => void;
}

export interface GuideCategoryPickerHandle {
  open(): void;
  close(opts?: { focusTrigger?: boolean }): void;
  isOpen(): boolean;
  /** Refresh props (groups / selection); re-renders when open. */
  update(props: Partial<GuideCategoryPickerProps>): void;
  /**
   * One-layer B handling: true when consumed (level up, or onBack
   * at the top level). The Guide's B section calls this first.
   */
  handleBack(): boolean;
  destroy(): void;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function mountGuideCategoryPicker(
  mount: HTMLElement,
  trigger: HTMLElement,
  initialProps: GuideCategoryPickerProps,
): GuideCategoryPickerHandle {
  let props: GuideCategoryPickerProps = { ...initialProps };
  let open = false;
  let level: "groups" | "subs" = "groups";
  let drilledGroupId: string | null = null;
  let destroyed = false;

  const panel = document.createElement("div");
  panel.className = "rs-guide-catdrawer";
  panel.setAttribute("data-guide-catdrawer", "");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Choose category");
  panel.hidden = true;
  panel.innerHTML =
    `<div class="rs-guide-catdrawer__head">` +
    `<span class="rs-guide-catdrawer__title">Category</span>` +
    `<span class="rs-guide-catdrawer__hint">Up / Down to browse · Right for subcategories · B goes back</span>` +
    `</div>` +
    `<div class="rs-guide-catdrawer__cols">` +
    `<div class="rs-guide-catdrawer__col rs-guide-catdrawer__groups" role="listbox" aria-label="Category groups" data-catdrawer-groups></div>` +
    `<div class="rs-guide-catdrawer__col rs-guide-catdrawer__subs" role="listbox" aria-label="Subcategories" data-catdrawer-subs hidden></div>` +
    `</div>`;
  mount.appendChild(panel);
  const groupsEl = panel.querySelector<HTMLElement>("[data-catdrawer-groups]")!;
  const subsEl = panel.querySelector<HTMLElement>("[data-catdrawer-subs]")!;

  function selectedGroup(): GuideCategoryGroupView | null {
    const id = props.selectedGroupId;
    if (id === null) return props.groups[0] ?? null;
    return props.groups.find((group) => group.id === id) ?? null;
  }

  function groupButtonHtml(group: GuideCategoryGroupView): string {
    const isSelected =
      props.selectedGroupId === group.id ||
      (props.selectedGroupId === null && group === props.groups[0]);
    const hasSubs = group.subcategories.length > 0;
    return (
      `<button type="button" role="option" aria-selected="${isSelected}" ` +
      `class="rs-guide-catdrawer__item${isSelected ? " rs-guide-catdrawer__item--selected" : ""}" ` +
      `data-catdrawer-group="${escapeHtml(group.id)}" ` +
      `data-focus-key="guide:category:group:${escapeHtml(group.id)}">` +
      `<span class="rs-guide-catdrawer__label">${escapeHtml(group.label)}</span>` +
      `<span class="rs-guide-catdrawer__count">${group.channelCount.toLocaleString()}</span>` +
      (hasSubs ? `<span class="rs-guide-catdrawer__chev" aria-hidden="true">›</span>` : "") +
      `</button>`
    );
  }

  function renderGroups(): void {
    groupsEl.innerHTML = props.groups.map(groupButtonHtml).join("");
  }

  function renderSubs(group: GuideCategoryGroupView): void {
    const allSelected =
      props.selectedGroupId === group.id && props.selectedSubcategoryId === null;
    const allRow =
      `<button type="button" role="option" aria-selected="${allSelected}" ` +
      `class="rs-guide-catdrawer__item${allSelected ? " rs-guide-catdrawer__item--selected" : ""}" ` +
      `data-catdrawer-sub="__all_in_group__" data-catdrawer-group="${escapeHtml(group.id)}" ` +
      `data-focus-key="guide:category:sub:${escapeHtml(group.id)}:__all__">` +
      `<span class="rs-guide-catdrawer__label">All ${escapeHtml(group.label)}</span>` +
      `<span class="rs-guide-catdrawer__count">${group.channelCount.toLocaleString()}</span>` +
      `</button>`;
    const rows = group.subcategories.map((sub) => {
      const isSelected =
        props.selectedGroupId === group.id &&
        props.selectedSubcategoryId === sub.id;
      return (
        `<button type="button" role="option" aria-selected="${isSelected}" ` +
        `class="rs-guide-catdrawer__item${isSelected ? " rs-guide-catdrawer__item--selected" : ""}" ` +
        `data-catdrawer-sub="${escapeHtml(sub.id)}" data-catdrawer-group="${escapeHtml(group.id)}" ` +
        `data-focus-key="guide:category:sub:${escapeHtml(group.id)}:${escapeHtml(sub.id)}">` +
        `<span class="rs-guide-catdrawer__label">${escapeHtml(sub.label)}</span>` +
        `<span class="rs-guide-catdrawer__count">${sub.channelCount.toLocaleString()}</span>` +
        `</button>`
      );
    });
    subsEl.innerHTML = allRow + rows.join("");
    subsEl.hidden = false;
  }

  function hideSubs(): void {
    subsEl.hidden = true;
    subsEl.innerHTML = "";
  }

  function focusGroup(id: string | null): void {
    const target =
      (id === null
        ? groupsEl.querySelector<HTMLElement>("[data-catdrawer-group]")
        : groupsEl.querySelector<HTMLElement>(
            `[data-catdrawer-group="${CSS.escape(id)}"]`,
          )) ?? groupsEl.querySelector<HTMLElement>("[data-catdrawer-group]");
    target?.focus({ preventScroll: true });
  }

  function focusSub(groupId: string, subId: string | null): void {
    const selector =
      subId === null
        ? `[data-catdrawer-sub="__all_in_group__"]`
        : `[data-catdrawer-sub="${CSS.escape(subId)}"]`;
    const target =
      subsEl.querySelector<HTMLElement>(selector) ??
      subsEl.querySelector<HTMLElement>("[data-catdrawer-sub]");
    void groupId;
    target?.focus({ preventScroll: true });
  }

  function drillInto(group: GuideCategoryGroupView): boolean {
    if (group.subcategories.length === 0) return false;
    level = "subs";
    drilledGroupId = group.id;
    renderSubs(group);
    focusSub(
      group.id,
      props.selectedGroupId === group.id ? props.selectedSubcategoryId : null,
    );
    return true;
  }

  function backToGroups(): void {
    level = "groups";
    const id = drilledGroupId;
    drilledGroupId = null;
    hideSubs();
    focusGroup(id);
  }

  function selectGroup(groupId: string): void {
    props.onSelect({ groupId, subcategoryId: null });
  }

  function selectSub(groupId: string, subId: string | null): void {
    props.onSelect({ groupId, subcategoryId: subId });
  }

  function moveWithin(list: HTMLElement, delta: number): boolean {
    const items = [...list.querySelectorAll<HTMLElement>("[data-catdrawer-group], [data-catdrawer-sub]")];
    const active = document.activeElement;
    const idx = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const next = items[idx + delta];
    if (next) {
      next.focus({ preventScroll: true });
      // Optional-chained: jsdom (tests) has no scrollIntoView.
      next.scrollIntoView?.({ block: "nearest" });
      return true;
    }
    return false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const groupBtn = target.closest<HTMLElement>("[data-catdrawer-group]");
    const subBtn = target.closest<HTMLElement>("[data-catdrawer-sub]");
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveWithin(level === "subs" ? subsEl : groupsEl, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "ArrowRight" && level === "groups" && groupBtn) {
      const group = props.groups.find((g) => g.id === groupBtn.dataset.catdrawerGroup);
      if (group && drillInto(group)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "ArrowLeft" && level === "subs") {
      event.preventDefault();
      event.stopPropagation();
      backToGroups();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handle.handleBack();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && (groupBtn || subBtn)) {
      // Let the native click fire (Space/Enter on a button) — the
      // click handler below performs the selection. Stop the Guide
      // from also treating it as a row activation.
      event.stopPropagation();
    }
  }

  function onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const subBtn = target.closest<HTMLElement>("[data-catdrawer-sub]");
    if (subBtn && level === "subs") {
      event.stopPropagation();
      const groupId = subBtn.dataset.catdrawerGroup ?? "";
      const subId = subBtn.dataset.catdrawerSub ?? "";
      selectSub(groupId, subId === "__all_in_group__" ? null : subId);
      return;
    }
    const groupBtn = target.closest<HTMLElement>("[data-catdrawer-group]");
    if (groupBtn) {
      event.stopPropagation();
      selectGroup(groupBtn.dataset.catdrawerGroup ?? "");
    }
  }

  panel.addEventListener("keydown", onKeydown);
  panel.addEventListener("click", onClick);

  const handle: GuideCategoryPickerHandle = {
    open(): void {
      if (destroyed || open) return;
      open = true;
      level = "groups";
      drilledGroupId = null;
      hideSubs();
      renderGroups();
      panel.hidden = false;
      const current = selectedGroup();
      focusGroup(current ? current.id : null);
    },
    close(opts: { focusTrigger?: boolean } = {}): void {
      if (!open) return;
      open = false;
      level = "groups";
      drilledGroupId = null;
      panel.hidden = true;
      hideSubs();
      if (opts.focusTrigger !== false) {
        trigger.focus({ preventScroll: true });
      }
    },
    isOpen(): boolean {
      return open;
    },
    update(next: Partial<GuideCategoryPickerProps>): void {
      props = { ...props, ...next };
      if (!open) return;
      renderGroups();
      if (level === "subs" && drilledGroupId) {
        const group = props.groups.find((g) => g.id === drilledGroupId);
        if (group && group.subcategories.length > 0) {
          renderSubs(group);
        } else {
          backToGroups();
        }
      }
    },
    handleBack(): boolean {
      if (!open) return false;
      if (level === "subs") {
        backToGroups();
        return true;
      }
      props.onBack();
      return true;
    },
    destroy(): void {
      destroyed = true;
      open = false;
      panel.removeEventListener("keydown", onKeydown);
      panel.removeEventListener("click", onClick);
      panel.remove();
    },
  };
  return handle;
}
