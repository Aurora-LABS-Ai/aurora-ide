# Lessons

- When a setting is scoped to a workspace, do not let an early app-open save path write default store values before that workspace-specific setting has been loaded from persistence.
- For expensive safety work like checkpoints, move the wait to the last safe execution boundary instead of blocking the initial request send path.
- Do not run `cargo check` for frontend-only edits; reserve Rust verification for turns that actually modify Rust files.
- In this repo, treat any reproducible existing validation failure in touched workflows as part of the active bug surface; fix it instead of dismissing it as merely pre-existing.
- Do not change this app's visual design unless the user explicitly asks for design work; preserve the existing UI language when fixing bugs.
- Verify the actual alpha/transparency of user-provided image assets before styling around them; do not assume an image is transparent just because it is intended to be.
- Do not conflate the application icon with empty-state or onboarding artwork; keep brand/app icon and empty-surface assets mapped to their explicitly assigned files.
