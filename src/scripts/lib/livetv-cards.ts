// RedSilk Couch — Live TV card builders (W1, canonical owner).
//
// Client-side renderers for the two shared Astro components
// (TvChannelCard.astro / TvProgrammeMeta.astro). Live TV data only
// exists at runtime (cache-only reads in the browser), so the Home
// rails and the Channel Browser build their cards with these
// builders instead of server-rendering them — but the DOM they
// produce is the SAME contract: same classes, same
// data-channel-card / data-programme-meta attributes, same optional
// parts omitted (never invented). If the Astro markup changes,
// change these builders in the same commit.
//
// All text goes through textContent — channel / programme strings
// are provider data, never trusted HTML.
import {
  programmeProgress,
  epgTimeRangeLabel,
} from "./couch-livetv-epg";
import { fallbackMarkFor } from "./couch-image";
import type { LivetvChannel } from "./livetv-data";

export interface ChannelCardRenderOptions {
  nowTitle?: string | null;
  nextTitle?: string | null;
  progress?: number | null;
  catchup?: boolean;
  favourite?: boolean;
  size?: "large" | "medium";
  focusKey?: string;
  /** When set the card is a link to this href; otherwise the article itself is the operable element. */
  href?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function logoBox(channel: Pick<LivetvChannel, "logo" | "displayName" | "name">): HTMLElement {
  const wrap = el("span", "rs-livetv-channel-card__logo");
  const label = channel.displayName || channel.name || "";
  if (channel.logo) {
    const img = el("img") as HTMLImageElement;
    img.src = channel.logo;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      img.remove();
      wrap.appendChild(initialMark(label));
    });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(initialMark(label));
  }
  return wrap;
}

function initialMark(label: string): HTMLElement {
  // Branded fallback from the shared couch-image helper (W7
  // consumes it — the "N" brand mark for logos; the channel name
  // sits beside the logo in every card, so no info is lost).
  const mark = el("span", "rs-livetv-channel-card__initial");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = fallbackMarkFor("logo", label);
  return mark;
}

/**
 * One channel card. Mirrors TvChannelCard.astro: article
 * [data-channel-card][data-channel-id][data-focus-key], fitted logo,
 * name (+ channel number), now / up-next lines, progress bar,
 * catch-up badge, favourite mark. Missing optional parts are
 * omitted, never invented.
 */
export function buildChannelCardElement(
  channel: Pick<LivetvChannel, "id" | "name" | "displayName" | "logo" | "chno">,
  opts: ChannelCardRenderOptions = {},
): HTMLElement {
  const size = opts.size ?? "medium";
  const label = channel.displayName || channel.name || `#${channel.id}`;
  const article = el("article", `rs-livetv-channel-card rs-livetv-channel-card--${size}`);
  article.setAttribute("data-channel-card", "");
  article.setAttribute("data-channel-id", String(channel.id));
  if (opts.focusKey) article.setAttribute("data-focus-key", opts.focusKey);

  const body = el("span", "rs-livetv-channel-card__body");
  const name = el("span", "rs-livetv-channel-card__name");
  if (channel.chno != null) {
    const num = el("span", "rs-livetv-channel-card__num");
    num.textContent = String(channel.chno);
    name.appendChild(num);
  }
  name.appendChild(document.createTextNode(label));
  body.appendChild(name);
  if (opts.nowTitle) {
    const now = el("span", "rs-livetv-channel-card__now");
    now.textContent = opts.nowTitle;
    body.appendChild(now);
  }
  if (opts.nextTitle) {
    const next = el("span", "rs-livetv-channel-card__next");
    next.textContent = `Up next: ${opts.nextTitle}`;
    body.appendChild(next);
  }

  const extras: HTMLElement[] = [];
  if (opts.favourite) {
    const fav = el("span", "rs-livetv-channel-card__fav");
    fav.setAttribute("aria-label", "Favourite");
    fav.textContent = "♥";
    extras.push(fav);
  }
  if (opts.catchup) {
    const badge = el("span", "rs-livetv-channel-card__catchup");
    badge.textContent = "Catch-up";
    extras.push(badge);
  }
  const pct =
    typeof opts.progress === "number" && Number.isFinite(opts.progress)
      ? Math.max(0, Math.min(1, opts.progress))
      : null;
  let progress: HTMLElement | null = null;
  if (pct !== null) {
    progress = el("span", "rs-livetv-channel-card__progress");
    progress.setAttribute("aria-hidden", "true");
    const fill = el("span");
    fill.style.width = `${Math.round(pct * 100)}%`;
    progress.appendChild(fill);
  }

  if (opts.href) {
    const link = el("a", "rs-livetv-channel-card__link") as HTMLAnchorElement;
    link.href = opts.href;
    if (opts.focusKey) link.setAttribute("data-focus-key", opts.focusKey);
    link.appendChild(logoBox(channel));
    link.appendChild(body);
    for (const extra of extras) link.appendChild(extra);
    if (progress) link.appendChild(progress);
    article.appendChild(link);
  } else {
    article.setAttribute("tabindex", "0");
    article.setAttribute("role", "button");
    article.appendChild(logoBox(channel));
    article.appendChild(body);
    for (const extra of extras) article.appendChild(extra);
    if (progress) article.appendChild(progress);
  }
  return article;
}

export interface ProgrammeMetaRenderInput {
  title: string;
  startMs: number;
  stopMs: number;
  desc?: string | null;
  catchup?: boolean;
  live?: boolean;
  nowMs?: number;
}

/**
 * One programme meta block. Mirrors TvProgrammeMeta.astro:
 * title (+ LIVE badge) + time range + progress + description +
 * catch-up badge. Missing optional props are omitted, never
 * invented. Returns null when there is no title to show.
 */
export function buildProgrammeMetaElement(
  meta: ProgrammeMetaRenderInput,
): HTMLElement | null {
  if (!meta.title) return null;
  const root = el("div", "rs-livetv-programme-meta");
  root.setAttribute("data-programme-meta", "");
  const title = el("p", "rs-livetv-programme-meta__title");
  if (meta.live) {
    const badge = el("span", "rs-livetv-programme-meta__live");
    badge.textContent = "LIVE";
    title.appendChild(badge);
  }
  title.appendChild(document.createTextNode(meta.title));
  root.appendChild(title);
  const validRange =
    Number.isFinite(meta.startMs) &&
    Number.isFinite(meta.stopMs) &&
    meta.stopMs > meta.startMs;
  if (validRange) {
    const time = el("p", "rs-livetv-programme-meta__time");
    time.textContent = epgTimeRangeLabel(meta.startMs, meta.stopMs, "en-IE");
    root.appendChild(time);
  }
  if (meta.desc) {
    const desc = el("p", "rs-livetv-programme-meta__desc");
    desc.textContent = meta.desc;
    root.appendChild(desc);
  }
  if (meta.catchup) {
    const badge = el("p", "rs-livetv-programme-meta__catchup");
    badge.textContent = "Catch-up available";
    root.appendChild(badge);
  }
  if (validRange) {
    const bar = el("span", "rs-livetv-programme-meta__progress");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("span");
    fill.style.width = `${Math.round(programmeProgress(meta.startMs, meta.stopMs, meta.nowMs ?? Date.now()) * 100)}%`;
    bar.appendChild(fill);
    root.appendChild(bar);
  }
  return root;
}
