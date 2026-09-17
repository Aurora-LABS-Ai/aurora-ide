//! Files dropped from Explorer reach the agent as WebviewEvent::DragDrop.
//! Tauri 2.9 grants its asset scope there, but plugin-fs 2.4 grants its separate
//! read scope only for WindowEvent::DragDrop. Bridge that missing native event
//! so the composer can read the exact paths the user dropped.

use std::path::PathBuf;

use tauri::{DragDropEvent, Runtime, Webview, WebviewEvent};
use tauri_plugin_fs::FsExt;

fn dropped_paths<'a>(label: &str, event: &'a WebviewEvent) -> Option<&'a [PathBuf]> {
    if label != "agent-window" {
        return None;
    }
    match event {
        WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => Some(paths),
        _ => None,
    }
}

pub fn on_webview_event<R: Runtime>(webview: &Webview<R>, event: &WebviewEvent) {
    let Some(paths) = dropped_paths(webview.label(), event) else {
        return;
    };
    let scope = webview.fs_scope();
    for path in paths {
        // An exact grant also lets plugin-fs stat a dropped directory so the
        // composer can turn it into a folder mention. Its children are not needed.
        if let Err(error) = scope.allow_file(path) {
            crate::logging::log_error(
                "composer.drop",
                &format!(
                    "cannot grant access to dropped path {}: {error}",
                    path.display()
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drop_event() -> WebviewEvent {
        WebviewEvent::DragDrop(DragDropEvent::Drop {
            paths: vec![PathBuf::from(
                r"E:\PHONE-FINAL-FARM\screenshot\_labeled.png",
            )],
            position: tauri::PhysicalPosition::new(100.0, 200.0),
        })
    }

    #[test]
    fn agent_webview_drop_selects_the_exact_external_path() {
        let event = drop_event();
        assert_eq!(
            dropped_paths("agent-window", &event).unwrap(),
            &[PathBuf::from(
                r"E:\PHONE-FINAL-FARM\screenshot\_labeled.png"
            )]
        );
    }

    #[test]
    fn a_browser_or_signin_webview_cannot_grant_composer_access() {
        for label in ["browser-1", "kenari-signin", "main"] {
            assert!(dropped_paths(label, &drop_event()).is_none());
        }
    }

    #[test]
    fn hovering_a_file_does_not_grant_access() {
        let event = WebviewEvent::DragDrop(DragDropEvent::Enter {
            paths: vec![PathBuf::from(r"E:\private.png")],
            position: tauri::PhysicalPosition::new(100.0, 200.0),
        });
        assert!(dropped_paths("agent-window", &event).is_none());
    }
}
