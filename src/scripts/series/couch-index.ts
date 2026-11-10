// Couch Series index — thin mount entry for the standalone /series
// page. The kind adapter lives in couch-series-adapter.ts (shared
// with the consolidated /browse page); catalogue loading, rails,
// filtering, sorting and the windowed grid live in the shared browse
// controller (src/scripts/movies/couch-browse.ts).

import { mountCouchBrowse } from "@/scripts/movies/couch-browse.ts";
import { seriesAdapter } from "@/scripts/series/couch-series-adapter.ts";

mountCouchBrowse(seriesAdapter);
