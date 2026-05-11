//! Production [`PermissionEmitter`] backed by Tauri's per-app
//! [`AppHandle::emit`].
//!
//! Compiled out of the verify crate via the `verify_only` feature so
//! the standalone test rig stays Tauri-free.

#![cfg(not(feature = "verify_only"))]

use tauri::{AppHandle, Emitter};

use crate::tools::permissions::prompter::{
    PermissionEmitter, PermissionRequestPayload, PERMISSION_REQUEST_EVENT,
};

/// Emits `"agent_permission_request"` events on the main Tauri
/// `AppHandle`. The matching frontend listener is set up in
/// `src/services/agent-runtime-client.ts`.
pub struct TauriPermissionEmitter {
    pub app: AppHandle,
}

impl TauriPermissionEmitter {
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl PermissionEmitter for TauriPermissionEmitter {
    fn emit_permission_request(&self, payload: &PermissionRequestPayload) {
        // Best-effort emit. If the WebView is gone (shutdown / window
        // closed), the frontend can't approve anyway and the request
        // will eventually be cancelled by the conversation runtime.
        if let Err(err) = self.app.emit(PERMISSION_REQUEST_EVENT, payload) {
            eprintln!(
                "[TauriPermissionEmitter] failed to emit {PERMISSION_REQUEST_EVENT}: {err}"
            );
        }
    }
}
