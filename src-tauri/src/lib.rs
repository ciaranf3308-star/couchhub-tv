#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod audio_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod compositing;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod discord;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod external_player;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod firewall;

mod followed;
mod followed_core;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod hevc_extension;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod http_range;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod matroska;

mod ai_keyring;

mod receiver;

mod receiver_store;

mod safe_fetch;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod sniffer;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod store_paths;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tray;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod updater;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod vod_audio_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod vod_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod xinput;

mod warmup;

#[cfg(not(target_os = "ios"))]
fn log_line_prefix(
    stamp: &chrono::DateTime<chrono::FixedOffset>,
    target: &str,
    level: log::Level,
) -> String {
    format!(
        "[{}][{}][{}][{}] ",
        stamp.format("%Y-%m-%d"),
        stamp.format("%H:%M:%S%.3f%:z"),
        target,
        level
    )
}

// The Stdout target also covers Android release builds; tauri-plugin-log routes it to logcat there, not just the debug-only terminal.
#[cfg(not(target_os = "ios"))]
fn build_log_plugin() -> tauri_plugin_log::Builder {
    let now = chrono::Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    // The plugin's own default format drops the date and level on mobile, so state it here:
    // an Android log with no timestamps can't be correlated with anything a reporter says.
    // Offset resolved once - a per-record local lookup would hit the tz database on every line.
    let offset = *now.offset();
    // clear_targets() drops the plugin's own default LogDir target so records aren't double-written.
    let mut log_builder = tauri_plugin_log::Builder::new()
        .format(move |out, message, record| {
            let prefix =
                log_line_prefix(&chrono::Utc::now().with_timezone(&offset), record.target(), record.level());
            out.finish(format_args!("{prefix}{message}"))
        })
        .level(log::LevelFilter::Info)
        .max_file_size(50_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .clear_targets()
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(format!("app-{day}")),
            },
        ));
    if cfg!(debug_assertions) || cfg!(target_os = "android") {
        log_builder = log_builder.target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ));
    }
    log_builder
}

// KeepSome only prunes the active day-stamped file's prefix, never prior days, and Android lacks desktop's manual "Open log folder" cleanup.
#[cfg(target_os = "android")]
const LOG_RETENTION_DAYS: u64 = 14;

#[cfg(target_os = "android")]
fn prune_old_android_logs(app: &tauri::App) {
    use tauri::Manager;

    let log_dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("[log-prune] app_log_dir unavailable: {error}");
            return;
        }
    };
    let entries = match std::fs::read_dir(&log_dir) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("[log-prune] read_dir failed for {}: {error}", log_dir.display());
            return;
        }
    };
    let Some(cutoff) = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(LOG_RETENTION_DAYS * 24 * 60 * 60))
    else {
        return;
    };

    let mut kept = 0usize;
    let mut removed = 0usize;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        // Every log in our own log dir: day-stamped, plugin-log's size-rotation names, and
        // the pre-day-stamp "<app name>.log" that the prefix check used to leave behind.
        let is_app_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".log") || name.ends_with(".log.bak"));
        if !is_app_log {
            continue;
        }
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(error) => {
                log::warn!("[log-prune] metadata failed for {}: {error}", path.display());
                continue;
            }
        };
        if modified < cutoff {
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) => {
                    log::warn!("[log-prune] remove_file failed for {}: {error}", path.display())
                }
            }
        } else {
            kept += 1;
        }
    }
    log::info!("[log-prune] kept {kept} log file(s), removed {removed} older than {LOG_RETENTION_DAYS} days");
}

// Marks a session boundary in a log file that can span days and app restarts.
fn log_session_banner(app: &tauri::App) {
    use tauri::Manager;

    let package = app.package_info();
    let log_dir = app
        .path()
        .app_log_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|_| "unavailable".to_string());
    log::info!(
        "[session] {} {} start on {} {} ({} build), logs at {log_dir}",
        package.name,
        package.version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(debug_assertions) { "debug" } else { "release" },
    );
}

fn install_panic_hook() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let payload = panic_info.payload();
        let message = if let Some(text) = payload.downcast_ref::<&str>() {
            text.to_string()
        } else if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else {
            "non-string panic payload".to_string()
        };
        let location = panic_info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        log::error!("[panic] {message} at {location}");
        previous_hook(panic_info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Followed Series launch args (--check-followed / --open-series): parsed
    // once so the headless flag can gate the tray + window in setup().
    let followed_launch = followed::FollowedLaunch::from_env();
    let followed_headless = followed_launch.headless;
    // Must run before the builder exists: the main window is created before
    // setup(), so the WebKitGTK env var has to land before that.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    compositing::initialize(&context.config().identifier);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(warmup::WarmupState::default())
        .manage(receiver::ReceiverState::default())
        .manage(followed_launch);

    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(build_log_plugin().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch hands its args to the running instance:
            // deep links open the series, --check-followed runs a check.
            followed::handle_second_instance(app, &args);
        }))
        .plugin(external_player::sandbox_bootstrap_plugin())
        .plugin(
            // 0.11.1 W1 (white bar): the window-state plugin must NOT
            // save or restore ANY window geometry. v0.2.2 excluded only
            // FULLSCREEN and DECORATIONS — but SIZE, POSITION and
            // MAXIMIZED were still restored from the saved state, which
            // predates the fullscreen launch (0.2.0) and can still land
            // the window in a windowed rect on the projector: the WebView
            // then ends above the bottom of the screen and the desktop
            // shows through below it as a full-width white strip (user
            // photos 2026-11-11, Home + Settings — same strip on both,
            // below the fixed hints pill, content sliced at its top
            // edge). A fullscreen TV launcher has no windowed geometry
            // worth remembering, so the flag set is empty: the plugin
            // neither restores a stale rect nor saves a new one.
            // Fullscreen is owned by the config plus the explicit
            // set_fullscreen(true) calls in setup() below (re-asserted
            // after show(), and again on RunEvent::Ready); decorations
            // are forced off there too. Do NOT re-add SIZE, POSITION
            // or MAXIMIZED here without a hardware check that the app
            // still launches fullscreen on the user's PC.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE
                        - tauri_plugin_window_state::StateFlags::FULLSCREEN
                        - tauri_plugin_window_state::StateFlags::DECORATIONS
                        - tauri_plugin_window_state::StateFlags::SIZE
                        - tauri_plugin_window_state::StateFlags::POSITION
                        - tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(audio_proxy::AudioProxyState::default())
        .manage(discord::RpcState::default())
        .manage(external_player::ExternalPlayerState::default())
        .manage(updater::PendingUpdateState::default())
        .manage(sniffer::SnifferState::default())
        .manage(vod_audio_proxy::VodAudioProxyState::default())
        .manage(vod_proxy::VodProxyState::default())
        .invoke_handler(tauri::generate_handler![
            ai_keyring::ai_key_set,
            ai_keyring::ai_key_get,
            ai_keyring::ai_key_has,
            ai_keyring::ai_key_delete,
            ai_keyring::ai_test_connection,
            audio_proxy::audio_transcode_available,
            audio_proxy::register_audio_transcode,
            audio_proxy::unregister_audio_transcode,
            compositing::compositing_state,
            compositing::compositing_set,
            discord::discord_set_activity,
            discord::discord_clear,
            discord::discord_disconnect,
            external_player::launch_external_player,
            external_player::stop_external_player,
            external_player::sandbox_runtime,
            external_player::discover_external_players,
            firewall::receiver_firewall_status,
            firewall::receiver_firewall_allow,
            followed::followed_headless_mode,
            followed::followed_take_pending_deep_link,
            followed::followed_headless_done,
            followed::followed_publish_notifications,
            followed::followed_schedule_status,
            followed::followed_schedule_set,
            followed::followed_schedule_repair,
            hevc_extension::install_appx_package,
            hevc_extension::is_store_build,
            receiver::receiver_start,
            receiver::receiver_stop,
            receiver::receiver_status,
            receiver::receiver_regenerate_code,
            receiver::receiver_set_name,
            receiver::receiver_revoke_device,
            receiver::receiver_report_state,
            receiver::receiver_log_lines,
            receiver::receiver_discover,
            receiver::device_hostname,
            safe_fetch::probe_manifest,
            sniffer::sniff_page,
            sniffer::cancel_sniff,
            sniffer::sniff_report,
            sniffer::sniff_report_drm,
            store_paths::resolve_explorer_path,
            tray::set_close_to_tray,
            updater::updater_check_from,
            updater::updater_install,
            vod_audio_proxy::vod_audio_remux_available,
            vod_audio_proxy::register_vod_audio_remux,
            vod_audio_proxy::unregister_vod_audio_remux,
            vod_proxy::register_vod_proxy,
            vod_proxy::register_vod_proxy_file,
            vod_proxy::unregister_vod_proxy,
            warmup::warmup_start,
            warmup::warmup_status,
            warmup::warmup_cancel,
            warmup::warmup_ack,
            warmup::warmup_read_staged,
            xinput::xinput_status,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        ai_keyring::ai_key_set,
        ai_keyring::ai_key_get,
        ai_keyring::ai_key_has,
        ai_keyring::ai_key_delete,
        ai_keyring::ai_test_connection,
        followed::followed_headless_mode,
        followed::followed_take_pending_deep_link,
        followed::followed_headless_done,
        receiver::receiver_start,
        receiver::receiver_stop,
        receiver::receiver_status,
        receiver::receiver_regenerate_code,
        receiver::receiver_set_name,
        receiver::receiver_revoke_device,
        receiver::receiver_report_state,
        receiver::receiver_log_lines,
        receiver::receiver_discover,
        receiver::device_hostname,
        safe_fetch::probe_manifest,
        warmup::warmup_start,
        warmup::warmup_status,
        warmup::warmup_cancel,
        warmup::warmup_ack,
        warmup::warmup_read_staged,
    ]);

    let app = builder
        .setup(move |app| {
            install_panic_hook();
            log_session_banner(app);
            #[cfg(target_os = "android")]
            prune_old_android_logs(app);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            external_player::sweep_orphan_mpv_sockets();
            // Headless check mode: no tray icon, no window — the frontend
            // runs the check and calls followed_headless_done to exit.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if !followed_headless {
                tray::install(app)?;
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if !followed_headless {
                use tauri::Manager;
                if let Some(main_window) = app.get_webview_window("main") {
                    if let Err(error) = main_window.set_decorations(false) {
                        log::warn!("[window] set_decorations(false) failed: {error}");
                    }
                    // Nylah Studios v0.2.2: belt-and-braces for any state
                    // already saved before this release — the window must
                    // launch fullscreen even if a stale saved state was
                    // restored by the plugin above.
                    if let Err(error) = main_window.set_fullscreen(true) {
                        log::warn!("[window] set_fullscreen(true) failed: {error}");
                    }
                    if let Err(error) = main_window.set_shadow(true) {
                        log::warn!("[window] set_shadow(true) failed: {error}");
                    }
                    if let Err(error) = main_window.show() {
                        log::warn!("[window] show() failed: {error}");
                    }
                    // 0.11.1 W1 (white bar): re-assert fullscreen AFTER
                    // show(). The pre-show set_fullscreen(true) above was
                    // the only fullscreen call the 0.11.0 launch path made,
                    // and a fullscreen request made while the window is
                    // still hidden can be dropped by the window manager —
                    // the window then launches in a windowed rect and the
                    // desktop shows through below the WebView as a white
                    // strip. Re-asserting on the visible window is the
                    // call that sticks, and it also forces the resize
                    // event that re-lays the WebView out to the full
                    // window. The log line below proves the outcome on
                    // the user's PC — check the log, not the code.
                    if let Err(error) = main_window.set_fullscreen(true) {
                        log::warn!("[window] set_fullscreen(true) after show failed: {error}");
                    }
                    let fullscreen = main_window.is_fullscreen().unwrap_or(false);
                    let size = main_window
                        .inner_size()
                        .map(|s| format!("{}x{}", s.width, s.height))
                        .unwrap_or_else(|_| "unknown".to_string());
                    log::info!("[window] launch fullscreen={fullscreen} inner_size={size}");
                    let _ = main_window.set_focus();
                }
            }
            // Synchronous: runs before any IPC, so it can't race a warmup_start's staging_dir.
            warmup::sweep_stale_staging(app.handle());
            // 0.11.4 W6 (native XInput): the poll thread starts here,
            // at cold launch, with no wait for a connect event or a
            // first button press — a pad already connected when the
            // app starts is reported on the first poll. Without this
            // the native path would have the same cold-launch hole the
            // browser Gamepad API path had.
            #[cfg(target_os = "windows")]
            xinput::start_xinput_poll(app.handle());
            Ok(())
        })
        .build(context)
        .expect("error while running tauri application");

    if followed_headless {
        // Safety net: a hung provider must never leave a ghost process
        // behind after a scheduled check.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(10 * 60));
            log::warn!("[followed] headless check watchdog: exiting after 10 minutes");
            std::process::exit(0);
        });
    }

    app.run(|app_handle, event| {
        // 0.11.1 W1 (white bar): re-assert fullscreen once the event
        // loop is running. Anything that restores window geometry after
        // setup() would otherwise leave the window windowed for the
        // whole session; this is the last launch-time chance to force
        // it fullscreen.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let tauri::RunEvent::Ready = event {
            use tauri::Manager;
            if let Some(main_window) = app_handle.get_webview_window("main") {
                if let Err(error) = main_window.set_fullscreen(true) {
                    log::warn!("[window] set_fullscreen(true) on Ready failed: {error}");
                }
            }
        }
        // Tauri exit paths (e.g. tray Quit) may not run Drop for state behind Arcs, so kill any active ffmpeg session here.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager;
            audio_proxy::shutdown(&app_handle.state::<audio_proxy::AudioProxyState>());
            vod_audio_proxy::shutdown(&app_handle.state::<vod_audio_proxy::VodAudioProxyState>());
        }
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager;
            receiver::shutdown(&app_handle.state::<receiver::ReceiverState>());
        }
    });
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::log_line_prefix;

    fn stamp(text: &str) -> chrono::DateTime<chrono::FixedOffset> {
        chrono::DateTime::parse_from_rfc3339(text).unwrap()
    }

    #[test]
    fn log_line_prefix_carries_date_time_offset_target_and_level() {
        let prefix = log_line_prefix(&stamp("2026-08-25T11:27:23.456+02:00"), "webview:app", log::Level::Warn);
        assert_eq!(prefix, "[2026-08-25][11:27:23.456+02:00][webview:app][WARN] ");
    }

    #[test]
    fn log_line_prefix_keeps_a_utc_offset_explicit() {
        let prefix = log_line_prefix(&stamp("2026-01-02T03:04:05.006Z"), "app_lib::receiver", log::Level::Info);
        assert_eq!(prefix, "[2026-01-02][03:04:05.006+00:00][app_lib::receiver][INFO] ");
    }

    #[test]
    fn log_line_prefix_keeps_a_negative_offset() {
        let prefix = log_line_prefix(&stamp("2026-08-25T20:15:00.000-07:00"), "app_lib", log::Level::Error);
        assert_eq!(prefix, "[2026-08-25][20:15:00.000-07:00][app_lib][ERROR] ");
    }
}
