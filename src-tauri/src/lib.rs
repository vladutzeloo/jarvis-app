// Tauri command surface for the JARVIS local app.
//
// The integrations layer (NVIDIA hosted inference) lives here rather than in
// the webview for two reasons: the API key stays on the Rust side and never
// touches JS strings, and we sidestep CORS surprises against
// `integrate.api.nvidia.com`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, WebviewWindow};

// ─── env file backing ────────────────────────────────────────────────────────

struct EnvStore {
    path: PathBuf,
    values: HashMap<String, String>,
}

static ENV: OnceLock<Mutex<EnvStore>> = OnceLock::new();

fn env_store() -> &'static Mutex<EnvStore> {
    ENV.get_or_init(|| {
        let path = locate_env_file();
        let values = parse_env_file(&path).unwrap_or_default();
        Mutex::new(EnvStore { path, values })
    })
}

/// Resolve the `.env` path. Looks in the current working directory and its
/// parent — that covers `tauri dev` (cwd is `src-tauri/`, parent is the
/// project root) and a binary launched directly from the project root.
fn locate_env_file() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let here = cwd.join(".env");
    if here.exists() {
        return here;
    }
    if let Some(parent) = cwd.parent() {
        let up = parent.join(".env");
        if up.exists() {
            return up;
        }
    }
    // No file yet — pick a sensible default (project root). Writes will
    // create it on first save from the settings UI.
    cwd.parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(cwd)
        .join(".env")
}

fn parse_env_file(path: &std::path::Path) -> std::io::Result<HashMap<String, String>> {
    let content = std::fs::read_to_string(path)?;
    let mut out = HashMap::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim().to_string();
            let val = v
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !key.is_empty() {
                out.insert(key, val);
            }
        }
    }
    Ok(out)
}

fn get_env(key: &str) -> Option<String> {
    let store = env_store().lock().ok()?;
    store
        .values
        .get(key)
        .cloned()
        .or_else(|| std::env::var(key).ok())
}

// ─── public commands: env ────────────────────────────────────────────────────

#[derive(Serialize)]
struct EnvSnapshot {
    path: String,
    has_nvidia_key: bool,
    nvidia_api_base: String,
    nvidia_default_model: String,
}

#[tauri::command]
fn read_env_snapshot() -> EnvSnapshot {
    let store = env_store().lock().expect("env mutex poisoned");
    let key_present = store
        .values
        .get("NVIDIA_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    EnvSnapshot {
        path: store.path.display().to_string(),
        has_nvidia_key: key_present,
        nvidia_api_base: store
            .values
            .get("NVIDIA_API_BASE")
            .cloned()
            .unwrap_or_else(|| "https://integrate.api.nvidia.com/v1".to_string()),
        nvidia_default_model: store
            .values
            .get("NVIDIA_DEFAULT_MODEL")
            .cloned()
            .unwrap_or_else(|| "meta/llama-3.1-70b-instruct".to_string()),
    }
}

#[tauri::command]
fn write_env_value(key: String, value: String) -> Result<String, String> {
    if key.is_empty() || key.contains('=') || key.contains('\n') {
        return Err("invalid env key".to_string());
    }
    if value.contains('\n') {
        return Err("env value cannot contain newlines".to_string());
    }

    let mut store = env_store().lock().map_err(|e| e.to_string())?;
    let path = store.path.clone();

    let existing = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut lines: Vec<String> = existing.lines().map(String::from).collect();
    let prefix = format!("{key}=");
    let mut found = false;
    for line in lines.iter_mut() {
        if line.trim_start().starts_with(&prefix) {
            *line = format!("{key}={value}");
            found = true;
            break;
        }
    }
    if !found {
        while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
            lines.pop();
        }
        lines.push(format!("{key}={value}"));
    }
    let mut joined = lines.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, joined).map_err(|e| e.to_string())?;

    store.values.insert(key, value);
    Ok(path.display().to_string())
}

// ─── vault I/O ────────────────────────────────────────────────────────────────────────

/// Returns the vault root path if JARVIS_VAULT_PATH is set and the directory exists.
fn vault_root() -> Option<PathBuf> {
    let raw = get_env("JARVIS_VAULT_PATH").filter(|v| !v.trim().is_empty())?;
    let path = PathBuf::from(raw.trim());
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

#[tauri::command]
fn get_vault_status() -> serde_json::Value {
    match vault_root() {
        Some(p) => serde_json::json!({ "configured": true, "path": p.display().to_string() }),
        None => serde_json::json!({ "configured": false, "path": null }),
    }
}

/// Read a markdown file relative to the vault root.
/// `rel_path` example: "01_Identity/about.md"
#[tauri::command]
fn read_vault_file(rel_path: String) -> Result<String, String> {
    let root = vault_root()
        .ok_or_else(|| "Vault not configured. Set JARVIS_VAULT_PATH in .env.".to_string())?;
    // Prevent path traversal: reject any component that is "..".
    let rel = std::path::Path::new(&rel_path);
    if rel.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("path traversal not allowed".to_string());
    }
    let full = root.join(rel);
    std::fs::read_to_string(&full).map_err(|e| format!("cannot read {}: {}", full.display(), e))
}

/// Write a timestamped note to `06_Memory/` in the vault.
/// `filename` should be something like `2026-05-09_session.md`.
/// `content` is the full markdown body to write.
#[tauri::command]
fn write_memory_entry(filename: String, content: String) -> Result<String, String> {
    let root = vault_root().ok_or_else(|| "Vault not configured.".to_string())?;
    // Safety: only allow simple filenames, no slashes.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("filename must not contain path separators".to_string());
    }
    let dir = root.join("06_Memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let full = dir.join(&filename);
    std::fs::write(&full, content).map_err(|e| e.to_string())?;
    Ok(full.display().to_string())
}

// ─── public commands: NVIDIA ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    top_p: Option<f32>,
    #[serde(default)]
    max_tokens: Option<i32>,
}

#[derive(Debug, Serialize)]
struct ChatStreamSummary {
    tokens: u64,
    finish_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct NvidiaModel {
    id: String,
    owned_by: Option<String>,
}

#[tauri::command]
async fn nvidia_list_models() -> Result<Vec<NvidiaModel>, String> {
    let api_key = get_env("NVIDIA_API_KEY")
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "NVIDIA_API_KEY not set in .env".to_string())?;
    let base = get_env("NVIDIA_API_BASE")
        .unwrap_or_else(|| "https://integrate.api.nvidia.com/v1".to_string());

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("client build error: {e}"))?;

    let resp = client
        .get(format!("{}/models", base.trim_end_matches('/')))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                out.push(NvidiaModel {
                    id: id.to_string(),
                    owned_by: m
                        .get("owned_by")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                });
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Streams an OpenAI-compatible chat completion from NVIDIA, emitting one
/// event per token delta on the channel `event_name`. Frontend listens via
/// `@tauri-apps/api/event` and the awaited invoke resolves once the stream
/// terminates.
///
/// Event payload shape:
///   { "type": "delta", "content": "..." }
///   { "type": "done",  "tokens": N, "finish_reason": "stop" }
///   { "type": "error", "message": "..." }
#[tauri::command]
async fn nvidia_chat_stream(
    window: WebviewWindow,
    request: ChatRequest,
    event_name: String,
) -> Result<ChatStreamSummary, String> {
    let api_key = get_env("NVIDIA_API_KEY")
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "NVIDIA_API_KEY not set in .env".to_string())?;
    let base = get_env("NVIDIA_API_BASE")
        .unwrap_or_else(|| "https://integrate.api.nvidia.com/v1".to_string());

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": request.messages.iter().map(|m| {
            serde_json::json!({ "role": m.role, "content": m.content })
        }).collect::<Vec<_>>(),
        "stream": true,
    });
    if let Some(t) = request.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(p) = request.top_p {
        body["top_p"] = serde_json::json!(p);
    }
    if let Some(n) = request.max_tokens {
        if n > 0 {
            body["max_tokens"] = serde_json::json!(n);
        }
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("client build error: {e}"))?;

    let mut resp = client
        .post(format!(
            "{}/chat/completions",
            base.trim_end_matches('/')
        ))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("HTTP {status}: {text}");
        let _ = window.emit(
            &event_name,
            serde_json::json!({ "type": "error", "message": msg.clone() }),
        );
        return Err(msg);
    }

    let mut buffer = String::new();
    let mut total_tokens: u64 = 0;
    let mut finish_reason: Option<String> = None;

    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let msg = format!("stream error: {e}");
                let _ = window.emit(
                    &event_name,
                    serde_json::json!({ "type": "error", "message": msg.clone() }),
                );
                return Err(msg);
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE: newline-delimited frames of `data: ...`.
        loop {
            let Some(idx) = buffer.find('\n') else { break };
            let line = buffer[..idx].trim().to_string();
            buffer.drain(..=idx);
            if line.is_empty() {
                continue;
            }
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                let _ = window.emit(
                    &event_name,
                    serde_json::json!({
                        "type": "done",
                        "tokens": total_tokens,
                        "finish_reason": finish_reason.clone(),
                    }),
                );
                return Ok(ChatStreamSummary {
                    tokens: total_tokens,
                    finish_reason,
                });
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            if let Some(delta) = json
                .pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
            {
                if !delta.is_empty() {
                    total_tokens += 1;
                    let _ = window.emit(
                        &event_name,
                        serde_json::json!({ "type": "delta", "content": delta }),
                    );
                }
            }
            if let Some(reason) = json
                .pointer("/choices/0/finish_reason")
                .and_then(|v| v.as_str())
            {
                if !reason.is_empty() {
                    finish_reason = Some(reason.to_string());
                }
            }
            if let Some(usage) = json.get("usage") {
                if let Some(t) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                    total_tokens = t;
                }
            }
        }
    }

    let _ = window.emit(
        &event_name,
        serde_json::json!({
            "type": "done",
            "tokens": total_tokens,
            "finish_reason": finish_reason.clone(),
        }),
    );
    Ok(ChatStreamSummary {
        tokens: total_tokens,
        finish_reason,
    })
}

// ─── entrypoint ──────────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Eagerly parse `.env` on startup so the first chat request doesn't pay
    // the cost mid-stream.
    let _ = env_store().lock();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            read_env_snapshot,
            write_env_value,
            get_vault_status,
            read_vault_file,
            write_memory_entry,
            nvidia_list_models,
            nvidia_chat_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
