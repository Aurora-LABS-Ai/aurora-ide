/**
 * Agent Window — which shell a Terminal tab runs.
 *
 * Everything else about starting a shell lives in Rust now
 * (`commands::terminal_pty`): resolving the executable from the verified
 * registry, its interactive arguments, the MSYS `PATH` overlay, `TERM` for
 * POSIX shells, and Aurora's PowerShell prompt (installed only over the stock
 * one). This file used to build all of that and hand it to `tauri-pty`.
 */

/**
 * Which shell a terminal session runs.
 *
 * These are the registry's own kind ids (`src-tauri/src/shell/kinds.rs`), so
 * anything Settings → Tools › Shells lists can be opened here. It used to be
 * `"powershell" | "bash"` — two literals — which is why the terminal could only
 * ever open Windows PowerShell 5.1 or Git Bash, however many shells the scan
 * had found.
 */
export type ShellProfile = "pwsh" | "powershell" | "bash" | "zsh" | "sh" | "cmd";
