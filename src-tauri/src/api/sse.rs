//! Phase 2.2 placeholder.
//!
//! SSE parsing for Aurora's streaming providers lives in
//! [`super::provider_kernel_adapter`] — a Phase-2.2 re-implementation of
//! the byte-level frame splitter from
//! `commands::provider_kernel::streaming` that we cannot re-use directly
//! (those types and the splitter are `pub(crate)` to a private
//! `mod types;` / `mod streaming;`). The Phase-5 plan is to retire
//! `commands::provider_kernel` and fold the consolidated SSE plumbing
//! into this file. Until then this module stays empty so the API
//! surface stays grep-able for the Phase-5 cutover.
