//! The Files panel's tree: open a project, expand and collapse, select and
//! reveal, refresh, save, and the `@` picker's file list. The tree is
//! [`crate::explorer::service`] and the open/save/watcher are
//! [`crate::explorer::ops`]; the window calls the same ones. One tree per
//! engine, so every front end shows the same expanded folders.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::explorer::{file_list, ops};

pub const COMMANDS: &[&str] = &[
    "explorer_open_workspace",
    "explorer_list_files",
    "explorer_refresh",
    "explorer_apply_fs_changes",
    "explorer_toggle_folder",
    "explorer_expand_folder",
    "explorer_select_file",
    "explorer_reveal_file",
    "explorer_collapse_all",
    "explorer_save_state",
    "explorer_get_state",
    "explorer_clear_workspace",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    let state = &ctx.explorer;
    Some(match name {
        "explorer_open_workspace" => {
            let path: String = get!("path");
            let show_hidden: Option<bool> = get!("showHidden");
            done(ops::open_workspace(state, ctx.db.clone(), ctx.events.clone(), path, show_hidden).await)
        }
        "explorer_list_files" => done(file_list::explorer_list_files(get!("root")).await),
        "explorer_refresh" => done(state.lock_manager().refresh()),
        "explorer_apply_fs_changes" => {
            let paths: Vec<String> = get!("paths");
            let kind: Option<String> = get!("kind");
            done(state.lock_manager().apply_fs_changes(&paths, kind.as_deref()))
        }
        "explorer_toggle_folder" => {
            let folder_id: String = get!("folderId");
            done(state.lock_manager().toggle_folder(&folder_id))
        }
        "explorer_expand_folder" => {
            let folder_id: String = get!("folderId");
            done(state.lock_manager().expand_folder(&folder_id))
        }
        "explorer_select_file" => {
            let file_id: Option<String> = get!("fileId");
            done(state.lock_manager().select_file(file_id))
        }
        "explorer_reveal_file" => {
            let file_path: String = get!("filePath");
            done(state.lock_manager().reveal_file(&file_path))
        }
        "explorer_collapse_all" => done(state.lock_manager().collapse_all()),
        "explorer_save_state" => done(ops::save_state(state, ctx.db.clone()).await),
        "explorer_get_state" => done(Ok(state.lock_manager().get_snapshot())),
        "explorer_clear_workspace" => {
            ops::clear_workspace(state);
            done(Ok(()))
        }
        _ => return None,
    })
}
