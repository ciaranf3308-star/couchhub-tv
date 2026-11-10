// RedSilk Couch — image fallback helpers (W1 shared system).
//
// TvImage must NEVER render a broken-image icon: on error (or an
// empty/missing src) the <img> is hidden and the branded fallback
// block shows instead. The DOM half lives here so TvImage.astro and
// the tests exercise the same code.

export type TvImageKind = "poster" | "backdrop" | "logo" | "thumb";

/** True only for a non-blank src string. Pure. */
export function isUsableImageSrc(src: string | undefined | null): boolean {
  return typeof src === "string" && src.trim().length > 0;
}

/**
 * Fallback mark for a title: up to two initials ("Nylah Studios" ->
 * "NS", "Dune" -> "D"). Logos fall back to the "N" brand mark.
 * Pure.
 */
export function fallbackMarkFor(kind: TvImageKind, title?: string): string {
  if (kind === "logo") return "N";
  const words = (title ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "N";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0].slice(0, 1) + words[1].slice(0, 1)).toUpperCase();
}

/**
 * Swap one <img> to its fallback: marks the wrapping [data-tv-image]
 * with .is-fallback (CSS hides the img and shows the fallback block).
 * Returns true when a wrapper was found and marked.
 */
export function applyImageFallback(img: HTMLImageElement | null): boolean {
  if (!img) return false;
  const wrapper = img.closest?.("[data-tv-image]");
  if (!wrapper) return false;
  wrapper.classList.add("is-fallback");
  return true;
}

/**
 * Arm fallback handling under `root` (default document). Idempotent:
 * a capture-phase error listener catches <img> failures (error events
 * do not bubble) and a scan covers images that already failed before
 * this ran. Safe to call once per page from TvImage.
 */
export function armTvImageFallbacks(
  root: ParentNode = document,
): void {
  const doc = root.ownerDocument ?? (root as unknown as Document);
  const win = doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);
  const flag = "__rsTvImageFallbacksArmed" as const;
  const store = (win ?? globalThis) as unknown as Record<string, unknown>;
  if (store[flag]) return;
  store[flag] = true;

  const onError = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target && target.tagName === "IMG") {
      applyImageFallback(target as HTMLImageElement);
    }
  };
  // Capture phase: <img> error events do not bubble.
  doc.addEventListener("error", onError, true);

  // Images that already finished (and failed) before arming.
  const imgs = (root as ParentNode).querySelectorAll?.("img[data-tv-image-img]") ?? [];
  imgs.forEach((img) => {
    const el = img as HTMLImageElement;
    if (el.complete && el.naturalWidth === 0) applyImageFallback(el);
  });
}
