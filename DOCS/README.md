# Documentation Index

Aurora technical documentation for the current Rust-provider-kernel architecture.

**Last updated:** 2026-03-30
**Last validated:** 2026-03-30  
**Current branch baseline:** `codex/aurora-provider-kernel`

**Last validation result:** ✅ Fully in sync — no mismatches found, no changes made

## Files

- [01-ARCHITECTURE.md](./01-ARCHITECTURE.md)  
  Current system overview, module map, provider kernel placement, runtime flow.

- [02-CODE-STYLE-PATTERNS.md](./02-CODE-STYLE-PATTERNS.md)  
  Implementation patterns for modular files, Tauri boundaries, stores, and provider work.

- [03-EXPANSION-GUIDE.md](./03-EXPANSION-GUIDE.md)  
  How to add features, Tauri command domains, tools, and new providers in the Rust-first architecture.

- [04-PROVIDER-KERNEL.md](./04-PROVIDER-KERNEL.md)  
  Current provider-kernel design and implementation status.

- [GETTING-STARTED.md](./GETTING-STARTED.md)  
  Setup, run, local model notes, and first-provider guidance.

## Current Reality Check

These docs are aligned to the current implementation where:

- provider execution is Rust-owned
- provider presets are loaded from Rust catalog data
- local provider detection is Rust-owned
- frontend provider code is a thin bridge

## Verification Reference

At the time of this doc refresh:

- `pnpm test` passes
- `pnpm build` passes

