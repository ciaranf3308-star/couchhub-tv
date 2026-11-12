// W2 Settings rebuild 0.11.4 renders — CouchHub TV.
// Serves THIS worktree's built dist via python http.server and screenshots
// the changed cards at 1920x1080 with headless Chrome (playwright).
// Fixture data only — nothing here ships.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire("/home/hatch/workspace/couchhub-tv-0114-w2/package.json");
const { chromium } = require("playwright");

const ROOT = "/home/hatch/workspace/couchhub-tv-0114-w2";
const OUT = `${ROOT}/docs/screenshots`;
const BASE = "http://127.0.0.1:4404";
const CHROME = "/home/hatch/workspace/.chrome-test/chrome-linux/chrome";

mkdirSync(OUT, { recursive: true });

const preview = spawn(
  "python3",
  ["-m", "http.server", "4404", "--directory", `${ROOT}/dist`, "--bind", "127.0.0.1"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
);
const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("preview server did not come up");
};

const results = {};
function note(name, obj) {
  results[name] = obj;
  console.log(`--- ${name} ---`, JSON.stringify(obj));
}

const shot = async (page, name, targetSel) => {
  if (targetSel) {
    const ok = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: "start" });
      return true;
    }, targetSel);
    note(`scroll:${name}`, { target: targetSel, found: ok });
    await page.waitForTimeout(500);
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_tmdb_enabled", "");
      localStorage.setItem("xt_livetv_resume_last", "1");
      localStorage.setItem("xt_last_seen_version", "99.0.0");
      sessionStorage.setItem("xt_splash_done", "1");
    } catch {}
  });

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // ---- live DOM checks for the W2 fixes ----
  const checks = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const txt = (sel) => (q(sel)?.textContent || "").trim();
    return {
      monoRowGone: !q("#card-mono-audio") && !q("#settings-mono-audio"),
      tmdbState: txt("#settings-tmdb-state"),
      tmdbStateVisible: !!q("#settings-tmdb-state"),
      aiHeader: txt("#card-ai-discovery .settings-surface__helper"),
      costRowGone: !document.body.textContent.includes("AI questions are billed separately"),
      setupStepsGone: !document.body.textContent.includes("Set up in four steps"),
      modelControlPresent: !!q("#settings-ai-model-control"),
      modelCustomHiddenInitially: q("#settings-ai-model-custom")?.classList.contains("hidden"),
      uaOverrideNotePresent: !!q("#ua-override-note"),
      displayDiagGone: !q("#update-display-diag"),
      resumeLiveTv: !!q("#settings-resume-last-livetv"),
      resumePlayback: !!q("#settings-resume-last-playback"),
      resumeOnPressed:
        q("#settings-resume-last-livetv [data-resume='on']")?.getAttribute("aria-pressed"),
      followedErrorPresent: !!q("#settings-followed-task-error"),
      forkBugLink: [...document.querySelectorAll("a")].some((a) =>
        (a.href || "").includes("ciaranf3308-star/couchhub-tv/issues")
      ),
      forkFeedbackLink: [...document.querySelectorAll("a")].some((a) =>
        (a.href || "").includes("ciaranf3308-star/couchhub-tv/discussions")
      ),
      upstreamIssueLink: [...document.querySelectorAll("a")].some((a) =>
        (a.href || "").includes("infinitel8p/Extreme-InfiniTV/issues")
      ),
      resetDialogBody: txt("#settings-reset-desc"),
      backupHelper: txt("#card-backup [data-i18n='settings.backup.helperLong']") || txt("#card-backup p"),
      // ---- 0.11.4 defect fixes (AI status / key saved / paste-masking) ----
      aiBadgePresent: !!q("#settings-ai-key-saved-badge"),
      aiBadgeHiddenWhenNoKey: q("#settings-ai-key-saved-badge")?.classList.contains("hidden"),
      aiKeyInputType: q("#settings-ai-key")?.getAttribute("type"),
      aiKeyInputValue: q("#settings-ai-key")?.value,
      tmdbKeyInputType: q("#settings-tmdb-key")?.getAttribute("type"),
      noAiReveal: !q("#settings-ai-reveal"),
      noTmdbReveal: !q("#settings-tmdb-reveal"),
      aiStatusLine: txt("#settings-ai-status"),
      aiKeyStatusLine: txt("#settings-ai-key-status"),
      aiTestMsgEmpty: txt("#settings-ai-msg") === "",
      // The status line must never claim "isn't set up yet" while a key
      // is saved; with no key saved here, the honest line is the off line.
      noNotSetUpLie: !document.body.textContent.includes("isn't set up yet"),
    };
  });
  note("w2-checks", checks);

  await shot(page, "w2-01-ai-discovery", "#card-ai-discovery");
  await shot(page, "w2-02-tmdb", "#card-tmdb");
  await shot(page, "w2-03-network-ua", "#card-network");
  await shot(page, "w2-04-followed", "#card-followed");
  await shot(page, "w2-05-playback-resume", "#playback-section");
  await shot(page, "w2-06-livetv-resume", "#card-livetv");
  await shot(page, "w2-07-backup", "#card-backup");
  await shot(page, "w2-08-about", "#update-section");
  await shot(page, "w2-09-danger", "#settings-danger");

  // Reset dialog open, for the honest-copy check.
  await page.evaluate(() => {
    document.getElementById("settings-reset-all")?.click();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/w2-10-reset-dialog.png` });
  note("reset-dialog-open", {
    dialogOpen: await page.evaluate(
      () => document.getElementById("settings-reset-dialog")?.open === true
    ),
  });

  await browser.close();
  writeFileSync(`${OUT}/w2-render-results.json`, JSON.stringify(results, null, 2));
  console.log("DONE");
} finally {
  preview.kill();
}
