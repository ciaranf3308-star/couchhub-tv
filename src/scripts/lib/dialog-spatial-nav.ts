const DEFAULT_FOCUSABLES =
    "button, a, [role='tab'], [tabindex]:not([tabindex='-1']), input, select, textarea, summary"

const MAIN_SECTION_ID = "main"

let mainDisabledDepth = 0
function suspendMainSection() {
    if (mainDisabledDepth === 0) {
        try { window.SpatialNavigation?.disable?.(MAIN_SECTION_ID) } catch {}
    }
    mainDisabledDepth++
}
function resumeMainSection() {
    if (mainDisabledDepth === 0) return
    mainDisabledDepth--
    if (mainDisabledDepth === 0) {
        try { window.SpatialNavigation?.enable?.(MAIN_SECTION_ID) } catch {}
    }
}

interface SectionOpts {
    id: string
    selector: string
    defaultElement?: string
    focusOnRegister?: HTMLElement | null
}

// Shared registration core used by both <dialog> and popover wrappers.
// Returns register/unregister handles plus the refcount-safe main-section
// suspend that all overlay surfaces want.
function makeSectionHandle(opts: SectionOpts) {
    let registered = false

    const register = () => {
        const SN = window.SpatialNavigation
        if (!SN || registered) return
        // A body swap can destroy an open dialog without firing its close event, leaking the section id.
        try { SN.remove(opts.id) } catch {}
        try {
            SN.add({
                id: opts.id,
                selector: opts.selector,
                restrict: "self-only",
                enterTo: "default-element",
                defaultElement: opts.defaultElement || opts.selector,
            })
        } catch {
            return
        }
        registered = true
        suspendMainSection()
        SN.makeFocusable?.()
    }

    const unregister = () => {
        const SN = window.SpatialNavigation
        if (!SN || !registered) return
        try {
            SN.remove(opts.id)
        } catch {}
        registered = false
        resumeMainSection()
    }

    return { register, unregister }
}

interface AttachOpts {
    id?: string
    selector?: string
    defaultElement?: string
}

export function attachDialogSpatialNav(
    dlg: HTMLDialogElement | null,
    opts: AttachOpts = {}
): (() => void) | undefined {
    if (!dlg || !dlg.id) return

    const sectionId = opts.id || `${dlg.id}-section`
    const selector =
        opts.selector ||
        DEFAULT_FOCUSABLES.split(",")
            .map((s) => `#${dlg.id} ${s.trim()}`)
            .join(", ")

    const { register, unregister } = makeSectionHandle({
        id: sectionId,
        selector,
        defaultElement: opts.defaultElement,
    })

    const registerWithFocus = () => {
        register()
        const active = document.activeElement
        if (!active || !dlg.contains(active)) {
            const target =
                (opts.defaultElement
                    ? document.querySelector<HTMLElement>(opts.defaultElement)
                    : null) ||
                dlg.querySelector<HTMLElement>(selector)
            target?.focus?.({ focusVisible: true })
        }
    }

    const observer = new MutationObserver(() => {
        if (dlg.hasAttribute("open")) registerWithFocus()
        else unregister()
    })
    observer.observe(dlg, { attributes: true, attributeFilter: ["open"] })
    dlg.addEventListener("close", unregister)
    // A page swap while the dialog is open never fires "close"; unregister explicitly.
    document.addEventListener("astro:before-swap", unregister)

    // A body swap that drops the dialog never calls the returned cleanup.
    const afterSwapCleanup = (): void => {
        if (dlg.isConnected) return
        cleanup()
    }
    document.addEventListener("astro:after-swap", afterSwapCleanup)

    const cleanup = (): void => {
        observer.disconnect()
        dlg.removeEventListener("close", unregister)
        document.removeEventListener("astro:before-swap", unregister)
        document.removeEventListener("astro:after-swap", afterSwapCleanup)
        unregister()
    }

    if (dlg.hasAttribute("open")) registerWithFocus()

    return cleanup
}

interface PopoverOpts {
    /** Spatial-nav section id. Required - no element id to derive from. */
    id: string
    /** CSS selector for focusable items inside the popover. */
    selector: string
    /** Optional default element selector for enterTo. */
    defaultElement?: string
}

interface PopoverHandle {
    /** Call when the popover becomes visible. */
    open: () => void
    /** Call when the popover hides. Safe to call repeatedly. */
    close: () => void
    /** Same as close - call on component unmount. */
    teardown: () => void
}

/**
 * Spatial-nav wrapper for non-<dialog> popovers / floating menus. Mirrors
 * attachDialogSpatialNav: registers a self-only section, suspends the
 * shared "main" section via the same refcount, and exposes explicit
 * open/close calls (since plain elements don't have a standard "open"
 * attribute or close event we can observe).
 */
export function attachPopoverSpatialNav(opts: PopoverOpts): PopoverHandle {
    const { register, unregister } = makeSectionHandle({
        id: opts.id,
        selector: opts.selector,
        defaultElement: opts.defaultElement,
    })
    return {
        open: register,
        close: unregister,
        teardown: unregister,
    }
}

// ──────────────────────────────────────────────────────────────────────
// Generic "is a modal open?" detection (Nylah v0.2.1).
//
// The gamepad rail model and other nav paths need one cheap answer to
// "is the user inside a dialog right now?" — without knowing which one.
// A modal is either a native <dialog> with the open attribute (every
// showModal() dialog, whether or not it registered a spatial-nav
// section) or a plain-element overlay carrying data-nylah-dialog that
// is currently visible (the ProfilePicker; native dialogs do not need
// the marker). Plain-element overlays must ALSO register a spatial-nav
// section (attachPopoverSpatialNav above) so keyboard arrows stay
// inside them; this detection is the gamepad-side half of the trap.
// ──────────────────────────────────────────────────────────────────────

export const MODAL_DIALOG_SELECTOR =
    "dialog[open], [data-nylah-dialog]:not([hidden])"

function isModalVisible(el: Element): boolean {
    // A <dialog> with `open` can still be display:none'd by CSS, and a
    // [data-nylah-dialog] overlay can be class-hidden — require a real
    // box in both cases, not just the attribute.
    if (el.getClientRects().length === 0) return false
    return getComputedStyle(el).visibility !== "hidden"
}

/** The topmost open modal in the document, or null when none is open. */
export function findOpenModal(
    root: ParentNode = document,
): HTMLElement | null {
    const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(MODAL_DIALOG_SELECTOR),
    ).filter(isModalVisible)
    // Later in document order wins: dialogs are appended to <body> as
    // they open, so the last one is the one on top.
    return candidates.length > 0 ? candidates[candidates.length - 1] : null
}

const MODAL_FOCUSABLES =
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"

/** First visible focusable inside a modal, for pulling stray focus in. */
export function firstFocusableInModal(modal: HTMLElement): HTMLElement | null {
    const found = Array.from(
        modal.querySelectorAll<HTMLElement>(MODAL_FOCUSABLES),
    ).filter(
        (el) =>
            el.getClientRects().length > 0 &&
            getComputedStyle(el).visibility !== "hidden",
    )
    return found.length > 0 ? found[0] : null
}
