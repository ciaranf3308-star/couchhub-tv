// W2 — Browse consolidation: keyboard show/hide lifecycle + search entry.
//
// Guards the fix for the permanent on-screen keyboard on Discover:
// TvKeyboard renders only when its owner's search is active (open prop),
// Discover/Search open it on input focus and hide it on dismiss / blur /
// commit, and the Browse search action returns focus on the way back
// from /search. The lifecycle itself is pure (couch-keyboard.ts); the
// Svelte views are guarded by source assertions in the repo's usual
// style, since the suite mounts no Svelte components.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CouchKeyboardLifecycle,
  markSearchReturn,
  consumeSearchReturn,
  SEARCH_RETURN_KEY,
  SEARCH_RETURN_MAX_AGE_MS,
  TRAILING_ESCAPE_WINDOW_MS,
} from "@/scripts/lib/couch-keyboard";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
function pageSource(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

/** Minimal Storage stand-in backed by a Map. */
function makeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("couch-keyboard lifecycle: hidden on landing, opens on search focus", () => {
  it("starts closed — nothing renders on initial page load", () => {
    expect(new CouchKeyboardLifecycle().open).toBe(false);
  });

  it("opens when the search input receives focus and stays open on refocus", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    expect(kb.open).toBe(true);
    kb.onInputFocus();
    expect(kb.open).toBe(true);
  });

  it("suppresses the Search page's programmatic mount focus, then opens on the next focus", () => {
    const kb = new CouchKeyboardLifecycle({ suppressInitialFocus: true });
    kb.onInputFocus(); // mount focus: keyboard stays hidden
    expect(kb.open).toBe(false);
    kb.onInputFocus(); // a real focus after mount: opens
    expect(kb.open).toBe(true);
  });

  it("ArrowDown opens explicitly even while the mount focus is suppressed", () => {
    const kb = new CouchKeyboardLifecycle({ suppressInitialFocus: true });
    kb.openKeyboard();
    expect(kb.open).toBe(true);
    kb.onInputFocus();
    expect(kb.open).toBe(true);
  });
});

describe("couch-keyboard lifecycle: dismiss / blur / commit", () => {
  it("dismiss returns false when closed and true + closes when open", () => {
    const kb = new CouchKeyboardLifecycle();
    expect(kb.dismiss()).toBe(false);
    kb.onInputFocus();
    expect(kb.dismiss()).toBe(true);
    expect(kb.open).toBe(false);
  });

  it("dismiss-to-input suppresses exactly the next focus (the refocus), then opens again", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    expect(kb.dismissToInput()).toBe(true);
    expect(kb.open).toBe(false);
    kb.onInputFocus(); // the programmatic refocus: stays hidden
    expect(kb.open).toBe(false);
    kb.onInputFocus(); // a later, real focus: opens
    expect(kb.open).toBe(true);
  });

  it("commit hides so focus can move on to the results", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    kb.commit();
    expect(kb.open).toBe(false);
  });

  it("focus leaving the scope for a real element hides the keyboard", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    expect(kb.onScopeFocusOut(true, 1000)).toBe("hid");
    expect(kb.open).toBe(false);
  });

  it("focus leaving to nowhere (controller B blur) keeps the keyboard so D-pad can reach its keys", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    expect(kb.onScopeFocusOut(false, 1000)).toBe("kept");
    expect(kb.open).toBe(true);
  });

  it("a scope exit while closed records nothing", () => {
    const kb = new CouchKeyboardLifecycle();
    expect(kb.onScopeFocusOut(true, 1000)).toBe("was-closed");
    expect(kb.onScopeFocusOut(false, 1000)).toBe("was-closed");
    expect(kb.isFreshScopeExit(1100)).toBe(false);
  });
});

describe("couch-keyboard lifecycle: trailing Escape after a B-blur", () => {
  it("is fresh inside the window and stale after it", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    kb.onScopeFocusOut(false, 10_000);
    expect(kb.isFreshScopeExit(10_000 + TRAILING_ESCAPE_WINDOW_MS)).toBe(true);
    expect(kb.isFreshScopeExit(10_000 + TRAILING_ESCAPE_WINDOW_MS + 1)).toBe(false);
  });

  it("is not fresh before the exit happened", () => {
    const kb = new CouchKeyboardLifecycle();
    kb.onInputFocus();
    kb.onScopeFocusOut(true, 10_000);
    expect(kb.isFreshScopeExit(9_999)).toBe(false);
  });
});

describe("search-return focus: TvSearchAction round-trip", () => {
  it("mark + consume round-trips and consume is single-use", () => {
    const storage = makeStorage();
    markSearchReturn(storage);
    expect(storage.getItem(SEARCH_RETURN_KEY)).not.toBeNull();
    expect(consumeSearchReturn(storage)).toBe(true);
    expect(storage.getItem(SEARCH_RETURN_KEY)).toBeNull();
    expect(consumeSearchReturn(storage)).toBe(false);
  });

  it("an expired flag does not restore focus", () => {
    const storage = makeStorage();
    const now = Date.now();
    markSearchReturn(storage);
    expect(
      consumeSearchReturn(storage, now + SEARCH_RETURN_MAX_AGE_MS + 1),
    ).toBe(false);
    expect(storage.getItem(SEARCH_RETURN_KEY)).toBeNull();
  });

  it("a malformed or missing flag does not restore focus", () => {
    expect(consumeSearchReturn(makeStorage())).toBe(false);
    expect(
      consumeSearchReturn(makeStorage({ [SEARCH_RETURN_KEY]: "not-a-time" })),
    ).toBe(false);
  });

  it("a throwing storage never throws and never restores", () => {
    const broken = makeStorage();
    broken.getItem = () => {
      throw new Error("denied");
    };
    broken.setItem = () => {
      throw new Error("denied");
    };
    broken.removeItem = () => {
      throw new Error("denied");
    };
    expect(() => markSearchReturn(broken)).not.toThrow();
    expect(consumeSearchReturn(broken)).toBe(false);
  });
});

describe("TvKeyboard visibility contract", () => {
  it("renders only when open, defaults open for the dialog usage, and offers a Hide button", () => {
    const src = pageSource("src/components/couch/TvKeyboard.svelte");
    expect(src).toContain("open = true");
    expect(src).toContain("{#if open}");
    expect(src).toContain("onDismiss");
    expect(src).toContain("{#if onDismiss}");
    expect(src).toContain("data-couch-keyboard-dismiss");
    expect(src).toContain("Hide keyboard");
  });

  // The Movies / Series search dialogs mount TvKeyboard from .astro
  // pages with no open prop — the <dialog> gates visibility there, and
  // the default-open prop is what makes that work. Whatever .astro
  // usage exists (today: the two catalogue dialogs; after the Browse
  // consolidation: the same dialogs inside browse.astro), none of it
  // may pass open= — only the Svelte owners gate on lifecycle state.
  it("every .astro TvKeyboard usage relies on the default-open prop (dialog-gated)", () => {
    const astroFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".astro")) astroFiles.push(full);
      }
    };
    walk(resolve(root, "src"));
    const usages: string[] = [];
    for (const f of astroFiles) {
      const src = readFileSync(f, "utf8");
      const tags = src.match(/<TvKeyboard[^>]*>/g) ?? [];
      for (const tag of tags) usages.push(`${f}: ${tag}`);
    }
    expect(usages.length).toBeGreaterThan(0);
    expect(usages.filter((u) => u.includes("open="))).toEqual([]);
  });
});

describe("DiscoverView keyboard wiring (Discover search field)", () => {
  it("gates the keyboard on lifecycle state — no unconditional render", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    expect(src).toContain('import { CouchKeyboardLifecycle } from "@/scripts/lib/couch-keyboard.ts"');
    expect(src.match(/<TvKeyboard/g)?.length).toBe(1);
    expect(src).toContain("open={keyboardOpen}");
    expect(src).toContain("onDismiss={dismissKeyboardToInput}");
    expect(src).toContain("onCommit={onKeyboardCommit}");
    expect(src).not.toContain("onCommit={focusFirstResult}");
  });

  it("opens on input focus, dismisses on Escape, opens on ArrowDown, hides on scope blur", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    expect(src).toContain("onfocus={onSearchInputFocus}");
    // A pointer click on an already-focused input fires no focus
    // event — the click handler reopens after a Hide-button dismiss.
    expect(src).toContain("onclick={onSearchInputFocus}");
    expect(src).toContain("onkeydown={onSearchInputKeyDown}");
    expect(src).toContain("onfocusout={onKeyboardScopeFocusOut}");
    expect(src).toContain("keyboard.onInputFocus()");
    expect(src).toContain("keyboard.dismiss()");
    expect(src).toContain("keyboard.openKeyboard()");
    expect(src).toContain("keyboard.onScopeFocusOut(");
    expect(src).toContain("keyboard.dismissToInput()");
    expect(src).toContain("keyboard.commit()");
    expect(src).toContain("rs-discover__keyboard-scope");
    // Regression: the scope contains the keyboard, so focus moving
    // input -> key must NOT count as leaving. Hide only when focus
    // lands OUTSIDE the scope (the old `scope.contains(next)` without
    // the `!` hid the keyboard the moment a key was focused).
    expect(src).toContain("const leftScope = !!next && !scope.contains(next)");
    expect(src).not.toContain("&& scope.contains(next)");
  });

  it("restores the remembered card after the async rows render (return from a detail)", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    expect(src).toContain('import { restoreCouchFocus } from "@/scripts/lib/couch-focus.ts"');
    expect(src).toContain("restoreCouchFocus()");
    // The restore runs in the rows effect (after every rows render),
    // not only at mount — the rows arrive async, after CouchLayout's
    // one-shot restore has already run and missed them.
    expect(src).toContain("void tick().then(() => restoreCouchFocus())");
  });
});

describe("SearchView keyboard wiring", () => {
  it("gates the keyboard on lifecycle state — no unconditional render", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain('import { CouchKeyboardLifecycle } from "@/scripts/lib/couch-keyboard.ts"');
    expect(src.match(/<TvKeyboard/g)?.length).toBe(1);
    expect(src).toContain("open={keyboardOpen}");
    expect(src).toContain("onDismiss={dismissSearchKeyboard}");
  });

  it("suppresses the mount focus so /search loads keyboard-free, then opens on input focus", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("suppressInitialFocus: focusOnMount");
    expect(src).toContain("onfocus={onSearchInputFocus}");
    // A pointer click on an already-focused input fires no focus
    // event — the click handler reopens after a Hide-button dismiss.
    expect(src).toContain("onclick={onSearchInputFocus}");
    expect(src).toContain("keyboard.onInputFocus()");
    // The page still autofocuses the field — the suppression lives in the view.
    expect(pageSource("src/pages/search.astro")).toContain("focusOnMount={true}");
  });

  it("first Escape dismisses the keyboard (before clear / go-back) and swallows the gamepad trailing Escape", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("keyboard.isFreshScopeExit()");
    expect(src).toContain("keyboard.dismissToInput()");
    expect(src).toContain('document.activeElement === document.body');
  });

  it("ArrowDown opens a closed keyboard and commit hides it before moving to results", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("keyboard.openKeyboard()");
    expect(src).toContain("onfocusout={onSearchScopeFocusOut}");
    expect(src).toContain("keyboard.commit()");
    expect(src).toContain("keyboard.onScopeFocusOut(");
    // Same regression as Discover: the scope contains the keyboard,
    // so focus moving input -> key must NOT count as leaving.
    expect(src).toContain("const leftScope = !!next && !scope.contains(next)");
    expect(src).not.toContain("&& scope.contains(next)");
  });
});

describe("TvSearchAction: Browse search entry", () => {
  it("links to /search, marks the return, and restores focus on mount", () => {
    const src = pageSource("src/components/couch/TvSearchAction.svelte");
    expect(src).toContain('href = "/search"');
    expect(src).toContain("data-tv-search-action");
    expect(src).toContain("markSearchReturn(sessionStorage)");
    expect(src).toContain("consumeSearchReturn(sessionStorage)");
    expect(src).toContain("actionEl?.focus()");
    expect(src).toContain("client:load");
    expect(src).toContain("data-nylah-item");
  });
});

describe("OSK X shortcut removed (0.11.10 §28): no Gamepad API poll", () => {
  it("has no X poll — the Clear KEY is the clear path", () => {
    const src = pageSource("src/components/OnScreenKeyboard.svelte");
    // The old rAF poll read navigator.getGamepads()[0] only (the exact
    // slot-0 bug gamepad.ts fixed for its own loop) and was invisible
    // to the native XInput path, which never implements X-clear. The
    // Clear key below is the clear path; X has no OSK shortcut.
    expect(src).not.toContain("getGamepads");
    expect(src).not.toContain("pollGamepadX");
    expect(src).not.toContain("BTN_X");
    expect(src).toContain('data-osk-action="clear"');
    expect(src).toContain("clearAll()");
    expect(src).not.toContain(".search-view");
    expect(src).not.toContain("search-view");
  });

  it("B/Escape dismisses via the shared lifecycle; Backspace deletes", () => {
    const src = pageSource("src/components/OnScreenKeyboard.svelte");
    expect(src).toContain("oskKeyAction(ev.key)");
    expect(src).toContain("closeCouchKeyboard(false)");
    expect(src).toContain("backspace()");
    expect(src).toContain('data-osk-action="backspace"');
  });
});

describe("TvDialog script (W8): a bundled module, never an inlined classic script", () => {
  it("uses a plain <script> so Astro bundles the imports as a module", () => {
    const src = pageSource("src/components/couch/TvDialog.astro");
    // <script define:vars> is inlined verbatim by Astro: the bare
    // imports reached the browser as a classic script and threw
    // "Cannot use import statement outside a module", so the dialog
    // spatial-nav attach (and even the Search-button trigger wiring)
    // never ran on any page with a search dialog.
    expect(src).not.toMatch(/<script[^>]*define:vars/);
    expect(src).toContain("<script>");
    expect(src).toContain('import { attachDialogSpatialNav }');
  });

  it("wires every dialog on the page, guarded against double-attach", () => {
    const src = pageSource("src/components/couch/TvDialog.astro");
    // No define:vars means no per-instance id: the script scans for
    // all dialogs. A second script instance (or a second TvDialog)
    // must not attach twice — two handles would register two
    // spatial-nav sections under one id and fight over focus.
    expect(src).toContain('document.querySelectorAll("dialog[data-nylah-dialog]")');
    expect(src).toContain("dlg.dataset.dialogWired");
    expect(src).toContain("trigger.dataset.dialogTriggerWired");
    expect(src).toContain('querySelectorAll(`[data-couch-dialog-open="${dialogId}"]`)');
  });
});
