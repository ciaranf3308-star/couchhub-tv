// 0.11.8 W2 — Browse filter drawer (brief §8, §9, §10, §16.4).
//
// ONE substantial elegant filter drawer, controller-designed.
// U/D move between families, L/R change values, A selects, B
// cancels/back, prominent Clear All + Apply. NO auto-apply: the
// drawer edits a DRAFT; nothing recalculates until Apply (no
// expensive grid rebuild per D-pad touch). B cancels the draft —
// the grid underneath is untouched. Closing restores focus to the
// invoker (the controller owns that; the drawer fires onCancel
// and never touches grid focus).
//
// Families (brief §8 movies / §9 series), in drawer order:
//   Genre (single-select; L/R cycles canonical genres — multi
//     stays unexposed, see browse-state.ts), Year/Decade (with a
//     custom-range row when the caller enables it), Rating,
//     Runtime (movies) / Seasons (series), Watch Status,
//     Favourites, Watch Later, Followed + New Episodes (series),
//     Language, Provider Category, Status (series, only with
//     genuine metadata).
// A family renders ONLY when its metadata supports it
// (BrowseFilterDrawerAvailability); unsupported families are
// omitted with a single honest footnote ("No runtime data in
// this catalogue"), never offered dead. Language offers ONLY
// tags actually present in the catalogue; provider category
// offers ONLY real provider labels.
//
// Value rows are L/R cyclers: each family shows its current
// value, and L/R steps through the ordered values. A on a value
// row steps forward (same as Right) — there is no second
// selection level to get lost in. The bottom two rows are
// actions: Apply (commits the draft) and Clear All (resets the
// DRAFT to defaults; Apply still commits — the header Reset All
// is the one-press immediate clear, see browse-everything.ts).
// Focus is trapped in the drawer while it is the top layer: the
// controller routes keys here and nowhere else.

import {
  BROWSE_DECADE_KEYS,
  BROWSE_RUNTIME_BUCKETS,
  BROWSE_SEASON_COUNT_BUCKETS,
  BROWSE_SERIES_STATUS_OPTIONS,
  BROWSE_WATCH_STATUS_OPTIONS,
  createBrowseFilters,
  type BrowseFilters,
  type BrowseKind,
  type BrowseRuntimeBucket,
  type BrowseSeasonCountBucket,
  type BrowseSeriesStatus,
  type BrowseWatchStatus,
} from "@/scripts/lib/browse-state.ts";
import { genreLabelForId } from "@/scripts/lib/genres.ts";

export interface BrowseFilterDrawerAvailability {
  genre: boolean;
  year: boolean;
  rating: boolean;
  /** Movies: verified runtime present. */
  runtime: boolean;
  /** Series: at least one confirmed season count. */
  seasonCounts: boolean;
  /** Fraction of series with a confirmed season count (0–1). Shown honestly. */
  seasonCoverage: number;
  /** Series status metadata genuinely present. */
  seriesStatus: boolean;
  /** Language tags actually present. Empty = family omitted. */
  languages: string[];
  /** Provider categories actually present: {id, label}. Empty = family omitted. */
  providerCategories: Array<{ id: string; label: string }>;
  /** Followed/new-episodes backing data present (series). */
  followedAvailable: boolean;
  newEpisodesAvailable: boolean;
  /** Custom year-range row offered (controller-usable). */
  customYearRange: boolean;
}

export const DEFAULT_FILTER_DRAWER_AVAILABILITY: BrowseFilterDrawerAvailability = {
  genre: true,
  year: true,
  rating: true,
  runtime: false,
  seasonCounts: false,
  seasonCoverage: 0,
  seriesStatus: false,
  languages: [],
  providerCategories: [],
  followedAvailable: false,
  newEpisodesAvailable: false,
  customYearRange: true,
};

export interface FilterFamilyOption {
  value: string;
  label: string;
}

export interface FilterFamily {
  id: string;
  label: string;
  /** Current value ("" = any). */
  value: string;
  options: FilterFamilyOption[];
  /** Honest footnote for the family (coverage / unknown handling). */
  note?: string;
  /** True for the Apply / Clear All action rows. */
  action?: "apply" | "clear";
}

/**
 * Build the filter families for a kind + draft + availability.
 * Pure: the DOM mount and the tests share this shape. The genre
 * family lists canonical genres for the kind (from the W1 shim
 * constants — integration swaps the source, not the shape).
 */
export function buildFilterFamilies(
  kind: BrowseKind,
  draft: BrowseFilters,
  availability: BrowseFilterDrawerAvailability,
  genreIds: string[],
): FilterFamily[] {
  const families: FilterFamily[] = [];

  if (availability.genre) {
    families.push({
      id: "genre",
      label: "Genre",
      value: draft.genre,
      options: [
        { value: "", label: "Any genre" },
        ...genreIds.map((id) => ({
          value: id,
          label: genreLabelForId(id, kind === "movie" ? "vod" : "series"),
        })),
      ],
      note: "One genre at a time — picking a new genre replaces the last.",
    });
  }

  if (availability.year) {
    const options: FilterFamilyOption[] = [
      { value: "", label: "Any decade" },
      ...BROWSE_DECADE_KEYS.map((key) => ({
        value: key,
        label: key === "older" ? "Before 1960" : key,
      })),
    ];
    families.push({
      id: "year",
      label: kind === "movie" ? "Release decade" : "First-air decade",
      value: draft.year,
      options,
      note: "Release year, not the date the provider added it.",
    });
    if (availability.customYearRange) {
      families.push({
        id: "yearRange",
        label: "Year range",
        value:
          draft.yearFrom != null || draft.yearTo != null
            ? `${draft.yearFrom ?? "…"}–${draft.yearTo ?? "…"}`
            : "",
        options: [
          { value: "", label: "No custom range" },
          { value: "2020-2026", label: "2020–2026" },
          { value: "2010-2019", label: "2010–2019" },
          { value: "2000-2009", label: "2000–2009" },
          { value: "1990-1999", label: "1990–1999" },
          { value: "1980-1989", label: "1980–1989" },
          { value: "1960-1979", label: "1960–1979" },
          { value: "1900-1959", label: "Before 1960" },
        ],
        note: "A custom range overrides the decade above.",
      });
    }
  }

  if (availability.rating) {
    families.push({
      id: "rating",
      label: "Minimum rating",
      value: String(draft.minRating || 0),
      options: [
        { value: "0", label: "Any rating" },
        { value: "6", label: "6+" },
        { value: "7", label: "7+" },
        { value: "8", label: "8+" },
        { value: "9", label: "9+" },
      ],
      note: "Titles with no rating never pass a minimum.",
    });
  }

  if (kind === "movie" && availability.runtime) {
    families.push({
      id: "runtime",
      label: "Length",
      value: draft.runtime,
      options: BROWSE_RUNTIME_BUCKETS.map((b) => ({ value: b.value, label: b.label })),
      note: "Verified runtime only — unknown lengths stay hidden behind a limit.",
    });
  }

  if (kind === "series" && availability.seasonCounts) {
    const pct = Math.round(availability.seasonCoverage * 100);
    families.push({
      id: "seasons",
      label: "Seasons",
      value: draft.seasonCount,
      options: BROWSE_SEASON_COUNT_BUCKETS.map((b) => ({
        value: b.value,
        label: b.label,
      })),
      note: `Confirmed counts only — season data covers ${pct}% of this catalogue.`,
    });
  }

  if (kind === "series" && availability.seriesStatus) {
    families.push({
      id: "status",
      label: "Status",
      value: draft.seriesStatus,
      options: BROWSE_SERIES_STATUS_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
      })),
    });
  }

  families.push({
    id: "watchStatus",
    label: "Watch status",
    value: draft.watchStatus,
    options: BROWSE_WATCH_STATUS_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label,
    })),
  });

  families.push({
    id: "favourites",
    label: "Favourites only",
    value: draft.favouritesOnly ? "1" : "",
    options: [
      { value: "", label: "No" },
      { value: "1", label: "Yes" },
    ],
  });

  families.push({
    id: "watchLater",
    label: "Watch Later only",
    value: draft.watchLaterOnly ? "1" : "",
    options: [
      { value: "", label: "No" },
      { value: "1", label: "Yes" },
    ],
  });

  if (kind === "series" && availability.followedAvailable) {
    families.push({
      id: "followed",
      label: "Followed only",
      value: draft.followedOnly ? "1" : "",
      options: [
        { value: "", label: "No" },
        { value: "1", label: "Yes" },
      ],
    });
  }

  if (kind === "series" && availability.newEpisodesAvailable) {
    families.push({
      id: "newEpisodes",
      label: "New Episodes only",
      value: draft.newEpisodesOnly ? "1" : "",
      options: [
        { value: "", label: "No" },
        { value: "1", label: "Yes" },
      ],
      note: "Backed by Followed Series episode detection.",
    });
  }

  if (availability.languages.length > 0) {
    families.push({
      id: "language",
      label: "Language",
      value: draft.language,
      options: [
        { value: "", label: "Any language" },
        ...availability.languages.map((tag) => ({ value: tag, label: tag })),
      ],
      note: "Original language from catalogue data only.",
    });
  }

  if (availability.providerCategories.length > 0) {
    families.push({
      id: "providerCategory",
      label: "Provider category",
      value: draft.providerCategory,
      options: [
        { value: "", label: "Any provider category" },
        ...availability.providerCategories.map((p) => ({
          value: p.id,
          label: p.label,
        })),
      ],
      note: "The provider's own grouping — distinct from genre.",
    });
  }

  families.push({
    id: "__apply",
    label: "Apply filters",
    value: "",
    options: [],
    action: "apply",
  });
  families.push({
    id: "__clear",
    label: "Clear All",
    value: "",
    options: [],
    action: "clear",
  });

  return families;
}

/** Omitted-family footnotes: one honest line per unsupported family. */
export function omittedFamilyNotes(
  kind: BrowseKind,
  availability: BrowseFilterDrawerAvailability,
): string[] {
  const notes: string[] = [];
  if (!availability.genre) notes.push("No genre data in this catalogue.");
  if (!availability.year) notes.push("No release-year data in this catalogue.");
  if (!availability.rating) notes.push("No rating data in this catalogue.");
  if (kind === "movie" && !availability.runtime) {
    notes.push("No runtime data in this catalogue — length filter unavailable.");
  }
  if (kind === "series" && !availability.seasonCounts) {
    notes.push("No confirmed season counts yet — open a series to load its seasons.");
  }
  if (kind === "series" && !availability.seriesStatus) {
    notes.push("No series status data in this catalogue.");
  }
  if (availability.languages.length === 0) {
    notes.push("No language data in this catalogue.");
  }
  return notes;
}

/**
 * Pure: cycle one family's value by delta (±1), wrapping within
 * its options. Returns a NEW draft. Action rows are untouched.
 * A genre cycle REPLACES the genre (single string). A year-range
 * cycle sets yearFrom/yearTo and clears the decade key.
 */
export function cycleFilterFamilyValue(
  draft: BrowseFilters,
  family: FilterFamily,
  delta: number,
): BrowseFilters {
  if (family.action || family.options.length === 0) return draft;
  const current = family.options.findIndex((o) => o.value === family.value);
  const at = current >= 0 ? current : 0;
  const next =
    family.options[(at + delta + family.options.length) % family.options.length];
  return setFilterFamilyValue(draft, family.id, next.value);
}

/** Pure: set one family's value. Returns a NEW draft. */
export function setFilterFamilyValue(
  draft: BrowseFilters,
  familyId: string,
  value: string,
): BrowseFilters {
  switch (familyId) {
    case "genre":
      return { ...draft, genre: value, genreMode: "single", genres: [] };
    case "year":
      return { ...draft, year: value, yearFrom: null, yearTo: null };
    case "yearRange": {
      if (!value) return { ...draft, yearFrom: null, yearTo: null };
      const [from, to] = value.split("-").map(Number);
      return {
        ...draft,
        year: "",
        yearFrom: Number.isFinite(from) ? from : null,
        yearTo: Number.isFinite(to) ? to : null,
      };
    }
    case "rating":
      return { ...draft, minRating: Number(value) || 0 };
    case "runtime":
      return { ...draft, runtime: value as BrowseRuntimeBucket };
    case "seasons":
      return { ...draft, seasonCount: value as BrowseSeasonCountBucket };
    case "status":
      return { ...draft, seriesStatus: value as BrowseSeriesStatus };
    case "watchStatus":
      return { ...draft, watchStatus: value as BrowseWatchStatus };
    case "favourites":
      return { ...draft, favouritesOnly: value === "1" };
    case "watchLater":
      return { ...draft, watchLaterOnly: value === "1" };
    case "followed":
      return { ...draft, followedOnly: value === "1" };
    case "newEpisodes":
      return { ...draft, newEpisodesOnly: value === "1" };
    case "language":
      return { ...draft, language: value };
    case "providerCategory":
      return { ...draft, providerCategory: value };
    default:
      return draft;
  }
}

// ── DOM mount ───────────────────────────────────────────────────

export interface BrowseFilterDrawerOptions {
  kind: BrowseKind;
  /** Starting draft (a copy is taken; the caller's object is never mutated). */
  initial: BrowseFilters;
  availability: BrowseFilterDrawerAvailability;
  genreIds: string[];
  onApply: (filters: BrowseFilters) => void;
  onCancel: () => void;
}

export interface BrowseFilterDrawerHandle {
  root: HTMLElement;
  getDraft(): BrowseFilters;
  getFocusedFamilyId(): string | null;
  handleKey(event: KeyboardEvent): boolean;
  pressBack(): void;
  focusCurrent(): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function mountBrowseFilterDrawer(
  container: HTMLElement,
  opts: BrowseFilterDrawerOptions,
): BrowseFilterDrawerHandle {
  let draft: BrowseFilters = { ...opts.initial, genres: [...opts.initial.genres] };
  let families = buildFilterFamilies(
    opts.kind,
    draft,
    opts.availability,
    opts.genreIds,
  );
  let focusIndex = 0;
  let destroyed = false;
  // Hover guard (0.11.8 integration fix, brief §16.4): same parked-mouse
  // focus steal as the category drawer — Chromium fires mouseenter
  // when the drawer opens (or re-renders) under a stationary pointer.
  // Hover only takes effect after real mouse movement; every render
  // re-arms the guard. Clicks are unaffected.
  let hoverEnabled = false;
  const onMouseMove = (): void => {
    hoverEnabled = true;
  };

  const root = el("div", "rs-browse-filter-drawer");
  root.setAttribute("data-browse-filter-drawer", "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Filters");
  root.addEventListener("mousemove", onMouseMove);

  const scrim = el("div", "rs-browse-filter-drawer__scrim");
  scrim.setAttribute("aria-hidden", "true");

  const panel = el("div", "rs-browse-filter-drawer__panel");
  root.appendChild(panel);
  root.appendChild(scrim);

  const header = el("div", "rs-browse-filter-drawer__header");
  const title = el("h2", "rs-browse-filter-drawer__title");
  title.textContent = "Filters";
  header.appendChild(title);
  const subtitle = el("p", "rs-browse-filter-drawer__subtitle");
  subtitle.textContent = "Changes apply when you choose Apply.";
  header.appendChild(subtitle);
  panel.appendChild(header);

  const list = el("div", "rs-browse-filter-drawer__list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Filter families");
  panel.appendChild(list);

  const notesEl = el("div", "rs-browse-filter-drawer__notes");
  const omitted = omittedFamilyNotes(opts.kind, opts.availability);
  for (const note of omitted) {
    const p = el("p", "rs-browse-filter-drawer__note");
    p.textContent = note;
    notesEl.appendChild(p);
  }
  if (omitted.length > 0) panel.appendChild(notesEl);

  const hints = el("p", "rs-browse-filter-drawer__hints");
  hints.setAttribute("aria-hidden", "true");
  hints.textContent = "↕ Family · ↔ Value · A Select · B Cancel";
  panel.appendChild(hints);

  container.appendChild(root);

  function valueLabel(family: FilterFamily): string {
    if (family.action) return "";
    const found = family.options.find((o) => o.value === family.value);
    return found ? found.label : family.value;
  }

  function render(): void {
    if (destroyed) return;
    // Re-arm the hover guard (see above).
    hoverEnabled = false;
    families = buildFilterFamilies(opts.kind, draft, opts.availability, opts.genreIds);
    focusIndex = Math.max(0, Math.min(families.length - 1, focusIndex));
    list.replaceChildren();
    families.forEach((family, index) => {
      const row = el("button", "rs-browse-filter-drawer__row") as HTMLButtonElement;
      row.type = "button";
      row.setAttribute("data-filter-drawer-row", "");
      row.setAttribute("data-family-id", family.id);
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      if (index === focusIndex) row.classList.add("is-focused");
      if (family.action === "apply") row.classList.add("is-apply");
      if (family.action === "clear") row.classList.add("is-clear");
      const label = el("span", "rs-browse-filter-drawer__row-label");
      label.textContent = family.label;
      row.appendChild(label);
      if (!family.action) {
        const value = el("span", "rs-browse-filter-drawer__row-value");
        value.textContent = `‹ ${valueLabel(family)} ›`;
        row.appendChild(value);
      }
      if (family.note) {
        const note = el("span", "rs-browse-filter-drawer__row-note");
        note.textContent = family.note;
        row.appendChild(note);
      }
      row.setAttribute(
        "aria-label",
        family.action ? family.label : `${family.label}: ${valueLabel(family)}`,
      );
      row.addEventListener("click", () => {
        if (destroyed) return;
        focusIndex = index;
        activateRow();
      });
      row.addEventListener("mouseenter", () => {
        if (destroyed || !hoverEnabled) return;
        focusIndex = index;
        paintFocus();
      });
      list.appendChild(row);
    });
  }

  function focusCurrent(): void {
    const rows = list.querySelectorAll<HTMLElement>("[data-filter-drawer-row]");
    const target = rows[focusIndex];
    if (!target) return;
    target.focus({ preventScroll: true });
    try {
      target.scrollIntoView?.({ block: "nearest" });
    } catch {
      // Focus still lands.
    }
  }

  function paintFocus(): void {
    if (destroyed) return;
    const rows = list.querySelectorAll<HTMLElement>("[data-filter-drawer-row]");
    rows.forEach((row, index) =>
      row.classList.toggle("is-focused", index === focusIndex),
    );
    focusCurrent();
  }

  function cycleFocused(delta: number): void {
    const family = families[focusIndex];
    if (!family || family.action) return;
    draft = cycleFilterFamilyValue(draft, family, delta);
    // Re-render values only: the row set is stable, but the value
    // labels changed. A full render here is safe (no hover loop:
    // cycling comes from keys, and mouseenter only paints focus).
    render();
    focusCurrent();
  }

  function activateRow(): void {
    const family = families[focusIndex];
    if (!family) return;
    if (family.action === "apply") {
      opts.onApply({ ...draft, genres: [...draft.genres] });
      return;
    }
    if (family.action === "clear") {
      draft = createBrowseFilters();
      render();
      focusCurrent();
      return;
    }
    // A on a value row steps forward (same as Right).
    cycleFocused(1);
  }

  function pressBack(): void {
    opts.onCancel();
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (destroyed) return false;
    switch (event.key) {
      case "ArrowUp":
        focusIndex = Math.max(0, focusIndex - 1);
        paintFocus();
        return true;
      case "ArrowDown":
        focusIndex = Math.min(families.length - 1, focusIndex + 1);
        paintFocus();
        return true;
      case "ArrowLeft":
        cycleFocused(-1);
        return true;
      case "ArrowRight":
        cycleFocused(1);
        return true;
      case "Enter":
      case " ":
        activateRow();
        return true;
      case "Escape":
        pressBack();
        return true;
      default:
        return false;
    }
  }

  scrim.addEventListener("click", () => {
    if (!destroyed) opts.onCancel();
  });

  render();

  return {
    root,
    getDraft: () => ({ ...draft, genres: [...draft.genres] }),
    getFocusedFamilyId: () => families[focusIndex]?.id ?? null,
    handleKey,
    pressBack,
    focusCurrent,
    destroy(): void {
      destroyed = true;
      root.removeEventListener("mousemove", onMouseMove);
      root.remove();
    },
  };
}
