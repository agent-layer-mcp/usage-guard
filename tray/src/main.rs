// Usage Guard tray: reads the local Usage Guard API (usage-guard serve) and shows
// each lane's daily budget. It never spends a banked reset; that button only opens
// the provider's page after the user confirms.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

const TRAY_ID: &str = "usage-guard";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/codex/settings/usage";

fn port() -> u16 {
    std::env::var("USAGE_GUARD_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(4765)
}

// Minimal HTTP/1.0 client for the loopback API; HTTP/1.0 keeps the reply unchunked.
fn request(method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let address = ("127.0.0.1", port());
    let mut stream = TcpStream::connect(address)
        .map_err(|_| format!("Usage Guard API is not running on port {}. Start it with `usage-guard serve`.", address.1))?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
    let body = body.unwrap_or("");
    let head = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body.as_bytes())).map_err(|e| e.to_string())?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).map_err(|e| e.to_string())?;
    let (status_line, rest) = reply.split_once("\r\n").ok_or("Malformed reply")?;
    let payload = rest.split_once("\r\n\r\n").map(|(_, payload)| payload).unwrap_or("").to_string();
    if !status_line.contains(" 200 ") {
        return Err(format!("Usage Guard API: {status_line} {payload}"));
    }
    Ok(payload)
}

#[tauri::command]
fn guard_status() -> Result<String, String> {
    request("GET", "/api/status", None)
}

#[tauri::command]
fn guard_route(kind: String) -> Result<String, String> {
    if !["code", "review", "plan", "bulk"].contains(&kind.as_str()) {
        return Err("Unknown route kind".into());
    }
    request("GET", &format!("/api/route?kind={kind}"), None)
}

#[tauri::command]
fn guard_models(refresh: bool) -> Result<String, String> {
    request("GET", if refresh { "/api/models?refresh=1" } else { "/api/models" }, None)
}

// Only the settings the panel edits may be changed from here.
#[tauri::command]
fn set_config(patch: serde_json::Map<String, serde_json::Value>) -> Result<String, String> {
    const ALLOWED: [&str; 4] = ["routingPaused", "hermesModel", "payAsYouGoDailyCapUsd", "planPreset"];
    if patch.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("That setting cannot be changed from the tray".into());
    }
    request("PATCH", "/api/config", Some(&serde_json::Value::Object(patch).to_string()))
}

// Runs `usage-guard enable|disable` with the runtime recorded at install, so the
// Linux monitor timer starts and stops with the switch.
fn run_switch(enabled: bool) -> Result<String, String> {
    let home = std::env::var("USAGE_GUARD_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        let base = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
        std::path::Path::new(&base).join(".usage-guard")
    });
    let record: serde_json::Value = std::fs::read_to_string(home.join("install-record.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or("Usage Guard is not installed. Run `usage-guard install` first.")?;
    let command = record["runtime"]["command"].as_str().ok_or("Install record has no runtime")?;
    let prefix: Vec<String> = record["runtime"]["argsPrefix"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let output = std::process::Command::new(command)
        .args(prefix)
        .arg(if enabled { "enable" } else { "disable" })
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn set_enabled(enabled: bool) -> Result<String, String> {
    run_switch(enabled)
}

fn toggle_enabled(app: &AppHandle) {
    let enabled = request("GET", "/api/status", None)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .map(|status| status["config"]["enabled"].as_bool() != Some(false))
        .unwrap_or(true);
    let _ = run_switch(!enabled);
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.eval("refresh()");
    }
}

#[tauri::command]
fn set_tray_label(app: AppHandle, label: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(label.as_str()));
        let _ = tray.set_tooltip(Some(format!("Usage Guard: {label}")));
    }
}

// Opens the Codex usage page so the user can choose to spend a banked reset there.
#[tauri::command]
fn open_codex_usage() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(CODEX_USAGE_URL);
        command
    };
    #[cfg(not(target_os = "windows"))]
    command.arg(CODEX_USAGE_URL);
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn show_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("panel") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_panel(app);
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![guard_status, guard_route, guard_models, set_config, set_enabled, set_tray_label, open_codex_usage])
        .setup(|app| {
            let switch = MenuItem::with_id(app, "switch", "Turn Usage Guard on/off", true, None::<&str>)?;
            let details = MenuItem::with_id(app, "details", "Show details", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&switch, &details, &quit])?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Usage Guard")
                .title("UG …")
                .menu(&menu)
                // Linux tray icons only offer a menu, so the menu opens on left click there.
                .show_menu_on_left_click(cfg!(target_os = "linux"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "switch" => toggle_enabled(app),
                    "details" => show_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_panel(tray.app_handle());
                    }
                });
            // Light variant of the mark: tray bars are dark on Linux and Windows by default.
            tray = tray.icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-light.png"))?);
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Usage Guard tray");
}
