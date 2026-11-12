// AI Discovery 3.0 (0.11.6) W3 renders — CouchHub TV Discover UI.
// Serves THIS worktree's built dist via python http.server and
// screenshots the Discover states at 1920x1080 with headless Chrome.
// Fixture data only — nothing here ships. The app runs against:
//  - a fixture catalogue seeded into the app's own IndexedDB cache
//    (the same `xt_cache` store the real provider cache uses),
//  - the W3 orchestrator SHIM (canned-but-shape-correct results,
//    matched against the fixture catalogue),
//  - a mocked Tauri IPC stub (ai_key_has -> true, so AI is runnable),
//  - mocked TMDB artwork: every image.tmdb.org request is fulfilled
//    with a generated SVG poster labelled MOCK ART.
// All other external requests are aborted, so renders are offline
// and deterministic.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire("/home/hatch/workspace/couchhub-tv-ai0116-w3/package.json");
const { chromium } = require("playwright");

const ROOT = "/home/hatch/workspace/couchhub-tv-ai0116-w3";
const OUT = `${ROOT}/docs/screenshots/ai-0116-w3`;
const BASE = "http://127.0.0.1:4416";
const CHROME = "/home/hatch/workspace/.chrome-test/chrome-linux/chrome";

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture catalogue (provider rows, as the Xtream cache stores them).
// Titles overlap the shim's fixture sets so availability is MIXED:
// some recommendations match, some genuinely do not.
// ---------------------------------------------------------------------------

const VOD_ROWS = [
  { id: 101, name: "The Shawshank Redemption", year: 1994, rating: 9.3, category: "Drama", logo: "https://image.tmdb.org/t/p/w342/shim-shawshank.jpg", added: 1780000000 },
  { id: 102, name: "Spirited Away", year: 2001, rating: 8.6, category: "Animation / Fantasy", logo: "https://image.tmdb.org/t/p/w342/shim-spirited-away.jpg", added: 1780000100 },
  { id: 103, name: "Hot Fuzz", year: 2007, rating: 7.8, category: "Comedy / Action", logo: "https://image.tmdb.org/t/p/w342/shim-hot-fuzz.jpg", added: 1780000200 },
  { id: 104, name: "Paddington 2", year: 2017, rating: 7.8, category: "Family / Comedy", logo: "https://image.tmdb.org/t/p/w342/shim-paddington-2.jpg", added: 1780000300 },
  { id: 105, name: "The Grand Budapest Hotel", year: 2014, rating: 8.0, category: "Comedy / Drama", logo: "https://image.tmdb.org/t/p/w342/shim-grand-budapest.jpg", added: 1780000400 },
  { id: 106, name: "A Funny Thing", year: 2019, rating: 6.9, category: "Comedy", logo: "https://image.tmdb.org/t/p/w342/shim-funny-thing.jpg", added: 1780000500 },
  { id: 107, name: "The Pranksters", year: 2021, rating: 6.4, category: "Comedy", logo: "https://image.tmdb.org/t/p/w342/shim-pranksters.jpg", added: 1780000600 },
  { id: 108, name: "Akira", year: 1988, rating: 8.0, category: "Animation / Sci-Fi", logo: "https://image.tmdb.org/t/p/w342/shim-akira.jpg", added: 1780000700 },
  { id: 109, name: "The Thing", year: 1982, rating: 8.2, category: "Horror / Sci-Fi", logo: "https://image.tmdb.org/t/p/w342/shim-the-thing.jpg", added: 1780000800 },
  { id: 110, name: "Knives Out", year: 2019, rating: 7.8, category: "Mystery / Comedy", logo: "https://image.tmdb.org/t/p/w342/shim-knives-out.jpg", added: 1780000900 },
  { id: 111, name: "Amélie", year: 2001, rating: 8.3, category: "Comedy / Romance", logo: "https://image.tmdb.org/t/p/w342/shim-amelie.jpg", added: 1780001000 },
  { id: 112, name: "Airplane!", year: 1980, rating: 7.7, category: "Comedy", logo: "https://image.tmdb.org/t/p/w342/shim-airplane.jpg", added: 1780001100 },
];

const SERIES_ROWS = [
  { id: 201, name: "Breaking Bad", year: 2008, rating: 9.5, category: "Crime / Drama", logo: "https://image.tmdb.org/t/p/w342/shim-breaking-bad.jpg", added: 1780001200 },
  { id: 202, name: "Attack on Titan", year: 2013, rating: 9.0, category: "Animation / Action", logo: "https://image.tmdb.org/t/p/w342/shim-attack-on-titan.jpg", added: 1780001300 },
  { id: 203, name: "Death Note", year: 2006, rating: 8.9, category: "Animation / Thriller", logo: "https://image.tmdb.org/t/p/w342/shim-death-note.jpg", added: 1780001400 },
  { id: 204, name: "Brooklyn Nine-Nine", year: 2013, rating: 8.4, category: "Comedy", logo: "https://image.tmdb.org/t/p/w342/shim-brooklyn-nine-nine.jpg", added: 1780001500 },
  { id: 205, name: "Severance", year: 2022, rating: 8.7, category: "Sci-Fi / Mystery", logo: "https://image.tmdb.org/t/p/w342/shim-severance.jpg", added: 1780001600 },
  { id: 206, name: "Dark", year: 2017, rating: 8.7, category: "Sci-Fi / Mystery", logo: "https://image.tmdb.org/t/p/w342/shim-dark.jpg", added: 1780001700 },
];

const POSTER_TITLES = {
  "shim-shawshank": "The Shawshank Redemption",
  "shim-spirited-away": "Spirited Away",
  "shim-parasite": "Parasite",
  "shim-breaking-bad": "Breaking Bad",
  "shim-paddington-2": "Paddington 2",
  "shim-grand-budapest": "The Grand Budapest Hotel",
  "shim-dark": "Dark",
  "shim-hot-fuzz": "Hot Fuzz",
  "shim-shadows": "What We Do in the Shadows",
  "shim-brooklyn-nine-nine": "Brooklyn Nine-Nine",
  "shim-airplane": "Airplane!",
  "shim-attack-on-titan": "Attack on Titan",
  "shim-death-note": "Death Note",
  "shim-perfect-blue": "Perfect Blue",
  "shim-akira": "Akira",
  "shim-ghost-in-the-shell": "Ghost in the Shell",
  "shim-edgerunners": "Cyberpunk: Edgerunners",
  "shim-the-thing": "The Thing",
  "shim-fargo": "Fargo",
  "shim-severance": "Severance",
  "shim-knives-out": "Knives Out",
  "shim-chernobyl": "Chernobyl",
  "shim-amelie": "Amélie",
  "shim-funny-thing": "A Funny Thing",
  "shim-pranksters": "The Pranksters",
};

function posterSvg(url) {
  const slug = url.split("/").pop().replace(/\.jpg$/, "").replace(/-backdrop$/, "");
  const title = POSTER_TITLES[slug] || slug;
  const wide = url.includes("-backdrop");
  const w = wide ? 780 : 342;
  const h = wide ? 439 : 513;
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const hue = (hash + 340) % 360;
  const words = title.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > 14 && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const text = lines
    .map(
      (l, i) =>
        `<text x="50%" y="${h / 2 - (lines.length - 1) * 22 + i * 44}" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#fff">${esc(l)}</text>`
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,32%)"/><stop offset="1" stop-color="hsl(${(hue + 20) % 360},55%,16%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${text}<text x="50%" y="${h - 18}" text-anchor="middle" font-family="sans-serif" font-size="13" letter-spacing="3" fill="rgba(255,255,255,0.6)">MOCK ART</text></svg>`;
}

// ---------------------------------------------------------------------------
// Server + browser
// ---------------------------------------------------------------------------

const preview = spawn(
  "python3",
  ["-m", "http.server", "4416", "--directory", `${ROOT}/dist`, "--bind", "127.0.0.1"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
);
const waitForServer = async (base = BASE) => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) return true;
    } catch {
      // Server not up yet — retry until the loop gives up.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`preview server did not come up at ${base}`);
};
/** A second, independent preview server (own port + process) for the
    quick-picks leg: the shared server stops answering navigations
    late in a full run under sandbox pressure. */
const BASE2 = "http://127.0.0.1:4417";
const startSecondServer = () =>
  spawn(
    "python3",
    ["-m", "http.server", "4417", "--directory", `${ROOT}/dist`, "--bind", "127.0.0.1"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

const results = {};
function note(name, obj) {
  results[name] = obj;
  console.log(`--- ${name} ---`, JSON.stringify(obj));
}

/** Seed localStorage + the Tauri IPC stub before any app script runs. */
async function seedContext(context, { scenario = null } = {}) {
  await context.addInitScript(
    ({ scenario }) => {
      // Mocked Tauri internals: only ai_key_has is implemented (the
      // Discover AI gate); every other command throws, so Tauri-only
      // code paths fall back to their web behaviour instead of
      // reading a fake success.
      let cbId = 1;
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd === "ai_key_has") return true;
          if (cmd === "ai_key_get") return null;
          // The event plugin's listen/emit/unlisten: no-op with a
          // plausible return, so layout init that listens for Tauri
          // events does not throw on every page.
          if (cmd === "plugin:event|listen") return 1;
          if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return undefined;
          throw new Error(`mock IPC: unimplemented command ${cmd}`);
        },
        transformCallback: (cb) => {
          const id = cbId++;
          (window.__TAURI_CALLBACKS__ = window.__TAURI_CALLBACKS__ || {})[id] = cb;
          return id;
        },
        unregisterCallback: (id) => {
          if (window.__TAURI_CALLBACKS__) delete window.__TAURI_CALLBACKS__[id];
        },
        convertFileSrc: (p) => p,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {};
      try {
        localStorage.setItem(
          "xt_playlists",
          JSON.stringify({
            entries: [
              {
                _id: "fixture-playlist",
                title: "Fixture",
                type: "xtream",
                serverUrl: "http://127.0.0.1:9",
                username: "fixture",
                password: "fixture",
                addedAt: 1,
              },
            ],
            selectedId: "fixture-playlist",
          })
        );
        localStorage.setItem("xt_ai_enabled", "1");
        localStorage.setItem("xt_ai_endpoint", "https://api.openai.com/v1");
        localStorage.setItem("xt_ai_model", "gpt-4o-mini");
        localStorage.setItem(
          "xt_ai_last_test_v1",
          JSON.stringify({
            ok: true,
            at: Date.now(),
            endpoint: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            modelVerified: true,
          })
        );
        localStorage.setItem("rs-ai-onboarding-dismissed-v1", "1");
        localStorage.setItem("xt_last_seen_version", "99.0.0");
        localStorage.setItem("xt_tmdb_enabled", "");
        sessionStorage.setItem("xt_splash_done", "1");
        if (scenario) sessionStorage.setItem("rs-discovery-shim-scenario", scenario);
      } catch {
        // Storage unavailable in this context — seeds are best-effort.
      }
    },
    { scenario }
  );
}

/** Seed the fixture catalogue into the app's IndexedDB cache. */
async function seedCatalogue(page, { empty = false } = {}) {
  await page.evaluate(
    async ({ vod, series }) => {
      const open = () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("xt_cache", 4);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            let store;
            if (!db.objectStoreNames.contains("entries")) {
              store = db.createObjectStore("entries");
            } else {
              store = e.target.transaction.objectStore("entries");
            }
            if (!store.indexNames.contains("fetchedAt")) {
              store.createIndex("fetchedAt", "fetchedAt");
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const db = await open();
      const put = (key, data) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction("entries", "readwrite");
          tx.objectStore("entries").put(
            { data, fetchedAt: Date.now(), ttl: 24 * 60 * 60 * 1000 },
            key
          );
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      await put("xt_cache:fixture-playlist:vod", vod);
      await put("xt_cache:fixture-playlist:series", series);
      db.close();
    },
    { vod: empty ? [] : VOD_ROWS, series: empty ? [] : SERIES_ROWS }
  );
}

async function newDiscoverPage(browser, opts = {}) {
  const base = opts.base ?? BASE;
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await seedContext(context, opts);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url.startsWith("https://image.tmdb.org/")) {
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: posterSvg(url),
      });
    }
    return route.abort();
  });
  // Prime the origin, seed the catalogue, then load Discover fresh.
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await seedCatalogue(page, opts);
  await page.goto(`${base}/discover`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-discover-root]", { timeout: 15000 });
  // Wait for the catalogue to load (rows render, or the empty state).
  // NOTE: waitForFunction(fn, arg, options) — options is the THIRD
  // argument; passing it second silently keeps the 30s default.
  const rowsReady = () =>
    page.waitForFunction(
      () =>
        document.querySelector("[data-discover-rows]") ||
        document.querySelector("[data-discover-results]") ||
        document.querySelector(".rs-empty"),
      undefined,
      { timeout: 45000 }
    );
  try {
    await rowsReady();
  } catch (error) {
    // Sandbox CPU pressure can stall a first load past 45s late in a
    // full run; one reload retry, then fail with a state dump.
    console.log(
      "[newDiscoverPage] rows wait timed out, reloading once…",
      String(error).slice(0, 120)
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      await rowsReady();
    } catch (retryError) {
      const dump = await page.evaluate(() => ({
        root: !!document.querySelector("[data-discover-root]"),
        rows: !!document.querySelector("[data-discover-rows]"),
        results: !!document.querySelector("[data-discover-results]"),
        empty: !!document.querySelector(".rs-empty"),
        bodyLen: document.body?.innerText?.length ?? 0,
        bodyStart: (document.body?.innerText || "").slice(0, 200),
      }));
      console.log("[newDiscoverPage] reload retry failed, page state:", JSON.stringify(dump));
      throw retryError;
    }
  }
  await page.waitForTimeout(800);
  return { context, page };
}

async function discoverState(page) {
  return page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const txt = (sel) => (q(sel)?.textContent || "").trim().replace(/\s+/g, " ");
    const cards = [...document.querySelectorAll("[data-ai-result-card]")].map((el) => ({
      title: el.querySelector(".rs-ai-card__title")?.textContent?.trim(),
      badges: [...el.querySelectorAll(".rs-ai-badge")].map((b) => b.textContent.trim()),
      href: el.getAttribute("href") || null,
      tag: el.tagName,
    }));
    const localCards = [...document.querySelectorAll(
      "[data-discover-results] .rs-discover-card .rs-card__title"
    )].map((el) => el.textContent.trim());
    const nav = q(".rs-topnav")?.getBoundingClientRect();
    const moodGrid = q(".rs-discover__mood-grid")?.getBoundingClientRect();
    return {
      railTitle: txt("[data-discover-results] .rs-section-title"),
      stateNote: txt("[data-ai-state-note]"),
      phase: txt("[data-ai-phase]"),
      localNote: txt("[data-local-note]"),
      askAiVisible: !!q(".rs-discover-ask-ai"),
      askAiText: txt(".rs-discover-ask-ai"),
      modeBadge: txt(".rs-discover-mode"),
      modeDetail: txt(".rs-discover-mode__detail"),
      aiCards: cards,
      localCards,
      refineContext: txt("[data-refine-context]"),
      toggleText: txt("[data-available-toggle]"),
      togglePressed: q("[data-available-toggle]")?.getAttribute("aria-pressed"),
      noneAvailable: !!q("[data-none-available]"),
      aiUnavailable: !!q("[data-ai-unavailable]"),
      aiEmpty: !!q("[data-ai-empty]"),
      availableEmpty: !!q("[data-available-empty]"),
      localSimilarVisible: !!q("[data-local-similar]"),
      diagToggleVisible: !!q("[data-ai-diagnostics] .rs-discover-diag__toggle"),
      scrollY: Math.round(window.scrollY),
      navBottom: nav ? Math.round(nav.bottom) : null,
      moodGridTop: moodGrid ? Math.round(moodGrid.top) : null,
      activeElement: (() => {
        const el = document.activeElement;
        return el ? `${el.tagName}.${String(el.className).split(" ")[0]}#${el.id}` : null;
      })(),
    };
  });
}

async function askAiAbout(page, query) {
  await page.fill("#discover-query", query);
  // Debounced local search runs; wait for the Ask AI button, then ask.
  await page.waitForSelector(".rs-discover-ask-ai", { timeout: 15000 });
  await page.click(".rs-discover-ask-ai");
  await page.waitForSelector("[data-ai-results] [data-ai-result-card]", { timeout: 15000 });
  await page.waitForTimeout(600);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`shot ${name}.png`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  // LEG=<name> runs a single scenario (fresh process/browser) — used
  // to isolate a leg that stalls late in a full run.
  const onlyLeg = process.env.LEG || null;
  const run = async (name, fn) => {
    if (onlyLeg && name !== onlyLeg) return;
    try {
      await fn();
    } catch (error) {
      note(`${name}-FAILED`, { error: String(error).slice(0, 500) });
      console.log(`[scenario ${name} failed]`, error?.stack || String(error));
    }
  };

  // ---- 1. Landing ------------------------------------------------------
  await run("landing", async () => {
    const { context, page } = await newDiscoverPage(browser);
    const state = await discoverState(page);
    note("landing", state);
    await shot(page, "01-landing");
    await context.close();
  });

  // ---- 2-6. One journey: mixed -> toggle -> refine -> new search -> cached
  await run("journey", async () => {
    const { context, page } = await newDiscoverPage(browser);
    // Mixed availability: "dark anime" matches 3 of 6 in the fixture catalogue.
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(500);
    const mixed = await discoverState(page);
    note("mixed", mixed);
    await shot(page, "02-ai-results-mixed");

    // Controller proxy: keyboard arrows drive the same spatial
    // navigation the gamepad layer feeds (D-pad dispatches arrows).
    // Record where focus lands on Right / Down / Left / Up.
    const navSequence = [];
    const focusedTitle = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return (
          el?.querySelector?.(".rs-ai-card__title")?.textContent?.trim() ||
          (el?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)
        );
      });
    await page.evaluate(() =>
      document.querySelector("[data-ai-results] [data-ai-result-card]")?.focus()
    );
    navSequence.push(await focusedTitle());
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(350);
      navSequence.push(await focusedTitle());
    }
    note("controller-nav", { sequence: navSequence });

    // Toggle ON: only matched cards, no new request (state note + rail title unchanged).
    await page.click("[data-available-toggle]");
    await page.waitForTimeout(500);
    const toggled = await discoverState(page);
    note("toggle-on", toggled);
    await shot(page, "03-available-only-on");

    // Toggle back OFF for the refinement leg.
    await page.click("[data-available-toggle]");
    await page.waitForTimeout(400);

    // Diagnostics open (on the AI receipt).
    await page.click("[data-ai-diagnostics] .rs-discover-diag__toggle");
    await page.waitForTimeout(400);
    const diag = await page.evaluate(() => {
      const grid = document.querySelector(".rs-discover-diag__grid");
      return { diagText: (grid?.textContent || "").trim().replace(/\s+/g, " ") };
    });
    note("diagnostics", { ...diag, ...(await discoverState(page)) });
    await page.evaluate(() =>
      document.querySelector("[data-ai-diagnostics]")?.scrollIntoView({ block: "center" })
    );
    await page.waitForTimeout(400);
    await shot(page, "04-diagnostics-open");
    await page.click("[data-ai-diagnostics] .rs-discover-diag__toggle");
    await page.waitForTimeout(300);

    // Refinement: follow-up keeps the conversation, returns new titles.
    await page.fill("#discover-query", "Darker");
    await page.waitForTimeout(300);
    await page.click(".rs-discover-ask"); // "Refine" submit button
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-ai-result-card] .rs-ai-card__title")].some((el) =>
          ["The Thing", "Severance", "Fargo"].includes(el.textContent.trim())
        ),
      undefined,
      { timeout: 15000 }
    );
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    const refined = await discoverState(page);
    note("refinement", refined);
    await shot(page, "05-refinement");

    // New Search: everything cleared, landing rows back.
    await page.click("[data-refine-context] .rs-discover-refine__new");
    await page.waitForTimeout(600);
    const cleared = await discoverState(page);
    note("new-search", cleared);
    await shot(page, "06-new-search-cleared");

    // Cached: ask the same question again with a fresh conversation.
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    const cached = await discoverState(page);
    note("cached", cached);
    await shot(page, "07-cached-receipt");
    await context.close();
  });

  // ---- 7. AI unavailable (+ local similar) ------------------------------
  await run("unavailable", async () => {
    const { context, page } = await newDiscoverPage(browser, { scenario: "unavailable" });
    await page.fill("#discover-query", "something funny");
    await page.waitForSelector(".rs-discover-ask-ai", { timeout: 15000 });
    await page.click(".rs-discover-ask-ai");
    await page.waitForSelector("[data-ai-unavailable]", { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    note("unavailable", await discoverState(page));
    await shot(page, "08-ai-unavailable");
    await page.click("[data-ai-unavailable] .rs-ai-panel__primary");
    await page.waitForSelector("[data-local-similar]", { timeout: 15000 });
    await page.waitForTimeout(400);
    note("unavailable-local-similar", await discoverState(page));
    await shot(page, "08b-ai-unavailable-local-similar");
    await context.close();
  });

  // ---- 8. Empty catalogue: all Not in Library ---------------------------
  await run("empty-catalogue", async () => {
    const { context, page } = await newDiscoverPage(browser, { empty: true });
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    note("empty-catalogue", await discoverState(page));
    await shot(page, "09-empty-catalogue");
    await context.close();
  });

  // ---- 9. Unverified titles ---------------------------------------------
  await run("unverified", async () => {
    const { context, page } = await newDiscoverPage(browser, { scenario: "unverified" });
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    note("unverified", await discoverState(page));
    await shot(page, "10-unverified");
    await context.close();
  });

  // ---- 10. Quick picks after a search submit (clipping check) -----------
  // Submit via Enter, wait for the results section (local or AI — with
  // default settings Enter takes the local path, by the manual-trigger
  // discipline), then scroll back to the top: the quick-pick grid must
  // sit fully below the sticky nav (the 0.11.5 scroll-padding-top fix
  // must not regress). Runs AFTER the shared browser closes, in its
  // own fresh browser AND its own preview server: late in a full run
  // the shared server stops answering navigations under sandbox CPU
  // pressure, stalling even a fresh browser past 45s.
  await browser.close();
  if (!onlyLeg || onlyLeg === "quick-picks") {
    const preview2 = startSecondServer();
    const freshBrowser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      await waitForServer(BASE2);
      console.log("[quick-picks] newDiscoverPage…");
      const { context, page } = await newDiscoverPage(freshBrowser, { base: BASE2 });
      console.log("[quick-picks] page ready, filling…");
      await page.fill("#discover-query", "COMEDY");
      console.log("[quick-picks] filled, pressing Enter…");
      await page.keyboard.press("Enter");
      console.log("[quick-picks] waiting for results…");
      await page.waitForSelector("[data-discover-results]", { timeout: 15000 });
      console.log("[quick-picks] results present, scrolling to top…");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const after = await discoverState(page);
      note("quick-picks-after-submit", {
        ...after,
        clippingOk: after.moodGridTop != null && after.navBottom != null && after.moodGridTop >= after.navBottom,
      });
      await shot(page, "11-quick-picks-after-submit");
      await context.close();
    } catch (error) {
      note("quick-picks-FAILED", { error: String(error).slice(0, 500) });
      console.log("[scenario quick-picks failed]", error?.stack || String(error));
    } finally {
      await freshBrowser.close();
      preview2.kill();
    }
  }

  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log("done");
} finally {
  preview.kill();
}
