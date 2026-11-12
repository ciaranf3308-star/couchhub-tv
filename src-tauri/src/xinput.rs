// Nylah Studios — native Xbox controller input via XInput (0.11.4, W6).
//
// THE PRIMARY INPUT PATH. The browser Gamepad API path in
// src/scripts/lib/gamepad.ts failed on the user's PC twice (0.11.0,
// then the 0.11.1 four-break fix): the controller works in games but
// the app never sees it. The browser layer is where the input keeps
// getting lost — WebView2's Gamepad API hides an already-connected pad
// behind an anti-fingerprinting gesture gate until its first button
// press, and a `gamepadconnected` fired before the page's listener
// exists is lost forever. XInput is the API games use on Windows, it
// has no gesture gate, and it reports a pad that was already connected
// at cold launch on the very first poll. This module reads the pad(s)
// in Rust and forwards button edges + D-pad / stick directions as
// Tauri events; the frontend feeds them into the SAME action pipeline
// the browser path uses (gamepad.ts `dispatchNativeButton` /
// `dispatchNativeDirection`) — there is one focus engine, not two.
//
// APPROACH — direct FFI, zero new crates. XInput is three functions in
// xinput1_4.dll with a stable ABI since 2005; adding the `windows`
// crate (or a gamepad crate with an XInput backend) would pin a crate
// version this sandbox cannot compile-check (no Rust toolchain here —
// Windows CI is the compile proof), and a wrong feature set would
// break the desktop build. Instead the DLL is loaded dynamically with
// kernel32 `LoadLibraryA` / `GetProcAddress` (declared by hand, std
// only), trying xinput1_4.dll, then xinput1_3.dll, then
// xinput9_1_0.dll. A machine with no XInput DLL at all degrades to
// `available: false` — it can never stop the app launching, which a
// static `#[link(name = "xinput1_4")]` import would risk.
//
// WHAT RUNS WHERE
// - `start_xinput_poll` spawns one background thread at app setup (see
//   lib.rs) that polls slots 0..=3 every 8 ms, from cold launch, with
//   no wait for a connect event or a first press. Edge detection lives
//   here: buttons, triggers-as-digital (threshold 30, the XInput
//   dead-zone constant) and one direction at a time (D-pad beats the
//   left stick; stick dead zone 7849, the XInput constant) are emitted
//   as `xinput-button` / `xinput-direction` events. Connect /
//   disconnect emits `xinput-status`.
// - `xinput_status` is the synchronous snapshot the diagnostics UI
//   (`ControllerStatus.svelte`, /controller-status) polls. It is the
//   only Tauri command: the poll thread needs no command to run.
// - Non-Windows builds compile a stub: `available: false`, no thread.
//   The browser Gamepad API stays as the fallback there (and for
//   non-XInput pads on Windows — see native-gamepad.ts suppression).
//
// HONEST LIMIT: XInput exposes no friendly device name —
// XInputGetCapabilities only reports a subtype (gamepad, wheel,
// arcade stick, ...). The display name is therefore
// "<subtype label> (XInput Player N)". The diagnostics component also
// shows the browser Gamepad API id when one exists, as a cross-check.

use serde::Serialize;

// ── Public snapshot types (also the `xinput-status` event payload) ──

#[derive(Debug, Clone, Serialize)]
pub struct XInputSlotStatus {
    pub slot: u32,
    pub connected: bool,
    /// XInput subtype label, e.g. "Gamepad", "Wheel", "Unknown".
    pub subtype: String,
    /// Display name. XInput has no friendly name; see the module docs.
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct XInputStatus {
    /// False when no XInput DLL could be loaded (non-Windows, or a
    /// machine without XInput) — the browser fallback owns input then.
    pub available: bool,
    pub slots: Vec<XInputSlotStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct XInputButtonEvent {
    slot: u32,
    button: &'static str,
    pressed: bool,
}

#[derive(Debug, Clone, Serialize)]
struct XInputDirectionEvent {
    slot: u32,
    /// "up" | "down" | "left" | "right". On phase "end" this is the
    /// direction that just ended.
    direction: &'static str,
    phase: &'static str, // "start" | "end"
}

/// Synchronous snapshot for the diagnostics UI. Never blocks on the
/// poll thread: it polls XInput directly, one GetState per slot.
#[tauri::command]
pub fn xinput_status() -> XInputStatus {
    imp::snapshot()
}

/// Start the background poll thread. Called once from lib.rs setup()
/// on Windows; a no-op everywhere else. Safe to call twice (the second
/// call is ignored).
pub fn start_xinput_poll(app: &tauri::AppHandle) {
    // (*app).clone(): an explicit owned clone — `app.clone()` on a
    // &AppHandle would clone the reference, not the handle.
    imp::start_poll((*app).clone());
}

// ── Windows implementation ──────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::{XInputButtonEvent, XInputDirectionEvent, XInputSlotStatus, XInputStatus};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Emitter;

    // XInput button bits (XINPUT_GAMEPAD_*).
    const BTN_DPAD_UP: u16 = 0x0001;
    const BTN_DPAD_DOWN: u16 = 0x0002;
    const BTN_DPAD_LEFT: u16 = 0x0004;
    const BTN_DPAD_RIGHT: u16 = 0x0008;
    const BTN_START: u16 = 0x0010;
    const BTN_BACK: u16 = 0x0020;
    const BTN_LEFT_THUMB: u16 = 0x0040;
    const BTN_RIGHT_THUMB: u16 = 0x0080;
    const BTN_LB: u16 = 0x0100;
    const BTN_RB: u16 = 0x0200;
    const BTN_A: u16 = 0x1000;
    const BTN_B: u16 = 0x2000;
    const BTN_X: u16 = 0x4000;
    const BTN_Y: u16 = 0x8000;

    const TRIGGER_THRESHOLD: u8 = 30;
    const STICK_DEADZONE: i16 = 7849;
    const ERROR_DEVICE_NOT_CONNECTED: u32 = 1167;
    const MAX_SLOTS: u32 = 4;
    const POLL_INTERVAL_MS: u64 = 8;

    // (button bit, event name) for every non-directional button, in
    // standard-mapping order. D-pad bits are directions, not buttons.
    const BUTTONS: &[(u16, &str)] = &[
        (BTN_A, "a"),
        (BTN_B, "b"),
        (BTN_X, "x"),
        (BTN_Y, "y"),
        (BTN_LB, "lb"),
        (BTN_RB, "rb"),
        (BTN_START, "menu"),
        (BTN_BACK, "view"),
        (BTN_LEFT_THUMB, "left_stick"),
        (BTN_RIGHT_THUMB, "right_stick"),
    ];

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct XInputGamepad {
        w_buttons: u16,
        b_left_trigger: u8,
        b_right_trigger: u8,
        s_thumb_lx: i16,
        s_thumb_ly: i16,
        s_thumb_rx: i16,
        s_thumb_ry: i16,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct XInputState {
        dw_packet_number: u32,
        gamepad: XInputGamepad,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct XInputVibration {
        w_left_motor_speed: u16,
        w_right_motor_speed: u16,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct XInputCapabilities {
        type_: u8,
        sub_type: u8,
        flags: u16,
        gamepad: XInputGamepad,
        vibration: XInputVibration,
    }

    type HModule = *mut c_void;
    type XInputGetStateFn = unsafe extern "system" fn(u32, *mut XInputState) -> u32;
    type XInputGetCapabilitiesFn =
        unsafe extern "system" fn(u32, u32, *mut XInputCapabilities) -> u32;

    // "system" = WINAPI (__stdcall): the kernel32 entry points use
    // the Windows calling convention, not C.
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(lp_lib_file_name: *const u8) -> HModule;
        fn GetProcAddress(h_module: HModule, lp_proc_name: *const u8) -> *mut c_void;
    }

    struct XInputApi {
        get_state: XInputGetStateFn,
        get_capabilities: Option<XInputGetCapabilitiesFn>,
    }

    // SAFETY: function pointers into a loaded system DLL; they are
    // only ever called, never mutated, after initialisation.
    unsafe impl Send for XInputApi {}
    unsafe impl Sync for XInputApi {}

    fn load_api() -> Option<&'static XInputApi> {
        static API: OnceLock<Option<XInputApi>> = OnceLock::new();
        API.get_or_init(|| {
            // SAFETY: LoadLibraryA / GetProcAddress are kernel32 calls
            // with NUL-terminated ASCII literals that outlive the call.
            unsafe {
                for (dll, label) in [
                    ("xinput1_4.dll\0", "xinput1_4.dll"),
                    ("xinput1_3.dll\0", "xinput1_3.dll"),
                    ("xinput9_1_0.dll\0", "xinput9_1_0.dll"),
                ] {
                    let handle = LoadLibraryA(dll.as_ptr());
                    if handle.is_null() {
                        continue;
                    }
                    let get_state = GetProcAddress(handle, "XInputGetState\0".as_ptr());
                    if get_state.is_null() {
                        continue;
                    }
                    let get_capabilities =
                        GetProcAddress(handle, "XInputGetCapabilities\0".as_ptr());
                    log::info!("[xinput] loaded {label} (XInputGetState available)");
                    return Some(XInputApi {
                        get_state: std::mem::transmute::<*mut c_void, XInputGetStateFn>(
                            get_state,
                        ),
                        get_capabilities: if get_capabilities.is_null() {
                            None
                        } else {
                            Some(std::mem::transmute::<
                                *mut c_void,
                                XInputGetCapabilitiesFn,
                            >(get_capabilities))
                        },
                    });
                }
                log::warn!("[xinput] no XInput DLL found — native controller path unavailable");
                None
            }
        })
        .as_ref()
    }

    fn subtype_label(sub_type: u8) -> &'static str {
        match sub_type {
            0x01 => "Gamepad",
            0x02 => "Wheel",
            0x03 => "Arcade stick",
            0x04 => "Flight stick",
            0x05 => "Dance pad",
            0x06 => "Guitar",
            0x07 => "Guitar (alternate)",
            0x08 => "Drum kit",
            0x0B => "Bass guitar",
            0x13 => "Arcade pad",
            _ => "Unknown",
        }
    }

    fn display_name(sub_type: u8, slot: u32) -> String {
        // XInput reports no friendly name — the subtype + player
        // number is the most specific label the API can give.
        let label = subtype_label(sub_type);
        if sub_type == 0x01 {
            format!("Xbox controller (XInput Player {})", slot + 1)
        } else {
            format!("{label} (XInput Player {})", slot + 1)
        }
    }

    fn poll_slot(api: &XInputApi, slot: u32) -> Option<XInputState> {
        let mut state = XInputState::default();
        // SAFETY: GetState writes exactly one XInputState into a
        // valid stack slot; the return code is checked by callers.
        let result = unsafe { (api.get_state)(slot, &mut state) };
        if result == ERROR_DEVICE_NOT_CONNECTED {
            return None;
        }
        if result != 0 {
            log::debug!("[xinput] GetState slot {slot} failed: {result:#x}");
            return None;
        }
        Some(state)
    }

    /// Capabilities are queried once per connection, never per poll:
    /// GetCapabilities is a device query, not a state read.
    fn subtype_of(api: &XInputApi, slot: u32) -> u8 {
        let Some(get_capabilities) = api.get_capabilities else {
            return 0x01; // assume a gamepad if caps are missing
        };
        let mut caps = XInputCapabilities::default();
        let result = unsafe { get_capabilities(slot, 0, &mut caps) };
        if result == 0 {
            caps.sub_type
        } else {
            0x01
        }
    }

    pub fn snapshot() -> XInputStatus {
        let Some(api) = load_api() else {
            return XInputStatus {
                available: false,
                slots: Vec::new(),
            };
        };
        let mut slots = Vec::with_capacity(MAX_SLOTS as usize);
        for slot in 0..MAX_SLOTS {
            match poll_slot(api, slot) {
                Some(_) => {
                    let sub_type = subtype_of(api, slot);
                    slots.push(XInputSlotStatus {
                        slot,
                        connected: true,
                        subtype: subtype_label(sub_type).to_string(),
                        display_name: display_name(sub_type, slot),
                    })
                }
                None => slots.push(XInputSlotStatus {
                    slot,
                    connected: false,
                    subtype: "Unknown".to_string(),
                    display_name: String::new(),
                }),
            }
        }
        XInputStatus {
            available: true,
            slots,
        }
    }

    /// One direction at a time, D-pad first (it is the precise
    /// control; the stick is the analogue fallback), dominant axis on
    /// the stick — the same priority the browser path uses.
    fn direction_of(pad: &XInputGamepad) -> Option<&'static str> {
        if pad.w_buttons & BTN_DPAD_UP != 0 {
            return Some("up");
        }
        if pad.w_buttons & BTN_DPAD_DOWN != 0 {
            return Some("down");
        }
        if pad.w_buttons & BTN_DPAD_LEFT != 0 {
            return Some("left");
        }
        if pad.w_buttons & BTN_DPAD_RIGHT != 0 {
            return Some("right");
        }
        let x = pad.s_thumb_lx;
        let y = pad.s_thumb_ly;
        if x.abs() > STICK_DEADZONE && x.abs() >= y.abs() {
            return Some(if x > 0 { "right" } else { "left" });
        }
        if y.abs() > STICK_DEADZONE {
            // Y is up-positive in XInput; screen up is negative.
            return Some(if y > 0 { "up" } else { "down" });
        }
        None
    }

    #[derive(Default)]
    struct SlotPollState {
        connected: bool,
        sub_type: u8,
        buttons: u16,
        lt: bool,
        rt: bool,
        direction: Option<&'static str>,
    }

    static POLL_STARTED: AtomicBool = AtomicBool::new(false);

    pub fn start_poll(app: tauri::AppHandle) {
        if POLL_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::Builder::new()
            .name("xinput-poll".to_string())
            .spawn(move || {
                let Some(api) = load_api() else {
                    // No XInput on this machine: nothing to poll, and
                    // the frontend falls back to the browser path.
                    return;
                };
                log::info!("[xinput] poll thread started (8 ms, slots 0..=3)");
                let mut slots: Vec<SlotPollState> =
                    (0..MAX_SLOTS).map(|_| SlotPollState::default()).collect();
                loop {
                    let mut status_changed = false;
                    for slot in 0..MAX_SLOTS {
                        let index = slot as usize;
                        match poll_slot(api, slot) {
                            None => {
                                if slots[index].connected {
                                    slots[index] = SlotPollState::default();
                                    status_changed = true;
                                    log::info!("[xinput] slot {slot} disconnected");
                                }
                            }
                            Some(state) => {
                                let pad = &state.gamepad;
                                let was_connected = slots[index].connected;
                                if !was_connected {
                                    let sub_type = subtype_of(api, slot);
                                    slots[index].connected = true;
                                    slots[index].sub_type = sub_type;
                                    slots[index].buttons = pad.w_buttons;
                                    slots[index].lt = pad.b_left_trigger > TRIGGER_THRESHOLD;
                                    slots[index].rt = pad.b_right_trigger > TRIGGER_THRESHOLD;
                                    slots[index].direction = direction_of(pad);
                                    status_changed = true;
                                    log::info!(
                                        "[xinput] slot {slot} connected: {}",
                                        display_name(sub_type, slot)
                                    );
                                    // A pad connected at startup reports
                                    // its direction immediately — no
                                    // first press needed.
                                    if let Some(dir) = slots[index].direction {
                                        let _ = app.emit(
                                            "xinput-direction",
                                            XInputDirectionEvent {
                                                slot,
                                                direction: dir,
                                                phase: "start",
                                            },
                                        );
                                    }
                                    continue;
                                }
                                // Button edges (D-pad excluded: it is a
                                // direction, emitted below).
                                let prev = slots[index].buttons;
                                let changed = prev ^ pad.w_buttons;
                                if changed != 0 {
                                    for (bit, name) in BUTTONS {
                                        if changed & bit != 0 {
                                            let _ = app.emit(
                                                "xinput-button",
                                                XInputButtonEvent {
                                                    slot,
                                                    button: name,
                                                    pressed: pad.w_buttons & bit != 0,
                                                },
                                            );
                                        }
                                    }
                                    slots[index].buttons = pad.w_buttons;
                                }
                                // Triggers as digital buttons.
                                let lt = pad.b_left_trigger > TRIGGER_THRESHOLD;
                                if lt != slots[index].lt {
                                    slots[index].lt = lt;
                                    let _ = app.emit(
                                        "xinput-button",
                                        XInputButtonEvent {
                                            slot,
                                            button: "lt",
                                            pressed: lt,
                                        },
                                    );
                                }
                                let rt = pad.b_right_trigger > TRIGGER_THRESHOLD;
                                if rt != slots[index].rt {
                                    slots[index].rt = rt;
                                    let _ = app.emit(
                                        "xinput-button",
                                        XInputButtonEvent {
                                            slot,
                                            button: "rt",
                                            pressed: rt,
                                        },
                                    );
                                }
                                // Direction edges.
                                let dir = direction_of(pad);
                                if dir != slots[index].direction {
                                    if let Some(old) = slots[index].direction {
                                        let _ = app.emit(
                                            "xinput-direction",
                                            XInputDirectionEvent {
                                                slot,
                                                direction: old,
                                                phase: "end",
                                            },
                                        );
                                    }
                                    if let Some(new) = dir {
                                        let _ = app.emit(
                                            "xinput-direction",
                                            XInputDirectionEvent {
                                                slot,
                                                direction: new,
                                                phase: "start",
                                            },
                                        );
                                    }
                                    slots[index].direction = dir;
                                }
                            }
                        }
                    }
                    if status_changed {
                        let _ = app.emit("xinput-status", snapshot());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
                }
            })
            .expect("failed to spawn xinput poll thread");
    }
}

// ── Non-Windows stub ────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::XInputStatus;

    pub fn snapshot() -> XInputStatus {
        XInputStatus {
            available: false,
            slots: Vec::new(),
        }
    }

    pub fn start_poll(_app: tauri::AppHandle) {
        // XInput is Windows-only; the browser Gamepad API is the
        // input path on every other platform.
    }
}
