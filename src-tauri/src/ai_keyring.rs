// AI Discovery API key storage — OS credential store, never plaintext.
//
// Windows: Windows Credential Manager (keyring `windows-native`).
// macOS: Keychain. Linux: Secret Service (gnome-keyring / KWallet).
// Android/iOS: no OS credential store is wired up here, so every command
// below returns an "UNSUPPORTED" error and AI stays off on those builds.
//
// The key is NEVER written to the app's config, plugin-store, localStorage
// or logs. The only way the frontend ever sees it is `ai_key_get`, which
// hands it to JS memory for a single request's Authorization header —
// callers must never persist, cache-to-disk or log the returned value.
// `ai_test_connection` instead reads the key on the Rust side, so the
// Settings "Test connection" button never moves the key into JS at all.
//
// Contrast with `src/scripts/lib/creds.js`: IPTV passwords there live in
// plaintext in plugin-store JSON + localStorage + cookies. This module
// deliberately does NOT copy that pattern.

use serde::Serialize;

const SERVICE: &str = "Nylah Studios";
const USERNAME: &str = "ai-discovery-api-key";

/// Longest API key we accept. Real provider keys are well under this;
/// the cap stops a pasted document from landing in the credential store.
const MAX_KEY_CHARS: usize = 512;
const MAX_ENDPOINT_CHARS: usize = 256;
const TEST_TIMEOUT_SECS: u64 = 10;

const UNSUPPORTED: &str = "UNSUPPORTED:AI key storage is not available on this platform";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    /// Short machine-readable code, never a message that could echo the
    /// key or the endpoint's response body: "no_key" | "invalid_endpoint" |
    /// "invalid_key" | "rate_limited" | "unavailable" | "timeout" | "store_error".
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Store access (cfg-split: real keyring on desktop, stub on mobile)
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USERNAME).map_err(|error| format!("STORE:{error}"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn open_entry() -> Result<keyring::Entry, String> {
    Err(UNSUPPORTED.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn read_key_from_store() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| match open_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("STORE:{error}")),
        },
        Err(error) => Err(error),
    })
    .await
    .map_err(|error| format!("STORE:key read worker failed: {error}"))?
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn read_key_from_store() -> Result<Option<String>, String> {
    Err(UNSUPPORTED.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Store (or replace) the AI provider API key in the OS credential store.
/// Returns true on success. The key is trimmed; empty or over-long keys
/// are rejected without touching the store.
#[tauri::command]
pub async fn ai_key_set(key: String) -> Result<bool, String> {
    let key = validate_key(&key)?;
    let owned = key.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = open_entry()?;
        entry
            .set_password(&owned)
            .map_err(|error| format!("STORE:{error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("STORE:key write worker failed: {error}"))?
}

/// Transient read of the stored key for a single request's Authorization
/// header. Returns None when no key is stored. Callers must hold the value
/// in memory only — never persist, log or display it.
#[tauri::command]
pub async fn ai_key_get() -> Result<Option<String>, String> {
    read_key_from_store().await
}

/// Whether a key is currently stored. Never reveals the key itself.
#[tauri::command]
pub async fn ai_key_has() -> Result<bool, String> {
    Ok(read_key_from_store().await?.is_some())
}

/// Delete the stored key. Returns true when a key was removed, false when
/// there was nothing stored.
#[tauri::command]
pub async fn ai_key_delete() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let entry = open_entry()?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(format!("STORE:{error}")),
        }
    })
    .await
    .map_err(|error| format!("STORE:key delete worker failed: {error}"))?
}

/// Validate the stored key against the configured provider without moving
/// the key into JS: a plain GET on `{endpoint}/models` with a Bearer
/// header. 2xx means the endpoint + key pair is accepted. The response
/// body is discarded — only the status is reported.
#[tauri::command]
pub async fn ai_test_connection(endpoint: String, model: String) -> Result<AiTestResult, String> {
    let endpoint = match sanitize_endpoint(&endpoint) {
        Ok(endpoint) => endpoint,
        Err(code) => {
            return Ok(AiTestResult {
                ok: false,
                status: None,
                error: Some(code.to_string()),
            })
        }
    };
    if model.trim().is_empty() || model.trim().chars().count() > 128 {
        return Ok(AiTestResult {
            ok: false,
            status: None,
            error: Some("invalid_model".to_string()),
        });
    }
    let key = match read_key_from_store().await? {
        Some(key) => key,
        None => {
            return Ok(AiTestResult {
                ok: false,
                status: None,
                error: Some("no_key".to_string()),
            })
        }
    };

    let url = format!("{endpoint}/models");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("OTHER:{error}"))?;
    let response = client
        .get(url)
        .bearer_auth(&key)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await;
    // Drop the key from this scope as soon as the request is built.
    drop(key);

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            // `without_url()` moves the error, so read the timeout flag first.
            // The error Display never includes the Authorization header.
            let is_timeout = error.is_timeout();
            log::warn!(
                "[ai-keyring] connection test failed: {}",
                error.without_url()
            );
            let code = if is_timeout { "timeout" } else { "unavailable" };
            return Ok(AiTestResult {
                ok: false,
                status: None,
                error: Some(code.to_string()),
            });
        }
    };
    let status = response.status().as_u16();
    Ok(AiTestResult {
        ok: response.status().is_success(),
        status: Some(status),
        error: if response.status().is_success() {
            None
        } else {
            Some(classify_test_status(status).to_string())
        },
    })
}

// ---------------------------------------------------------------------------
// Validation (pure — unit-tested below)
// ---------------------------------------------------------------------------

/// Trim + sanity-check an API key. Keys are single tokens: any interior
/// whitespace means the user pasted something else (a sentence, a URL).
fn validate_key(raw: &str) -> Result<&str, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("INVALID:empty key".to_string());
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err("INVALID:key too long".to_string());
    }
    if key.chars().any(char::is_whitespace) {
        return Err("INVALID:key must be a single token".to_string());
    }
    Ok(key)
}

/// Normalise a provider endpoint to `scheme://host[:port][/path]` with no
/// trailing slash. Rejects anything that is not http(s), has no host, or
/// smuggles credentials in the URL (the key travels in a header, never
/// in a URL).
fn sanitize_endpoint(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_ENDPOINT_CHARS {
        return Err("invalid_endpoint");
    }
    let url = reqwest::Url::parse(trimmed).map_err(|_| "invalid_endpoint")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("invalid_endpoint");
    }
    if url.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("invalid_endpoint");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("invalid_endpoint");
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn classify_test_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "invalid_key",
        429 => "rate_limited",
        _ => "unavailable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_key_accepts_a_typical_provider_key() {
        assert_eq!(validate_key("  sk-test123  ").unwrap(), "sk-test123");
    }

    #[test]
    fn validate_key_rejects_empty_and_whitespace_only() {
        assert!(validate_key("").is_err());
        assert!(validate_key("   ").is_err());
    }

    #[test]
    fn validate_key_rejects_interior_whitespace() {
        assert!(validate_key("sk-test 123").is_err());
        assert!(validate_key("sk-test\n123").is_err());
    }

    #[test]
    fn validate_key_rejects_overlong_keys() {
        assert!(validate_key(&"k".repeat(MAX_KEY_CHARS + 1)).is_err());
        assert!(validate_key(&"k".repeat(MAX_KEY_CHARS)).is_ok());
    }

    #[test]
    fn sanitize_endpoint_strips_trailing_slashes() {
        assert_eq!(
            sanitize_endpoint("https://api.openai.com/v1///").unwrap(),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn sanitize_endpoint_accepts_http_for_local_compatible_servers() {
        // OpenAI-compatible endpoints include self-hosted ones (Ollama etc.).
        assert_eq!(
            sanitize_endpoint("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn sanitize_endpoint_rejects_non_http_schemes() {
        assert!(sanitize_endpoint("ftp://example.com/v1").is_err());
        assert!(sanitize_endpoint("api.openai.com/v1").is_err());
    }

    #[test]
    fn sanitize_endpoint_rejects_missing_host_and_embedded_credentials() {
        // NB: "https:///v1" is NOT host-less — WHATWG parsing reads "v1" as
        // the host. A truly empty host ("https://") fails to parse.
        assert!(sanitize_endpoint("https://").is_err());
        assert!(sanitize_endpoint("https://user:pass@example.com/v1").is_err());
        assert!(sanitize_endpoint("").is_err());
    }

    #[test]
    fn classify_test_status_maps_auth_and_rate_limits() {
        assert_eq!(classify_test_status(401), "invalid_key");
        assert_eq!(classify_test_status(403), "invalid_key");
        assert_eq!(classify_test_status(429), "rate_limited");
        assert_eq!(classify_test_status(500), "unavailable");
        assert_eq!(classify_test_status(404), "unavailable");
    }
}
