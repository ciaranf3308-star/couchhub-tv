/**
 * @vitest-environment jsdom
 */
// 0.11.8 W2 — keyed page grid + pagination math (brief §1.4, §6.2–§6.3, §15.4).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createKeyedPageGrid,
  pageSizeForGrid,
  pageSlice,
} from "@/scripts/lib/couch-grid";

beforeEach(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const flush = async (ms = 20) => new Promise((r) => setTimeout(r, ms));

function item(key: string, signature = "v1") {
  return { key, signature };
}

describe("page-size math", () => {
  it("lands ~30 posters in the 24–36 band", () => {
    expect(pageSizeForGrid(6, 5)).toBe(30);
    expect(pageSizeForGrid(8, 5)).toBe(36);
    expect(pageSizeForGrid(4, 5)).toBe(24);
    expect(pageSizeForGrid(6, 4)).toBe(24);
  });

  it("pageSlice bounds pages", () => {
    const items = Array.from({ length: 65 }, (_, i) => i);
    expect(pageSlice(items, 1, 30)).toHaveLength(30);
    expect(pageSlice(items, 3, 30)).toHaveLength(5);
    expect(pageSlice(items, 4, 30)).toEqual([]);
    expect(pageSlice(items, 0, 30)).toHaveLength(30);
  });
});

describe("createKeyedPageGrid", () => {
  it("mounts only the current page's nodes", async () => {
    const grid = createKeyedPageGrid({
      buildCard: (item) => {
        const node = document.createElement("div");
        node.setAttribute("data-browse-key", item.key);
        node.textContent = item.key;
        return node;
      },
    });
    document.body.appendChild(grid.el);
    grid.setPage(Array.from({ length: 30 }, (_, i) => item(`k${i}`)));
    await flush();
    expect(grid.mountedCount()).toBe(30);
    expect(grid.el.children.length).toBe(30);
    grid.destroy();
  });

  it("REUSES stable nodes across renders (same key + signature = same node)", async () => {
    const built: string[] = [];
    const grid = createKeyedPageGrid({
      buildCard: (it) => {
        built.push(it.key);
        const node = document.createElement("div");
        node.setAttribute("data-browse-key", it.key);
        return node;
      },
    });
    document.body.appendChild(grid.el);
    grid.setPage([item("a"), item("b"), item("c")]);
    await flush();
    const nodeB = grid.el.children[1];
    grid.setPage([item("a"), item("b"), item("d")]);
    await flush();
    expect(built).toEqual(["a", "b", "c", "d"]);
    expect(grid.el.children[1]).toBe(nodeB);
    expect(grid.mountedKeys()).toEqual(["a", "b", "d"]);
    grid.destroy();
  });

  it("updates in place on signature change via updateCard, rebuilds otherwise", async () => {
    const grid = createKeyedPageGrid({
      buildCard: (it) => {
        const node = document.createElement("div");
        node.setAttribute("data-browse-key", it.key);
        node.textContent = it.signature;
        return node;
      },
      updateCard: (node, it) => {
        node.textContent = it.signature;
        return true;
      },
    });
    document.body.appendChild(grid.el);
    grid.setPage([item("a", "v1")]);
    await flush();
    const node = grid.el.children[0];
    grid.setPage([item("a", "v2")]);
    await flush();
    expect(grid.el.children[0]).toBe(node);
    expect(grid.el.children[0].textContent).toBe("v2");
    grid.destroy();
  });

  it("cancels obsolete work: a newer setPage wins", async () => {
    const grid = createKeyedPageGrid({
      buildCard: (it) => {
        const node = document.createElement("div");
        node.setAttribute("data-browse-key", it.key);
        return node;
      },
    });
    document.body.appendChild(grid.el);
    grid.setPage([item("stale-1"), item("stale-2")]);
    grid.setPage([item("fresh")]);
    await flush();
    expect(grid.mountedKeys()).toEqual(["fresh"]);
    grid.destroy();
  });

  it("focusKey focuses the mounted card; destroy removes everything", async () => {
    const grid = createKeyedPageGrid({
      buildCard: (it) => {
        const node = document.createElement("a");
        node.href = "#";
        node.setAttribute("data-browse-key", it.key);
        return node;
      },
    });
    document.body.appendChild(grid.el);
    grid.setPage([item("a"), item("b")]);
    await flush();
    expect(grid.focusKey("b")).toBe(true);
    expect(document.activeElement).toBe(grid.el.children[1]);
    expect(grid.focusKey("missing")).toBe(false);
    grid.destroy();
    expect(grid.el.isConnected).toBe(false);
    expect(grid.mountedCount()).toBe(0);
  });
});
