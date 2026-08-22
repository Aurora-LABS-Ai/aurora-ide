//! Generated Rust bindings for Cursor's `agent.v1` protobuf schema.
//!
//! The schema under `proto/` is vendored from [can1357/oh-my-pi][omp] (MIT),
//! which extracted it from Cursor's own service descriptor. Field numbers
//! there are authoritative — they are what is on the wire, and editing one to
//! "clean it up" silently corrupts every request.
//!
//! This crate is generated code and nothing else. The transport (Connect-RPC
//! framing, HTTP/2, the turn state machine) lives in `aurora`'s
//! `api::cursor` module; keeping the two apart is what lets 7.6k lines of
//! generated types compile once and stay cached.
//!
//! [omp]: https://github.com/can1357/oh-my-pi
//!
//! # Attribution
//!
//! `proto/agent.proto` and `proto/value.proto`: Copyright (c) Mario Zechner,
//! Can Bölük, Stencil Labs Inc. Licensed MIT.

#![allow(clippy::all)]
#![allow(rustdoc::all)]

/// Cursor's `agent.v1` package — the agent service messages.
pub mod agent {
    include!(concat!(env!("OUT_DIR"), "/agent.v1.rs"));
}

/// `google.protobuf.Value` stand-in. `McpArgs.args` is a
/// `map<string, bytes>` whose values are each a serialized `Value`, so tool
/// arguments need this envelope to decode into real JSON.
pub mod shim {
    include!(concat!(env!("OUT_DIR"), "/shim.rs"));
}

pub use prost::Message;
