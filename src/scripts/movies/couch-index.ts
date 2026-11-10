// Couch Movies index — thin mount entry for the standalone /movies
// page. The kind adapter lives in couch-movies-adapter.ts (shared
// with the consolidated /browse page); catalogue loading, rails,
// filtering, sorting and the windowed grid live in the shared browse
// controller (couch-browse.ts).

import { mountCouchBrowse } from "@/scripts/movies/couch-browse.ts";
import { moviesAdapter } from "@/scripts/movies/couch-movies-adapter.ts";

mountCouchBrowse(moviesAdapter);
