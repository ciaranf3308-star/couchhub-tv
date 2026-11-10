// Followed Series — pure Rust logic (no Tauri dependency).
//
// Split out of `followed.rs` so the CLI parsing, notifications.json
// validation, and Scheduled Task string handling can be unit-tested without
// building the whole Tauri app (which needs desktop system libraries).
// The tests in this file run in the app crate AND in a standalone harness.

use serde::{Deserialize, Serialize};

/// Exact name of the Windows Scheduled Task (see docs/followed-series.md).
pub const SCHEDULED_TASK_NAME: &str = "Nylah Studios Followed Series Check";

/// Deep-link target: an opaque provider series id plus an optional S/E episode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLink {
    pub series_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliArgs {
    pub headless_check: bool,
    pub deep_link: Option<DeepLink>,
}

fn parse_episode_spec(spec: &str) -> Option<(u32, u32)> {
    let (season, episode) = spec.split_once(':')?;
    let season: u32 = season.parse().ok()?;
    let episode: u32 = episode.parse().ok()?;
    if season == 0 || episode == 0 {
        return None;
    }
    Some((season, episode))
}

/// Parse process args. `args[0]` (the exe path) is skipped; unknown flags
/// are ignored; a malformed `--episode` value drops the episode but keeps
/// the series link; `--open-series` without a value is dropped entirely.
pub fn parse_cli_args(args: &[String]) -> CliArgs {
    let mut out = CliArgs::default();
    let mut pending_series: Option<String> = None;
    let mut pending_episode: Option<(u32, u32)> = None;
    let mut iter = args.iter().skip(1).peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--check-followed" => out.headless_check = true,
            "--open-series" => {
                if let Some(value) = iter.next() {
                    if !value.is_empty() {
                        pending_series = Some(value.clone());
                    }
                }
            }
            "--episode" => {
                if let Some(value) = iter.next() {
                    pending_episode = parse_episode_spec(value);
                }
            }
            _ => {}
        }
    }
    if let Some(series_id) = pending_series {
        let (season, episode) = pending_episode.unzip();
        out.deep_link = Some(DeepLink {
            series_id,
            season,
            episode,
        });
    }
    out
}

/// Validate the launcher payload before it touches disk: must be JSON, an
/// object, schemaVersion 1. The JS side builds it; this is the second gate.
fn validate_notifications_json(json: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("notifications.json is not valid JSON: {e}"))?;
    let schema = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "notifications.json is missing schemaVersion".to_string())?;
    if schema != 1 {
        return Err(format!(
            "unsupported notifications.json schemaVersion: {schema}"
        ));
    }
    if !value
        .get("notifications")
        .map(serde_json::Value::is_array)
        .unwrap_or(false)
    {
        return Err("notifications.json is missing the notifications array".to_string());
    }
    Ok(())
}

/// `schtasks /Query /TN <name> /XML` output carries the trigger interval as
/// `<Interval>PT6H</Interval>` and the command as `<Command>...</Command>`.
/// Substring search is enough — the file is machine-generated.
fn parse_interval_hours_from_xml(xml: &str) -> Option<u32> {
    let start = xml.find("<Interval>PT")? + "<Interval>PT".len();
    let rest = &xml[start..];
    let end = rest.find('H')?;
    rest[..end].parse::<u32>().ok()
}

fn parse_command_from_xml(xml: &str) -> Option<String> {
    let start = xml.find("<Command>")? + "<Command>".len();
    let rest = &xml[start..];
    let end = rest.find("</Command>")?;
    let raw = rest[..end].trim();
    // schtasks XML-escapes quotes as &quot;.
    Some(raw.replace("&quot;", "\""))
}

fn valid_interval(interval_hours: u32) -> Result<(), String> {
    if matches!(interval_hours, 3 | 6 | 12 | 24) {
        Ok(())
    } else {
        Err(format!(
            "invalid check interval {interval_hours}: expected 3, 6, 12 or 24 hours"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_cli_args_ignores_exe_path_and_unknown_flags() {
        let parsed = parse_cli_args(&args(&["couchhub-tv.exe", "--verbose", "x"]));
        assert_eq!(parsed, CliArgs::default());
    }

    #[test]
    fn parse_cli_args_detects_headless_check() {
        let parsed = parse_cli_args(&args(&["couchhub-tv.exe", "--check-followed"]));
        assert!(parsed.headless_check);
        assert_eq!(parsed.deep_link, None);
    }

    #[test]
    fn parse_cli_args_parses_deep_link_with_episode() {
        let parsed = parse_cli_args(&args(&[
            "couchhub-tv.exe",
            "--open-series",
            "42",
            "--episode",
            "2:3",
        ]));
        assert_eq!(
            parsed.deep_link,
            Some(DeepLink {
                series_id: "42".to_string(),
                season: Some(2),
                episode: Some(3),
            })
        );
        assert!(!parsed.headless_check);
    }

    #[test]
    fn parse_cli_args_deep_link_without_episode() {
        let parsed = parse_cli_args(&args(&["couchhub-tv.exe", "--open-series", "42"]));
        assert_eq!(
            parsed.deep_link,
            Some(DeepLink {
                series_id: "42".to_string(),
                season: None,
                episode: None,
            })
        );
    }

    #[test]
    fn parse_cli_args_drops_malformed_episode_but_keeps_series() {
        let parsed = parse_cli_args(&args(&[
            "couchhub-tv.exe",
            "--open-series",
            "42",
            "--episode",
            "banana",
        ]));
        assert_eq!(
            parsed.deep_link,
            Some(DeepLink {
                series_id: "42".to_string(),
                season: None,
                episode: None,
            })
        );
    }

    #[test]
    fn parse_cli_args_drops_zero_season_or_episode() {
        let parsed = parse_cli_args(&args(&[
            "couchhub-tv.exe",
            "--open-series",
            "42",
            "--episode",
            "0:3",
        ]));
        assert_eq!(
            parsed.deep_link,
            Some(DeepLink {
                series_id: "42".to_string(),
                season: None,
                episode: None,
            })
        );
    }

    #[test]
    fn parse_cli_args_drops_open_series_without_value() {
        let parsed = parse_cli_args(&args(&["couchhub-tv.exe", "--open-series"]));
        assert_eq!(parsed.deep_link, None);
    }

    #[test]
    fn parse_cli_args_episode_before_series_still_applies() {
        let parsed = parse_cli_args(&args(&[
            "couchhub-tv.exe",
            "--episode",
            "1:5",
            "--open-series",
            "7",
        ]));
        assert_eq!(
            parsed.deep_link,
            Some(DeepLink {
                series_id: "7".to_string(),
                season: Some(1),
                episode: Some(5),
            })
        );
    }

    #[test]
    fn parse_interval_hours_from_xml_reads_hourly_trigger() {
        let xml = r#"<Task><Triggers><CalendarTrigger><Repetition><Interval>PT6H</Interval></Repetition></CalendarTrigger></Triggers></Task>"#;
        assert_eq!(parse_interval_hours_from_xml(xml), Some(6));
    }

    #[test]
    fn parse_interval_hours_from_xml_returns_none_without_interval() {
        assert_eq!(parse_interval_hours_from_xml("<Task></Task>"), None);
    }

    #[test]
    fn parse_command_from_xml_unescapes_quotes() {
        let xml = r#"<Exec><Command>&quot;C:\Program Files\Nylah Studios\couchhub-tv.exe&quot; --check-followed</Command></Exec>"#;
        assert_eq!(
            parse_command_from_xml(xml),
            Some(
                r#""C:\Program Files\Nylah Studios\couchhub-tv.exe" --check-followed"#.to_string()
            )
        );
    }

    #[test]
    fn validate_notifications_json_accepts_schema_v1() {
        let json = r#"{"schemaVersion":1,"lastCheck":"2026-11-10T10:00:00.000Z","unreadCount":1,"notifications":[{"seriesId":"42","seriesTitle":"Show","season":2,"episode":3,"episodeTitle":"","detectedAt":"2026-11-10T10:00:00.000Z"}]}"#;
        assert!(validate_notifications_json(json).is_ok());
    }

    #[test]
    fn validate_notifications_json_rejects_wrong_schema_and_junk() {
        assert!(validate_notifications_json("not json").is_err());
        assert!(validate_notifications_json(r#"{"schemaVersion":2,"notifications":[]}"#).is_err());
        assert!(validate_notifications_json(r#"{"schemaVersion":1}"#).is_err());
    }

    #[test]
    fn valid_interval_accepts_only_3_6_12_24() {
        assert!(valid_interval(6).is_ok());
        assert!(valid_interval(5).is_err());
        assert!(valid_interval(0).is_err());
    }
}
