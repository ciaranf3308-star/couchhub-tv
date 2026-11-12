/**
 * @vitest-environment jsdom
 *
 * Live TV 2.0 (0.11.7) W5 — test 7: the Guide stays bounded.
 *
 *   7. Guide On Now and By Channel remain bounded with 2,000+
 *      entries.
 *
 * Rows are built by the REAL nowNextRows helper from fixture EPG
 * (channels with nothing on now never produce a row); mounting is
 * the STUB-FOR-INTEGRATION virtualised Guide list (the W3
 * contract). Integration re-points the mounting at W3's real
 * Guide lists, keeping the assertions.
 * Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nowNextRows } from "@/scripts/lib/livetv-guide";
import {
  mountGuideList,
  virtualRowBound,
  type GuideChannelRow,
} from "./stubs/guide.stub";
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

const ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 600;
const OVERSCAN = 3;

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
    const handle = mountGuideList(root, {
      mode: "now",
      rows,
      rowHeight: ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscanRows: OVERSCAN,
    });
    expect(handle.getRowCount()).toBe(2500);
    expect(handle.getMountedRowCount()).toBeGreaterThan(0);
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(
      virtualRowBound(VIEWPORT_HEIGHT, ROW_HEIGHT, OVERSCAN),
    );
    handle.destroy();
  });

  it("On Now stays bounded across scrolling and focus movement", { timeout: 30_000 }, () => {
    const { programmes } = buildGuideFixture(2500);
    const rows = nowNextRows(programmes, FIXTURE_NOW_MS);
    const handle = mountGuideList(root, {
      mode: "now",
      rows,
      rowHeight: ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscanRows: OVERSCAN,
    });
    const bound = virtualRowBound(VIEWPORT_HEIGHT, ROW_HEIGHT, OVERSCAN);
    for (let step = 0; step < 60; step++) {
      handle.scrollByRows(17);
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
    const handle = mountGuideList(root, {
      mode: "channel",
      rows,
      rowHeight: ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscanRows: OVERSCAN,
    });
    expect(handle.getRowCount()).toBe(2500);
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(
      virtualRowBound(VIEWPORT_HEIGHT, ROW_HEIGHT, OVERSCAN),
    );
    handle.destroy();
  });

  it("By Channel stays bounded across scrolling and focus movement", { timeout: 30_000 }, () => {
    const { channels, programmes } = buildGuideFixture(2500);
    const rows: GuideChannelRow[] = channels.map((channel) => ({
      channelId: String(channel.id),
      channelName: channel.displayName,
      programmes: programmes.get(String(channel.id)) ?? [],
    }));
    const handle = mountGuideList(root, {
      mode: "channel",
      rows,
      rowHeight: ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscanRows: OVERSCAN,
    });
    const bound = virtualRowBound(VIEWPORT_HEIGHT, ROW_HEIGHT, OVERSCAN);
    for (let step = 0; step < 60; step++) {
      handle.scrollByRows(23);
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
    const handle = mountGuideList(root, {
      mode: "now",
      rows,
      rowHeight: ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscanRows: OVERSCAN,
    });
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(
      virtualRowBound(VIEWPORT_HEIGHT, ROW_HEIGHT, OVERSCAN),
    );
    handle.destroy();
  });

  it("an empty guide mounts zero rows without crashing", () => {
    const rows = nowNextRows(new Map(), FIXTURE_NOW_MS);
    expect(rows).toEqual([]);
    const handle = mountGuideList(root, {
      mode: "now",
      rows,
      rowHeight: ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscanRows: OVERSCAN,
    });
    expect(handle.getMountedRowCount()).toBe(0);
    expect(handle.moveFocus(1)).toBeNull();
    handle.destroy();
  });
});
