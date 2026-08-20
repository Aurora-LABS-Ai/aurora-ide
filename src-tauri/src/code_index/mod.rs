//! Structural code index — where things are defined, and who uses them.
//!
//! Aurora's read tools are all **positional**: `file_read` needs a path and a
//! line, `grep` needs a string, `glob` needs a name. None of them can address a
//! *symbol*, so answering "who calls this" meant grepping, getting every
//! comment and string literal that happened to contain the word, and opening
//! files to find out which hits were real. Measured on a live repo: grep
//! returned 20+ matches for `dump_tree`, of which 2 were actual call sites.
//!
//! This module parses the workspace with tree-sitter and records three facts —
//! every definition, every usage, and which function each usage sits inside —
//! so those questions get one answer instead of a pile of text.
//!
//! ## What it is not
//!
//! It reads **syntax, not types**. There is no type checking here and no
//! attempt at one; that is `read_lints`' job. Resolution is by NAME, and where
//! a name is ambiguous the index says so rather than guessing (see
//! [`store::ResolutionStats`]). The upside of the syntax-only choice is that it
//! needs no toolchain installed, costs well under a second for a whole
//! workspace, and keeps working on a file the agent has half-rewritten — none
//! of which a language server can offer.
//!
//! ## Layout
//!
//! | module | responsibility |
//! |---|---|
//! | [`lang`] | grammar + query registry; adding a language is one arm here |
//! | [`extract`] | one file's source -> its definitions and references |
//! | [`walk`] | which files count (gitignore, build dirs, generated output) |
//! | [`store`] | the in-memory index and the questions it answers |
//! | [`persist`] | compact cached form on disk |
//! | [`module_graph`] | which parts of the workspace depend on which |
//! | [`repo_map`] | renders the `<repo_map>` block given to the model |
//! | [`service`] | one index per workspace, cached per process |

pub mod extract;
pub mod lang;
pub mod module_graph;
pub mod persist;
pub mod repo_map;
pub mod service;
pub mod store;
pub mod walk;

// Only what callers outside this module actually reach for. `CodeIndex` and
// `CodeIndexService` are addressed through their own modules
// (`code_index::store::CodeIndex`), so re-exporting them here would be a second
// name for one type and the compiler correctly calls it unused.
pub use lang::Lang;
pub use service::{service, IndexProbe, IndexStatus};
