// Couch Movies index — mode router for the 0.11.8 Movies Home /
// Browse Everything split (brief §1.1, §2).
//
// Movies is ONE nav destination with TWO explicit modes, chosen by
// the URL (W2's mode contract, via movies-home-modes-shim.ts until
// integration wires the real module):
//
//   /movies              -> Movies Home (curated; default)
//   /movies?view=browse  -> Browse Everything (exhaustive)
//
// Exactly one mode mounts per page load (full navigation between
// modes), so Movies Home NEVER mounts the full catalogue grid and
// Browse state never leaks into Home. A return from a detail page
// (history.back) restores the exact URL — mode, category, page —
// and couch-focus memory restores the selected poster.
//
// B / Escape in Browse mode is the mode's back step: it returns to
// Movies Home. In Home mode B does nothing (top-level destination).
// The dialog and text-field cases are excluded: a modal owns B, and
// B in a field blurs (the shared gamepad gate owns that).

import { mountMoviesHome } from "@/scripts/movies/movies-home-mount.ts";
import {
  mountBrowseEverything,
  parseModeFromUrl,
  setModeInUrl,
  shouldMountBrowse,
} from "@/scripts/movies/movies-home-modes-shim.ts";

const HOME_ROOT_ID = "movies-home-root";
const BROWSE_MOUNT_ID = "movies-browse-mount";

function isEditingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    element.isContentEditable === true
  );
}

function installBrowseBackStep(isBrowse: boolean): void {
  if (!isBrowse) return;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" && event.key !== "BrowserBack") return;
    if (event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    if (isEditingTarget(event.target)) return;
    // Return to Movies Home (never history.back: a direct landing
    // on a Browse URL must not back out of the app).
    event.preventDefault();
    setModeInUrl({ view: "home" });
  });
}

function mountMoviesPage(): void {
  const mode = parseModeFromUrl();
  const homeRoot = document.getElementById(HOME_ROOT_ID);
  const browseMount = document.getElementById(BROWSE_MOUNT_ID);
  const browse = shouldMountBrowse(mode) && browseMount != null;
  if (homeRoot) homeRoot.hidden = browse;
  if (browseMount) browseMount.hidden = !browse;
  if (browse && browseMount) {
    mountBrowseEverything(browseMount, mode);
  } else {
    mountMoviesHome();
  }
  installBrowseBackStep(browse);
}

mountMoviesPage();
