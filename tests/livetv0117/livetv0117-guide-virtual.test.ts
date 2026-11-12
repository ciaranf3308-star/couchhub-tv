/**
 * @vitest-environment jsdom
 *
 * Live TV 2.0 (0.11.7) W5 — test 7: the Guide stays bounded.
 *
 *   7. Guide On Now and By Channel remain bounded with 2,000+
 *      entries.
 *
 * Rows are built by the REAL nowNextRows helper from fixture EPG
 * (channels with nothing on now never produce a row); mounting
 * uses W3's REAL virtual-list engine (createVirtualList, spacer
 * mode — the mode the Guide's On Now list and By Channel picker
 * use) with the real row heights. The bound is the brief's row
 * formula — ceil(viewport/rowHeight) + 2·overscan + 1 — computed
 * through the real virtualListWindow math (+1 covers the engine's
 * one pinned focused node).
 * Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nowNextRows, type GuideNowRow } from "@/scripts/lib/livetv-guide";
import { guideProgrammeKey } from "@/scripts/lib/livetv-state";
import {
  createVirtualList,
  virtualListWindow,
  type VirtualListHandle,
} from "@/scripts/lib/livetv-guide-virtual";
import {
  FIXTURE_NOW_MS,
  buildFixtureProgrammes,
  buildGuideFixture,
} from "./fixtures";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
});

const VIEWPORT_HEIGHT = 600;
const OVERSCAN = 4;
/** Real Guide row heights (TvGuideView.astro fallbacks, measured after paint in production). */
const NOW_ROW_HEIGHT = 112;
const PICK_ROW_HEIGHT = 80;

async function nextFrames(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

interface GuideChannelRow {
  channelId: string;
  channelName: string;
  programmes: readonly unknown[];
}

type GuideListRow = GuideNowRow | GuideChannelRow;

function isNowRow(row: GuideListRow): row is GuideNowRow {
  return "current" in row;
}

/** The brief's row bound: the maximum window over all scroll positions (mid-list, overscan both sides) + 1 pinned focused node, through the real window math. */
function rowBound(total: number, rowHeightPx: number): number {
  const win = virtualListWindow({
    total,
    rowHeightPx,
    scrollTopPx: rowHeightPx * 100,
    viewportHeightPx: VIEWPORT_HEIGHT,
    overscanRows: OVERSCAN,
  });
  return win.endIndex - win.startIndex + 1;
}

/**
 * Mount W3's real virtual list over Guide rows, with a mocked
 * scroll container (jsdom has no layout). Keys match production:
 * On Now rows key by programme (channel + start), By Channel rows
 * by channel.
 */
function mountRealGuideList(
  rootEl: HTMLElement,
  opts: { mode: "now" | "channel"; rows: readonly GuideListRow[]; rowHeightPx: number },
): {
  getRowCount(): number;
  getMountedRowCount(): number;
  getMountedKeys(): string[];
  moveFocus(delta: number): string | null;
  scrollByRows(rows: number): Promise<void>;
  destroy(): void;
} {
  const container = document.createElement("div");
  rootEl.appendChild(container);
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
    configurable: true,
  });
  Object.defineProperty(container, "clientHeight", {
    get: () => VIEWPORT_HEIGHT,
    configurable: true,
  });
  const keyOf = (row: GuideListRow): string =>
    opts.mode === "now" && isNowRow(row)
      ? guideProgrammeKey(row.channelId, row.current.startMs)
      : (row as GuideChannelRow).channelId;
  const list: VirtualListHandle<GuideListRow> = createVirtualList<GuideListRow>({
    container,
    mode: "spacer",
    rowHeightPx: opts.rowHeightPx,
    overscanRows: OVERSCAN,
    keyOf: (row) => keyOf(row),
    renderRow: (row, _index, existing) => {
      const label = isNowRow(row) ? row.current.title : row.channelName;
      if (existing) {
        existing.textContent = label;
        return existing;
      }
      const node = document.createElement("button");
      node.setAttribute("data-focus-key", keyOf(row));
      node.textContent = label;
      return node;
    },
  });
  list.setItems(opts.rows);
  list.renderNow();
  let focusIndex = 0;
  return {
    getRowCount: () => list.getItems().length,
    getMountedRowCount: () => list.mountedCount(),
    getMountedKeys: () =>
      [...container.querySelectorAll("[data-focus-key]")].map(
        (el) => el.getAttribute("data-focus-key") ?? "",
      ),
    moveFocus(delta: number): string | null {
      const items = list.getItems();
      if (items.length === 0) return null;
      focusIndex = Math.max(0, Math.min(items.length - 1, focusIndex + delta));
      const node = list.ensureIndexVisible(focusIndex);
      node?.focus({ preventScroll: true });
      return keyOf(items[focusIndex]!);
    },
    async scrollByRows(rows: number): Promise<void> {
      scrollTop += rows * opts.rowHeightPx;
      container.dispatchEvent(new Event("scroll"));
      await nextFrames();
      list.renderNow();
    },
    destroy(): void {
      list.destroy();
      container.remove();
    },
  };
}

describe("test 7 — Guide On Now and By Channel remain bounded", () => {
  it("On Now builds 2,500 real rows from fixture EPG", () => {
    const { programmes } = buildGuideFixture(2500);
    const rows = nowNextRows(programmes, FIXTURE_NOW_MS);
    expect(rows).toHaveLength(2500);
    // Every row genuinely has a programme on now.
    for (const row of rows) {
      expect(row.current.startMs).toBeLessThanOrEqual(FIXTURE_NOW_MS);
      expect(row.current.stopMs).toBeGreaterThan(FIXTURE_NOW_MS);
    }
  });

  it("On Now mounts only a bounded window with 2,500 entries", () => {
    const { programmes } = buildGuideFixture(2500);
    const rows = nowNextRows(programmes, FIXTURE_NOW_MS);
    const handle = mountRealGuideList(root, {
      mode: "now",
      rows,
      rowHeightPx: NOW_ROW_HEIGHT,
    });
    expect(handle.getRowCount()).toBe(2500);
    expect(handle.getMountedRowCount()).toBeGreaterThan(0);
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(
      rowBound(2500, NOW_ROW_HEIGHT),
    );
    handle.destroy();
  });

  it("On Now stays bounded across scrolling and focus movement", { timeout: 30_000 }, async () => {
    const { programmes } = buildGuideFixture(2500);
    const rows = nowNextRows(programmes, FIXTURE_NOW_MS);
    const handle = mountRealGuideList(root, {
      mode: "now",
      rows,
      rowHeightPx: NOW_ROW_HEIGHT,
    });
    const bound = rowBound(2500, NOW_ROW_HEIGHT);
    for (let step = 0; step < 60; step++) {
      await handle.scrollByRows(17);
      expect(handle.getMountedRowCount()).toBeLessThanOrEqual(bound);
    }
    for (let step = 0; step < 400; step++) {
      const focused = handle.moveFocus(1);
      expect(focused).not.toBeNull();
      expect(handle.getMountedKeys()).toContain(focused);
      expect(handle.getMountedRowCount()).toBeLessThanOrEqual(bound);
    }
    handle.destroy();
  });

  it("By Channel mounts only a bounded window with 2,500 channels", () => {
    const { channels, programmes } = buildGuideFixture(2500);
    const rows: GuideChannelRow[] = channels.map((channel) => ({
      channelId: String(channel.id),
      channelName: channel.displayName,
      programmes: programmes.get(String(channel.id)) ?? [],
    }));
    const handle = mountRealGuideList(root, {
      mode: "channel",
      rows,
      rowHeightPx: PICK_ROW_HEIGHT,
    });
    expect(handle.getRowCount()).toBe(2500);
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(
      rowBound(2500, PICK_ROW_HEIGHT),
    );
    handle.destroy();
  });

  it("By Channel stays bounded across scrolling and focus movement", { timeout: 30_000 }, async () => {
    const { channels, programmes } = buildGuideFixture(2500);
    const rows: GuideChannelRow[] = channels.map((channel) => ({
      channelId: String(channel.id),
      channelName: channel.displayName,
      programmes: programmes.get(String(channel.id)) ?? [],
    }));
    const handle = mountRealGuideList(root, {
      mode: "channel",
      rows,
      rowHeightPx: PICK_ROW_HEIGHT,
    });
    const bound = rowBound(2500, PICK_ROW_HEIGHT);
    for (let step = 0; step < 60; step++) {
      await handle.scrollByRows(23);
      expect(handle.getMountedRowCount()).toBeLessThanOrEqual(bound);
    }
    for (let step = 0; step < 400; step++) {
      const focused = handle.moveFocus(1);
      expect(handle.getMountedKeys()).toContain(focused);
      expect(handle.getMountedRowCount()).toBeLessThanOrEqual(bound);
    }
    handle.destroy();
  });

  it("sparse EPG yields fewer On Now rows, still bounded", () => {
    const { channels } = buildGuideFixture(2500);
    const sparse = buildFixtureProgrammes(channels, { coverage: 0.3 });
    const rows = nowNextRows(sparse, FIXTURE_NOW_MS);
    expect(rows.length).toBeGreaterThan(400);
    expect(rows.length).toBeLessThan(2500);
    const handle = mountRealGuideList(root, {
      mode: "now",
      rows,
      rowHeightPx: NOW_ROW_HEIGHT,
    });
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(
      rowBound(rows.length, NOW_ROW_HEIGHT),
    );
    handle.destroy();
  });

  it("an empty guide mounts zero rows without crashing", () => {
    const rows = nowNextRows(new Map(), FIXTURE_NOW_MS);
    expect(rows).toEqual([]);
    const handle = mountRealGuideList(root, {
      mode: "now",
      rows,
      rowHeightPx: NOW_ROW_HEIGHT,
    });
    expect(handle.getMountedRowCount()).toBe(0);
    expect(handle.moveFocus(1)).toBeNull();
    handle.destroy();
  });
});
