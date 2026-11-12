// W4 0.11.4 Live TV landing hero fidelity renders.
//
// Serves the built preview of THIS worktree on :4331, seeds a
// 10-channel M3U fixture with a now-relative EPG, and screenshots
// the Live TV landing at 1920x1080 in four states:
//   (a) hero-bbc-enriched — resume channel "Basic UK: BBC One"
//       (prefixed name, provider tvg-id NOT in the EPG; the guide
//       carries it as "BBC One" / bbconelondon.uk) with a seeded
//       enrichment-cache backdrop. This is the user's photo case:
//       the hero must show BBC One's programme with art.
//   (b) hero-bbc-noart — same, no enrichment cache: the honest
//       no-art state (programme-led, channel brand on the right,
//       never a flat mauve slab).
//   (c) hero-fallback — recents point at "Obscure Channel 9"
//       (no EPG anywhere); the hero must fall back to a live
//       channel ("On Now") instead of a "Live TV" band.
//   (d) hero-noepg — EPG route 404s: no programme anywhere; the
//       hero keeps the resume channel with its honest
//       no-programme state.
// No paid AI calls: api.openai.com is aborted + logged; TMDB is
// inactive in the fixture (no key) — the enriched state is proven
// via the seeded enrichment cache, the same cache the TMDb path
// writes to, so the art-swap path is the real one.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";

const require = createRequire("/home/hatch/workspace/couchhub-tv/node_modules/playwright/package.json");
const { chromium } = require("playwright");

const ROOT = "/home/hatch/workspace/couchhub-tv-0114-w4";
const OUT = "/home/hatch/workspace/couchhub-tv-0114-w4/docs/screenshots";
const BASE = "http://127.0.0.1:4331";
const PLAYLIST_ID = "fixture-hero-tv";
const CHROME = "/home/hatch/workspace/.chrome-test/chrome-linux/chrome";

mkdirSync(OUT, { recursive: true });

const ART_PNG = readFileSync(`${OUT}/fixtures/hero-art.png`);

const PLAYLIST = `#EXTM3U x-tvg-url="https://fixtures.invalid/epg.xml"
#EXTINF:-1 tvg-id="bbc-one-provider" tvg-logo="https://fixtures.invalid/logos/bbc-one.png" group-title="Basic UK",Basic UK: BBC One
https://fixtures.invalid/live/1.m3u8
#EXTINF:-1 tvg-id="rte-one" tvg-logo="https://fixtures.invalid/logos/rte-one.png" group-title="Irish & UK",RTÉ One
https://fixtures.invalid/live/2.m3u8
#EXTINF:-1 tvg-id="sky-f1" tvg-logo="https://fixtures.invalid/logos/sky-f1.png" group-title="Sports",Sky Sports F1 HD
https://fixtures.invalid/live/3.m3u8
#EXTINF:-1 tvg-id="bbc-two-provider" tvg-logo="https://fixtures.invalid/logos/bbc-two.png" group-title="Basic UK",Basic UK: BBC Two
https://fixtures.invalid/live/4.m3u8
#EXTINF:-1 tvg-id="virgin-one" tvg-logo="https://fixtures.invalid/logos/virgin-one.png" group-title="Irish & UK",Virgin Media One
https://fixtures.invalid/live/5.m3u8
#EXTINF:-1 tvg-id="sky-cinema" tvg-logo="https://fixtures.invalid/logos/sky-cinema.png" group-title="Movies",Sky Cinema Action
https://fixtures.invalid/live/6.m3u8
#EXTINF:-1 tvg-id="sky-news" tvg-logo="https://fixtures.invalid/logos/sky-news.png" group-title="News",Sky News
https://fixtures.invalid/live/7.m3u8
#EXTINF:-1 tvg-id="comedy-central" tvg-logo="https://fixtures.invalid/logos/comedy-central.png" group-title="Entertainment",Comedy Central
https://fixtures.invalid/live/8.m3u8
#EXTINF:-1 tvg-id="cartoon-net" tvg-logo="https://fixtures.invalid/logos/cartoon-net.png" group-title="Kids",Cartoon Network
https://fixtures.invalid/live/9.m3u8
#EXTINF:-1 tvg-id="obscure-9" tvg-logo="https://fixtures.invalid/logos/obscure-9.png" group-title="Entertainment",Obscure Channel 9
https://fixtures.invalid/live/10.m3u8
`;

function fmt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}
const MIN = 60_000;
function prog(channel, title, startMin, stopMin, desc) {
  const t0 = Date.now();
  return `  <programme start="${fmt(new Date(t0 + startMin * MIN))}" stop="${fmt(new Date(t0 + stopMin * MIN))}" channel="${channel}">
    <title>${title}</title>
    <desc>${desc}</desc>
  </programme>`;
}
const EPG = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="bbconelondon.uk"><display-name>BBC One</display-name></channel>
  <channel id="rte-one"><display-name>RTÉ One</display-name></channel>
  <channel id="sky-f1"><display-name>Sky Sports F1</display-name></channel>
  <channel id="bbc2.uk"><display-name>BBC Two</display-name></channel>
  <channel id="virgin-one"><display-name>Virgin Media One</display-name></channel>
  <channel id="sky-cinema"><display-name>Sky Cinema</display-name></channel>
  <channel id="sky-news"><display-name>Sky News</display-name></channel>
  <channel id="comedy-central"><display-name>Comedy Central</display-name></channel>
  <channel id="cartoon-net"><display-name>Cartoon Network</display-name></channel>
${prog("bbconelondon.uk", "The One Show", -25, 35, "Alex Jones and Clara Amfo bring you the latest celebrity interviews, music and topical chat, live from London.")}
${prog("bbconelondon.uk", "EastEnders", 35, 65, "Drama continues in Walford as the Square faces another dramatic evening.")}
${prog("rte-one", "The Six O'Clock Show", -40, 20, "Live from Dublin with the day's entertainment and real-life stories.")}
${prog("rte-one", "RTÉ News: Six One", 20, 50, "The day's main news from Ireland and around the world.")}
${prog("sky-f1", "F1: Brazilian Grand Prix — Qualifying", -30, 90, "Live coverage of qualifying from Interlagos as the grid for the Brazilian Grand Prix takes shape.")}
${prog("sky-f1", "F1: Qualifying Highlights", 90, 120, "The best of qualifying from Interlagos.")}
${prog("bbc2.uk", "University Challenge", -10, 20, "Students battle it out in the quiz.")}
${prog("virgin-one", "The Chase", -20, 40, "Bradley Walsh hosts the quiz.")}
${prog("sky-cinema", "Fast & Furious 9", -50, 70, "Dom Toretto faces his past.")}
${prog("sky-news", "Sky News Tonight", -60, 60, "The evening's top stories.")}
${prog("comedy-central", "Friends", -15, 45, "The one with the quiz.")}
${prog("cartoon-net", "Adventure Time", -5, 25, "Finn and Jake's adventures.")}
</tv>`;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const tb = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function solidPng(hex, w = 64, h = 64) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
const LOGO_COLORS = ["e5484d", "3e7bfa", "7c5cff", "e8a33d", "2fbf71", "e5498d", "19b5c9", "8a5a2b", "6b7c93"];
const logoPngs = new Map();
function logoFor(url) {
  if (!logoPngs.has(url)) {
    const i = [...logoPngs.keys()].length % LOGO_COLORS.length;
    logoPngs.set(url, solidPng(LOGO_COLORS[i]));
  }
  return logoPngs.get(url);
}

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetch(url)
        .then((r) => (r.ok || r.status === 404 ? resolve(true) : tick()))
        .catch(() => {
          if (Date.now() - start > timeoutMs) reject(new Error("preview server did not start"));
          else setTimeout(tick, 500);
        });
    };
    tick();
  });
}

const results = {};
function note(name, obj) {
  results[name] = obj;
  console.log(`--- ${name} ---`, JSON.stringify(obj));
}

async function main() {
  const preview = spawn("node_modules/.bin/astro", ["preview", "--port", "4331", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const openAiAttempts = [];
  try {
    await waitForServer(`${BASE}/livetv`);
    console.log("[step] server up");
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
    await context.route("**/api.openai.com/**", async (route) => {
      openAiAttempts.push(route.request().url());
      await route.abort();
    });
    await context.route("https://api.github.com/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    let withEpg = true;
    await context.route("https://fixtures.invalid/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/playlist.m3u")
        return route.fulfill({ status: 200, contentType: "audio/x-mpegurl", body: PLAYLIST });
      if (url.pathname === "/epg.xml") {
        if (!withEpg) return route.fulfill({ status: 404, contentType: "text/plain", body: "no epg" });
        return route.fulfill({ status: 200, contentType: "application/xml", body: EPG });
      }
      if (url.pathname === "/art/bbc-one.jpg")
        return route.fulfill({ status: 200, contentType: "image/png", body: ART_PNG });
      if (url.pathname.startsWith("/logos/"))
        return route.fulfill({ status: 200, contentType: "image/png", body: logoFor(url.href) });
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    });

    async function seedBase() {
      await context.clearCookies();
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(500);
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.evaluate(({ playlistId }) => {
        localStorage.setItem("xt_playlists", JSON.stringify({
          entries: [{ _id: playlistId, title: "Fixture TV", type: "m3u", url: "https://fixtures.invalid/playlist.m3u", addedAt: Date.now() }],
          selectedId: playlistId,
        }));
        localStorage.setItem("xt_theme", "dark");
        localStorage.setItem("xt_perf_mode", "1");
        localStorage.setItem("xt_last_seen_version", "99.0.0");
        sessionStorage.setItem("xt_splash_done", "1");
        localStorage.setItem(`xt_m3u_epg:${playlistId}`, "https://fixtures.invalid/epg.xml");
      }, { playlistId: PLAYLIST_ID });
    }

    // Phase A: discover the fixture channel ids via the browser rows.
    await seedBase();
    await page.goto(`${BASE}/livetv?mode=browser`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(6000);
    const ids = await page.evaluate(() => {
      const out = {};
      for (const row of document.querySelectorAll("[data-browser-row]")) {
        const name = row.querySelector("[data-browser-name], .rs-livetv-browser__name")?.textContent?.trim()
          ?? row.textContent?.trim().slice(0, 40);
        out[name] = row.getAttribute("data-channel-id");
      }
      return out;
    });
    console.log("[step] channel ids", JSON.stringify(ids));
    const bbcId = Object.entries(ids).find(([name]) => name.includes("BBC One"))?.[1];
    const obscureId = Object.entries(ids).find(([name]) => name.includes("Obscure"))?.[1];
    if (!bbcId || !obscureId) throw new Error(`channel ids not discovered: ${JSON.stringify(ids)}`);

    async function heroInfo() {
      return page.evaluate(() => {
        const hero = document.querySelector("[data-livetv-hero]");
        const r = hero?.getBoundingClientRect();
        const artImg = hero?.querySelector("[data-hero-art] img");
        return {
          heroVisible: !!hero && !hero.hasAttribute("hidden"),
          heroHeightPx: r ? Math.round(r.height) : null,
          heroTopPx: r ? Math.round(r.top) : null,
          eyebrow: hero?.querySelector("[data-hero-eyebrow]")?.textContent?.trim() ?? "",
          channel: hero?.querySelector("[data-hero-title]")?.textContent?.trim() ?? "",
          programme: hero?.querySelector("[data-hero-programme-title]")?.textContent?.trim() ?? "",
          time: hero?.querySelector("[data-hero-programme-time]")?.textContent?.trim() ?? "",
          progressPct: hero?.querySelector("[data-hero-progress-fill]")?.style.width ?? "",
          progressHidden: hero?.querySelector("[data-hero-progress-wrap]")?.hasAttribute("hidden") ?? null,
          description: hero?.querySelector("[data-hero-description]")?.textContent?.trim().slice(0, 120) ?? "",
          descriptionHidden: hero?.querySelector("[data-hero-description]")?.hasAttribute("hidden") ?? null,
          next: hero?.querySelector("[data-hero-next]")?.textContent?.trim() ?? "",
          nextHidden: hero?.querySelector("[data-hero-next]")?.hasAttribute("hidden") ?? null,
          watchChannelId: hero?.querySelector("[data-hero-watch]")?.getAttribute("data-channel-id") ?? "",
          artImg: !!artImg,
          artSrc: artImg?.getAttribute("src") ?? "",
          placeholderChannel: hero?.querySelector(".rs-livetv-programme-art__channel")?.textContent?.trim() ?? "",
          placeholderRect: (() => {
            const s = hero?.querySelector(".rs-livetv-programme-art__channel");
            if (!s) return null;
            const r = s.getBoundingClientRect();
            const cs = getComputedStyle(s);
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), color: cs.color, fontSize: cs.fontSize };
          })(),
          heroClasses: hero ? [...hero.classList].filter((c) => c.includes("no-") || c.includes("has-")) : [],
          quickPills: [...document.querySelectorAll("[data-landing-action]")].filter((b) => !b.hasAttribute("hidden")).length,
          categories: document.querySelectorAll("[data-category-id]").length,
          scrollH: document.documentElement.scrollHeight,
          innerH: window.innerHeight,
        };
      });
    }

    async function waitForHero(timeoutMs = 40000) {
      // The EPG loads in the background after the landing mounts
      // (stream.ts boot load + parse), so the hero can sit on the
      // "Live TV" no-programme state for many seconds before the
      // late EPG_LOADED re-render fills it. Poll until a real
      // programme lands; the no-EPG shot times out instead, which
      // is its honest state. Returns the elapsed wait.
      const start = Date.now();
      for (;;) {
        const info = await heroInfo();
        if (info.heroVisible && info.programme && info.programme !== "Live TV") {
          return { info, waitedMs: Date.now() - start };
        }
        if (Date.now() - start > timeoutMs) return { info, waitedMs: Date.now() - start };
        await page.waitForTimeout(500);
      }
    }

    async function shot({ label, epg, recentId, enriched }) {
      withEpg = epg;
      await seedBase();
      await page.evaluate(({ playlistId, recentId, enriched }) => {
        if (recentId != null) {
          localStorage.setItem("xt_prefs", JSON.stringify({
            [playlistId]: {
              recLive: [{ id: recentId, name: "seeded recent", logo: null, ts: Date.now() }],
            },
          }));
        }
        if (enriched) {
          localStorage.setItem("xt_livetv_enrichment_v1", JSON.stringify({
            "The One Show": {
              art: {
                backdropUrl: "https://fixtures.invalid/art/bbc-one.jpg",
                posterUrl: null,
                stillUrl: null,
                source: "tmdb-series",
                confidence: 0.95,
                matchedTitle: "The One Show",
                synopsis: null,
                genres: [],
              },
              expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
              negative: false,
            },
          }));
        }
      }, { playlistId: PLAYLIST_ID, recentId, enriched });
      await page.goto(`${BASE}/livetv`, { waitUntil: "domcontentloaded", timeout: 20000 });
      const { info, waitedMs } = await waitForHero(epg ? 40000 : 20000);
      // Let the async art upgrade settle, then re-read.
      await page.waitForTimeout(2000);
      const settled = await heroInfo();
      note(label, { ...settled, heroWaitedMs: waitedMs, earlyProgramme: info.programme });
      await page.screenshot({ path: `${OUT}/${label}.png` });
    }

    await shot({ label: "hero-bbc-enriched", epg: true, recentId: bbcId, enriched: true });
    await shot({ label: "hero-bbc-noart", epg: true, recentId: bbcId, enriched: false });
    await shot({ label: "hero-fallback", epg: true, recentId: obscureId, enriched: false });
    await shot({ label: "hero-noepg", epg: false, recentId: bbcId, enriched: false });

    note("openai-attempts", { count: openAiAttempts.length, urls: openAiAttempts });
    note("channel-ids", ids);
    writeFileSync(`${OUT}/hero-results.json`, JSON.stringify({ ...results, openAiAttempts }, null, 2));
    await browser.close();
  } finally {
    preview.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
