// Guide category picker (Live TV 0.11.7, W3 + integration).
//
// The Guide's category drawer, implemented on W2's shared drawer
// module (livetv-category-drawer.ts / mountCategoryDrawer) — the
// SAME drawer the Channel Browser uses, so category navigation
// behaves identically in both surfaces. The Guide cannot use the
// TvCategoryDrawer.astro wrapper: Astro components cannot take
// live props from a client script, and the Guide's groups derive
// from the runtime catalogue. This module is therefore a thin
// DOM controller with the drawer contract:
//
//   props: groups, selectedGroupId, selectedSubcategoryId,
//          onSelect, onBack
//
// The Guide (TvGuideView.astro) mounts it through
// `mountGuideCategoryPicker(mount, props)` and talks to it ONLY
// through those props plus open()/close()/update()/handleBack()/
// handleKey(). Selection REPLACES the previous filter (never
// intersects); picking a category only filters the Guide (no
// auto-tuning).
//
// Behaviour is the drawer's contract (see
// livetv-category-drawer.ts): vertical top-level list; Enter on
// a real group opens its provider subcategories ("All <Group>"
// first); Enter on a subcategory or "All <Group>" selects it;
// Left in subcategories returns to groups; Right closes without
// a selection; B is one layer (subcategories → groups → onBack).
// The drawer lists categories (tens), not channels — it needs
// no virtualisation; channel scale is the lists' problem.
//
// Groups carry the adapter's view shape (id / label / channelCount
// / subcategories); pseudo-groups ("All categories", "Favourites",
// "Recently watched") arrive as ordinary groups with the
// GUIDE_CATEGORY_* ids and no subcategories, and map to drawer
// pseudo-entries (select immediately, never drill).

import type { GuideCategoryGroupView } from "./livetv-guide-categories";
import { GUIDE_CATEGORY_ALL } from "./livetv-guide-categories";
import {
  mountCategoryDrawer,
  type CategoryDrawerHandle,
  type DrawerGroup,
  type DrawerLevel,
} from "./livetv-category-drawer";

/** Drawer-contract selection payload. */
export interface GuideCategoryDrawerSelection {
  /** Group id (verbatim, pseudo-ids included), or null for "all". */
  groupId: string | null;
  /** W1 subcategory id, or null for the whole group. */
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
  /**
   * Route one key event to the open drawer; true when the drawer
   * consumed it. The Guide calls this for non-B keys while the
   * picker is open (B routes through handleBack / the nav stack).
   */
  handleKey(event: KeyboardEvent): boolean;
  /** Current drawer level ("groups" when closed). */
  getLevel(): DrawerLevel;
  destroy(): void;
}

/** Adapter view groups → drawer groups (counts verbatim, never invented). */
function toDrawerGroups(
  groups: GuideCategoryGroupView[],
): DrawerGroup[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    count: group.channelCount,
    opensSubcategories: group.subcategories.length > 0,
    subcategories: group.subcategories.map((sub) => ({
      id: sub.id,
      label: sub.label,
      count: sub.channelCount,
    })),
  }));
}

export function mountGuideCategoryPicker(
  mount: HTMLElement,
  trigger: HTMLElement,
  initialProps: GuideCategoryPickerProps,
): GuideCategoryPickerHandle {
  let props: GuideCategoryPickerProps = { ...initialProps };
  let drawerHandle: CategoryDrawerHandle | null = null;
  let destroyed = false;

  /** The drawer's selected-group id: null (Guide "all") maps to the "__all__" pseudo-entry. */
  function drawerSelectedGroupId(): string | null {
    return props.selectedGroupId ?? GUIDE_CATEGORY_ALL;
  }

  function mountDrawer(): CategoryDrawerHandle {
    drawerHandle = mountCategoryDrawer(mount, {
      groups: toDrawerGroups(props.groups),
      selectedGroupId: drawerSelectedGroupId(),
      selectedSubcategoryId: props.selectedSubcategoryId,
      label: "Choose category",
      onSelect: (selection) => {
        props.onSelect({
          groupId: selection.groupId,
          subcategoryId: selection.subcategoryId,
        });
      },
      onBack: () => {
        props.onBack();
      },
    });
    return drawerHandle;
  }

  function destroyDrawer(): void {
    if (!drawerHandle) return;
    const handle = drawerHandle;
    drawerHandle = null;
    handle.destroy();
  }

  const handle: GuideCategoryPickerHandle = {
    open(): void {
      if (destroyed || drawerHandle) return;
      mountDrawer().focusCurrent();
    },
    close(opts: { focusTrigger?: boolean } = {}): void {
      if (!drawerHandle) return;
      destroyDrawer();
      if (opts.focusTrigger !== false) {
        trigger.focus({ preventScroll: true });
      }
    },
    isOpen(): boolean {
      return drawerHandle != null;
    },
    update(next: Partial<GuideCategoryPickerProps>): void {
      props = { ...props, ...next };
      if (!drawerHandle) return;
      // Groups/counts refresh in place, keeping the nav state by
      // id. The applied-selection highlight follows the props
      // captured at open; a selection change while open takes
      // effect on the next open (selection changes close the
      // picker through onSelect in practice).
      drawerHandle.updateGroups(toDrawerGroups(props.groups));
    },
    handleBack(): boolean {
      if (!drawerHandle) return false;
      // Subcategories → groups (no close); groups → onBack (the
      // Guide closes the drawer). Exactly one layer per press.
      drawerHandle.pressBack();
      return true;
    },
    handleKey(event: KeyboardEvent): boolean {
      if (!drawerHandle) return false;
      return drawerHandle.handleKey(event);
    },
    getLevel(): DrawerLevel {
      return drawerHandle?.getLevel() ?? "groups";
    },
    destroy(): void {
      destroyed = true;
      destroyDrawer();
    },
  };
  return handle;
}
