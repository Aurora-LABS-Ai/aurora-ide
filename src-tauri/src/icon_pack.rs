use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Subcommand)]
pub enum IconPackCommand {
    /// Build a distributable .aurora icon-pack bundle.
    Build(IconPackBuildArgs),
}

#[derive(Args, Debug, Clone)]
pub struct IconPackBuildArgs {
    /// Path to the source manifest JSON file.
    #[arg(long)]
    pub manifest: PathBuf,

    /// Output .aurora bundle path.
    #[arg(long)]
    pub output: PathBuf,

    /// Optional root directory for icon asset paths. Defaults to the manifest directory.
    #[arg(long)]
    pub assets_root: Option<PathBuf>,

    /// Overwrite the output file if it already exists.
    #[arg(long, default_value_t = false)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceAuroraIconPack {
    format: String,
    schema_version: u8,
    package_type: String,
    manifest: SourcePackManifest,
    icons: BTreeMap<String, String>,
    mappings: AuroraIconPackMappings,
}

#[derive(Debug, Deserialize, Serialize)]
struct SourcePackManifest {
    id: String,
    name: String,
    version: String,
    author: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraIconPackMappings {
    default_file: Option<String>,
    default_folder: Option<String>,
    default_folder_expanded: Option<String>,
    file_extensions: Option<BTreeMap<String, String>>,
    file_names: Option<BTreeMap<String, String>>,
    folder_names: Option<BTreeMap<String, String>>,
    folder_names_expanded: Option<BTreeMap<String, String>>,
    language_ids: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputAuroraIconPack {
    format: &'static str,
    schema_version: u8,
    package_type: &'static str,
    manifest: SourcePackManifest,
    icons: BTreeMap<String, String>,
    mappings: AuroraIconPackMappings,
}

pub fn execute_cli_command(command: &IconPackCommand) -> Result<()> {
    match command {
        IconPackCommand::Build(args) => build_pack(args),
    }
}

fn build_pack(args: &IconPackBuildArgs) -> Result<()> {
    if args.output.exists() && !args.force {
        bail!(
            "Output file already exists: {}. Pass --force to overwrite it.",
            args.output.display()
        );
    }

    let manifest_path = fs::canonicalize(&args.manifest).with_context(|| {
        format!(
            "Failed to resolve source manifest path: {}",
            args.manifest.display()
        )
    })?;

    let assets_root = match &args.assets_root {
        Some(path) => fs::canonicalize(path).with_context(|| {
            format!("Failed to resolve assets root directory: {}", path.display())
        })?,
        None => manifest_path
            .parent()
            .map(Path::to_path_buf)
            .context("Manifest path does not have a parent directory.")?,
    };

    let manifest_content = fs::read_to_string(&manifest_path).with_context(|| {
        format!("Failed to read source manifest: {}", manifest_path.display())
    })?;

    let source_pack: SourceAuroraIconPack = serde_json::from_str(&manifest_content)
        .with_context(|| format!("Manifest is not valid JSON: {}", manifest_path.display()))?;

    validate_source_pack(&source_pack)?;

    let bundled_icons = source_pack
        .icons
        .iter()
        .map(|(icon_name, source)| {
            build_icon_payload(source, &assets_root).map(|payload| (icon_name.clone(), payload))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;

    let output_pack = OutputAuroraIconPack {
        format: "aurora-pack",
        schema_version: 1,
        package_type: "icon-pack",
        manifest: source_pack.manifest,
        icons: bundled_icons,
        mappings: source_pack.mappings,
    };

    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("Failed to create output directory: {}", parent.display())
        })?;
    }

    let serialized = serde_json::to_string_pretty(&output_pack)
        .context("Failed to serialize .aurora output bundle.")?;
    fs::write(&args.output, serialized)
        .with_context(|| format!("Failed to write output file: {}", args.output.display()))?;

    println!(
        "Built Aurora icon pack '{}' -> {} ({} icons)",
        output_pack.manifest.name,
        args.output.display(),
        output_pack.icons.len()
    );

    Ok(())
}

fn validate_source_pack(pack: &SourceAuroraIconPack) -> Result<()> {
    if pack.format != "aurora-pack" {
        bail!("Source manifest format must be \"aurora-pack\".");
    }

    if pack.package_type != "icon-pack" {
        bail!("Source manifest packageType must be \"icon-pack\".");
    }

    if pack.schema_version != 1 {
        bail!("Only schemaVersion 1 is currently supported.");
    }

    if pack.manifest.id.trim().is_empty() {
        bail!("manifest.id must be a non-empty string.");
    }

    if pack.manifest.name.trim().is_empty() {
        bail!("manifest.name must be a non-empty string.");
    }

    if pack.manifest.version.trim().is_empty() {
        bail!("manifest.version must be a non-empty string.");
    }

    if pack.icons.is_empty() {
        bail!("Source manifest must define at least one icon asset.");
    }

    let mut referenced_icons: Vec<&str> = Vec::new();

    for icon_name in [
        pack.mappings.default_file.as_deref(),
        pack.mappings.default_folder.as_deref(),
        pack.mappings.default_folder_expanded.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        referenced_icons.push(icon_name);
    }

    for mapping in [
        pack.mappings.file_extensions.as_ref(),
        pack.mappings.file_names.as_ref(),
        pack.mappings.folder_names.as_ref(),
        pack.mappings.folder_names_expanded.as_ref(),
        pack.mappings.language_ids.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        referenced_icons.extend(mapping.values().map(String::as_str));
    }

    for icon_name in referenced_icons {
        if !pack.icons.contains_key(icon_name) {
            bail!(
                "Source manifest mappings reference missing icon asset \"{}\".",
                icon_name
            );
        }
    }

    Ok(())
}

fn build_icon_payload(source: &str, assets_root: &Path) -> Result<String> {
    let trimmed = source.trim();

    if trimmed.starts_with("data:") {
        return Ok(trimmed.to_owned());
    }

    if trimmed.starts_with("<svg") {
        let encoded = BASE64_STANDARD.encode(trimmed.as_bytes());
        return Ok(format!("data:image/svg+xml;base64,{encoded}"));
    }

    let asset_path = assets_root.join(trimmed);
    let asset_bytes = fs::read(&asset_path)
        .with_context(|| format!("Failed to read icon asset: {}", asset_path.display()))?;
    let mime_type = mime_type_for_asset(&asset_path)?;
    let encoded = BASE64_STANDARD.encode(asset_bytes);

    Ok(format!("data:{mime_type};base64,{encoded}"))
}

fn mime_type_for_asset(path: &Path) -> Result<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .context("Icon asset must have a valid file extension.")?;

    match extension.as_str() {
        "svg" => Ok("image/svg+xml"),
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        _ => bail!(
            "Unsupported icon asset format for {}. Supported formats: svg, png, jpg, jpeg, webp, gif.",
            path.display()
        ),
    }
}
