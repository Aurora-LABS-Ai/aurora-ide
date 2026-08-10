//! # code-index — structural code index probe
//!
//! A standalone probe for Aurora: parse a workspace with tree-sitter and answer
//! the questions `grep` structurally cannot —
//!
//!   * where is `X` **defined** (one answer, not every mention of the string)
//!   * **who calls** `X`, and from inside which function
//!   * what is **unreferenced**
//!
//! It is deliberately its own crate, outside `src-tauri`'s package, so it can be
//! measured and thrown away without touching the app build. If it earns its
//! keep, `lang`/`extract`/`index`/`walk` move to `src-tauri/src/code_index/`
//! roughly as-is and the CLI in `main.rs` is replaced by agent tools.
//!
//! **What this is not:** a type checker. tree-sitter sees syntax, so resolution
//! is name-based and reports its own ambiguity (`ResolutionStats`). Type truth
//! is the LSP layer's job — see `DOCS/agent-window-lsp-plan.md`.

pub mod extract;
pub mod index;
pub mod lang;
pub mod walk;

pub use index::CodeIndex;
