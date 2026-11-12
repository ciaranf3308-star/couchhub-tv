// @vitest-environment jsdom
/**
 * Drawer hover guard (0.11.8 integration fix, brief §7.3/§16.4).
 *
 * Chromium fires mouseenter when a drawer opens (or re-renders) under a
 * stationary pointer. Both drawers used to move state + DOM focus on
 * mouseenter, so a parked mouse stole focus off the selected row on
 * open — caught by the screenshot gate (drawer opened focused on
 * "Genres" instead of the selected "All Movies", via click AND via
 * keyboard, because the pointer never moved). Hover now takes effect
 * only after real mouse movement, and every render re-arms the guard.
 * Clicks are unaffected.
 */
import { describe, expect, it, vi } from "vitest";
import {
  mountBrowseCategoryDrawer,
  type BrowseDrawerFamily,
} from "@/scripts/lib/browse-category-drawer";
import {
  DEFAULT_FILTER_DRAWER_AVAILABILITY,
  mountBrowseFilterDrawer,
} from "@/scripts/lib/browse-filter-drawer";
import { createBrowseFilters } from "@/scripts/lib/browse-state";

const FAMILIES: BrowseDrawerFamily[] = [
  {
    id: "all",
    label: "All Movies",
    icon: "▦",
    count: 3,
    items: [
      {
        id: "all",
        label: "All Movies",
        count: 3,
        category: { kind: "all", id: "all", label: "All Movies" },
      },
    ],
  },
  {
    id: "genres",
    label: "Genres",
    icon: "◆",
    count: 3,
    items: [
      {
        id: "action",
        label: "Action",
        count: 2,
        category: { kind: "genre", id: "action", label: "Action" },
      },
      {
        id: "drama",
        label: "Drama",
        count: 1,
        category: { kind: "genre", id: "drama", label: "Drama" },
      },
    ],
  },
  {
    id: "collections",
    label: "Collections",
    icon: "★",
    count: 3,
    items: [
      {
        id: "recent",
        label: "Recently Added",
        count: 3,
        category: { kind: "collection", id: "recent", label: "Recently Added" },
      },
    ],
  },
];

function drawerItems(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-category-drawer-item]")];
}

describe("category drawer hover guard (§7.3 opens on selected)", () => {
  it("ignores mouseenter from a stationary pointer on open", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const drawer = mountBrowseCategoryDrawer(host, {
      families: FAMILIES,
      selected: { kind: "all", id: "all", label: "All Movies" },
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    try {
      drawer.focusCurrent();
      const items = drawerItems(host);
      expect(document.activeElement).toBe(items[0]);
      // Stationary pointer: mouseenter with no preceding mousemove.
      items[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(document.activeElement).toBe(items[0]);
      expect(drawer.getState().familyIndex).toBe(0);
      expect(items[0].classList.contains("is-focused")).toBe(true);
    } finally {
      drawer.destroy();
      host.remove();
    }
  });

  it("honours hover after real mouse movement", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const drawer = mountBrowseCategoryDrawer(host, {
      families: FAMILIES,
      selected: { kind: "all", id: "all", label: "All Movies" },
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    try {
      drawer.focusCurrent();
      const items = drawerItems(host);
      // Real movement: the event targets the row and bubbles through
      // the drawer root, where the guard's listener lives.
      items[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      items[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(document.activeElement).toBe(items[1]);
      expect(drawer.getState().familyIndex).toBe(1);
    } finally {
      drawer.destroy();
      host.remove();
    }
  });

  it("re-arms the guard on re-render", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const drawer = mountBrowseCategoryDrawer(host, {
      families: FAMILIES,
      selected: { kind: "all", id: "all", label: "All Movies" },
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    try {
      drawer.focusCurrent();
      drawerItems(host)[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      drawerItems(host)[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(drawer.getState().familyIndex).toBe(1);
      // Re-render replaces nodes under the (now stationary) pointer.
      drawer.updateFamilies(FAMILIES);
      const items = drawerItems(host);
      items[2].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(drawer.getState().familyIndex).toBe(1);
    } finally {
      drawer.destroy();
      host.remove();
    }
  });

  it("clicks still activate without any mouse movement", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onSelect = vi.fn();
    const drawer = mountBrowseCategoryDrawer(host, {
      families: FAMILIES,
      selected: { kind: "all", id: "all", label: "All Movies" },
      onSelect,
      onBack: vi.fn(),
    });
    try {
      // Clicking the single-item Collections family selects it directly.
      drawerItems(host)[2].click();
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "collection", id: "recent" }),
      );
    } finally {
      drawer.destroy();
      host.remove();
    }
  });
});

describe("filter drawer hover guard (§16.4)", () => {
  it("ignores mouseenter from a stationary pointer, honours it after movement", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const drawer = mountBrowseFilterDrawer(host, {
      kind: "movie",
      initial: createBrowseFilters(),
      availability: DEFAULT_FILTER_DRAWER_AVAILABILITY,
      genreIds: ["action", "drama"],
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });
    try {
      drawer.focusCurrent();
      const rows = [...host.querySelectorAll<HTMLElement>("[data-filter-drawer-row]")];
      expect(rows.length).toBeGreaterThan(2);
      expect(document.activeElement).toBe(rows[0]);
      const firstFamily = drawer.getFocusedFamilyId();
      rows[2].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(document.activeElement).toBe(rows[0]);
      expect(drawer.getFocusedFamilyId()).toBe(firstFamily);
      rows[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      rows[2].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(document.activeElement).toBe(rows[2]);
      expect(drawer.getFocusedFamilyId()).not.toBe(firstFamily);
    } finally {
      drawer.destroy();
      host.remove();
    }
  });
});
