//! Files and folders: listing, reading, writing, creating, renaming, copying,
//! deleting, searching, and the watcher that reports changes on disk. The
//! work is in [`crate::workspace`]; the window's commands in
//! `commands/mod.rs` call the same functions.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::workspace::{self, RipgrepSearchRequest};

pub const COMMANDS: &[&str] = &[
    "read_directory",
    "read_file_content",
    "read_file_with_meta",
    "stat_file_mtime",
    "write_file_content",
    "create_file",
    "create_folder",
    "delete_path",
    "rename_path",
    "copy_path",
    "list_filesystem_roots",
    "ripgrep_search",
    "invalidate_file_cache",
    "start_fs_watcher",
    "stop_fs_watcher",
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
    Some(match name {
        "read_directory" => {
            let path: String = get!("path");
            let include_hidden: Option<bool> = get!("includeHidden");
            done(workspace::fs::read_directory(path, include_hidden).await)
        }
        "read_file_content" => done(workspace::fs::read_file_content(get!("path")).await),
        "read_file_with_meta" => done(workspace::fs::read_file_with_meta(get!("path")).await),
        "stat_file_mtime" => done(workspace::fs::stat_file_mtime(get!("path")).await),
        "write_file_content" => {
            let path: String = get!("path");
            let content: String = get!("content");
            done(workspace::fs::write_file_content(path, content).await)
        }
        "create_file" => done(workspace::fs::create_file(get!("path")).await),
        "create_folder" => done(workspace::fs::create_folder(get!("path")).await),
        "delete_path" => done(workspace::fs::delete_path(get!("path")).await),
        "rename_path" => {
            let old_path: String = get!("oldPath");
            let new_path: String = get!("newPath");
            done(workspace::fs::rename_path(old_path, new_path).await)
        }
        "copy_path" => {
            let source: String = get!("source");
            let destination: String = get!("destination");
            done(workspace::fs::copy_path(source, destination).await)
        }
        "list_filesystem_roots" => done(Ok(workspace::fs::filesystem_roots())),
        "ripgrep_search" => {
            let request: RipgrepSearchRequest = get!("request");
            done(workspace::ripgrep_search(request).await)
        }
        "invalidate_file_cache" => {
            let path: String = get!("path");
            let is_prefix: bool = get!("isPrefix");
            workspace::fs::invalidate_file_cache(&path, is_prefix);
            done(Ok(()))
        }
        "start_fs_watcher" => {
            done(workspace::watch::start_fs_watcher(ctx.events.clone(), get!("path")).await)
        }
        "stop_fs_watcher" => done(workspace::watch::stop_fs_watcher().await),
        _ => return None,
    })
}
