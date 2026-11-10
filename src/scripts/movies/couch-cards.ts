// Couch cards — JS-rendered catalogue cards for the Movies / Series
// Couch screens (W4).
//
// The catalogue loads client-side (Xtream provider), so the browse and
// detail pages build cards in JS. This builder emits the exact same
// markup the W1 `TvCard` Astro component renders (same classes, same
// `data-nylah-item` / `data-couch-key` hooks, same TvImage fallback
// structure) so focus, spatial nav and focus memory treat JS cards and
// Astro cards identically. It is the only place that markup is
// duplicated, and it is kept in lock-step with TvCard.astro /
// TvImage.astro on purpose: one helper, used by every Couch VOD screen.

import { fallbackMarkFor, isUsableImageSrc, armTvImageFallbacks } from "@/scripts/lib/couch-image.ts";

export interface CouchCardView {
  title: string;
  subtitle?: string;
  meta?: string;
  image?: string | null;
  imageAlt?: string;
  kind?: "poster" | "landscape" | "channel";
  /** Watched fraction in [0, 1]. Shown only when > 0. */
  progress?: number;
  badge?: string;
  href?: string;
  /** Stable catalogue id for focus memory. */
  itemKey?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Build one catalogue card element. `armFallbacks` defaults to arming
 * the shared TvImage error handling once per document (idempotent).
 */
export function buildCouchCard(view: CouchCardView, armFallbacks = true): HTMLElement {
  const kind = view.kind ?? "poster";
  const imageKind = kind === "poster" ? "poster" : kind === "channel" ? "logo" : "backdrop";
  const tag = view.href ? "a" : "div";
  const card = el(tag, `rs-card rs-card--${kind}`);
  card.setAttribute("data-nylah-item", "");
  if (view.itemKey) card.setAttribute("data-couch-key", view.itemKey);
  if (view.href) (card as HTMLAnchorElement).href = view.href;
  else {
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
  }
  card.setAttribute("aria-label", view.title);

  const media = el("span", "rs-card__media");
  const imageWrap = el("div", `rs-image rs-image--${imageKind}`);
  imageWrap.setAttribute("data-tv-image", "");
  imageWrap.setAttribute("data-kind", imageKind);
  const usable = isUsableImageSrc(view.image ?? null);
  if (!usable) imageWrap.classList.add("is-fallback");
  if (usable) {
    const img = el("img", "");
    img.setAttribute("src", view.image as string);
    img.setAttribute("alt", view.imageAlt ?? view.title);
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("data-tv-image-img", "");
    imageWrap.appendChild(img);
  }
  const fallback = el("div", "rs-image__fallback");
  fallback.setAttribute("aria-hidden", "true");
  const mark = el("span", "rs-image__fallback-mark");
  mark.textContent = fallbackMarkFor(imageKind, view.title);
  fallback.appendChild(mark);
  if (view.title) {
    const fbTitle = el("span", "rs-image__fallback-title");
    fbTitle.textContent = view.title;
    fallback.appendChild(fbTitle);
  }
  imageWrap.appendChild(fallback);
  media.appendChild(imageWrap);

  if (view.badge) {
    const badge = el("span", "rs-card__badge");
    badge.textContent = view.badge;
    media.appendChild(badge);
  }
  const pct =
    typeof view.progress === "number" && Number.isFinite(view.progress)
      ? Math.max(0, Math.min(1, view.progress))
      : null;
  if (pct !== null && pct > 0) {
    const bar = el("span", "rs-card__progress");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("span", "rs-card__progress-fill");
    fill.setAttribute("style", `width: ${Math.round(pct * 100)}%`);
    bar.appendChild(fill);
    media.appendChild(bar);
  }
  card.appendChild(media);

  const body = el("span", "rs-card__body");
  const title = el("span", "rs-card__title");
  title.textContent = view.title;
  body.appendChild(title);
  if (view.subtitle) {
    const sub = el("span", "rs-card__subtitle");
    sub.textContent = view.subtitle;
    body.appendChild(sub);
  }
  if (view.meta) {
    const meta = el("span", "rs-card__meta");
    meta.textContent = view.meta;
    body.appendChild(meta);
  }
  card.appendChild(body);

  if (armFallbacks) {
    try {
      armTvImageFallbacks(document);
    } catch {
      // Non-DOM test runtimes: the markup is still correct.
    }
  }
  return card;
}

/**
 * Render cards into a container, replacing its children. Cards are
 * built from the supplied views in order. Also (re)arms spatial
 * navigation when it is present, so D-pad focus reaches the new cards.
 */
export function renderCouchCards(container: HTMLElement, views: CouchCardView[]): void {
  container.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const view of views) frag.appendChild(buildCouchCard(view, false));
  container.appendChild(frag);
  try {
    armTvImageFallbacks(document);
  } catch {
    // ignore — non-DOM runtimes
  }
  try {
    (window as any).SpatialNavigation?.makeFocusable?.();
  } catch {
    // ignore
  }
}
