/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§2/§5) — navigation-ownership contract: the rail model
// must apply ONLY on rail/shelf views, owners must scope + replace +
// unregister cleanly, hidden owners must never claim input, and the
// W2 cursor seam must be inert until a handler registers.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearNavigationOwners,
  drawerContaining,
  effectiveNavigationKind,
  navigationKindForView,
  railNavigationApplies,
  railScopeRoot,
  registerCursorDirectionHandler,
  registerNavigationOwner,
  resolveNavigationOwner,
  routeDirectionToCursor,
  setCurrentNavigationView,
} from "@/scripts/lib/navigation-ownership";

beforeEach(() => {
  document.body.innerHTML = "";
  clearNavigationOwners();
  setCurrentNavigationView("");
});

describe("navigationKindForView", () => {
  it("maps the §2 view kinds", () => {
    expect(navigationKindForView("home")).toBe("rail");
    expect(navigationKindForView("movies-home")).toBe("shelf");
    expect(navigationKindForView("series-home")).toBe("shelf");
    expect(navigationKindForView("movies-browse")).toBe("grid");
    expect(navigationKindForView("discover")).toBe("mixed");
    expect(navigationKindForView("search")).toBe("search");
    expect(navigationKindForView("livetv-guide")).toBe("timeline");
    expect(navigationKindForView("settings")).toBe("form");
    expect(navigationKindForView("livetv-browser")).toBe("delegate");
  });

  it("falls back to spatial for unknown views", () => {
    expect(navigationKindForView("no-such-view")).toBe("spatial");
  });

  it("infers rail/shelf from page structure when no view is named yet", () => {
    expect(navigationKindForView("")).toBe("spatial");
    document.body.innerHTML = `<div data-nylah-rails></div>`;
    expect(navigationKindForView("")).toBe("rail");
    document.body.innerHTML = `<div id="series-home-root"></div>`;
    expect(navigationKindForView("")).toBe("shelf");
    // Discover-style rail markers alone never infer the rail model.
    document.body.innerHTML = `<section data-nylah-rail="discover-results"></section>`;
    expect(navigationKindForView("")).toBe("spatial");
  });
});

describe("railNavigationApplies (§2)", () => {
  it("applies on Home even though other pages also carry rail markers", () => {
    setCurrentNavigationView("home");
    document.body.innerHTML = `
      <div data-nylah-rails>
        <section data-nylah-rail="shelf-1"><a href="#" id="c1">One</a></section>
      </div>`;
    const card = document.getElementById("c1") as HTMLElement;
    expect(railNavigationApplies(card)).toBe(true);
  });

  it("never applies on Discover, however many rail markers it carries", () => {
    setCurrentNavigationView("discover");
    document.body.innerHTML = `
      <section data-nylah-rail="discover-results"><a href="#" id="c1">One</a></section>
      <section data-nylah-rail="row-1"><a href="#" id="c2">Two</a></section>`;
    expect(railNavigationApplies(document.getElementById("c1"))).toBe(false);
    expect(railNavigationApplies(document.getElementById("c2"))).toBe(false);
  });

  it("never applies on Search, grids, Guide or Settings", () => {
    document.body.innerHTML = `<section data-nylah-rail="x"><a href="#" id="c1">One</a></section>`;
    const card = document.getElementById("c1");
    for (const view of ["search", "movies-browse", "favorites", "livetv-guide", "settings"]) {
      setCurrentNavigationView(view);
      expect(railNavigationApplies(card)).toBe(false);
    }
  });

  it("applies on Movies/Series Home (established shelf behaviour)", () => {
    document.body.innerHTML = `<div id="movies-home-root"><section data-nylah-rail="worth"><a href="#" id="c1">One</a></section></div>`;
    setCurrentNavigationView("movies-home");
    expect(railNavigationApplies(document.getElementById("c1"))).toBe(true);
  });

  it("allows entry when nothing is focused yet on a rail view", () => {
    setCurrentNavigationView("home");
    expect(railNavigationApplies(null)).toBe(true);
    expect(railNavigationApplies(document.body)).toBe(true);
  });

  it("does not allow entry on a non-rail view with no focus", () => {
    setCurrentNavigationView("discover");
    expect(railNavigationApplies(null)).toBe(false);
  });
});

describe("registerNavigationOwner", () => {
  it("resolves the owner whose root contains focus; most recent wins", () => {
    document.body.innerHTML = `
      <div id="a"><button id="ba">A</button></div>
      <div id="b"><button id="bb">B</button></div>`;
    registerNavigationOwner({ id: "a", kind: "grid", root: "#a" });
    registerNavigationOwner({ id: "b", kind: "mixed", root: () => document.getElementById("b") });
    expect(resolveNavigationOwner(document.getElementById("ba"))?.id).toBe("a");
    expect(resolveNavigationOwner(document.getElementById("bb"))?.id).toBe("b");
    expect(effectiveNavigationKind(document.getElementById("bb"))).toBe("mixed");
  });

  it("re-registering the same id replaces the owner", () => {
    document.body.innerHTML = `<div id="a"><button id="ba">A</button></div>`;
    registerNavigationOwner({ id: "a", kind: "grid", root: "#a" });
    registerNavigationOwner({ id: "a", kind: "mixed", root: "#a" });
    expect(resolveNavigationOwner(document.getElementById("ba"))?.kind).toBe("mixed");
  });

  it("unregister drops the owner; the view kind takes over again", () => {
    document.body.innerHTML = `<div id="a"><button id="ba">A</button></div>`;
    setCurrentNavigationView("discover");
    const unregister = registerNavigationOwner({ id: "a", kind: "grid", root: "#a" });
    expect(effectiveNavigationKind(document.getElementById("ba"))).toBe("grid");
    unregister();
    expect(resolveNavigationOwner(document.getElementById("ba"))).toBeNull();
    expect(effectiveNavigationKind(document.getElementById("ba"))).toBe("mixed");
  });

  it("an inactive (hidden) owner never claims input", () => {
    document.body.innerHTML = `<div id="browse" hidden><button id="bb">B</button></div>`;
    registerNavigationOwner({
      id: "browse",
      kind: "grid",
      root: "#browse",
      isActive: () => !document.getElementById("browse")?.closest("[hidden]"),
    });
    setCurrentNavigationView("movies-home");
    expect(resolveNavigationOwner(document.getElementById("bb"))).toBeNull();
    expect(effectiveNavigationKind(document.getElementById("bb"))).toBe("shelf");
  });

  it("an owner whose root is detached never claims input", () => {
    const detached = document.createElement("div");
    const btn = document.createElement("button");
    detached.appendChild(btn);
    document.body.appendChild(document.createElement("div"));
    registerNavigationOwner({ id: "gone", kind: "grid", root: detached });
    expect(resolveNavigationOwner(btn)).toBeNull();
  });

  it("an owner can override the view kind inside its root only", () => {
    document.body.innerHTML = `
      <div id="grid-zone"><button id="g">G</button></div>
      <button id="outside">O</button>`;
    setCurrentNavigationView("discover");
    registerNavigationOwner({ id: "zone", kind: "grid", root: "#grid-zone" });
    expect(effectiveNavigationKind(document.getElementById("g"))).toBe("grid");
    expect(effectiveNavigationKind(document.getElementById("outside"))).toBe("mixed");
  });
});

describe("railScopeRoot", () => {
  it("prefers the owner root, then the Home rails wrapper, then the Home root", () => {
    document.body.innerHTML = `
      <div data-nylah-rails id="wrap"><section data-nylah-rail="s1"></section></div>
      <div id="movies-home-root"></div>`;
    expect(railScopeRoot().getAttribute("data-nylah-rails")).toBe("");
    registerNavigationOwner({ id: "o", kind: "rail", root: "#movies-home-root" });
    expect(railScopeRoot().id).toBe("movies-home-root");
  });
});

describe("drawerContaining (§5)", () => {
  it("finds filter, category and Live TV drawers", () => {
    document.body.innerHTML = `
      <div data-browse-filter-drawer><button id="f">F</button></div>
      <div data-browse-category-drawer><button id="c">C</button></div>
      <div data-category-drawer><button id="l">L</button></div>
      <button id="p">P</button>`;
    expect(drawerContaining(document.getElementById("f"))?.hasAttribute("data-browse-filter-drawer")).toBe(true);
    expect(drawerContaining(document.getElementById("c"))?.hasAttribute("data-browse-category-drawer")).toBe(true);
    expect(drawerContaining(document.getElementById("l"))?.hasAttribute("data-category-drawer")).toBe(true);
    expect(drawerContaining(document.getElementById("p"))).toBeNull();
    expect(drawerContaining(null)).toBeNull();
  });
});

describe("cursor direction seam (W2)", () => {
  it("is inert until W2 registers a handler", () => {
    expect(routeDirectionToCursor("down")).toBe(false);
  });

  it("routes to the handler and honours its consumption", () => {
    const seen: string[] = [];
    const unregister = registerCursorDirectionHandler((dir) => {
      seen.push(dir);
      return dir === "down";
    });
    expect(routeDirectionToCursor("down")).toBe(true);
    expect(routeDirectionToCursor("up")).toBe(false);
    expect(seen).toEqual(["down", "up"]);
    unregister();
    expect(routeDirectionToCursor("down")).toBe(false);
  });

  it("a throwing handler never breaks routing", () => {
    registerCursorDirectionHandler(() => {
      throw new Error("boom");
    });
    expect(routeDirectionToCursor("down")).toBe(false);
  });
});
