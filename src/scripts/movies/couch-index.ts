// Couch Movies index — mode router for the 0.11.8 Movies Home /
// Browse Everything split (brief §1.1, §2).
//
// Movies is ONE nav destination with TWO explicit modes, chosen by
// the URL (W2's mode contract):
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
// B / Escape in Browse mode is owned by the browse controller: it
// pops overlay layers first, then calls onExit, which navigates
// home. There is NO document-level back-step listener here — one
// would fire before the mount's window-level handler and break
// drawer layer-popping. In Home mode B does nothing (top-level
// destination). The dialog and text-field cases are excluded by
// the shared gamepad gate.

import { mountMoviesHome, recordMoviesHomeReturnFocus } from "@/scripts/movies/movies-home-mount.ts";
import { mountBrowseEverything } from "@/scripts/lib/browse-everything.ts";
import { setLogicalView } from "@/scripts/lib/couch-focus.ts";
import {
  browseStateFromMode,
  parseModeFromUrl,
} from "@/scripts/lib/home-browse-modes.ts";
import {
  createMoviesBrowseSource,
  resolveBrowseCategoryLabel,
} from "@/scripts/lib/browse-sources.ts";

const HOME_ROOT_ID = "movies-home-root";
const BROWSE_MOUNT_ID = "movies-browse-mount";

function mountMoviesPage(): void {
  const resolveLabel = (selection: Parameters<typeof resolveBrowseCategoryLabel>[1]) =>
    resolveBrowseCategoryLabel("movie", selection);
  const mode = parseModeFromUrl("movie", resolveLabel);
  const homeRoot = document.getElementById(HOME_ROOT_ID);
  const browseMount = document.getElementById(BROWSE_MOUNT_ID);
  const browse = mode.view === "browse" && browseMount != null;
  if (homeRoot) homeRoot.hidden = browse;
  if (browseMount) browseMount.hidden = !browse;
  if (browse && browseMount) {
    setLogicalView("movies-browse");
    // Search Movies links here with focus=search: consume it as
    // autoOpenSearch and strip it before mounting, so the mount's
    // URL sync never re-serialises it.
    const params = new URLSearchParams(window.location.search);
    const autoOpenSearch = params.get("focus") === "search";
    if (autoOpenSearch) {
      params.delete("focus");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
    }
    const controller = mountBrowseEverything(browseMount, {
      kind: "movie",
      initialState: browseStateFromMode(mode, resolveLabel),
      source: createMoviesBrowseSource(),
      autoOpenSearch,
      onOpenDetail: (id) => {
        window.location.href = `/movies/detail?id=${encodeURIComponent(id)}`;
      },
      onExit: () => {
        // B from Browse → Movies Home, with the genre tile the
        // viewer came from focused where possible: the current
        // category names the tile (genre → its tile, All → the
        // All Genres tile). Full navigation home (never
        // history.back: a direct landing on a Browse URL must
        // not back out of the app).
        try {
          const category = controller.getState().category;
          if (category.kind === "genre") {
            recordMoviesHomeReturnFocus(`movies-genre-${category.id}`);
          } else if (category.kind === "all") {
            recordMoviesHomeReturnFocus("movies-genre-all");
          }
        } catch {
          // Return focus is a nicety; the navigation still happens.
        }
        window.location.href = "/movies";
      },
    });
  } else {
    setLogicalView("movies-home");
    mountMoviesHome();
  }
}

mountMoviesPage();
