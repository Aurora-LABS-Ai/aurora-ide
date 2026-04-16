# Lessons

- When a setting is scoped to a workspace, do not let an early app-open save path write default store values before that workspace-specific setting has been loaded from persistence.
- For expensive safety work like checkpoints, move the wait to the last safe execution boundary instead of blocking the initial request send path.
- Do not run `cargo check` for frontend-only edits; reserve Rust verification for turns that actually modify Rust files.
