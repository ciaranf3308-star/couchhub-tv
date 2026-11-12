/**
 * @vitest-environment jsdom
 */
// W5 — Controller Experience 2.0 (0.11.10): confirm-dialog focus
// contract (§38) — open focuses the safe default (Cancel), close
// restores the invoker, and while the dialog is open the Back
// dispatcher does not run page layers (B cancels the dialog first;
// no second Back step). jsdom has no native <dialog> behaviour, so
// the close event is dispatched manually to stand in for the
// browser's cancel/close path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { confirmDialog } from "../src/scripts/lib/confirm-dialog"
import {
  registerBackLayer,
  BACK_PRIORITY,
} from "../src/scripts/lib/controller-seams-0110"

describe("confirmDialog", () => {
  let invoker: HTMLButtonElement

  beforeEach(() => {
    // The dialog is a module singleton (as in production): keep it
    // across tests, clear everything else.
    for (const child of [...document.body.children]) {
      if (child.id !== "xt-confirm-dialog") child.remove()
    }
    invoker = document.createElement("button")
    invoker.type = "button"
    invoker.textContent = "Unfollow"
    document.body.appendChild(invoker)
    invoker.focus()
  })

  afterEach(() => {
    const node = document.querySelector("dialog")
    node?.removeAttribute("open")
    for (const child of [...document.body.children]) {
      if (child.id !== "xt-confirm-dialog") child.remove()
    }
  })

  function dialogNode(): HTMLDialogElement {
    const node = document.querySelector("dialog")
    if (!node) throw new Error("expected a dialog in the document")
    return node as HTMLDialogElement
  }

  function closeDialog(): void {
    // Stand-in for the browser's native close: remove the open
    // attribute (jsdom has no dialog.close(), and the spatial-nav
    // MutationObserver would otherwise re-focus Cancel on the next
    // microtask), then dispatch the close event the production
    // listener settles on.
    const node = dialogNode()
    node.removeAttribute("open")
    try {
      node.close?.()
    } catch {
      // Fall through to the manual event.
    }
    node.dispatchEvent(new Event("close"))
  }

  it("focuses Cancel (the safe default) on open", async () => {
    const pending = confirmDialog({
      title: "Unfollow?",
      message: "Stop following this series.",
      confirmLabel: "Unfollow",
      destructive: true,
    })
    const node = dialogNode()
    const cancel = node.querySelector<HTMLElement>('[data-role="cancel"]')
    expect(cancel).not.toBeNull()
    expect(document.activeElement).toBe(cancel)
    closeDialog()
    await expect(pending).resolves.toBe(false)
  })

  it("closing without confirming resolves false and restores the invoker", async () => {
    const pending = confirmDialog({
      title: "Unfollow?",
      message: "Stop following this series.",
      confirmLabel: "Unfollow",
      destructive: true,
    })
    expect(document.activeElement).not.toBe(invoker)
    closeDialog()
    await expect(pending).resolves.toBe(false)
    expect(document.activeElement).toBe(invoker)
  })

  it("confirming resolves true", async () => {
    const pending = confirmDialog({
      title: "Rebaseline?",
      message: "Reset the episode baseline.",
      confirmLabel: "Rebaseline",
    })
    const confirm = dialogNode().querySelector<HTMLElement>('[data-role="confirm"]')
    expect(confirm).not.toBeNull()
    confirm?.click()
    await expect(pending).resolves.toBe(true)
    closeDialog()
    expect(document.activeElement).toBe(invoker)
  })

  it("a page Back layer does not run while the dialog is open", async () => {
    const handle = vi.fn()
    const unregister = registerBackLayer({
      id: "page",
      priority: BACK_PRIORITY.PAGE,
      isActive: () => true,
      handle,
    })
    try {
      const pending = confirmDialog({
        title: "Unfollow?",
        message: "Stop following this series.",
        confirmLabel: "Unfollow",
        destructive: true,
      })
      // Simulate the open dialog the browser would show.
      dialogNode().setAttribute("open", "")
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      )
      expect(handle).not.toHaveBeenCalled()
      closeDialog()
      await expect(pending).resolves.toBe(false)
    } finally {
      unregister()
    }
  })

  it("restores focus to a survivor when the invoker is gone", async () => {
    const pending = confirmDialog({
      title: "Unfollow?",
      message: "Stop following this series.",
      confirmLabel: "Unfollow",
      destructive: true,
    })
    const survivor = document.createElement("button")
    survivor.type = "button"
    survivor.textContent = "Survivor"
    document.body.appendChild(survivor)
    invoker.remove()
    closeDialog()
    await expect(pending).resolves.toBe(false)
    // The invoker is detached; focus must land somewhere live (or
    // stay put) — never throw, never focus a detached node.
    expect(document.activeElement?.isConnected ?? true).toBe(true)
  })
})
