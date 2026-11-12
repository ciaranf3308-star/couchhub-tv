// 0.11.9 — variant picker helpers: find the group the current item
// belongs to, label each variant from provider data only, and render
// honest buttons (the current variant disabled, the rest selectable).

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups.ts";
import {
  couchVariantOptions,
  renderCouchVariantPicker,
} from "@/scripts/lib/couch-variants.ts";

beforeEach(() => {
  clearTitleGroupRegistry();
  document.body.innerHTML = "";
});

const ROWS = [
  { id: 1, name: "EN - Project Hail Mary (2026)", year: "2026", tmdb: 12345, containerExt: "mp4" },
  { id: 2, name: "ES - Proyecto Salvación (2026)", year: "2026", tmdb: 12345, containerExt: "mkv" },
  { id: 3, name: "4K-FR - Projet Dernière Chance (2026)", year: "2026", tmdb: 12345, containerExt: "mkv" },
  { id: 4, name: "Dune (2021)", year: "2021", tmdb: 77, containerExt: "mp4" },
];

describe("couchVariantOptions", () => {
  it("returns one option per group member, marking the current variant", () => {
    const options = couchVariantOptions(ROWS, "vod", 1);
    expect(options).not.toBeNull();
    expect(options).toHaveLength(3);
    expect(options!.map((option) => option.id).sort()).toEqual([1, 2, 3]);
    expect(options!.find((option) => option.id === 1)?.isCurrent).toBe(true);
    expect(options!.find((option) => option.id === 2)?.isCurrent).toBe(false);
  });

  it("labels variants from language, quality and container only", () => {
    const options = couchVariantOptions(ROWS, "vod", 1)!;
    const byId = new Map(options.map((option) => [option.id, option.label]));
    expect(byId.get(1)).toContain("MP4");
    expect(byId.get(2)).toContain("MKV");
    // The 4K prefix token survives in the label.
    expect(byId.get(3)).toContain("4K");
    // Full provider names are carried for the accessible name.
    expect(options.find((option) => option.id === 2)?.fullName).toBe(
      "ES - Proyecto Salvación (2026)"
    );
  });

  it("returns null for an ungrouped item", () => {
    expect(couchVariantOptions(ROWS, "vod", 4)).toBeNull();
  });

  it("returns null when the group has a single member", () => {
    const options = couchVariantOptions(
      [{ id: 9, name: "Solo (2024)", year: "2024", tmdb: 999, containerExt: "mp4" }],
      "vod",
      9
    );
    expect(options).toBeNull();
  });

  it("falls back to Version N when a variant has no distinguishing data", () => {
    const options = couchVariantOptions(
      [
        { id: 1, name: "Same Title", year: "2024", tmdb: 5, containerExt: null },
        { id: 2, name: "Same Title", year: "2024", tmdb: 5, containerExt: null },
      ],
      "vod",
      1
    );
    expect(options).not.toBeNull();
    expect(options).toHaveLength(2);
    expect(options![0].label).toBe("Version 1");
    expect(options![1].label).toBe("Version 2");
  });

  it("disambiguates duplicate labels with an occurrence suffix", () => {
    const options = couchVariantOptions(
      [
        { id: 1, name: "EN - Same Title", year: "2024", tmdb: 5, containerExt: "mp4" },
        { id: 2, name: "EN - Same Title", year: "2024", tmdb: 5, containerExt: "mp4" },
      ],
      "vod",
      1
    );
    expect(options).not.toBeNull();
    const labels = options!.map((option) => option.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels[1]).toMatch(/\(2\)$/);
  });
});

describe("renderCouchVariantPicker", () => {
  it("renders selectable buttons with the current variant disabled", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const onSelect = vi.fn();
    const options = couchVariantOptions(ROWS, "vod", 1)!;
    expect(renderCouchVariantPicker(mount, options, onSelect)).toBe(true);
    const buttons = [...mount.querySelectorAll("button")];
    expect(buttons).toHaveLength(3);
    const current = buttons.find(
      (button) => button.getAttribute("aria-current") === "true"
    );
    expect(current?.disabled).toBe(true);
    const other = buttons.find((button) => !button.disabled)!;
    expect(other.title).toBeTruthy();
    expect(other.getAttribute("aria-label")).toContain("Version:");
    other.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.any(Number));
  });

  it("returns false and renders nothing for an empty list or a missing mount", () => {
    expect(renderCouchVariantPicker(null, [], () => {})).toBe(false);
    const mount = document.createElement("div");
    expect(renderCouchVariantPicker(mount, [], () => {})).toBe(false);
    expect(mount.childElementCount).toBe(0);
  });
});
