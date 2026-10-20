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
fn set_paused(paused: bool) -> Result<String, String> {
    request("PATCH", "/api/config", Some(&serde_json::json!({ "routingPaused": paused }).to_string()))
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
        .invoke_handler(tauri::generate_handler![guard_status, guard_route, set_paused, set_tray_label, open_codex_usage])
        .setup(|app| {
            let details = MenuItem::with_id(app, "details", "Show details", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&details, &quit])?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Usage Guard")
                .title("UG …")
                .menu(&menu)
                // Linux tray icons only offer a menu, so the menu opens on left click there.
                .show_menu_on_left_click(cfg!(target_os = "linux"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "details" => show_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_panel(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
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
