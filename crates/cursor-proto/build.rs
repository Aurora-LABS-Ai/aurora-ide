//! Compile Cursor's `agent.v1` schema into `$OUT_DIR/agent.v1.rs`.
//!
//! Deliberately fails the build on error rather than warning and carrying on:
//! unlike an optional runtime asset, generated bindings are load-bearing —
//! without them the crate does not compile, and a warning would just bury the
//! real cause under hundreds of "cannot find type" errors.

use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let proto_dir = manifest_dir.join("proto");
    println!("cargo:rerun-if-changed={}", proto_dir.display());

    let files = [proto_dir.join("agent.proto"), proto_dir.join("value.proto")];
    for file in &files {
        assert!(file.is_file(), "missing proto file: {}", file.display());
    }

    let descriptors =
        protox::compile(&files, [&proto_dir]).expect("failed to compile Cursor .proto files");

    let mut config = prost_build::Config::new();
    // BTreeMap for `map<…>` fields so serialized output is deterministic —
    // the blob channel keys history by content hash, and a map that iterates
    // in random order would hash differently on every run.
    config.btree_map(["."]);
    config
        .compile_fds(descriptors)
        .expect("failed to generate Cursor proto bindings");
}
