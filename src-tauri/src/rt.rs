//! Where core code starts background work.
//!
//! The desktop app runs everything on Tauri's tokio runtime, so a task
//! started from a sync command (no runtime on that thread) still lands
//! there. Without the window there is no Tauri runtime: a task goes to the
//! caller's runtime when there is one, otherwise to a process-wide runtime
//! started on first use.
//!
//! Core modules call these instead of `tauri::async_runtime`, so they
//! compile without the `desktop` feature.

use std::future::Future;

/// Start `future` in the background. The task outlives the caller.
pub fn spawn<F>(future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    #[cfg(feature = "desktop")]
    {
        tauri::async_runtime::spawn(future);
    }
    #[cfg(not(feature = "desktop"))]
    {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(future);
            }
            Err(_) => {
                fallback::runtime().spawn(future);
            }
        }
    }
}

#[cfg(not(feature = "desktop"))]
mod fallback {
    use std::sync::OnceLock;
    use tokio::runtime::Runtime;

    static RUNTIME: OnceLock<Runtime> = OnceLock::new();

    pub fn runtime() -> &'static Runtime {
        RUNTIME.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("aurora-rt")
                .build()
                .expect("start the background tokio runtime")
        })
    }
}
