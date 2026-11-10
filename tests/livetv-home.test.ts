/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildChannelCardElement,
  buildProgrammeMetaElement,
} from "@/scripts/lib/livetv-cards";
import {
  dispatchLivetvTune,
  groupChannels,
  favouriteChannels,
  pickResumeHero,
  requestLivetvMode,
  type LivetvChannel,
} from "@/scripts/lib/livetv-data";
import {
  getLivetvResumeLastChannel,
  setLivetvResumeLastChannel,
} from "@/scripts/lib/app-settings.js";

const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

function ch(partial: Partial<LivetvChannel> & { id: string | number; name: string }): LivetvChannel {
  const rawCategory = partial.categoryId ?? partial.category ?? "";
  return {
    displayName: partial.name,
    logo: null,
    category: rawCategory,
    categoryId: rawCategory,
    categoryLabel: partial.categoryLabel ?? rawCategory,
    streamUrl: null,
    tvgId: null,
    chno: undefined,
    catchup: false,
    favourite: false,
    hidden: false,
    norm: (partial.name + " " + rawCategory).toLowerCase(),
    ...partial,
  };
}

describe("buildChannelCardElement (mirrors TvChannelCard.astro)", () => {
  it("renders the card contract: article[data-channel-card][data-channel-id][data-focus-key]", () => {
    const card = buildChannelCardElement(
      ch({ id: 101, name: "RTÉ One", logo: "https://x/logo.png", chno: 1 }),
      {
        nowTitle: "Evening News",
        nextTitle: "Late Film",
        progress: 0.5,
        catchup: true,
        favourite: true,
        size: "large",
        focusKey: "livetv-home-fav-101",
      },
    );
    expect(card.tagName).toBe("ARTICLE");
    expect(card.getAttribute("data-channel-card")).toBe("");
    expect(card.getAttribute("data-channel-id")).toBe("101");
    expect(card.getAttribute("data-focus-key")).toBe("livetv-home-fav-101");
    expect(card.classList.contains("rs-livetv-channel-card--large")).toBe(true);
    expect(card.querySelector("img")?.getAttribute("src")).toBe("https://x/logo.png");
    expect(card.querySelector(".rs-livetv-channel-card__name")?.textContent).toContain("RTÉ One");
    expect(card.querySelector(".rs-livetv-channel-card__now")?.textContent).toBe("Evening News");
    expect(card.querySelector(".rs-livetv-channel-card__next")?.textContent).toBe("Up next: Late Film");
    expect(card.querySelector(".rs-livetv-channel-card__progress > span")?.getAttribute("style")).toContain("width: 50%");
    expect(card.querySelector(".rs-livetv-channel-card__catchup")?.textContent).toBe("Catch-up");
    expect(card.querySelector(".rs-livetv-channel-card__fav")).not.toBeNull();
  });

  it("shows an initial mark when there is no logo, and omits missing parts", () => {
    const card = buildChannelCardElement(ch({ id: 7, name: "No Logo" }), { focusKey: "k-7" });
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".rs-livetv-channel-card__initial")?.textContent).toBe("N");
    expect(card.querySelector(".rs-livetv-channel-card__now")).toBeNull();
    expect(card.querySelector(".rs-livetv-channel-card__next")).toBeNull();
    expect(card.querySelector(".rs-livetv-channel-card__progress")).toBeNull();
    expect(card.querySelector(".rs-livetv-channel-card__catchup")).toBeNull();
    expect(card.querySelector(".rs-livetv-channel-card__fav")).toBeNull();
  });

  it("is operable without an href (role=button) and a link with one", () => {
    const plain = buildChannelCardElement(ch({ id: 1, name: "A" }), {});
    expect(plain.getAttribute("role")).toBe("button");
    expect(plain.getAttribute("tabindex")).toBe("0");
    const linked = buildChannelCardElement(ch({ id: 1, name: "A" }), { href: "/livetv?channel=1" });
    expect(linked.querySelector("a")?.getAttribute("href")).toBe("/livetv?channel=1");
  });
});

describe("buildProgrammeMetaElement (mirrors TvProgrammeMeta.astro)", () => {
  it("renders title + LIVE + time range + progress + description + catch-up", () => {
    const meta = buildProgrammeMetaElement({
      title: "Evening News",
      startMs: NOW - HOUR,
      stopMs: NOW + HOUR,
      desc: "The news.",
      catchup: true,
      live: true,
      nowMs: NOW,
    });
    expect(meta).not.toBeNull();
    expect(meta!.querySelector(".rs-livetv-programme-meta__title")?.textContent).toContain("Evening News");
    expect(meta!.querySelector(".rs-livetv-programme-meta__live")?.textContent).toBe("LIVE");
    const fmt = (ms: number) =>
      new Date(ms).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
    expect(meta!.querySelector(".rs-livetv-programme-meta__time")?.textContent).toBe(
      `${fmt(NOW - HOUR)}–${fmt(NOW + HOUR)}`,
    );
    expect(meta!.querySelector(".rs-livetv-programme-meta__desc")?.textContent).toBe("The news.");
    expect(meta!.querySelector(".rs-livetv-programme-meta__catchup")?.textContent).toBe("Catch-up available");
    expect(meta!.querySelector(".rs-livetv-programme-meta__progress > span")?.getAttribute("style")).toContain("width: 50%");
  });

  it("omits missing optional parts and returns null without a title", () => {
    const meta = buildProgrammeMetaElement({
      title: "Film",
      startMs: NOW,
      stopMs: NOW + HOUR,
      nowMs: NOW,
    });
    expect(meta!.querySelector(".rs-livetv-programme-meta__desc")).toBeNull();
    expect(meta!.querySelector(".rs-livetv-programme-meta__catchup")).toBeNull();
    expect(meta!.querySelector(".rs-livetv-programme-meta__live")).toBeNull();
    expect(buildProgrammeMetaElement({ title: "", startMs: NOW, stopMs: NOW + HOUR })).toBeNull();
  });
});

describe("resume setting (livetv.resumeLastChannel)", () => {
  beforeEach(() => {
    window.localStorage.removeItem("xt_livetv_resume_last");
  });
  afterEach(() => {
    window.localStorage.removeItem("xt_livetv_resume_last");
  });

  it("defaults OFF and round-trips", () => {
    expect(getLivetvResumeLastChannel()).toBe(false);
    setLivetvResumeLastChannel(true);
    expect(getLivetvResumeLastChannel()).toBe(true);
    expect(window.localStorage.getItem("xt_livetv_resume_last")).toBe("1");
    setLivetvResumeLastChannel(false);
    expect(getLivetvResumeLastChannel()).toBe(false);
    expect(window.localStorage.getItem("xt_livetv_resume_last")).toBeNull();
  });
});

describe("mode-shell event contract", () => {
  it("dispatchLivetvTune fires cancelable livetv:tune then livetv:mode playback", () => {
    const tune = vi.fn();
    const mode = vi.fn();
    window.addEventListener("livetv:tune", tune);
    window.addEventListener("livetv:mode", mode);
    const handled = dispatchLivetvTune(42);
    expect(handled).toBe(false); // nobody consumed it in this test
    expect(tune).toHaveBeenCalledTimes(1);
    expect((tune.mock.calls[0][0] as CustomEvent).detail).toEqual({ channelId: 42 });
    expect((tune.mock.calls[0][0] as CustomEvent).cancelable).toBe(true);
    expect(mode).toHaveBeenCalledTimes(1);
    expect((mode.mock.calls[0][0] as CustomEvent).detail).toEqual({ mode: "playback" });
    window.removeEventListener("livetv:tune", tune);
    window.removeEventListener("livetv:mode", mode);
  });

  it("a consumer can suppress the transitional fallback with preventDefault", () => {
    const consumer = (event: Event) => event.preventDefault();
    window.addEventListener("livetv:tune", consumer);
    expect(dispatchLivetvTune(7)).toBe(true);
    window.removeEventListener("livetv:tune", consumer);
  });

  it("requestLivetvMode fires livetv:mode; legacy \"home\" maps to \"landing\"", () => {
    const seen: string[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail.mode);
    window.addEventListener("livetv:mode", listener);
    requestLivetvMode("guide");
    requestLivetvMode("home");
    requestLivetvMode("browser", {
      browserFilter: { kind: "favourites" },
      openSearch: true,
    });
    expect(seen).toEqual(["guide", "landing", "browser"]);
    window.removeEventListener("livetv:mode", listener);
  });

  it("requestLivetvMode carries the browser / guide detail on livetv:mode", () => {
    let detail: unknown = null;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener("livetv:mode", listener);
    requestLivetvMode("guide", { guideMode: "tonight" });
    expect(detail).toEqual({ mode: "guide", guideMode: "tonight" });
    requestLivetvMode("browser", {
      browserFilter: { kind: "category", value: "sports" },
    });
    expect(detail).toEqual({
      mode: "browser",
      browserFilter: { kind: "category", value: "sports" },
    });
    window.removeEventListener("livetv:mode", listener);
  });
});

describe("Home empty-state rules", () => {
  it("Resume hero falls back to favourites when there is no history", () => {
    const channels = [ch({ id: 1, name: "Fav", favourite: true })];
    const pick = pickResumeHero(channels, [], new Map());
    expect(pick?.channel.id).toBe(1);
    expect(pick?.eyebrow).toBe("Favourite Channel");
  });

  it("empty rails hide: no favourites, no recents, no EPG-covered channels", () => {
    const channels = [ch({ id: 1, name: "A" })];
    expect(favouriteChannels(channels)).toEqual([]);
    expect(groupChannels([]).filter((g) => g.id !== "all")).toEqual([]);
  });
});
