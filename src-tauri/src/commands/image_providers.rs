//! The two buttons on an image-provider row: **Test** and **Discover models**.
//!
//! Both go through [`crate::tools::image::client::ImageClient`] — the same
//! client, headers and parsers `generate_image` uses — so a row that passes
//! here is a row the tool can use. A probe that succeeded while a turn failed
//! would be worse than no probe.
//!
//! Neither spends a generation. `GET /models` with the key is the cheapest
//! authenticated call both formats offer, and it doubles as the model list;
//! `/models/{id}` is never consulted (a6api's denied a model its list showed).

use std::time::Instant;

use serde::Serialize;

use crate::tools::image::client::ImageClient;
use crate::tools::image::config::ImageProviderConfig;
use crate::tools::image::wire::Discovery;

/// What the Test button learned.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProviderTestReport {
    /// The address answered and accepted the key.
    pub ok: bool,
    /// The endpoint actually called.
    pub url: String,
    /// How many image models the provider listed. Zero is not a failure — a
    /// provider can be reachable and list nothing Aurora recognises as an
    /// image model — but it is worth saying.
    pub image_models: usize,
    pub latency_ms: u64,
    /// Present only on failure. Already human-readable.
    pub error: Option<String>,
}

/// One model the Discover button found.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredImageModel {
    pub id: String,
    /// `true` when the provider itself tagged it as an image model; `false`
    /// when Aurora guessed from the name. The UI says which, so a guess is
    /// not presented as a fact.
    pub tagged: bool,
}

#[tauri::command]
pub async fn image_provider_test(config: ImageProviderConfig) -> ImageProviderTestReport {
    let url = config.models_url();
    let started = Instant::now();
    match ImageClient::new().test(&config).await {
        Ok(image_models) => ImageProviderTestReport {
            ok: true,
            url,
            image_models,
            latency_ms: started.elapsed().as_millis() as u64,
            error: None,
        },
        Err(error) => ImageProviderTestReport {
            ok: false,
            url,
            image_models: 0,
            latency_ms: started.elapsed().as_millis() as u64,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub async fn image_provider_discover_models(
    config: ImageProviderConfig,
) -> Result<Vec<DiscoveredImageModel>, String> {
    let models = ImageClient::new()
        .discover_models(&config)
        .await
        .map_err(|error| error.to_string())?;
    Ok(models
        .into_iter()
        .map(|model| DiscoveredImageModel {
            id: model.id,
            tagged: model.discovery == Discovery::Tagged,
        })
        .collect())
}
