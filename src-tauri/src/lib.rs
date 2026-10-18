//! bWalletX Desktop: the bWalletX web UI (build-desktop/, wide layout) in a Tauri window, plus the few native
//! pieces a desktop wallet needs. The wallet itself (keys, signing, BRC-100) runs in the webview exactly as on the
//! phones; nothing here can decrypt the keystore.
//!
//! - store_*:  storage.local in an owner-only file, atomic writes (store.rs).
//! - bio_*:    Touch ID unlock, sealed values in the Keychain (bio.rs, keychain.rs).
//! - open_external: http(s)/mailto links to the default browser; nothing else leaves the app.
//! - Tray: Show / Lock / Quit; closing the window hides it to the tray.
//! - bwalletx:// deep links (deep-link + single-instance), native notifications.
//! - Updater: registered only when tauri.conf has a real `plugins.updater` (pubkey + endpoint).
//!
//! No localhost BRC-100 server yet: that is a later phase with its own security review.

mod bio;
#[cfg(target_os = "macos")]
mod keychain;
mod store;

use std::collections::BTreeMap;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const MAIN: &str = "main";

#[tauri::command]
fn store_load(store: State<'_, store::Store>) -> BTreeMap<String, String> {
    store.load()
}

#[tauri::command]
fn store_apply(
    store: State<'_, store::Store>,
    sets: BTreeMap<String, String>,
    removes: Vec<String>,
) -> Result<(), String> {
    store.apply(sets, removes)
}

#[tauri::command]
fn bio_status() -> bio::Status {
    bio::status()
}

#[tauri::command]
async fn bio_set(key: String, value: String) -> Result<(), String> {
    blocking(move || bio::set(&key, &value)).await
}

#[tauri::command]
async fn bio_get(key: String, reason: String) -> Result<Option<String>, String> {
    blocking(move || bio::get(&key, &reason)).await
}

#[tauri::command]
async fn bio_remove(key: String) -> Result<(), String> {
    blocking(move || bio::remove(&key)).await
}

/// Opens a web or mail link in the default app. Any other scheme (file:, custom handlers) is refused.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err(format!("refusing to open a {} link", parsed.scheme()));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn updater_configured(app: &tauri::App) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty() && !k.contains("REPLACE"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First: a second launch (or a bwalletx:// link while running) focuses this one; deep-link forwards the URL.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(store::Store::open(&dir).map_err(|e| format!("storage: {e}"))?);

            #[cfg(desktop)]
            if updater_configured(app) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            // bwalletx:// links: forwarded to the UI as one event (desktop/boot.ts routes them). Launch links are
            // held by the plugin and read with get_current once the UI is listening.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    #[cfg(debug_assertions)]
                    eprintln!("[deep-link] {urls:?}");
                    show_main(&handle);
                    let _ = handle.emit_to(MAIN, "app-url", urls);
                });
            }

            // Linux / Windows dev runs register the scheme at runtime; macOS takes it from the bundle's Info.plist.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            let show = MenuItem::with_id(app, "show", "Show bWalletX", true, None::<&str>)?;
            let lock = MenuItem::with_id(app, "lock", "Lock wallet", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit bWalletX", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &lock, &quit])?;
            // Debug builds only: a way to check native notifications without waiting for a real event.
            #[cfg(debug_assertions)]
            menu.insert(
                &MenuItem::with_id(
                    app,
                    "test-notify",
                    "Test notification (debug)",
                    true,
                    None::<&str>,
                )?,
                2,
            )?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("bWalletX")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "lock" => {
                        let _ = app.emit_to(MAIN, "tray-lock", ());
                    }
                    "quit" => app.exit(0),
                    #[cfg(debug_assertions)]
                    "test-notify" => {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("bWalletX")
                            .body("Notifications are working on bWalletX Desktop.")
                            .show();
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close hides to the tray; Quit (tray or ⌘Q) ends the app.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            store_load,
            store_apply,
            bio_status,
            bio_set,
            bio_get,
            bio_remove,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("error while building bWalletX Desktop");

    app.run(|app, event| {
        // macOS: clicking the Dock icon while the window is hidden brings it back.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        let _ = (app, event);
    });
}
