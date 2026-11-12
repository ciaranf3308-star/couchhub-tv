// 0.11.8 W2 — home/browse mode + URL contract (brief §1.9).
import { describe, expect, it } from "vitest";
import {
  browseStateFromMode,
  categoryParamFor,
  modeFromBrowseState,
  modeFromSearchParams,
  modeToSearchParams,
  parseCategoryParam,
} from "@/scripts/lib/home-browse-modes";
import { createBrowseState, selectCategory } from "@/scripts/lib/browse-state";

describe("category params", () => {
  it("round-trips kind:id forms; unknown ids fall back to All", () => {
    const sel = parseCategoryParam("genre:horror", "movie", (s) => `L:${s.id}`);
    expect(sel).toEqual({ kind: "genre", id: "horror", label: "L:horror" });
    expect(categoryParamFor(sel)).toBe("genre:horror");
    expect(parseCategoryParam("uncategorised", "movie").kind).toBe("uncategorised");
    expect(parseCategoryParam("bogus", "movie").kind).toBe("all");
    expect(parseCategoryParam("nope:x", "movie").kind).toBe("all");
    expect(parseCategoryParam("", "series").kind).toBe("all");
    expect(parseCategoryParam("all", "series").label).toBe("All Series");
  });
});

describe("mode <-> search params", () => {
  it("missing view means home; kind never comes from the URL", () => {
    const mode = modeFromSearchParams(new URLSearchParams(""), "movie");
    expect(mode.view).toBe("home");
    const weird = modeFromSearchParams(
      new URLSearchParams("view=browse&kind=series"),
      "movie",
    );
    expect(weird.kind).toBe("movie");
    expect(weird.view).toBe("browse");
  });

  it("round-trips a full browse mode", () => {
    const state = selectCategory(createBrowseState("movie"), {
      kind: "genre",
      id: "horror",
      label: "Horror",
    });
    const full = {
      ...state,
      page: 3,
      selectedId: "group:dune:2021",
      search: "dune",
      searchScope: "category" as const,
      sort: "rating" as const,
      filters: {
        ...state.filters,
        year: "2010s",
        minRating: 8,
        runtime: "under-120" as const,
        favouritesOnly: true,
      },
    };
    const params = modeToSearchParams(modeFromBrowseState(full));
    const back = modeFromSearchParams(params, "movie");
    expect(back.view).toBe("browse");
    expect(back.category).toBe("genre:horror");
    expect(back.page).toBe(3);
    expect(back.selectedId).toBe("group:dune:2021");
    expect(back.search).toBe("dune");
    expect(back.searchScope).toBe("category");
    expect(back.sort).toBe("rating");
    expect(back.filters).toMatchObject({
      year: "2010s",
      minRating: 8,
      runtime: "under-120",
      favouritesOnly: true,
    });
    const stateBack = browseStateFromMode(back);
    expect(stateBack.page).toBe(3);
    expect(stateBack.filters.minRating).toBe(8);
    expect(stateBack.category.id).toBe("horror");
  });

  it("unknown filter values fall back to defaults (a bad URL never hides the catalogue)", () => {
    const mode = modeFromSearchParams(
      new URLSearchParams(
        "view=browse&rating=99&sort=bogus&year=1850s&runtime=under-999&page=-2",
      ),
      "movie",
    );
    expect(mode.sort).toBeUndefined();
    expect(mode.page).toBeUndefined();
    expect(mode.filters?.minRating).toBeUndefined();
    expect(mode.filters?.runtime).toBeUndefined();
    const state = browseStateFromMode(mode);
    expect(state.sort).toBe("recommended");
    expect(state.page).toBe(1);
    expect(state.filters.minRating).toBe(0);
  });

  it("omits defaults for short URLs", () => {
    const params = modeToSearchParams({ view: "browse", kind: "movie" });
    expect(params.toString()).toBe("view=browse");
    const home = modeToSearchParams({ view: "home", kind: "series" });
    expect(home.toString()).toBe("view=home");
  });
});
