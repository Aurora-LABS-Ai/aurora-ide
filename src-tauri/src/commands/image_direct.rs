//! The window's direct picture command. Written once in
//! [`crate::tools::image::direct`].

use std::sync::Arc;

use tauri::State;

use crate::agent_runtime::host::AgentRegistry;
use crate::tools::image::direct::{self, ImageDirectRequest, ImageDirectResult};

#[tauri::command]
pub async fn image_direct_generate(
    state: State<'_, Arc<AgentRegistry>>,
    request: ImageDirectRequest,
) -> Result<ImageDirectResult, String> {
    direct::generate(&state, request).await
}
