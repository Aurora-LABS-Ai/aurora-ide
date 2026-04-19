# Aurora Icon Packs

Aurora now supports:

- shipped built-in explorer icon packs
- user-imported `.aurora` icon-pack bundles
- a Rust builder CLI for packaging icon assets into `.aurora`

## Shipped Packs

Aurora currently ships with:

- `Material`
- `VS Code Icons`

Both are self-hosted and selectable from Appearance > Icon Packs.

## Bundle Format

A distributable Aurora icon pack is a single `.aurora` file containing:

- `format: "aurora-pack"`
- `schemaVersion: 1`
- `packageType: "icon-pack"`
- `manifest`
- `icons`
- `mappings`

Example bundle shape:

```json
{
  "format": "aurora-pack",
  "schemaVersion": 1,
  "packageType": "icon-pack",
  "manifest": {
    "id": "my-pack",
    "name": "My Pack",
    "version": "1.0.0",
    "author": "You",
    "description": "Custom Aurora icon pack."
  },
  "icons": {
    "defaultFile": "data:image/svg+xml;base64,...",
    "defaultFolder": "data:image/svg+xml;base64,..."
  },
  "mappings": {
    "defaultFile": "defaultFile",
    "defaultFolder": "defaultFolder"
  }
}
```

Aurora imports these by drag-drop or file import in the Appearance panel.

## Authoring Source Manifest

You do not need to hand-write the final bundled `data:` URIs yourself.

Author a source JSON manifest with the same top-level structure, but let the `icons` values point to local asset files relative to the manifest directory:

```json
{
  "format": "aurora-pack",
  "schemaVersion": 1,
  "packageType": "icon-pack",
  "manifest": {
    "id": "starter-pack",
    "name": "Starter Pack",
    "version": "1.0.0",
    "author": "Aurora",
    "description": "Starter icon pack."
  },
  "icons": {
    "defaultFile": "icons/default-file.svg",
    "defaultFolder": "icons/default-folder.svg",
    "defaultFolderExpanded": "icons/default-folder-open.svg",
    "typescript": "icons/typescript.svg",
    "packageJson": "icons/package-json.svg"
  },
  "mappings": {
    "defaultFile": "defaultFile",
    "defaultFolder": "defaultFolder",
    "defaultFolderExpanded": "defaultFolderExpanded",
    "fileExtensions": {
      "ts": "typescript",
      "tsx": "typescript"
    },
    "fileNames": {
      "package.json": "packageJson"
    }
  }
}
```

Supported asset formats for source icons:

- `.svg`
- `.png`
- `.jpg`
- `.jpeg`
- `.webp`
- `.gif`

## Builder CLI

Aurora includes icon-pack building in the main `aurora` CLI.

If the Aurora CLI is installed on your machine, the direct user-facing command is:

```bash
aurora icon-pack build --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack.aurora
```

You can run it through the workspace helper script:

```bash
pnpm icon-pack:build -- --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack.aurora
```

The helper script intentionally accepts either form below and forwards the args correctly:

```bash
pnpm icon-pack:build -- --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack.aurora
pnpm icon-pack:build --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack.aurora
```

Direct Cargo usage:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin aurora -- icon-pack build --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack.aurora
```

Optional flags:

- `--assets-root <path>` to override the asset base directory
- `--force` to overwrite an existing output file

## Starter Example

A runnable starter source pack lives here:

- [manifest.json](E:\VOID-EDITOR\Aurora-Agent-IDE\examples\icon-packs\starter\manifest.json)
- [icons](E:\VOID-EDITOR\Aurora-Agent-IDE\examples\icon-packs\starter\icons)

Build it with:

```bash
pnpm icon-pack:build -- --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack.aurora
```

Then import the generated `.aurora` file into Aurora from the Appearance > Icon Packs panel.
