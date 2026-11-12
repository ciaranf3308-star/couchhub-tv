// AI Discovery 3.0 (0.11.6) INTEGRATION renders — CouchHub TV Discover UI.
// Serves THIS worktree's built dist via python http.server and
// screenshots the Discover states at 1920x1080 with headless Chrome.
// Fixture data only — nothing here ships. Unlike the W3 harness
// (render-ai0116-w3.mjs, which drove the deleted orchestrator shim),
// THIS harness drives the REAL merged modules: runAiDiscovery (W1)
// -> verifyRecommendations (W2), with the network seams mocked:
//
//  - the AI endpoint (POST .../chat/completions) is fulfilled with
//    canned OpenAI-shaped replies — the real generation parser,
//    prompt builder and orchestrator cache all run for real;
//  - the TMDB API (api.themoviedb.org/3) is fulfilled from a canned
//    title table — the real identity picking, details fetch and
//    catalogue matching all run for real;
//  - a fixture catalogue is seeded into the app's own IndexedDB cache
//    (the same `xt_cache` store the real provider cache uses);
//  - a mocked Tauri IPC stub (ai_key_has -> true, ai_key_get -> a
//    fake key, so the real client sends the mocked request);
//  - mocked TMDB artwork: every image.tmdb.org request is fulfilled
//    with a generated SVG poster labelled MOCK ART.
// All other external requests are aborted, so renders are offline
// and deterministic. No real LLM call, no real TMDB call, no keys.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire("/home/hatch/workspace/couchhub-tv-ai0116-integration/package.json");
const { chromium } = require("playwright");

const ROOT = "/home/hatch/workspace/couchhub-tv-ai0116-integration";
const OUT = `${ROOT}/docs/screenshots/ai-0116-integration`;
const BASE = "http://127.0.0.1:4426";
const CHROME = "/home/hatch/workspace/.chrome-test/chrome-linux/chrome";

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture catalogue (provider rows, as the Xtream cache stores them).
// Titles overlap the mocked model's sets so availability is MIXED:
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
  const slug = url.split("/").pop().replace(/\.jpg$/, "").replace(/-backdrop$/, "").replace(/^mock-/, "");
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
// Mocked model replies (what the "LLM" generates) + mocked TMDB table.
// The model sets deliberately overlap the fixture catalogue 50/50 so
// the mixed-availability states are real verifier + matcher output.
// ---------------------------------------------------------------------------

const MODEL_SETS = {
  darkAnime: [
    { title: "Attack on Titan", year: 2013, kind: "series", reason: "Humanity's last stand is brutal, bleak and relentless.", tone: "dark and brutal" },
    { title: "Death Note", year: 2006, kind: "series", reason: "A psychological cat-and-mouse game with a body count.", tone: "dark psychological" },
    { title: "Akira", year: 1988, kind: "movie", reason: "A landmark of bleak, violent anime cinema.", tone: "bleak sci-fi" },
    { title: "Perfect Blue", year: 1997, kind: "movie", reason: "A disturbing descent into paranoia and identity loss.", tone: "disturbing psychological" },
    { title: "Ghost in the Shell", year: 1995, kind: "movie", reason: "A brooding cyberpunk meditation on identity.", tone: "bleak cyberpunk" },
    { title: "Cyberpunk: Edgerunners", year: 2022, kind: "series", reason: "A neon-drenched tragedy that pulls no punches.", tone: "dark action" },
  ],
  darker: [
    { title: "The Thing", year: 1982, kind: "movie", reason: "Paranoia and body horror in an Antarctic winter.", tone: "bleak horror" },
    { title: "Severance", year: 2022, kind: "series", reason: "A chilling workplace mystery that gets darker every episode.", tone: "dark mystery" },
    { title: "Fargo", year: 2014, kind: "series", reason: "Small-town crime spirals into bleak, brilliant violence.", tone: "dark crime" },
  ],
  funny: [
    { title: "Hot Fuzz", year: 2007, kind: "movie", reason: "A razor-sharp action comedy with a huge heart.", tone: "warm comedy" },
    { title: "Parasite", year: 2019, kind: "movie", reason: "A darkly funny class satire that turns on a dime.", tone: "dark comedy" },
    { title: "The Grand Budapest Hotel", year: 2014, kind: "movie", reason: "A caper played at full tilt, funny and bittersweet.", tone: "whimsical comedy" },
  ],
  invented: [
    { title: "The Glimmering Void", year: 2023, kind: "movie", reason: "A title the model invented.", tone: "mysterious" },
    { title: "Zorblax Rising", year: 2024, kind: "movie", reason: "Another invented title TMDB cannot resolve.", tone: "invented" },
    { title: "Captain Moonbeard's Revenge", year: 2022, kind: "series", reason: "A series that does not exist.", tone: "invented" },
  ],
};

// TMDB identities: id, kind, canonical title, year, genres, poster slug.
const TMDB_TABLE = [
  { id: 900001, kind: "series", title: "Attack on Titan", original: "Shingeki no Kyojin", year: 2013, genres: ["Animation", "Drama", "Action"], slug: "shim-attack-on-titan" },
  { id: 900002, kind: "series", title: "Death Note", original: "Death Note", year: 2006, genres: ["Animation", "Thriller", "Mystery"], slug: "shim-death-note" },
  { id: 900003, kind: "movie", title: "Akira", original: "Akira", year: 1988, genres: ["Animation", "Sci-Fi"], slug: "shim-akira" },
  { id: 900004, kind: "movie", title: "Perfect Blue", original: "Perfect Blue", year: 1997, genres: ["Animation", "Thriller"], slug: "shim-perfect-blue" },
  { id: 900005, kind: "movie", title: "Ghost in the Shell", original: "Ghost in the Shell", year: 1995, genres: ["Animation", "Sci-Fi"], slug: "shim-ghost-in-the-shell" },
  { id: 900006, kind: "series", title: "Cyberpunk: Edgerunners", original: "Cyberpunk: Edgerunners", year: 2022, genres: ["Animation", "Action"], slug: "shim-edgerunners" },
  { id: 900007, kind: "movie", title: "The Thing", original: "The Thing", year: 1982, genres: ["Horror", "Sci-Fi"], slug: "shim-the-thing" },
  { id: 900008, kind: "series", title: "Severance", original: "Severance", year: 2022, genres: ["Sci-Fi", "Mystery"], slug: "shim-severance" },
  { id: 900009, kind: "series", title: "Fargo", original: "Fargo", year: 2014, genres: ["Crime", "Drama"], slug: "shim-fargo" },
  { id: 900010, kind: "movie", title: "Hot Fuzz", original: "Hot Fuzz", year: 2007, genres: ["Comedy", "Action"], slug: "shim-hot-fuzz" },
  { id: 900011, kind: "movie", title: "Parasite", original: "Gisaengchung", year: 2019, genres: ["Thriller", "Drama"], slug: "shim-parasite" },
  { id: 900012, kind: "movie", title: "The Grand Budapest Hotel", original: "The Grand Budapest Hotel", year: 2014, genres: ["Comedy", "Drama"], slug: "shim-grand-budapest" },
];

const norm = (s) => (s || "").trim().toLowerCase();

function tmdbSearchResult(entry) {
  const date = `${entry.year}-01-01`;
  const base = {
    id: entry.id,
    vote_count: 1000,
    popularity: 50,
    poster_path: `/mock-${entry.slug}.jpg`,
    backdrop_path: `/mock-${entry.slug}-backdrop.jpg`,
    overview: `Overview for ${entry.title} (${entry.year}).`,
  };
  return entry.kind === "movie"
    ? { ...base, title: entry.title, original_title: entry.original, release_date: date }
    : { ...base, name: entry.title, original_name: entry.original, first_air_date: date };
}

function tmdbBundle(entry) {
  const date = `${entry.year}-01-01`;
  const base = {
    id: entry.id,
    overview: `Overview for ${entry.title} (${entry.year}).`,
    poster_path: `/mock-${entry.slug}.jpg`,
    backdrop_path: `/mock-${entry.slug}-backdrop.jpg`,
    vote_average: 8.0,
    genres: entry.genres.map((name, i) => ({ id: 100 + i, name })),
    credits: { cast: [], crew: [] },
    videos: { results: [] },
    recommendations: { results: [] },
    images: { logos: [] },
  };
  return entry.kind === "movie"
    ? { ...base, title: entry.title, release_date: date }
    : { ...base, name: entry.title, first_air_date: date };
}

/** Pick the model set for one chat-completions request body. */
function pickModelSet(bodyText, scenario) {
  if (scenario === "unverified") return MODEL_SETS.invented;
  let text = "";
  try {
    const body = JSON.parse(bodyText || "{}");
    text = (body.messages || []).map((m) => m.content || "").join("\n");
  } catch {
    text = "";
  }
  // A refinement carries the follow-up query ("Darker") plus the
  // earlier-turn context; a fresh ask carries only its own query.
  if (/darker/i.test(text)) return MODEL_SETS.darker;
  if (/funny/i.test(text)) return MODEL_SETS.funny;
  return MODEL_SETS.darkAnime;
}

// ---------------------------------------------------------------------------
// Server + browser
// ---------------------------------------------------------------------------

const preview = spawn(
  "python3",
  ["-m", "http.server", "4426", "--directory", `${ROOT}/dist`, "--bind", "127.0.0.1"],
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
const BASE2 = "http://127.0.0.1:4427";
const startSecondServer = () =>
  spawn(
    "python3",
    ["-m", "http.server", "4427", "--directory", `${ROOT}/dist`, "--bind", "127.0.0.1"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

const results = {};
function note(name, obj) {
  results[name] = obj;
  console.log(`--- ${name} ---`, JSON.stringify(obj));
}

/** Seed localStorage + the Tauri IPC stub before any app script runs. */
async function seedContext(context) {
  await context.addInitScript(() => {
    // Mocked Tauri internals: ai_key_has/ai_key_get answer with a
    // FAKE key so the real client sends the (mocked) request; every
    // other command throws, so Tauri-only code paths fall back to
    // their web behaviour instead of reading a fake success.
    let cbId = 1;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === "ai_key_has") return true;
        if (cmd === "ai_key_get") return "mock-render-key";
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
      // TMDB active with a FAKE key: the real defaultTmdbSearch runs
      // against the mocked TMDB API below.
      localStorage.setItem("xt_tmdb_enabled", "");
      localStorage.setItem("xt_tmdb_key", "mock-tmdb-key");
      sessionStorage.setItem("xt_splash_done", "1");
    } catch {
      // Storage unavailable in this context — seeds are best-effort.
    }
  });
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
  const scenario = opts.scenario ?? null;
  const net = { aiCalls: 0, tmdbSearches: 0, tmdbBundles: 0 };
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await seedContext(context);
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
    // Mocked AI endpoint: the real client + generation + orchestrator
    // run against these canned replies.
    if (url === "https://api.openai.com/v1/chat/completions") {
      net.aiCalls++;
      if (scenario === "unavailable") {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "mock provider outage" } }),
        });
      }
      const recs = pickModelSet(route.request().postData() || "", scenario);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify({ recommendations: recs }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      });
    }
    // Mocked TMDB API: the real verifier + details fetch run here.
    if (url.startsWith("https://api.themoviedb.org/3/")) {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/3/, "");
      const searchMatch = path.match(/^\/(search)\/(movie|tv)$/);
      if (searchMatch) {
        net.tmdbSearches++;
        const kind = searchMatch[2] === "movie" ? "movie" : "series";
        const q = norm(u.searchParams.get("query"));
        const hits = TMDB_TABLE.filter(
          (e) => e.kind === kind && (norm(e.title) === q || norm(e.original) === q)
        );
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            page: 1,
            results: hits.map(tmdbSearchResult),
            total_results: hits.length,
            total_pages: 1,
          }),
        });
      }
      const bundleMatch = path.match(/^\/(movie|tv)\/(\d+)$/);
      if (bundleMatch) {
        net.tmdbBundles++;
        const entry = TMDB_TABLE.find((e) => e.id === Number(bundleMatch[2]));
        if (!entry) {
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ status_message: "not found" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(tmdbBundle(entry)),
        });
      }
      const altMatch = path.match(/^\/(movie|tv)\/\d+\/alternative_titles$/);
      if (altMatch) {
        const key = altMatch[1] === "movie" ? "titles" : "results";
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: 0, [key]: [] }),
        });
      }
      console.log("[tmdb-mock] unhandled path:", path);
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ status_message: "mock: unhandled TMDB path" }),
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
  return { context, page, net };
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
  await page.waitForSelector("[data-ai-results] [data-ai-result-card]", { timeout: 30000 });
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
    const { context, page, net } = await newDiscoverPage(browser);
    const state = await discoverState(page);
    note("landing", { ...state, net });
    await shot(page, "01-landing");
    await context.close();
  });

  // ---- 2-6. One journey: mixed -> toggle -> refine -> new search -> cached
  await run("journey", async () => {
    const { context, page, net } = await newDiscoverPage(browser);
    // Mixed availability: "dark anime" matches 3 of 6 in the fixture catalogue.
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(500);
    const mixed = await discoverState(page);
    note("mixed", { ...mixed, net: { ...net } });
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
    note("toggle-on", { ...toggled, net: { ...net } });
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
    note("diagnostics", { ...diag, ...(await discoverState(page)), net: { ...net } });
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
      { timeout: 30000 }
    );
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    const refined = await discoverState(page);
    note("refinement", { ...refined, net: { ...net } });
    await shot(page, "05-refinement");

    // New Search: everything cleared, landing rows back.
    await page.click("[data-refine-context] .rs-discover-refine__new");
    await page.waitForTimeout(600);
    const cleared = await discoverState(page);
    note("new-search", { ...cleared, net: { ...net } });
    await shot(page, "06-new-search-cleared");

    // Cached: ask the same question again with a fresh conversation.
    // The orchestrator cache must answer with ZERO new model calls.
    const callsBeforeCached = net.aiCalls;
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    const cached = await discoverState(page);
    note("cached", { ...cached, net: { ...net }, callsBeforeCached, cachedCallDelta: net.aiCalls - callsBeforeCached });
    await shot(page, "07-cached-receipt");
    await context.close();
  });

  // ---- 7. AI unavailable (+ local similar) ------------------------------
  await run("unavailable", async () => {
    const { context, page, net } = await newDiscoverPage(browser, { scenario: "unavailable" });
    await page.fill("#discover-query", "something funny");
    await page.waitForSelector(".rs-discover-ask-ai", { timeout: 15000 });
    await page.click(".rs-discover-ask-ai");
    await page.waitForSelector("[data-ai-unavailable]", { timeout: 30000 });
    await page.waitForTimeout(400);
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    note("unavailable", { ...(await discoverState(page)), net: { ...net } });
    await shot(page, "08-ai-unavailable");
    await page.click("[data-ai-unavailable] .rs-ai-panel__primary");
    await page.waitForSelector("[data-local-similar]", { timeout: 15000 });
    await page.waitForTimeout(400);
    note("unavailable-local-similar", { ...(await discoverState(page)), net: { ...net } });
    await shot(page, "08b-ai-unavailable-local-similar");
    await context.close();
  });

  // ---- 8. Empty catalogue: all Not in Library ---------------------------
  await run("empty-catalogue", async () => {
    const { context, page, net } = await newDiscoverPage(browser, { empty: true });
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    note("empty-catalogue", { ...(await discoverState(page)), net: { ...net } });
    await shot(page, "09-empty-catalogue");
    await context.close();
  });

  // ---- 9. Unverified titles ---------------------------------------------
  await run("unverified", async () => {
    const { context, page, net } = await newDiscoverPage(browser, { scenario: "unverified" });
    await askAiAbout(page, "dark anime");
    await page.evaluate(() =>
      document.querySelector("[data-discover-results]")?.scrollIntoView({ block: "start" })
    );
    await page.waitForTimeout(400);
    note("unverified", { ...(await discoverState(page)), net: { ...net } });
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
