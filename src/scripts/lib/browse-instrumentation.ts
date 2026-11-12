// 0.11.8 — bounded-work instrumentation (brief §15 / §20).
//
// Tiny counters, zero behaviour change. Production modules increment
// them at the exact points where full-catalogue work happens; the
// benchmark harness and the acceptance tests read them to PROVE the
// deterministic invariants (one index build per revision, zero full
// passes / sorts / grouping runs on focus moves, scrolling and page
// turns, bounded DOM). Without counters those assertions would be
// proxies; with them they are measurements.
//
// The counters are process-wide and monotonic within a test run.
// Tests reset them explicitly. Production code never reads them.

export interface BrowseInstrumentationCounters {
  /** Full catalog index builds (buildCatalogIndex calls). */
  catalogIndexBuilds: number;
  /** getCatalogIndex calls served from the revision cache. */
  catalogIndexCacheHits: number;
  /** Title-grouping runs (groupEntries calls). */
  groupRuns: number;
  /** Browse derivations (deriveBrowseGroups calls) — the "full passes". */
  deriveCalls: number;
  /** Decorated sorts inside a derivation (seasons / updated orders). */
  decoratedSorts: number;
  /** Browse page turns (gotoPage calls that change the page). */
  pageTurns: number;
  /** Card focus moves observed by the mounted browse grid. */
  focusMoves: number;
}

const counters: BrowseInstrumentationCounters = {
  catalogIndexBuilds: 0,
  catalogIndexCacheHits: 0,
  groupRuns: 0,
  deriveCalls: 0,
  decoratedSorts: 0,
  pageTurns: 0,
  focusMoves: 0,
};

/** Snapshot copy of the current counters (tests / bench harness). */
export function readBrowseInstrumentation(): BrowseInstrumentationCounters {
  return { ...counters };
}

/** Reset every counter to zero (tests / bench harness). */
export function resetBrowseInstrumentation(): void {
  counters.catalogIndexBuilds = 0;
  counters.catalogIndexCacheHits = 0;
  counters.groupRuns = 0;
  counters.deriveCalls = 0;
  counters.decoratedSorts = 0;
  counters.pageTurns = 0;
  counters.focusMoves = 0;
}

// ── Incrementers (production modules only) ───────────────────────

export function noteCatalogIndexBuild(): void {
  counters.catalogIndexBuilds += 1;
}

export function noteCatalogIndexCacheHit(): void {
  counters.catalogIndexCacheHits += 1;
}

export function noteGroupRun(): void {
  counters.groupRuns += 1;
}

export function noteDeriveCall(): void {
  counters.deriveCalls += 1;
}

export function noteDecoratedSort(): void {
  counters.decoratedSorts += 1;
}

export function notePageTurn(): void {
  counters.pageTurns += 1;
}

export function noteFocusMove(): void {
  counters.focusMoves += 1;
}
