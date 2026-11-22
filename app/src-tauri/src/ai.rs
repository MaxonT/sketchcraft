//! The SketchCraft AI box (local test build, see docs/dev/minimodel-spike.md).
//!
//! The small model's answer is a list of commands. It is untrusted text: it is never evaluated, never turned into a
//! path, and it runs ONLY the way an external MCP agent's commands run: under `Caller::Mcp` (the agent allowlist and
//! per-command checks in `sketchcraft::policy`), and on top of that only the commands the model was trained on
//! (`MODEL_ALLOW`: modeling and read-only questions; no files, no shell, no network, no plugins, no undo).
//! Anything else is refused and reported as refused. One answer is one undo step: this file, not the model, adds
//! `begin_batch` / `end_batch`.
//!
//! The only network this file does is one HTTP POST to the model server on this machine (loopback only).

use serde_json::{json, Value};
use sketchcraft::live::Live;
use sketchcraft::policy::{Caller, Workspace};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub const DEFAULT_URL: &str = "http://127.0.0.1:11437";
const MAX_COMMANDS: usize = 60;
const MAX_REPLY_BYTES: usize = 1 << 20;

/// What the model may ask for: tools/minimodel/lib/spec.mjs COMMANDS minus `undo` (the app owns undo). A test in
/// app/tests keeps this list equal to the spec table.
pub const MODEL_ALLOW: &[&str] = &[
    "rect", "polygon", "line", "circle", "offset", "pushpull", "move", "rotate", "scale", "duplicate", "array", "copy", "delete", "paint", "begin_group", "end_group", "group", "rename", "tag", "hide", "unhide", "make_component", "place", "wall", "stairs", "roof", "column", "insert", "dimension", "info", "parts", "faces", "volume", "pick", "room_info", "floorplan_build", "room_rect", "room_preview", "rooms", "wall_pull", "wall_info", "texture_project", "texture_uv", "texture_position", "texture_frame", "vertex_paint", "vertex_paint_clear", "vertex_colors", "texture_paint_new", "texture_paint_stroke", "texture_paint_status", "uv_seam", "uv_unwrap", "uv_pack", "uv_lightmap", "uv_transform", "uv_info",
];

/// The endpoint: the box's own setting if given, else `SKETCHCRAFT_AI_URL`, else the default.
pub fn endpoint(setting: Option<&str>) -> String {
    let s = setting.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    s.or_else(|| std::env::var("SKETCHCRAFT_AI_URL").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())).unwrap_or_else(|| DEFAULT_URL.into())
}

/// `http://127.0.0.1:11437[/]` -> (host, port). Loopback and plain http only.
fn parse_url(url: &str) -> Result<(String, u16), String> {
    let rest = url.strip_prefix("http://").ok_or("the model address must start with http:// (this machine only)")?;
    let hostport = rest.split('/').next().unwrap_or("");
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "bad port in the model address")?),
        None => (hostport, 80),
    };
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err("the model address must be this machine (127.0.0.1 or localhost)".into());
    }
    Ok((host.to_string(), port))
}

fn decode_chunked(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(i) = b.windows(2).position(|w| w == b"\r\n") else { break };
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..i]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        b = &b[i + 2..];
        if n == 0 || b.len() < n {
            out.extend_from_slice(&b[..b.len().min(n)]);
            break;
        }
        out.extend_from_slice(&b[..n]);
        b = &b[(n + 2).min(b.len())..];
    }
    out
}

/// POST the chat to the model server; returns the model's text (untrusted).
pub fn chat(url: &str, messages: &Value) -> Result<String, String> {
    let (host, port) = parse_url(url)?;
    let body = json!({"model": "sketchcraft-ai", "messages": messages, "stream": false, "options": {"temperature": 0, "num_predict": 900}}).to_string();
    let addr = (host.trim_matches(|c| c == '[' || c == ']'), port).to_socket_addrs().map_err(|e| format!("model address: {e}"))?.next().ok_or("model address: no address")?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("can't reach the model at {url}: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(180))).ok();
    s.set_write_timeout(Some(Duration::from_secs(10))).ok();
    write!(s, "POST /api/chat HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).and_then(|_| s.write_all(body.as_bytes())).map_err(|e| format!("sending to the model: {e}"))?;
    let mut raw = Vec::new();
    s.take(MAX_REPLY_BYTES as u64).read_to_end(&mut raw).map_err(|e| format!("waiting for the model: {e}"))?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("the model sent a broken reply")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let status_ok = head.lines().next().is_some_and(|l| l.contains(" 200"));
    let payload = if head.contains("transfer-encoding: chunked") { decode_chunked(&raw[split + 4..]) } else { raw[split + 4..].to_vec() };
    let v: Value = serde_json::from_slice(&payload).map_err(|_| "the model's reply was not JSON".to_string())?;
    if !status_ok {
        return Err(format!("the model server said: {}", v["error"].as_str().unwrap_or("an error")));
    }
    v["message"]["content"].as_str().map(String::from).ok_or_else(|| "the model's reply had no text".into())
}

fn agent() -> Caller {
    let dir = std::env::temp_dir().join("sketchcraft-ai-empty-workspace");
    let _ = std::fs::create_dir_all(&dir);
    Caller::Mcp(Workspace::at(dir))
}

fn ident(name: &str) -> String {
    name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(32).collect()
}

fn n(x: &Value) -> String {
    let v = x.as_f64().unwrap_or(0.0);
    let s = format!("{:.2}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// A plain-words description of the model for the prompt (like the eval harness's fixture descriptions), and the
/// group names the model may use as `@name`.
pub fn state(live: &mut Live) -> String {
    let caller = agent();
    let info = live.exec_as(&caller, &json!({"cmd": "info"}));
    let parts = live.exec_as(&caller, &json!({"cmd": "parts"}));
    let groups = info["groups"].as_array().cloned().unwrap_or_default();
    // the groups' names are usable as @name in the answer
    for g in &groups {
        if let (Some(id), Some(name)) = (g["id"].as_u64(), g["name"].as_str()) {
            let k = ident(name);
            if !k.is_empty() {
                live.engine.names.insert(k, id as _);
            }
        }
    }
    let faces = info["faces"].as_u64().unwrap_or(0);
    let plist = parts["parts"].as_array().cloned().unwrap_or_default();
    if faces == 0 && plist.is_empty() {
        return "empty model".into();
    }
    let mut out = Vec::new();
    for p in plist.iter().take(12) {
        let name = p["name"].as_str().unwrap_or("");
        let k = ident(name);
        let sz = p["size"].as_array().map(|a| format!("{} m (x) by {} m (y) by {} m tall", n(&a[0]), n(&a[1]), n(&a[2]))).unwrap_or_default();
        let kind = p["kind"].as_str().unwrap_or("group");
        let mat = p["material"].as_str().map(|m| format!(", material {m}")).unwrap_or_default();
        out.push(format!("@{k} is a {kind} named \"{name}\": {sz}{mat}."));
    }
    let b = &info["bounds"];
    if b["min"].is_array() && b["max"].is_array() {
        let (lo, hi) = (&b["min"], &b["max"]);
        out.push(format!("Everything together: x {}..{}, y {}..{}, z {}..{}; {} faces.", n(&lo[0]), n(&hi[0]), n(&lo[1]), n(&hi[1]), n(&lo[2]), n(&hi[2]), faces));
    }
    // picture materials the person added: the model gets the NAME only (cleaned), never a file or a path
    let mats: Vec<String> = info["materials"].as_array().map(|a| a.iter().filter_map(|m| m.as_str().or_else(|| m["name"].as_str())).map(|m| m.chars().filter(|c| !c.is_control() && *c != '"').take(40).collect::<String>()).take(20).collect()).unwrap_or_default();
    if !mats.is_empty() {
        out.push(format!("Materials available: {}.", mats.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(", ")));
    }
    out.join(" ")
}

/// Run one answer: refused commands are skipped and reported, the rest run in order under the agent policy inside ONE
/// undo step, stopping at the first engine error (like the MCP `sketchcraft_run`). Returns one row per command.
pub fn apply(live: &mut Live, answer: &Value) -> Value {
    let Some(list) = answer.as_array() else { return json!({"ok": false, "error": "the answer was not a list of commands", "rows": []}) };
    if list.is_empty() {
        return json!({"ok": false, "error": "the model proposed no commands", "rows": []});
    }
    if list.len() > MAX_COMMANDS {
        return json!({"ok": false, "error": format!("the model proposed {} commands (limit {MAX_COMMANDS}); nothing was run", list.len()), "rows": []});
    }
    let caller = agent();
    let mut rows: Vec<Value> = Vec::new();
    let mut runnable: Vec<(usize, Value)> = Vec::new();
    for c in list {
        let name = c.get("cmd").and_then(Value::as_str).unwrap_or("");
        if c.is_object() && MODEL_ALLOW.contains(&name) && sketchcraft::policy::permits(&caller, name) {
            rows.push(json!({"cmd": name, "command": c, "status": "pending"}));
            runnable.push((rows.len() - 1, c.clone()));
        } else {
            let shown: String = name.chars().filter(|c| !c.is_control()).take(40).collect();
            rows.push(json!({"cmd": shown, "command": c, "status": "refused", "error": "not allowed for the AI box"}));
        }
    }
    let mut changed = false;
    if !runnable.is_empty() {
        let begin = live.exec_as(&caller, &json!({"cmd": "begin_batch"}));
        if begin["ok"] != true {
            return json!({"ok": false, "error": format!("couldn't start: {}", begin["error"].as_str().unwrap_or("busy")), "rows": rows});
        }
        let mut stopped = false;
        for (i, c) in runnable {
            if stopped {
                rows[i]["status"] = json!("skipped");
                continue;
            }
            let r = live.exec_as(&caller, &c);
            if r["ok"] == true {
                rows[i]["status"] = json!("ok");
                changed = true;
                rows[i]["reply"] = r;
            } else {
                rows[i]["status"] = json!("error");
                rows[i]["error"] = json!(r["error"].as_str().unwrap_or("the engine refused it"));
                stopped = true;
            }
        }
        live.exec_as(&caller, &json!({"cmd": "end_batch"}));
    }
    json!({"ok": true, "rows": rows, "changed": changed})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_only() {
        assert!(parse_url("http://127.0.0.1:11437").is_ok());
        assert!(parse_url("http://localhost:1/").is_ok());
        assert!(parse_url("https://127.0.0.1:1").is_err());
        assert!(parse_url("http://example.com:80").is_err());
    }

    #[test]
    fn nothing_that_touches_files_or_programs_is_allowed() {
        let agent = agent();
        for c in ["save", "open", "new", "export_obj", "import_obj", "insert_file", "library", "plugins", "install_plugin", "undo", "redo", "begin_batch", "end_batch", "add_location", "reveal", "save_text"] {
            assert!(!MODEL_ALLOW.contains(&c), "{c}");
        }
        for c in MODEL_ALLOW {
            assert!(sketchcraft::policy::permits(&agent, c), "{c}");
        }
    }
}
