// Followed Series — Rust side (Tauri commands + Windows integration).
//
// Pure logic (CLI parsing, notifications.json validation, schtasks string
// handling) lives in `followed_core.rs` so it can be tested without the
// Tauri build. See docs/followed-series.md for the contracts.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::followed_core::{
    parse_cli_args, parse_command_from_xml, parse_interval_hours_from_xml, valid_interval,
    validate_notifications_json, DeepLink, SCHEDULED_TASK_NAME,
};

/// Managed launch state, filled once from `std::env::args()` in `run()`.
pub struct FollowedLaunch {
    pub headless: bool,
    pub deep_link: Mutex<Option<DeepLink>>,
}

impl FollowedLaunch {
    pub fn from_env() -> Self {
        let parsed = parse_cli_args(&std::env::args().collect::<Vec<_>>());
        Self {
            headless: parsed.headless_check,
            deep_link: Mutex::new(parsed.deep_link),
        }
    }
}

/// Second-instance callback (single-instance plugin): forward the launch to
/// the running instance instead of opening a second window.
pub fn handle_second_instance(app: &AppHandle, args: &[String]) {
    let parsed = parse_cli_args(args);
    if let Some(link) = parsed.deep_link {
        show_main_window(app);
        let _ = app.emit("xt:open-series", link);
        return;
    }
    if parsed.headless_check {
        // The scheduled task fired while the app is already running: the
        // running instance does the check; this process exits.
        let _ = app.emit("xt:headless-check-request", ());
        return;
    }
    // Plain re-launch: bring the existing window forward.
    show_main_window(app);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Tauri commands: headless mode + pending deep link
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn followed_headless_mode(state: State<'_, FollowedLaunch>) -> bool {
    state.headless
}

#[tauri::command]
pub fn followed_take_pending_deep_link(state: State<'_, FollowedLaunch>) -> Option<DeepLink> {
    state.deep_link.lock().ok()?.take()
}

#[tauri::command]
pub fn followed_headless_done(app: AppHandle) {
    // The headless check finished (or its safety timer fired): exit now.
    // No window was ever shown, so there is nothing to tear down.
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Launcher notifications.json (atomic publish)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn notifications_file_path() -> Result<std::path::PathBuf, String> {
    let localappdata =
        std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    Ok(std::path::PathBuf::from(localappdata)
        .join("RedSilk")
        .join("integration")
        .join("notifications.json"))
}

#[tauri::command]
pub fn followed_publish_notifications(json: String) -> Result<String, String> {
    validate_notifications_json(&json)?;
    #[cfg(not(windows))]
    {
        let _ = json;
        return Err("notifications.json publishing is Windows-only".to_string());
    }
    #[cfg(windows)]
    {
        let path = notifications_file_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        // Atomic update: write a temp file in the same directory, then rename.
        let temp = path.with_extension(format!("json.tmp.{}", std::process::id()));
        std::fs::write(&temp, json.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
        std::fs::rename(&temp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("cannot publish {}: {e}", path.display())
        })?;
        Ok(path.to_string_lossy().into_owned())
    }
}

// ---------------------------------------------------------------------------
// Windows Scheduled Task for background checks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatus {
    pub installed: bool,
    pub task_name: String,
    pub command: Option<String>,
    pub interval_hours: Option<u32>,
}

fn not_windows<T>() -> Result<T, String> {
    Err("scheduled background checks are Windows-only".to_string())
}

#[cfg(windows)]
fn current_exe_string() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve current exe: {e}"))?;
    Ok(exe.to_string_lossy().into_owned())
}

/// The exact command the task runs. The exe path is quoted (install paths
/// contain spaces); `--check-followed` makes it run headless and exit.
#[cfg(windows)]
fn task_command(exe_path: &str) -> String {
    format!("\"{exe_path}\" --check-followed")
}

#[cfg(windows)]
fn run_schtasks(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: never flash a console window on the TV.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("schtasks.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run schtasks: {e}"))
}

#[cfg(windows)]
fn schtasks_stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[cfg(windows)]
fn query_task() -> Result<Option<ScheduleStatus>, String> {
    let output = run_schtasks(&["/Query", "/TN", SCHEDULED_TASK_NAME, "/XML"])?;
    if !output.status.success() {
        // Task not found (or schtasks itself failed): treat "not found" as
        // absent, anything else as an error worth surfacing.
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if stderr.contains("cannot find the file")
            || stderr.contains("does not exist")
            || stderr.contains("ERROR: The system cannot find")
        {
            return Ok(None);
        }
        // schtasks reports a missing task on stdout in some locales; an
        // empty XML body means the same thing.
        if schtasks_stdout(&output).trim().is_empty() {
            return Ok(None);
        }
        return Err(format!("schtasks /Query failed: {stderr}"));
    }
    let xml = schtasks_stdout(&output);
    if xml.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(ScheduleStatus {
        installed: true,
        task_name: SCHEDULED_TASK_NAME.to_string(),
        command: parse_command_from_xml(&xml),
        interval_hours: parse_interval_hours_from_xml(&xml),
    }))
}

#[cfg(windows)]
fn create_task(exe_path: &str, interval_hours: u32) -> Result<(), String> {
    let command = task_command(exe_path);
    // /ST: start time for the hourly trigger — now, so the first run lands
    // within the next interval rather than at some arbitrary hour.
    let start = chrono::Local::now().format("%H:%M").to_string();
    let interval = interval_hours.to_string();
    let output = run_schtasks(&[
        "/Create",
        "/TN",
        SCHEDULED_TASK_NAME,
        "/TR",
        &command,
        "/SC",
        "HOURLY",
        "/MO",
        &interval,
        "/ST",
        &start,
        "/F",
    ])?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Err(format!("schtasks /Create failed: {stderr}"))
}

#[cfg(windows)]
fn delete_task() -> Result<(), String> {
    let output = run_schtasks(&["/Delete", "/TN", SCHEDULED_TASK_NAME, "/F"])?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stderr.contains("cannot find the file")
        || stderr.contains("does not exist")
        || stderr.contains("ERROR: The system cannot find")
    {
        return Ok(());
    }
    Err(format!("schtasks /Delete failed: {stderr}"))
}

#[tauri::command]
pub fn followed_schedule_status() -> Result<ScheduleStatus, String> {
    #[cfg(not(windows))]
    {
        return not_windows();
    }
    #[cfg(windows)]
    {
        Ok(query_task()?.unwrap_or(ScheduleStatus {
            installed: false,
            task_name: SCHEDULED_TASK_NAME.to_string(),
            command: None,
            interval_hours: None,
        }))
    }
}

#[tauri::command]
pub fn followed_schedule_set(enabled: bool, interval_hours: u32) -> Result<ScheduleStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (enabled, interval_hours);
        return not_windows();
    }
    #[cfg(windows)]
    {
        if !enabled {
            delete_task()?;
            return Ok(ScheduleStatus {
                installed: false,
                task_name: SCHEDULED_TASK_NAME.to_string(),
                command: None,
                interval_hours: None,
            });
        }
        valid_interval(interval_hours)?;
        let exe = current_exe_string()?;
        create_task(&exe, interval_hours)?;
        Ok(ScheduleStatus {
            installed: true,
            task_name: SCHEDULED_TASK_NAME.to_string(),
            command: Some(task_command(&exe)),
            interval_hours: Some(interval_hours),
        })
    }
}

/// Startup repair: re-register the task when it is missing, points at a
/// stale exe path (an update moved it), or runs on the wrong interval.
#[tauri::command]
pub fn followed_schedule_repair(interval_hours: u32) -> Result<ScheduleStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = interval_hours;
        return not_windows();
    }
    #[cfg(windows)]
    {
        valid_interval(interval_hours)?;
        let exe = current_exe_string()?;
        let expected_command = task_command(&exe);
        if let Some(status) = query_task()? {
            if status.command.as_deref() == Some(expected_command.as_str())
                && status.interval_hours == Some(interval_hours)
            {
                return Ok(status);
            }
        }
        create_task(&exe, interval_hours)?;
        Ok(ScheduleStatus {
            installed: true,
            task_name: SCHEDULED_TASK_NAME.to_string(),
            command: Some(expected_command),
            interval_hours: Some(interval_hours),
        })
    }
}
