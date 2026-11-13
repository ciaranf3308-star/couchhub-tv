// RedSilk Couch — Live TV 2.0 navigation model (0.11.7, W4).
//
// ONE explicit navigation model for Live TV: a stack of layers.
// Every Live TV surface is a layer, and exactly one layer — the
// top of the stack — owns controller/keyboard input at any moment.
// A single B press removes ONLY the topmost layer. Nothing below
// the top may respond to input, and nothing hidden may keep a
// second, shadow browser alive behind the visible one.
//
// Layers (bottom → top in a typical session):
//
//   landing      Live TV landing (TvLiveLanding). The stack base.
//                B on a lone landing layer is NOT consumed here:
//                back() returns false and the shell decides (e.g.
//                leave Live TV). Entry: mode "landing".
//   browser      Channel Browser (W2). Pushed above landing.
//                B pops back to landing. Category, selection and
//                scroll position are preserved on the layer (see
//                `preserved`) so reopening the browser restores
//                them instead of resetting to the top.
//   drawer       Category Drawer (W2). An OVERLAY, not a page: it
//                sits above the browser and the browser stays
//                mounted and stateful underneath. B pops ONLY the
//                drawer; the browser is revealed unchanged.
//   subcategory  Subcategory Picker (W2). An overlay above the
//                drawer (or the browser, when opened directly).
//                B pops back to the drawer/browser underneath.
//   search       Search overlay (W4). Overlay above the browser.
//                B pops ONLY the search overlay; the browser's
//                category and scroll position survive underneath.
//   sort         Sort/Options overlay (W4). Overlay above the
//                browser. B pops ONLY the sort overlay, without
//                applying a change.
//   guide        Full programme Guide (W3). Pushed above
//                landing/playback/browser; B pops back to the
//                layer it was entered from (the entry layer is
//                whatever sits below it on the stack — no
//                separate returnTo bookkeeping).
//   playback     Fullscreen playback (W3 shell). Pushed above the
//                layer that tuned the channel. B pops back to it.
//
// Entry / exit behaviour is uniform: push() runs the new top's
// onEnter hook, pop()/back() runs the popped layer's onExit hook
// and then the focus-restore hook (the popped layer's
// onFocusRestore, else the controller default: focus the element
// that held focus when the layer was pushed, else the element
// matching the layer's returnFocusKey). Layers never re-mount on
// re-entry: a popped layer's `preserved` state is kept by the
// controller (preservedFor) so the next push of the same layer
// can restore category / selection / scroll position.
//
// Two halves, matching the livetv-state.ts pattern:
//
//   - Pure stack functions (createLivetvNavStack, navPush,
//     navPop, navReplace, navTop, navPopTo): no DOM, no hooks
//     invoked, fully unit-testable. Hook invocation is the
//     controller's job.
//   - LivetvNavController: the runtime singleton (livetvNav)
//     that owns one stack, invokes entry/exit/focus hooks,
//     notifies subscribers, mirrors the top layer to
//     html[data-livetv-nav-layer], and dispatches
//     `livetv:nav-change` {top, stack, previousTop} on window
//     (the hints component listens to it). Tests should use
//     createLivetvNavController() for isolation; production
//     uses the shared `livetvNav` singleton.
//
// Unifying W2/W3 onto this module (integration) is mechanical:
//
//   1. Each surface pushes its layer on open and pops on close
//      (or lets back() pop it).
//   2. Each surface's existing B/Escape handler gains ONE guard
//      at the top: `if (!livetvNav.isTop("<layer>")) return;`
//      — that is what makes hidden layers deaf. The handler
//      then calls livetvNav.back() instead of closing itself
//      directly, so one B press can never pop two layers.
//   3. Alternatively (or additionally), integration calls
//      installLivetvNavBackHandler() ONCE, early, on the Live
//      TV page: a single `livetv:back` listener routes B to
//      the top layer and stops propagation, so no per-surface
//      handler ever sees a B meant for another layer. Surfaces
//      keep their isTop guards as belt-and-braces.
//
// The controller never touches the mode shell (livetv:mode),
// playback, EPG, favourites, recents or catch-up: it only
// orders layers and routes Back. The `livetv:back` gamepad
// contract (livetv-keys.ts) is unchanged — B still resolves to
// "back" and gamepad.ts still dispatches the event; this
// module only decides WHICH layer answers it.

/** Every Live TV surface, as a navigation layer id. */
export type LivetvNavLayerId =
  | "landing"
  | "browser"
  | "drawer"
  | "subcategory"
  | "search"
  | "sort"
  | "guide"
  | "playback";

/** Layer ids in stack order (base → topmost overlay), for docs/tests. */
export const LIVETV_NAV_LAYER_IDS: readonly LivetvNavLayerId[] = [
  "landing",
  "browser",
  "drawer",
  "subcategory",
  "search",
  "sort",
  "guide",
  "playback",
] as const;

/** True when `value` names a navigation layer. */
export function isLivetvNavLayerId(value: unknown): value is LivetvNavLayerId {
  return (
    value === "landing" ||
    value === "browser" ||
    value === "drawer" ||
    value === "subcategory" ||
    value === "search" ||
    value === "sort" ||
    value === "guide" ||
    value === "playback"
  );
}

/**
 * State a layer preserves across a pop so re-entry restores it:
 * the browser's category, the selected channel/programme, and
 * the list scroll position. Layers write it (via the `preserved`
 * field, or preserveFor on the controller); the controller keeps
 * the last popped value per layer id until the layer is pushed
 * again. All fields optional — a layer preserves what it has.
 */
export interface LivetvNavPreservedState {
  /** Browser category / drawer group id, when the layer has one. */
  categoryId?: string | null;
  /** Subcategory id, when the layer has one. */
  subcategoryId?: string | null;
  /** Selected channel / programme id, when the layer has one. */
  selectedId?: string | number | null;
  /** Vertical scroll offset of the layer's list, when it has one. */
  scrollTop?: number | null;
  /** Focus key (data-focus-key) to restore on re-entry. */
  focusKey?: string | null;
}

/**
 * One layer on the stack. Hooks are optional and synchronous;
 * throwing hooks are caught by the controller so one layer's
 * bug can never wedge navigation.
 */
export interface LivetvNavLayer {
  /** Which surface this layer is. */
  id: LivetvNavLayerId;
  /**
   * Instance key within the id. Pushing a layer whose id+key
   * already sits on the stack REPLACES that entry in place
   * (no duplicate layers). Defaults to the id itself, so at
   * most one layer per id is ever on the stack unless callers
   * pass distinct keys.
   */
  key?: string;
  /** data-focus-key to restore when this layer exits. */
  returnFocusKey?: string | null;
  /** Caller context (category/subcategory ids, entry mode...). */
  context?: Record<string, unknown>;
  /** State preserved for the next entry (see LivetvNavPreservedState). */
  preserved?: LivetvNavPreservedState;
  /** Runs when the layer becomes the top via push/replace. */
  onEnter?: (layer: LivetvNavLayer, previousTop: LivetvNavLayer | null) => void;
  /** Runs when the layer leaves the stack via pop/back/replace/reset. */
  onExit?: (layer: LivetvNavLayer, nextTop: LivetvNavLayer | null) => void;
  /**
   * Runs when the layer is revealed again because the layer
   * above it popped. Distinct from onEnter: push-time setup
   * belongs in onEnter; re-exposure refresh belongs here.
   */
  onReveal?: (layer: LivetvNavLayer, popped: LivetvNavLayer) => void;
  /**
   * Back interceptor. Called ONLY for the top layer, and only
   * by back(). Return false to VETO the pop: the layer consumed
   * B internally (use sparingly — a confirm step, never a
   * silent swallow). Return true (or nothing) to pop exactly
   * one layer, as usual. A vetoed B is still consumed: no
   * layer below sees it.
   */
  onBack?: (layer: LivetvNavLayer) => boolean | void;
  /**
   * Focus-restore hook. Called after the layer pops, before
   * the controller's default restore. Return true when focus
   * was restored (the default is skipped); return false /
   * nothing to let the default run. The default focuses the
   * element that held focus when the layer was pushed (when
   * it is still connected), else the element matching
   * returnFocusKey.
   */
  onFocusRestore?: (layer: LivetvNavLayer) => boolean | void;
}

/** An immutable snapshot of the stack: bottom first, top last. */
export type LivetvNavStack = readonly LivetvNavLayer[];

function layerKey(layer: LivetvNavLayer): string {
  return layer.key ?? layer.id;
}

function sameLayer(a: LivetvNavLayer, b: LivetvNavLayer): boolean {
  return a.id === b.id && layerKey(a) === layerKey(b);
}

// ── Pure stack operations (no hooks, no DOM) ────────────────────

/** Fresh stack: landing only, the Live TV entry point. */
export function createLivetvNavStack(
  initial: LivetvNavLayer | null = { id: "landing" },
): LivetvNavStack {
  return initial ? [initial] : [];
}

/** The top layer, or null when the stack is empty. */
export function navTop(stack: LivetvNavStack): LivetvNavLayer | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

/** True when `id` (or id+key) is the top layer. */
export function navIsTop(
  stack: LivetvNavStack,
  id: LivetvNavLayerId,
  key?: string,
): boolean {
  const top = navTop(stack);
  if (!top || top.id !== id) return false;
  return key === undefined || layerKey(top) === key;
}

/** True when a layer with this id sits anywhere on the stack. */
export function navHas(stack: LivetvNavStack, id: LivetvNavLayerId): boolean {
  return stack.some((layer) => layer.id === id);
}

/**
 * Push a layer. Pushing a layer whose id+key already sits on the
 * stack replaces that entry in place (same position, new layer
 * object) instead of duplicating it — reopening the drawer never
 * stacks two drawers. Otherwise the layer is appended and
 * becomes the top. The input stack is never mutated.
 */
export function navPush(
  stack: LivetvNavStack,
  layer: LivetvNavLayer,
): LivetvNavStack {
  const index = stack.findIndex((entry) => sameLayer(entry, layer));
  if (index >= 0) {
    const next = [...stack];
    next[index] = layer;
    return next;
  }
  return [...stack, layer];
}

/**
 * Pop the top layer. Returns the new stack and the popped layer
 * (null when the stack was empty). Popping the LAST layer is
 * allowed by the pure function; the controller's back() refuses
 * to pop a lone landing layer (see LivetvNavController.back).
 * The input stack is never mutated.
 */
export function navPop(stack: LivetvNavStack): {
  stack: LivetvNavStack;
  popped: LivetvNavLayer | null;
} {
  if (stack.length === 0) return { stack, popped: null };
  return { stack: stack.slice(0, -1), popped: stack[stack.length - 1]! };
}

/**
 * Replace the top layer with another (same stack depth). On an
 * empty stack this pushes. The input stack is never mutated.
 */
export function navReplace(
  stack: LivetvNavStack,
  layer: LivetvNavLayer,
): { stack: LivetvNavStack; replaced: LivetvNavLayer | null } {
  if (stack.length === 0) return { stack: [layer], replaced: null };
  const replaced = stack[stack.length - 1]!;
  return { stack: [...stack.slice(0, -1), layer], replaced };
}

/**
 * Pop down to (and including) the named layer: everything above
 * it is removed and the named layer becomes the top. When the
 * layer is not on the stack the stack is returned unchanged.
 * The input stack is never mutated.
 */
export function navPopTo(
  stack: LivetvNavStack,
  id: LivetvNavLayerId,
  key?: string,
): { stack: LivetvNavStack; popped: LivetvNavLayer[] } {
  const index = stack.findIndex(
    (layer) => layer.id === id && (key === undefined || layerKey(layer) === key),
  );
  if (index < 0) return { stack, popped: [] };
  return { stack: stack.slice(0, index + 1), popped: stack.slice(index + 1) };
}

/** Layer ids on the stack, bottom first — for logging / events / tests. */
export function navLayerIds(stack: LivetvNavStack): LivetvNavLayerId[] {
  return stack.map((layer) => layer.id);
}

// ── Origin resolution (0.11.10 W4 — pure, no DOM) ───────────────
// Leaving a surface must return to the surface it was entered
// from — never a surprise jump. The Guide and playback both
// derive their return destination from the same inputs, but the
// evidence differs per surface, so each has its own resolver.
// Both normalise the legacy mode name "home" to "landing".

/** Modes the Guide can return to on B (its entry mode). */
export type GuideOriginMode = "landing" | "browser" | "playback";

/** Modes playback's B-exit can return to (its entry mode). */
export type PlaybackOriginMode = "landing" | "browser" | "guide";

function normaliseOriginMode(
  mode: string | null | undefined,
): string | null {
  if (!mode) return null;
  const trimmed = mode.trim();
  if (!trimmed) return null;
  return trimmed === "home" ? "landing" : trimmed;
}

/**
 * Where the Guide returns on B. Evidence, in order:
 *
 *   1. The invoker's mount (`mountMode` — the data-livetv-mode
 *      of the mount containing the focused invoker when the
 *      Guide opened): browser / playback / landing win outright.
 *      This is order-proof: it reads the focused element, not a
 *      mode the shell may or may not have persisted yet.
 *   2. The persisted mode (`persistedMode` — the mode stored
 *      before this entry): playback / browser win when the
 *      invoker carried no mount (focus on <body>).
 *   3. A held stream (`hasTunedSession`): a tuned channel can
 *      only be held while the user came from playback (leaving
 *      for landing releases it), so an otherwise-unknown origin
 *      with a held session returns to playback.
 *   4. Landing, the default.
 *
 * The Guide's own `guideReturnMode` (livetv-guide.ts) only knows
 * the home/playback binary; this resolver adds the browser
 * origin without touching that module.
 */
export function resolveGuideOrigin(
  mountMode: string | null | undefined,
  persistedMode: string | null | undefined,
  hasTunedSession = false,
): GuideOriginMode {
  const mount = normaliseOriginMode(mountMode);
  if (mount === "browser" || mount === "playback" || mount === "landing") {
    return mount;
  }
  const persisted = normaliseOriginMode(persistedMode);
  if (persisted === "browser" || persisted === "playback") {
    return persisted;
  }
  if (hasTunedSession) return "playback";
  return "landing";
}

/**
 * Where playback's B-exit returns: the last non-playback mode.
 * Browser and Guide keep the tuned session by design (the
 * release rule only fires for landing), so returning to either
 * is stream-safe; anything else (including the legacy "home"
 * and unknown values) returns to landing, which releases.
 */
export function resolvePlaybackOrigin(
  previousMode: string | null | undefined,
): PlaybackOriginMode {
  const previous = normaliseOriginMode(previousMode);
  if (previous === "browser" || previous === "guide") return previous;
  return "landing";
}

// ── Controller ──────────────────────────────────────────────────

/** Event dispatched on window whenever the stack changes. */
export const LIVETV_NAV_CHANGE_EVENT = "livetv:nav-change";

/** Detail carried by `livetv:nav-change`. */
export interface LivetvNavChangeDetail {
  /** New top layer id, or null when the stack is empty. */
  top: LivetvNavLayerId | null;
  /** Layer ids on the new stack, bottom first. */
  stack: LivetvNavLayerId[];
  /** Previous top layer id, or null when there was none. */
  previousTop: LivetvNavLayerId | null;
}

export type LivetvNavListener = (detail: LivetvNavChangeDetail) => void;

type DocumentLike = {
  activeElement?: unknown;
  documentElement?: { dataset: Record<string, string | undefined> };
  querySelector?: (selector: string) => unknown;
};

/** Call a hook, swallowing (and reporting) throws so navigation never wedges. */
function callHook(fn: (() => void) | undefined, label: string): void {
  if (!fn) return;
  try {
    fn();
  } catch (error) {
    // A layer hook must never wedge navigation. Report, don't throw.
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(`[livetv-nav] ${label} hook threw`, error);
    }
  }
}

function cssEscapeLike(value: string): string {
  const css = (
    globalThis as unknown as { CSS?: { escape?: (value: string) => string } }
  ).CSS;
  return css && typeof css.escape === "function"
    ? css.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/**
 * Runtime owner of one navigation stack. Create with
 * createLivetvNavController(); production code uses the shared
 * `livetvNav` singleton. DOM access is guarded throughout, so
 * the controller is fully usable in node tests (focus restore
 * and the dataset mirror simply no-op without a document).
 */
export class LivetvNavController {
  private stackValue: LivetvNavStack;
  private listeners = new Set<LivetvNavListener>();
  private preservedById = new Map<string, LivetvNavPreservedState>();
  private focusAtPush = new Map<string, unknown>();
  private backTarget: EventTarget | null = null;
  private backHandler: ((event: Event) => void) | null = null;
  private readonly doc: DocumentLike | null;
  private readonly eventTarget: EventTarget | null;

  constructor(
    initial: LivetvNavStack = createLivetvNavStack(),
    deps: {
      document?: DocumentLike | null;
      eventTarget?: EventTarget | null;
    } = {},
  ) {
    this.stackValue = [...initial];
    this.doc =
      deps.document !== undefined
        ? deps.document
        : typeof document !== "undefined"
          ? (document as unknown as DocumentLike)
          : null;
    this.eventTarget =
      deps.eventTarget !== undefined
        ? deps.eventTarget
        : typeof window !== "undefined"
          ? window
          : null;
    this.syncMirror();
  }

  /** Snapshot of the stack: bottom first, top last. Never mutated by callers. */
  get stack(): LivetvNavStack {
    return [...this.stackValue];
  }

  /** The top layer, or null when the stack is empty. */
  top(): LivetvNavLayer | null {
    return navTop(this.stackValue);
  }

  /** Id of the top layer, or null when the stack is empty. */
  topId(): LivetvNavLayerId | null {
    return this.top()?.id ?? null;
  }

  /** True when `id` (or id+key) is the top layer — the input gate. */
  isTop(id: LivetvNavLayerId, key?: string): boolean {
    return navIsTop(this.stackValue, id, key);
  }

  /** True when a layer with this id sits anywhere on the stack. */
  isActive(id: LivetvNavLayerId): boolean {
    return navHas(this.stackValue, id);
  }

  /** Layer ids on the stack, bottom first. */
  layerIds(): LivetvNavLayerId[] {
    return navLayerIds(this.stackValue);
  }

  /**
   * State the layer preserved when it last popped (or was
   * replaced), for re-entry restore. When the layer is pushed
   * again, push() attaches the held state to the pushed layer
   * as `preserved` (unless the layer brought its own) and
   * clears it here, so onEnter restores from `layer.preserved`.
   */
  preservedFor(id: LivetvNavLayerId, key?: string): LivetvNavPreservedState | null {
    return this.preservedById.get(key ?? id) ?? null;
  }

  /** Record preserved state for a layer without popping it. */
  preserveFor(
    id: LivetvNavLayerId,
    state: LivetvNavPreservedState,
    key?: string,
  ): void {
    this.preservedById.set(key ?? id, { ...state });
  }

  /**
   * Push a layer (or replace the same id+key in place — see
   * navPush). Runs the layer's onEnter hook when it becomes the
   * top (a same-position replace does NOT re-run onEnter: the
   * layer never left). Records the currently focused element
   * for the default focus restore on pop. Consumes any
   * preserved state held for this layer id: it is attached to
   * the pushed layer as `preserved` (when the layer did not
   * bring its own) so onEnter can restore from it.
   */
  push(layer: LivetvNavLayer): LivetvNavStack {
    const previousTop = this.top();
    const mapKey = layerKey(layer);
    const held = this.preservedById.get(mapKey);
    const effective: LivetvNavLayer =
      held && !layer.preserved ? { ...layer, preserved: { ...held } } : layer;
    this.preservedById.delete(mapKey);
    const wasTop = previousTop != null && sameLayer(previousTop, effective);
    this.recordFocusAtPush(mapKey);
    this.stackValue = navPush(this.stackValue, effective);
    if (!wasTop) {
      callHook(
        () => effective.onEnter?.(effective, previousTop),
        `onEnter(${effective.id})`,
      );
    }
    this.notify(previousTop?.id ?? null);
    return this.stack;
  }

  /**
   * Pop the top layer. Runs its onExit hook, keeps its
   * preserved state for the next entry, runs the focus-restore
   * hook, and runs the newly revealed layer's onReveal hook.
   * Returns the popped layer, or null when the stack was
   * empty. Popping the last layer is allowed here (reset()
   * uses it); back() is the guarded entry point for B.
   */
  pop(): LivetvNavLayer | null {
    const previousTop = this.top();
    const { stack, popped } = navPop(this.stackValue);
    if (!popped) return null;
    this.stackValue = stack;
    this.finishExit(popped, this.top());
    this.notify(previousTop?.id ?? null);
    return popped;
  }

  /**
   * Replace the top layer. Runs the replaced layer's onExit
   * hook (with preserved-state capture + focus restore) and
   * the new layer's onEnter hook. On an empty stack this
   * behaves like push().
   */
  replace(layer: LivetvNavLayer): LivetvNavLayer | null {
    const previousTop = this.top();
    const { stack, replaced } = navReplace(this.stackValue, layer);
    this.stackValue = stack;
    if (replaced) this.finishExit(replaced, layer, { reveal: false });
    this.recordFocusAtPush(layerKey(layer));
    callHook(() => layer.onEnter?.(layer, previousTop), `onEnter(${layer.id})`);
    this.notify(previousTop?.id ?? null);
    return replaced;
  }

  /**
   * Pop down to the named layer (inclusive). Each popped
   * layer's onExit hook runs, topmost first; the surviving
   * layer's onReveal runs once. Returns the popped layers
   * (topmost first). No-op when the layer is not on the stack.
   */
  popTo(id: LivetvNavLayerId, key?: string): LivetvNavLayer[] {
    const previousTop = this.top();
    const { stack, popped } = navPopTo(this.stackValue, id, key);
    if (popped.length === 0) return [];
    this.stackValue = stack;
    const survivor = this.top();
    for (const layer of [...popped].reverse()) {
      this.finishExit(layer, survivor, { restoreFocus: false, reveal: false });
    }
    // One focus restore for the whole popTo: the topmost popped
    // layer's hook (it is the surface the user was looking at).
    const topmost = popped[popped.length - 1]!;
    this.restoreFocus(topmost);
    if (survivor) {
      callHook(
        () => survivor.onReveal?.(survivor, topmost),
        `onReveal(${survivor.id})`,
      );
    }
    this.notify(previousTop?.id ?? null);
    return [...popped].reverse();
  }

  /**
   * Reset the stack to a single layer (landing by default).
   * Every removed layer's onExit hook runs, topmost first.
   * Preserved state is kept (re-entry still restores).
   */
  reset(to: LivetvNavLayer | null = { id: "landing" }): LivetvNavStack {
    const previousTop = this.top();
    const removed = [...this.stackValue].reverse();
    this.stackValue = to ? [to] : [];
    for (const layer of removed) {
      if (to && sameLayer(layer, to)) continue;
      this.finishExit(layer, to, { restoreFocus: false, reveal: false });
    }
    if (to) {
      callHook(() => to.onEnter?.(to, previousTop), `onEnter(${to.id})`);
    }
    this.notify(previousTop?.id ?? null);
    return this.stack;
  }

  /**
   * THE Back step. Exactly one layer per call, and only the top
   * layer is consulted:
   *
   *   - Empty stack → false (nothing consumed).
   *   - Lone landing layer → false (the shell decides what B
   *     means at the base; the stack is never emptied by B).
   *   - Top layer's onBack returns false → false-veto: B is
   *     consumed internally, the stack is unchanged, and
   *     back() returns true (handled) so no caller pops again.
   *   - Otherwise → pop exactly one layer, run its exit +
   *     focus-restore hooks, reveal the layer below, return
   *     true.
   *
   * Returns true when B was handled (popped or vetoed), false
   * when the caller should handle B itself (empty stack / lone
   * landing). Callers must NEVER pop again after a true return
   * — that is how one B press used to drop two layers.
   */
  back(): boolean {
    const top = this.top();
    if (!top) return false;
    if (this.stackValue.length === 1 && top.id === "landing") return false;
    if (top.onBack) {
      let veto = false;
      callHook(() => {
        veto = top.onBack?.(top) === false;
      }, `onBack(${top.id})`);
      if (veto) return true;
    }
    this.pop();
    return true;
  }

  /** Subscribe to stack changes. Returns an unsubscribe function. */
  subscribe(listener: LivetvNavListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Route the gamepad `livetv:back` event to the top layer.
   * Install ONCE, early, on the Live TV page (before the
   * browser/guide mount, so this listener runs before theirs).
   * When back() handles the press, the event's propagation is
   * stopped so no per-surface handler below can pop a second
   * layer for the same B. When back() declines (lone landing),
   * the event propagates untouched for the shell to handle.
   * Returns an uninstall function. Re-installing replaces the
   * previous install (never double-attached).
   */
  installBackRouting(target?: EventTarget | null): () => void {
    this.uninstallBackRouting();
    const resolved = target ?? this.eventTarget;
    if (!resolved || typeof resolved.addEventListener !== "function") {
      return () => undefined;
    }
    const handler = (event: Event) => {
      if (this.back()) {
        event.preventDefault();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        } else if (typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
      }
    };
    this.backTarget = resolved;
    this.backHandler = handler;
    resolved.addEventListener("livetv:back", handler);
    return () => this.uninstallBackRouting();
  }

  /** Remove the `livetv:back` routing installed by installBackRouting. */
  uninstallBackRouting(): void {
    if (this.backTarget && this.backHandler) {
      this.backTarget.removeEventListener("livetv:back", this.backHandler);
    }
    this.backTarget = null;
    this.backHandler = null;
  }

  // ── Internals ─────────────────────────────────────────────────

  private recordFocusAtPush(mapKey: string): void {
    const active = this.doc?.activeElement;
    if (active && typeof active === "object") {
      this.focusAtPush.set(mapKey, active);
    } else {
      this.focusAtPush.delete(mapKey);
    }
  }

  private finishExit(
    layer: LivetvNavLayer,
    nextTop: LivetvNavLayer | null,
    opts: { restoreFocus?: boolean; reveal?: boolean } = {},
  ): void {
    if (layer.preserved) {
      this.preservedById.set(layerKey(layer), { ...layer.preserved });
    }
    callHook(() => layer.onExit?.(layer, nextTop), `onExit(${layer.id})`);
    if (opts.restoreFocus !== false) this.restoreFocus(layer);
    this.focusAtPush.delete(layerKey(layer));
    if (opts.reveal !== false && nextTop) {
      callHook(
        () => nextTop.onReveal?.(nextTop, layer),
        `onReveal(${nextTop.id})`,
      );
    }
  }

  private restoreFocus(layer: LivetvNavLayer): void {
    let restored = false;
    callHook(() => {
      restored = layer.onFocusRestore?.(layer) === true;
    }, `onFocusRestore(${layer.id})`);
    if (restored || !this.doc) return;
    const pushed = this.focusAtPush.get(layerKey(layer)) as
      | { isConnected?: boolean; focus?: (opts?: { preventScroll?: boolean }) => void }
      | undefined;
    if (pushed?.isConnected && typeof pushed.focus === "function") {
      callHook(() => pushed.focus?.({ preventScroll: true }), "default focus restore");
      return;
    }
    const focusKey = layer.returnFocusKey ?? layer.preserved?.focusKey;
    if (focusKey && typeof this.doc.querySelector === "function") {
      const target = this.doc.querySelector(
        `[data-focus-key="${cssEscapeLike(focusKey)}"]`,
      ) as { focus?: (opts?: { preventScroll?: boolean }) => void } | null;
      if (target && typeof target.focus === "function") {
        callHook(() => target.focus?.({ preventScroll: true }), "focus-key restore");
      }
    }
  }

  private syncMirror(): void {
    const dataset = this.doc?.documentElement?.dataset;
    if (!dataset) return;
    const top = this.topId();
    if (top) dataset["livetvNavLayer"] = top;
    else delete dataset["livetvNavLayer"];
  }

  private notify(previousTop: LivetvNavLayerId | null): void {
    this.syncMirror();
    const detail: LivetvNavChangeDetail = {
      top: this.topId(),
      stack: this.layerIds(),
      previousTop,
    };
    for (const listener of [...this.listeners]) {
      callHook(() => listener(detail), "nav listener");
    }
    if (this.eventTarget && typeof CustomEvent !== "undefined") {
      try {
        this.eventTarget.dispatchEvent(
          new CustomEvent(LIVETV_NAV_CHANGE_EVENT, { detail }),
        );
      } catch {
        // Dispatch failures (detached target in tests) never wedge nav.
      }
    }
  }
}

/** Create an isolated controller (tests, and any non-singleton use). */
export function createLivetvNavController(
  initial: LivetvNavStack = createLivetvNavStack(),
  deps: {
    document?: DocumentLike | null;
    eventTarget?: EventTarget | null;
  } = {},
): LivetvNavController {
  return new LivetvNavController(initial, deps);
}

/**
 * Per-layer `livetv:back` guard for overlay surfaces (search /
 * sort overlays, and W2/W3 surfaces during the transition to
 * central back routing). While the named layer is the top
 * layer, a B press is consumed here — back() pops exactly one
 * layer — and propagation is stopped so no hidden layer below
 * can pop a second layer for the same press. While another
 * layer is on top, the guard ignores the event entirely: a
 * hidden layer never answers B. Safe alongside
 * installBackRouting: whichever listener runs first pops the
 * layer, and the second then finds a different top and ignores
 * the event. Returns an uninstall function.
 */
export function installTopLayerBackGuard(
  controller: LivetvNavController,
  layerId: LivetvNavLayerId,
  target?: EventTarget | null,
): () => void {
  const resolved =
    target ?? (typeof window !== "undefined" ? window : null);
  if (!resolved || typeof resolved.addEventListener !== "function") {
    return () => undefined;
  }
  const handler = (event: Event) => {
    if (!controller.isTop(layerId)) return;
    if (controller.back()) {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      } else if (typeof event.stopPropagation === "function") {
        event.stopPropagation();
      }
    }
  };
  resolved.addEventListener("livetv:back", handler);
  return () => resolved.removeEventListener("livetv:back", handler);
}

/**
 * The shared Live TV navigation controller. Production surfaces
 * push/pop/back through this instance so there is exactly one
 * stack — and exactly one top layer — on the Live TV page.
 */
export const livetvNav = createLivetvNavController();
