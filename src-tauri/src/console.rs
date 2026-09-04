//! Borrowing the terminal back, so a windowless binary can still be a CLI.
//!
//! ## The bug this exists for
//!
//! Aurora ships as one executable that is both a desktop application and a
//! command-line tool. As an application it must not flash up a black console
//! window when someone double-clicks it, so release builds are compiled for the
//! Windows GUI subsystem (`windows_subsystem = "windows"` in `main.rs`).
//!
//! A GUI-subsystem process starts with **no console at all**. Windows does not
//! attach it to the terminal that launched it, and `GetStdHandle` returns null.
//! Every `println!` then writes to nothing and reports success.
//!
//! The result was a CLI that worked perfectly in development and was completely
//! silent once installed:
//!
//! ```text
//! PS> aurora --help
//! PS>
//! ```
//!
//! No error, no output, nothing to search for. Debug builds are console-
//! subsystem, so it could not be reproduced anywhere except a real install.
//!
//! ## The fix, and why not the obvious ones
//!
//! `AttachConsole(ATTACH_PARENT_PROCESS)` adopts the console of whatever
//! launched this process. Standard handles that were never set are initialised
//! to it, and from that point `println!` reaches the terminal the user is
//! looking at.
//!
//! Two alternatives were rejected:
//!
//! - **Turning on the `cli-mode` feature**, which drops the GUI subsystem.
//!   That fixes the CLI and breaks the application: every normal launch pops a
//!   console window behind Aurora.
//! - **Shipping a second console-subsystem binary**, the way VS Code does with
//!   `code.cmd`. A second binary in this crate links the same tree — Tauri,
//!   candle, ONNX Runtime — so it would roughly double an installer that is
//!   already large, to gain what one API call does.
//!
//! ## Redirection is left alone
//!
//! When the caller has already redirected stdout — a pipe, a file, `aurora mcp`
//! spawned by another agent — the handle is valid before this runs, and
//! attaching would be at best pointless and at worst a way to lose the pipe.
//! So an existing handle is detected and nothing is touched. This is not a
//! nicety: `aurora mcp` speaking JSON-RPC over a pipe is the case where writing
//! to the wrong place breaks the protocol outright.

/// Attach this process to the terminal that launched it, when there is one.
///
/// Safe to call unconditionally and safe to call when it does not apply. It
/// does nothing at all when:
///
/// - stdout is already a pipe or a file (the caller redirected it),
/// - there is no parent console (launched from Explorer, the Start menu, or a
///   desktop shortcut),
/// - the build is not for Windows.
///
/// It never *allocates* a console, only borrows an existing one. A launch with
/// no terminal behind it stays exactly as silent and as windowless as before.
#[cfg(windows)]
pub fn attach_to_parent_terminal() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE,
    };

    // SAFETY: both calls are plain Win32 reads/attaches with no pointer
    // arguments. `GetStdHandle` cannot fail destructively — it reports null or
    // `INVALID_HANDLE_VALUE` for "not set" — and `AttachConsole` returns 0 when
    // there is no parent console, which is the ordinary case for a
    // double-clicked launch and is deliberately ignored.
    unsafe {
        let existing = GetStdHandle(STD_OUTPUT_HANDLE);
        if !existing.is_null() && existing != INVALID_HANDLE_VALUE {
            // Already redirected by the caller. Attaching now could replace a
            // pipe another program is reading, which for `aurora mcp` would
            // mean writing the protocol into a console nobody is parsing.
            return;
        }
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

/// No-op away from Windows, where a binary is not split by subsystem and stdio
/// is whatever the launching shell handed over.
#[cfg(not(windows))]
pub fn attach_to_parent_terminal() {}
