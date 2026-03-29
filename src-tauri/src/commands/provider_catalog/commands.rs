use super::types::{built_in_provider_presets, ProviderCatalogPreset};

#[tauri::command]
pub async fn provider_catalog_get_presets() -> Result<Vec<ProviderCatalogPreset>, String> {
    Ok(built_in_provider_presets())
}
