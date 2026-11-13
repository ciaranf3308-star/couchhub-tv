// @vitest-environment jsdom
// Live TV 0.11.11 (W4) — Guide MODES + NAVIGATION.
//
// Covers ONLY W4's new/changed behaviour: the On Now default
// scope (§11), the five failure states (shared with W3 — the
// classifier renders from observable conditions; the loadFailed
// input is W3's signal seam), the By Channel no-EPG message
// (§13), Full Guide cell-mount scroll math (§14), category
// replace semantics + drawer B levels (§15), and source guards
// that the Guide wiring exists and the 0.11.10 navigation code
// was kept. Guide behaviour against real IPTV data is hardware
// verified only — nothing here claims it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  channelScheduleEmptyMessage,
  guideDataState,
} from "@/scripts/lib/livetv-guide";
import {
  GUIDE_CATEGORY_FAVOURITES,
  GUIDE_CATEGORY_RECENTS,
  guideCategoryValueFromDrawer,
  pickDefaultGuideScope,
  resolveGuideCategory,
  sameGuideCategoryValue,
} from "@/scripts/lib/livetv-guide-categories";
import { gridScrollForCell } from "@/scripts/lib/livetv-guide-virtual";
import { mountGuideCategoryPicker } from "@/scripts/lib/livetv-guide-category-picker";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function fixtureChannels() {
  return [
    { id: 1, name: "BBC One", category: "UK | Entertainment" },
    { id: 2, name: "Sky Sports Main", category: "UK | Sports" },
    { id: 3, name: "Football 1", category: "Sports | Football" },
    { id: 4, name: "Football 2", category: "Sports | Football" },
    { id: 5, name: "F1 Channel", category: "Sports | F1" },
    { id: 6, name: "Sky News", category: "News" },
    { id: 7, name: "Movie Max", category: "Movies FHD" },
    { id: 8, name: "Mystery", category: "" },
    { id: 9, name: "RTE One", category: "IE | Entertainment" },
    { id: 10, name: "Sports Extra", category: "Sports" },
  ];
}

// ── §11 On Now default scope ────────────────────────────────────

describe("pickDefaultGuideScope", () => {
  it("starts on Favourites when the user has any", () => {
    expect(pickDefaultGuideScope({ favouriteCount: 3, recentCount: 9 })).toEqual({
      kind: "favourites",
    });
  });

  it("falls back to Recently Watched when there are no favourites", () => {
    expect(pickDefaultGuideScope({ favouriteCount: 0, recentCount: 4 })).toEqual({
      kind: "recents",
    });
  });

  it("falls back to All Channels only when neither scope has anything", () => {
    expect(pickDefaultGuideScope({ favouriteCount: 0, recentCount: 0 })).toEqual({
      kind: "all",
    });
  });

  it("treats negative / fractional counts as empty", () => {
    expect(pickDefaultGuideScope({ favouriteCount: -2, recentCount: 0.4 })).toEqual({
      kind: "all",
    });
  });
});

// ── Failure states (shared with W3) ─────────────────────────────

describe("guideDataState", () => {
  const base = {
    channelCount: 10,
    mappedChannelCount: 8,
    rowCount: 5,
    loading: false,
    loadFailed: false,
  };

  it("is ready when rows exist", () => {
    expect(guideDataState(base)).toEqual({ state: "ready", message: "" });
  });

  it("reports a genuine failure first, and never fabricates listings", () => {
    const failed = guideDataState({ ...base, loadFailed: true, loading: true });
    expect(failed.state).toBe("failure");
    expect(failed.message).toMatch(/couldn't be loaded/);
  });

  it("reports loading while activation is in flight", () => {
    expect(guideDataState({ ...base, loading: true, rowCount: 0 }).state).toBe("loading");
  });

  it("reports no-channels for an empty scope", () => {
    const state = guideDataState({
      ...base,
      channelCount: 0,
      mappedChannelCount: 0,
      rowCount: 0,
      scopeLabel: "Favourites",
    });
    expect(state.state).toBe("no-channels");
    expect(state.message).toContain("Favourites");
  });

  it("reports no-mapping when scope channels have no matched EPG, with a way out", () => {
    const state = guideDataState({
      ...base,
      mappedChannelCount: 0,
      rowCount: 0,
      scopeLabel: "Favourites",
      rangeLabel: "on now",
    });
    expect(state.state).toBe("no-mapping");
    expect(state.message).toMatch(/matched programme data/);
    expect(state.message).toMatch(/Change the scope/);
  });

  it("reports no-programmes when mapped channels simply have nothing in range", () => {
    const state = guideDataState({
      ...base,
      rowCount: 0,
      rangeLabel: "on now",
    });
    expect(state.state).toBe("no-programmes");
    expect(state.message).toBe("No programmes listed on now.");
  });

  it("keeps the five states distinct", () => {
    const states = new Set([
      guideDataState({ ...base, loadFailed: true }).state,
      guideDataState({ ...base, loading: true }).state,
      guideDataState({ ...base, channelCount: 0, mappedChannelCount: 0, rowCount: 0 }).state,
      guideDataState({ ...base, mappedChannelCount: 0, rowCount: 0 }).state,
      guideDataState({ ...base, rowCount: 0 }).state,
    ]);
    expect(states).toEqual(
      new Set(["failure", "loading", "no-channels", "no-mapping", "no-programmes"]),
    );
  });
});

// ── §13 By Channel empty text ───────────────────────────────────

describe("channelScheduleEmptyMessage", () => {
  it("names the empty category", () => {
    expect(
      channelScheduleEmptyMessage({
        visibleChannelCount: 0,
        channelHasAnyProgrammes: false,
        searching: false,
      }),
    ).toBe("No channels in this category.");
  });

  it("uses the exact no-schedule string for a channel with no EPG at all", () => {
    expect(
      channelScheduleEmptyMessage({
        visibleChannelCount: 10,
        channelHasAnyProgrammes: false,
        searching: false,
      }),
    ).toBe("No schedule available for this channel.");
  });

  it("distinguishes a search with no matches from an empty day", () => {
    expect(
      channelScheduleEmptyMessage({
        visibleChannelCount: 10,
        channelHasAnyProgrammes: true,
        searching: true,
      }),
    ).toBe("No programmes match this search for this channel on this day.");
    expect(
      channelScheduleEmptyMessage({
        visibleChannelCount: 10,
        channelHasAnyProgrammes: true,
        searching: false,
      }),
    ).toBe("No programmes listed for this channel on this day.");
  });
});

// ── §14 Full Guide cell-mount scroll math ───────────────────────

describe("gridScrollForCell", () => {
  const HOUR = 3_600_000;
  const dayStartMs = Date.UTC(2026, 10, 12, 0, 0, 0);
  const base = {
    rowIndex: 5,
    rowHeightPx: 76,
    scrollTopPx: 0,
    viewportHeightPx: 600,
    startMs: dayStartMs + 10 * HOUR,
    stopMs: dayStartMs + 11 * HOUR,
    dayStartMs,
    pxPerHour: 200,
    scrollLeftPx: 1800,
    viewportWidthPx: 1200,
  };

  it("returns null when the cell is already fully in view", () => {
    // Row 5 spans 380..456 (viewport 0..600); start x=2000 (view 1800..3000).
    expect(gridScrollForCell(base)).toBeNull();
  });

  it("scrolls up to a row above the viewport", () => {
    const out = gridScrollForCell({ ...base, rowIndex: 1, scrollTopPx: 500 });
    expect(out).not.toBeNull();
    expect(out!.scrollTop).toBe(76);
    expect(out!.scrollLeft).toBe(1800);
  });

  it("scrolls down to a row below the viewport", () => {
    const out = gridScrollForCell({ ...base, rowIndex: 50 });
    expect(out).not.toBeNull();
    // Row 50 spans 3800..3876; viewport must end at 3876.
    expect(out!.scrollTop).toBe(3876 - 600);
  });

  it("scrolls left to a cell starting before the time window", () => {
    const out = gridScrollForCell({
      ...base,
      startMs: dayStartMs + 2 * HOUR,
      stopMs: dayStartMs + 3 * HOUR,
    });
    expect(out).not.toBeNull();
    expect(out!.scrollLeft).toBe(400);
    expect(out!.scrollTop).toBe(0);
  });

  it("aligns a cell starting past the right edge with the left edge", () => {
    const out = gridScrollForCell({
      ...base,
      startMs: dayStartMs + 20 * HOUR,
      stopMs: dayStartMs + 21 * HOUR,
    });
    expect(out).not.toBeNull();
    expect(out!.scrollLeft).toBe(4000);
  });

  it("clamps negative offsets to zero", () => {
    const out = gridScrollForCell({
      ...base,
      rowIndex: 0,
      scrollTopPx: 500,
      startMs: dayStartMs - HOUR,
      stopMs: dayStartMs,
    });
    expect(out).not.toBeNull();
    expect(out!.scrollTop).toBe(0);
    expect(out!.scrollLeft).toBe(0);
  });

  it("holds at 15,319 channels: the entry row deep in the list scrolls exactly to it", () => {
    const out = gridScrollForCell({ ...base, rowIndex: 15318 });
    expect(out).not.toBeNull();
    expect(out!.scrollTop).toBe(15318 * 76 + 76 - 600);
  });
});

// ── §15 Category replace semantics + drawer B levels ────────────

describe("category selection replaces (never intersects)", () => {
  const context = {
    revision: 7,
    favouriteIds: new Set<string | number>([1, 6]),
    recentIds: ["7", "2"],
  };

  it("a second selection replaces the first: channels equal the new scope exactly", () => {
    const channels = fixtureChannels();
    const first = resolveGuideCategory(channels, { kind: "favourites" }, context);
    expect(first.channels.map((c) => c.id)).toEqual([1, 6]);
    const second = resolveGuideCategory(
      channels,
      { kind: "group", groupId: "sports", subcategoryId: null },
      context,
    );
    expect(second.channels.map((c) => c.id)).toEqual([2, 3, 4, 5, 10]);
    const third = resolveGuideCategory(channels, { kind: "recents" }, context);
    expect(third.channels.map((c) => c.id)).toEqual([7, 2]);
  });

  it("drawer ids round-trip through the adapter values", () => {
    expect(guideCategoryValueFromDrawer(GUIDE_CATEGORY_FAVOURITES, null)).toEqual({
      kind: "favourites",
    });
    expect(guideCategoryValueFromDrawer(GUIDE_CATEGORY_RECENTS, null)).toEqual({
      kind: "recents",
    });
    expect(
      sameGuideCategoryValue(
        guideCategoryValueFromDrawer("sports", "sub:sports-f1"),
        { kind: "group", groupId: "sports", subcategoryId: "sub:sports-f1" },
      ),
    ).toBe(true);
    expect(
      sameGuideCategoryValue({ kind: "favourites" }, { kind: "recents" }),
    ).toBe(false);
  });
});

describe("category picker B levels (one layer per press)", () => {
  function mountPicker() {
    const mount = document.createElement("div");
    const trigger = document.createElement("button");
    document.body.appendChild(mount);
    document.body.appendChild(trigger);
    const selected: Array<{ groupId: string | null; subcategoryId: string | null }> = [];
    let backs = 0;
    const picker = mountGuideCategoryPicker(mount, trigger, {
      groups: [
        { id: "__all__", label: "All categories", channelCount: 10, subcategories: [] },
        { id: "__favorites__", label: "Favourites", channelCount: 2, subcategories: [] },
        { id: "__recents__", label: "Recently watched", channelCount: 2, subcategories: [] },
        {
          id: "sports",
          label: "Sports",
          channelCount: 5,
          subcategories: [
            { id: "sub:sports-football", label: "Sports Football", channelCount: 2 },
          ],
        },
      ],
      selectedGroupId: null,
      selectedSubcategoryId: null,
      onSelect: (selection) => selected.push(selection),
      onBack: () => {
        backs += 1;
      },
    });
    return { mount, trigger, picker, selected, get backs() { return backs; } };
  }

  const key = (keyName: string) =>
    new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true });

  it("exposes All / Favourites / Recents / groups / subcategories, and B steps exactly one level", () => {
    const ctx = mountPicker();
    const { mount, picker } = ctx;
    picker.open();
    const labels = [...mount.querySelectorAll(".rs-tv-category-drawer__item-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["All categories", "Favourites", "Recently watched", "Sports"]);
    // Drill: All → Favourites → Recents → Sports, then Enter into subcategories.
    picker.handleKey(key("ArrowDown"));
    picker.handleKey(key("ArrowDown"));
    picker.handleKey(key("ArrowDown"));
    picker.handleKey(key("Enter"));
    expect(picker.getLevel()).toBe("subcategories");
    // B #1: subcategories → groups (drawer still open, no onBack).
    expect(picker.handleBack()).toBe(true);
    expect(picker.getLevel()).toBe("groups");
    expect(ctx.backs).toBe(0);
    expect(picker.isOpen()).toBe(true);
    // B #2: groups → onBack (the Guide closes the drawer).
    expect(picker.handleBack()).toBe(true);
    expect(ctx.backs).toBe(1);
    expect(ctx.selected).toEqual([]);
    picker.destroy();
    mount.remove();
  });

  it("selecting a pseudo-group selects immediately without drilling", () => {
    const ctx = mountPicker();
    const { mount, picker } = ctx;
    picker.open();
    picker.handleKey(key("ArrowDown"));
    picker.handleKey(key("Enter"));
    expect(ctx.selected).toEqual([{ groupId: "__favorites__", subcategoryId: null }]);
    picker.destroy();
    mount.remove();
  });
});

// ── Source guards: W4 wiring present, 0.11.10 navigation kept ───

describe("Guide source guards (0.11.11 W4)", () => {
  const guide = read("src/components/couch/TvGuideView.astro");

  it("applies the On Now default scope through the adapter (no second list)", () => {
    expect(guide).toContain("pickDefaultGuideScope");
    expect(guide).toContain("categorySelectionExplicit");
  });

  it("renders On Now failure states through the classifier + a scope-change action", () => {
    expect(guide).toContain("guideDataState");
    expect(guide).toContain("data-guide-now-change-scope");
  });

  it("keeps the exact By Channel no-schedule message and a pick-another action", () => {
    expect(guide).toContain("channelScheduleEmptyMessage");
    expect(guide).toContain("data-guide-channel-pick-another");
  });

  it("filters Tonight through the shared scope (visible channels, not the whole catalogue)", () => {
    const tonight = guide.slice(guide.indexOf("function renderTonight()"));
    const scan = tonight.slice(0, tonight.indexOf("buildTonightSections"));
    // Merged shape (0.11.11 integration, seam 1): W3's
    // collectTonightItems restructure carries W4's scope — the
    // scoped set is the collection source, never the catalogue.
    expect(scan).toContain("collectTonightItems(visibleChannels");
    expect(scan).not.toContain("collectTonightItems(allChannels");
    expect(scan).not.toContain("for (const channel of allChannels)");
  });

  it("mounts unmounted Full Guide cells before focusing them", () => {
    expect(guide).toContain("ensureGridCellMounted");
    expect(guide).toContain("gridScrollForCell");
    expect(guide).toContain("positionGridOnEntryChannel");
  });

  it("returns focus to Guide content after applying a category selection", () => {
    const onSelect = guide.slice(guide.indexOf("onSelect: (selection) => {"));
    expect(onSelect.slice(0, 1000)).toContain("focusFirstPanelItem()");
  });

  it("preserves the 0.11.10 navigation code (kept, not reverted)", () => {
    // Back coordinator seam: one-layer B section + nav-stack drawer layer.
    expect(guide).toContain("ONE-LAYER RULE");
    expect(guide).toContain('livetvNav.push({');
    expect(guide).toContain('id: "drawer"');
    // Intentional cross-region moves + tab-row resolver input.
    expect(guide).toContain("handleIntentionalMove");
    expect(guide).toContain("onTabRow");
    expect(guide).toContain("stepGuideMode");
    // Entry focus per mode + origin resolution.
    expect(guide).toContain("focusFirstPanelItem");
    expect(guide).toContain("resolveGuideOrigin");
    expect(guide).toContain("guideOrigin");
    // Single focus owner: claimed keys + gated livetv:back.
    expect(guide).toContain("const claim = () => {");
    expect(guide).toContain("stopImmediatePropagation");
    // Detail close returns focus to the same programme.
    expect(guide).toContain("function closeDetail()");
    // Keyboard lifecycle: search edits only through the shared session.
    expect(guide).toContain("openCouchKeyboard");
    expect(guide).toContain("suppressKeyboardReopen");
  });

  it("never releases a stream from the Guide (detail open must not stop playback)", () => {
    expect(guide).not.toMatch(/releaseStream|stopPlayback|player\.pause|video\.pause/);
  });

  it("does not depend on any new W3 API (builds against current APIs)", () => {
    expect(guide).not.toContain("epgFailureSignal");
    expect(guide).not.toContain("guideFailureState");
  });
});
