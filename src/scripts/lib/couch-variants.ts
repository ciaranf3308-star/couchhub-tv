// Couch detail variant picker (0.11.9) — shared by the movie and series
// detail pages.
//
// Grouping (language-groups.ts) already decides which catalogue rows
// are versions of the same title (TMDb-first, conservative); the
// detail pages only ever received the group's primary, so an
// unplayable primary was a dead end. This module finds the group the
// current item belongs to and builds honest per-variant labels from
// provider data only: the language prefix, the quality tokens, and
// the container extension. Nothing is invented — a variant with no
// distinguishing provider data is labelled "Version N".
//
// Selecting a variant plays THAT variant's stream: movies play in
// place on the same detail page; series navigate to the variant
// series' detail (episodes belong to a series entry). The pages own
// the click behaviour; this module only finds and labels.

import {
  groupEntries,
  type TitleGroupKind,
} from "@/scripts/lib/language-groups.ts";
import {
  parseNamePrefix,
  prefixQualityTokens,
  languageTagLabel,
} from "@/scripts/lib/language-tags.ts";
import { getActiveLocale } from "@/scripts/lib/i18n.js";

export interface CouchVariantRow {
  id: number | string;
  name?: string | null;
  year?: string | number | null;
  tmdb?: number | string | null;
  containerExt?: string | null;
}

export interface CouchVariantOption {
  /** The catalogue row id to play / navigate to. */
  id: number | string;
  /** Short distinguishing label, e.g. "English · 4K · MKV". */
  label: string;
  /** Full provider name, for the button's accessible name / title. */
  fullName: string;
  /** True for the variant the detail page is currently showing. */
  isCurrent: boolean;
}

function variantLabel(
  rawName: string,
  containerExt: string | null,
  fallbackIndex: number,
  locale: string
): string {
  const { tag } = parseNamePrefix(rawName);
  const parts: string[] = [];
  if (tag) {
    const label = languageTagLabel(tag, locale);
    if (label) parts.push(label);
  }
  const quality = prefixQualityTokens(rawName);
  if (quality.length > 0) parts.push(quality.join(" "));
  if (containerExt) parts.push(containerExt.replace(/^\./, "").toUpperCase());
  if (parts.length === 0) return `Version ${fallbackIndex}`;
  return parts.join(" · ");
}

/**
 * Variant options for the group containing `currentId`, or null when
 * the item is ungrouped / the group has a single member. Grouping
 * re-runs over the supplied rows (the registry replacement is the
 * designed behaviour — catalog-index does the same per build).
 */
export function couchVariantOptions<Row extends CouchVariantRow>(
  rows: Row[],
  kind: TitleGroupKind,
  currentId: number | string
): CouchVariantOption[] | null {
  if (rows.length < 2) return null;
  const groups = groupEntries(rows, kind);
  const currentKey = String(currentId);
  const group = groups.find((candidate) =>
    candidate.variantIds.includes(currentKey)
  );
  if (!group || group.variantIds.length < 2) return null;
  const byId = new Map<string, Row>(rows.map((row) => [String(row.id), row]));
  const locale = getActiveLocale();
  const seen = new Map<string, number>();
  const options: CouchVariantOption[] = [];
  group.variantIds.forEach((variantKey, index) => {
    const row = byId.get(variantKey);
    if (!row) return;
    const base = variantLabel(
      row.name ?? "",
      row.containerExt ?? null,
      index + 1,
      locale
    );
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const label = occurrence > 1 ? `${base} (${occurrence})` : base;
    options.push({
      id: row.id,
      label,
      fullName: row.name ?? "",
      isCurrent: variantKey === currentKey,
    });
  });
  return options.length > 1 ? options : null;
}

/**
 * Render variant buttons into `mount`. The current variant's button
 * is disabled (it is what the page is already showing); the rest call
 * `onSelect` with the variant's row id. Returns true when anything
 * was rendered.
 */
export function renderCouchVariantPicker(
  mount: HTMLElement | null,
  options: CouchVariantOption[],
  onSelect: (id: number | string) => void
): boolean {
  if (!mount || options.length === 0) return false;
  mount.replaceChildren();
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rs-hero__action rs-hero__action--secondary";
    button.setAttribute("data-nylah-item", "");
    button.textContent = option.label;
    if (option.fullName) {
      button.title = option.fullName;
      button.setAttribute("aria-label", `Version: ${option.fullName}`);
    }
    if (option.isCurrent) {
      button.disabled = true;
      button.setAttribute("aria-current", "true");
    } else {
      button.addEventListener("click", () => onSelect(option.id));
    }
    mount.appendChild(button);
  }
  (window as unknown as { SpatialNavigation?: { makeFocusable?: () => void } })
    .SpatialNavigation?.makeFocusable?.();
  return true;
}
