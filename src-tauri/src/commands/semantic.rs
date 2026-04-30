use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;

use crate::db::{
    Database, IndexProgress, SemanticIndex, SemanticIndexStatus, SemanticSearchResult,
    SemanticSettings,
};

// Import aurora-semantic from the local workspace crate.
use aurora_semantic::{
    graph::{GraphNode, GraphQuery, NodeLabel},
    ChunkType, Engine, EngineConfig, ExecutionProviderInfo, IgnoreConfig,
    IndexProgress as AuroraProgress, Language, ModelConfig, SearchConfig, SearchFilter,
    SearchMode as AuroraSearchMode, SearchQuery, WorkspaceConfig, WorkspaceId,
};

// ============================================================
// WORKSPACE-LOCAL SEMANTIC INDEXING
// ============================================================
// Index files live inside each opened workspace at:
//   <workspace>/.aurora/index
// This matches Aurora IDE's native workspace metadata layout and keeps each
// codebase's graph/vector index isolated from every other workspace.

// ============================================================
// ENGINE CACHE
// ============================================================

lazy_static::lazy_static! {
    static ref ENGINE_CACHE: RwLock<HashMap<String, Arc<Engine>>> = RwLock::new(HashMap::new());
    static ref INDEXING_TASKS: RwLock<HashMap<String, bool>> = RwLock::new(HashMap::new());
}

fn workspace_index_dir(workspace_path: &str) -> PathBuf {
    EngineConfig::workspace_index_dir(Path::new(workspace_path))
}

fn configured_model_path(settings: &SemanticSettings) -> Result<PathBuf, String> {
    let model_path = settings
        .model_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            "No embedding model is configured. Select the Qwen3 ONNX model folder in Settings > Semantic Search before indexing or searching.".to_string()
        })?;

    let path = PathBuf::from(model_path);
    validate_model_files(&path).map(|_| path)
}

fn model_file_candidates(model_dir: &Path) -> [PathBuf; 4] {
    [
        model_dir.join("onnx").join("model_fp16.onnx"),
        model_dir.join("model_fp16.onnx"),
        model_dir.join("model_optimized.onnx"),
        model_dir.join("model.onnx"),
    ]
}

fn find_model_file(model_dir: &Path) -> Option<PathBuf> {
    model_file_candidates(model_dir)
        .into_iter()
        .find(|path| path.exists())
}

fn validate_model_files(model_dir: &Path) -> Result<PathBuf, String> {
    if !model_dir.exists() {
        return Err(format!(
            "Model path does not exist: {}",
            model_dir.display()
        ));
    }

    if !model_dir.is_dir() {
        return Err(format!(
            "Model path must be a directory containing tokenizer.json and an ONNX file: {}",
            model_dir.display()
        ));
    }

    if !model_dir.join("tokenizer.json").exists() {
        return Err(format!(
            "Model directory is missing tokenizer.json: {}",
            model_dir.display()
        ));
    }

    find_model_file(model_dir).ok_or_else(|| {
        format!(
            "Model directory is missing an ONNX model. Expected one of: onnx/model_fp16.onnx, model_fp16.onnx, model_optimized.onnx, or model.onnx under {}",
            model_dir.display()
        )
    })
}

fn engine_cache_key(
    workspace_path: &str,
    settings: &SemanticSettings,
    workspace_index: Option<&SemanticIndex>,
) -> String {
    let mut hasher = DefaultHasher::new();
    workspace_path.hash(&mut hasher);
    settings.model_path.hash(&mut hasher);
    settings.search_mode.to_string().hash(&mut hasher);
    settings.lexical_weight.to_bits().hash(&mut hasher);
    settings.semantic_weight.to_bits().hash(&mut hasher);
    settings.max_file_size.hash(&mut hasher);
    settings.ignored_patterns.hash(&mut hasher);
    settings.ignored_directories.hash(&mut hasher);
    settings.excluded_files.hash(&mut hasher);
    settings.excluded_directories.hash(&mut hasher);
    if let Some(index) = workspace_index {
        index.excluded_files.hash(&mut hasher);
        index.excluded_directories.hash(&mut hasher);
    }
    format!("{workspace_path}:{}", hasher.finish())
}

fn build_ignore_config(
    settings: &SemanticSettings,
    workspace_index: Option<&SemanticIndex>,
) -> IgnoreConfig {
    let mut ignored_directories = settings.ignored_directories.clone();
    if !ignored_directories.iter().any(|dir| dir == ".aurora") {
        ignored_directories.push(".aurora".to_string());
    }

    let mut ignore_config = IgnoreConfig {
        use_gitignore: true,
        ignored_directories,
        ignored_extensions: settings
            .ignored_patterns
            .iter()
            .filter_map(|p| p.strip_prefix("*.").map(|s| s.to_string()))
            .collect(),
        max_file_size: settings.max_file_size as u64,
        // Glob patterns for file matching
        patterns: settings
            .ignored_patterns
            .iter()
            .filter(|p| !p.starts_with("*."))
            .cloned()
            .collect(),
        ..Default::default()
    };

    // Add specific file exclusions (relative paths)
    for file_path in &settings.excluded_files {
        ignore_config = ignore_config.with_excluded_file(file_path);
    }

    // Add specific directory exclusions (relative paths)
    for dir_path in &settings.excluded_directories {
        ignore_config = ignore_config.with_excluded_directory(dir_path);
    }

    if let Some(index) = workspace_index {
        for file_path in &index.excluded_files {
            ignore_config = ignore_config.with_excluded_file(file_path);
        }
        for dir_path in &index.excluded_directories {
            ignore_config = ignore_config.with_excluded_directory(dir_path);
        }
    }

    ignore_config
}

fn build_engine_config(
    workspace_path: &str,
    settings: &SemanticSettings,
    workspace_index: Option<&SemanticIndex>,
) -> EngineConfig {
    EngineConfig::for_workspace(PathBuf::from(workspace_path))
        .with_search(SearchConfig {
            default_mode: match settings.search_mode {
                crate::db::SearchMode::Lexical => AuroraSearchMode::Lexical,
                crate::db::SearchMode::Semantic => AuroraSearchMode::Semantic,
                crate::db::SearchMode::Hybrid => AuroraSearchMode::Hybrid,
            },
            lexical_weight: settings.lexical_weight as f32,
            semantic_weight: settings.semantic_weight as f32,
            ..Default::default()
        })
        .with_ignore(build_ignore_config(settings, workspace_index))
}

/// Get or create a workspace-local semantic engine.
async fn get_or_create_engine(
    workspace_path: &str,
    settings: &SemanticSettings,
    workspace_index: Option<&SemanticIndex>,
) -> Result<Arc<Engine>, String> {
    let key = engine_cache_key(workspace_path, settings, workspace_index);

    {
        let cache = ENGINE_CACHE.read().await;
        if let Some(engine) = cache.get(&key) {
            return Ok(engine.clone());
        }
    }

    let model_path = configured_model_path(settings)?;
    let config = build_engine_config(workspace_path, settings, workspace_index);
    let engine = Engine::with_model_path(config, &model_path, None).map_err(|e| {
        format!(
            "Failed to load embedding model from '{}': {}",
            model_path.display(),
            e
        )
    })?;

    let engine = Arc::new(engine);

    {
        let mut cache = ENGINE_CACHE.write().await;
        cache.insert(key, engine.clone());
    }

    Ok(engine)
}

/// Clear the engine cache (call when settings change)
async fn clear_engine_cache() {
    let mut cache = ENGINE_CACHE.write().await;
    cache.clear();
}

fn load_workspace_for_query(engine: &Engine, workspace_path: &str) -> Result<WorkspaceId, String> {
    engine
        .load_workspace_by_path(Path::new(workspace_path))
        .map_err(|e| format!("Failed to load workspace index: {}", e))?
        .ok_or_else(|| {
            format!(
                "Workspace '{}' was not found in its .aurora/index semantic store. Index this workspace first from Settings > Semantic Search.",
                workspace_path
            )
        })
}

// ============================================================
// SEMANTIC INDEX COMMANDS
// ============================================================

/// Get all semantic indexes
#[tauri::command]
pub fn get_all_semantic_indexes(
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<SemanticIndex>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.semantic()
        .get_all_indexes()
        .map_err(|e| format!("Failed to get indexes: {:?}", e))
}

/// Get a semantic index by ID
#[tauri::command]
pub fn get_semantic_index(
    id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<SemanticIndex>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.semantic()
        .get_index(&id)
        .map_err(|e| format!("Failed to get index: {:?}", e))
}

/// Get a semantic index by workspace path
#[tauri::command]
pub fn get_semantic_index_by_path(
    workspace_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<SemanticIndex>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.semantic()
        .get_index_by_path(&workspace_path)
        .map_err(|e| format!("Failed to get index: {:?}", e))
}

/// Create or update a semantic index record
#[tauri::command]
pub fn save_semantic_index(
    index: SemanticIndex,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.semantic()
        .save_index(&index)
        .map_err(|e| format!("Failed to save index: {:?}", e))
}

/// Delete a semantic index (also removes workspace-local index files)
#[tauri::command]
pub async fn delete_semantic_index(
    id: String,
    workspace_path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    // Get workspace path, settings, and per-workspace exclusions before async operations.
    let (workspace_path, settings, workspace_index) = {
        let db = db.lock().map_err(|e| e.to_string())?;

        let workspace_index = db
            .semantic()
            .get_index(&id)
            .map_err(|e| format!("Failed to get index: {:?}", e))?;
        let resolved_workspace_path = workspace_index
            .as_ref()
            .map(|idx| idx.workspace_path.clone())
            .unwrap_or(workspace_path);

        let settings = db
            .semantic()
            .get_settings()
            .map_err(|e| format!("Failed to get settings: {:?}", e))?;

        db.semantic()
            .delete_index(&id)
            .map_err(|e| format!("Failed to delete index: {:?}", e))?;

        (resolved_workspace_path, settings, workspace_index)
    };

    if let Ok(engine) =
        get_or_create_engine(&workspace_path, &settings, workspace_index.as_ref()).await
    {
        if let Ok(Some(ws_id)) = engine.find_workspace_by_path(Path::new(&workspace_path)) {
            let _ = engine.delete_workspace(&ws_id);
        }
    }

    clear_engine_cache().await;

    Ok(())
}

/// Update semantic index status
#[tauri::command]
pub fn update_semantic_index_status(
    id: String,
    status: String,
    error_message: Option<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let status = status
        .parse::<SemanticIndexStatus>()
        .map_err(|e| format!("Invalid status: {}", e))?;

    db.semantic()
        .update_index_status(&id, status, error_message.as_deref())
        .map_err(|e| format!("Failed to update status: {:?}", e))
}

/// Update workspace-specific exclusions
#[tauri::command]
pub fn update_workspace_exclusions(
    workspace_path: String,
    excluded_files: Vec<String>,
    excluded_directories: Vec<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;

    db.semantic()
        .update_index_exclusions(&workspace_path, &excluded_files, &excluded_directories)
        .map_err(|e| format!("Failed to update exclusions: {:?}", e))
}

// ============================================================
// SEMANTIC SETTINGS COMMANDS
// ============================================================

/// Get semantic settings
#[tauri::command]
pub fn get_semantic_settings(db: State<'_, Mutex<Database>>) -> Result<SemanticSettings, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.semantic()
        .get_settings()
        .map_err(|e| format!("Failed to get settings: {:?}", e))
}

/// Save semantic settings (clears engine cache to apply new settings)
#[tauri::command]
pub async fn save_semantic_settings(
    settings: SemanticSettings,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.semantic()
            .save_settings(&settings)
            .map_err(|e| format!("Failed to save settings: {:?}", e))?;
    }

    // Clear engine cache so new settings take effect
    clear_engine_cache().await;

    Ok(())
}

/// Set model path (clears engine cache)
#[tauri::command]
pub async fn set_semantic_model_path(
    path: Option<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.semantic()
            .set_model_path(path.as_deref())
            .map_err(|e| format!("Failed to set model path: {:?}", e))?;
    }

    // Clear engine cache so new model is loaded
    clear_engine_cache().await;

    Ok(())
}

/// Validate model directory without loading the ONNX session.
#[tauri::command]
pub fn validate_semantic_model_path(path: String) -> Result<bool, String> {
    Ok(validate_model_files(Path::new(&path)).is_ok())
}

/// Get model info if valid (lightweight - does NOT load the ONNX model)
/// For execution provider info, use get_execution_provider_info separately
#[tauri::command]
pub fn get_semantic_model_info(path: String) -> Result<Option<ModelInfo>, String> {
    let path = PathBuf::from(&path);

    let actual_model_file = match validate_model_files(&path) {
        Ok(model_file) => model_file,
        Err(_) => {
            return Ok(None);
        }
    };

    let config_file = path.join("config.json");
    if !actual_model_file.exists() {
        return Ok(None);
    }

    let model_size = std::fs::metadata(&actual_model_file)
        .map(|m| m.len())
        .unwrap_or(0);

    let model_name = if config_file.exists() {
        std::fs::read_to_string(&config_file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| {
                v.get("_name_or_path")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string())
            })
    } else {
        None
    };

    // NOTE: We intentionally do NOT load the ONNX model here to avoid UI freezing
    // Execution provider info is loaded lazily only when actually needed
    // (e.g., when starting indexing or searching)

    Ok(Some(ModelInfo {
        path: path.to_string_lossy().to_string(),
        name: model_name.unwrap_or_else(|| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        }),
        size_bytes: model_size,
        has_tokenizer: true,
        has_config: config_file.exists(),
        execution_provider: None, // Loaded lazily via get_execution_provider_info
    }))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub has_tokenizer: bool,
    pub has_config: bool,
    pub execution_provider: Option<ExecutionProviderDetails>,
}

/// Execution provider details for frontend display
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProviderDetails {
    pub name: String,
    pub is_gpu: bool,
    pub device_id: Option<u32>,
    pub description: String,
}

impl From<&ExecutionProviderInfo> for ExecutionProviderDetails {
    fn from(info: &ExecutionProviderInfo) -> Self {
        Self {
            name: info.name.clone(),
            is_gpu: info.is_gpu,
            device_id: info.device_id,
            description: info.description(),
        }
    }
}

/// Get execution provider info by loading the model temporarily
#[tauri::command]
pub fn get_execution_provider_info(model_path: String) -> Result<ExecutionProviderDetails, String> {
    let path = PathBuf::from(&model_path);
    validate_model_files(&path)?;

    // Try to load the model to get execution provider info
    let embedder = ModelConfig::from_directory(&path)
        .load()
        .map_err(|e| format!("Failed to load model: {}", e))?;

    Ok(ExecutionProviderDetails::from(
        embedder.execution_provider(),
    ))
}

/// Check what GPU features are available (compiled into the binary)
#[tauri::command]
pub fn get_available_gpu_features() -> GpuFeatures {
    GpuFeatures {
        cuda: cfg!(feature = "cuda"),
        tensorrt: cfg!(feature = "tensorrt"),
        directml: cfg!(feature = "directml"),
        coreml: cfg!(feature = "coreml"),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuFeatures {
    pub cuda: bool,
    pub tensorrt: bool,
    pub directml: bool,
    pub coreml: bool,
}

// ============================================================
// INDEXING COMMANDS (Integration with aurora-semantic)
// ============================================================

/// Start indexing a workspace into `<workspace>/.aurora/index`.
#[tauri::command]
pub async fn start_semantic_indexing(
    app: AppHandle,
    workspace_path: String,
    workspace_name: String,
    db: State<'_, Mutex<Database>>,
) -> Result<String, String> {
    use uuid::Uuid;

    // Check if already indexing this workspace
    {
        let tasks = INDEXING_TASKS.read().await;
        if tasks.values().any(|&v| v) {
            return Err("Another indexing operation is in progress".to_string());
        }
    }

    // Get settings for engine configuration
    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.semantic()
            .get_settings()
            .map_err(|e| format!("Failed to get settings: {:?}", e))?
    };
    configured_model_path(&settings)?;

    // Create or get existing index record. The aurora-semantic workspace ID is stored inside
    // the workspace-local index; this DB UUID is for Aurora UI/progress bookkeeping.
    let (index_id, workspace_index) = {
        let db = db.lock().map_err(|e| e.to_string())?;

        // Check if index already exists for this workspace path
        if let Some(existing) = db
            .semantic()
            .get_index_by_path(&workspace_path)
            .map_err(|e| format!("Failed to check existing index: {:?}", e))?
        {
            db.semantic()
                .update_index_status(&existing.id, SemanticIndexStatus::Indexing, None)
                .map_err(|e| format!("Failed to update status: {:?}", e))?;
            let index_id = existing.id.clone();
            (index_id, existing)
        } else {
            let new_index = SemanticIndex {
                id: Uuid::new_v4().to_string(),
                workspace_path: workspace_path.clone(),
                workspace_name: workspace_name.clone(),
                document_count: 0,
                chunk_count: 0,
                total_bytes: 0,
                status: SemanticIndexStatus::Indexing,
                error_message: None,
                last_indexed_at: None,
                excluded_files: Vec::new(),
                excluded_directories: Vec::new(),
                created_at: String::new(),
                updated_at: String::new(),
            };

            db.semantic()
                .save_index(&new_index)
                .map_err(|e| format!("Failed to create index: {:?}", e))?;

            let index_id = new_index.id.clone();
            (index_id, new_index)
        }
    };

    // Mark as indexing
    {
        let mut tasks = INDEXING_TASKS.write().await;
        tasks.insert(index_id.clone(), true);
    }

    let index_id_clone = index_id.clone();
    let workspace_path_clone = workspace_path.clone();
    let workspace_index_clone = workspace_index.clone();
    let app_clone = app.clone();

    // Spawn indexing task in background
    tokio::spawn(async move {
        let result = run_indexing(
            &app_clone,
            &workspace_path_clone,
            &index_id_clone,
            &settings,
            &workspace_index_clone,
        )
        .await;

        // Clear indexing flag
        {
            let mut tasks = INDEXING_TASKS.write().await;
            tasks.remove(&index_id_clone);
        }

        // IMPORTANT: Clear engine cache after indexing to release VRAM
        // The model will be reloaded on-demand when search is performed
        clear_engine_cache().await;

        // Get database from app state to update it
        let db_state: tauri::State<'_, Mutex<Database>> = app_clone.state();

        // Handle result
        match result {
            Ok((doc_count, chunk_count, total_bytes)) => {
                // Update database with final stats and status = Ready
                if let Ok(db) = db_state.lock() {
                    let _ = db.semantic().update_index_status(
                        &index_id_clone,
                        SemanticIndexStatus::Ready,
                        None,
                    );
                    // Update stats in database
                    let _ = db.semantic().update_index_stats(
                        &index_id_clone,
                        doc_count,
                        chunk_count,
                        total_bytes,
                    );
                }

                // Emit completion event
                let _ = app_clone.emit(
                    "semantic-index-progress",
                    IndexProgress {
                        workspace_id: index_id_clone.clone(),
                        phase: "complete".to_string(),
                        processed: doc_count,
                        total: doc_count,
                        current_file: None,
                        percentage: 100.0,
                    },
                );

                // Emit complete event for frontend to refresh
                let _ = app_clone.emit(
                    "semantic-index-complete",
                    serde_json::json!({
                        "workspaceId": index_id_clone,
                        "documentCount": doc_count,
                        "chunkCount": chunk_count,
                        "totalBytes": total_bytes,
                    }),
                );
            }
            Err(e) => {
                // Update database with error status
                if let Ok(db) = db_state.lock() {
                    let _ = db.semantic().update_index_status(
                        &index_id_clone,
                        SemanticIndexStatus::Error,
                        Some(&e),
                    );
                }

                // Emit error event
                let _ = app_clone.emit(
                    "semantic-index-error",
                    serde_json::json!({
                        "workspaceId": index_id_clone,
                        "error": e,
                    }),
                );
            }
        }
    });

    Ok(index_id)
}

/// Internal function to run the actual indexing.
async fn run_indexing(
    app: &AppHandle,
    workspace_path: &str,
    index_id: &str, // Our database record ID (for progress events)
    settings: &SemanticSettings,
    workspace_index: &SemanticIndex,
) -> Result<(i64, i64, i64), String> {
    // Clear any cached engine to ensure fresh config
    clear_engine_cache().await;

    let engine = get_or_create_engine(workspace_path, settings, Some(workspace_index)).await?;

    // Emit scanning phase
    let _ = app.emit(
        "semantic-index-progress",
        IndexProgress {
            workspace_id: index_id.to_string(),
            phase: "scanning".to_string(),
            processed: 0,
            total: 0,
            current_file: None,
            percentage: 0.0,
        },
    );

    // Create workspace config
    let ws_config = WorkspaceConfig::new(PathBuf::from(workspace_path));

    // Create progress callback
    let app_clone = app.clone();
    let index_id_clone = index_id.to_string();
    let progress_callback = Box::new(move |progress: AuroraProgress| {
        let phase = match progress.phase {
            aurora_semantic::IndexPhase::Scanning => "scanning",
            aurora_semantic::IndexPhase::Parsing => "parsing",
            aurora_semantic::IndexPhase::Embedding => "embedding",
            aurora_semantic::IndexPhase::Indexing => "indexing",
            aurora_semantic::IndexPhase::Persisting => "persisting",
            aurora_semantic::IndexPhase::Complete => "complete",
        };

        let percentage = progress.percentage();
        let _ = app_clone.emit(
            "semantic-index-progress",
            IndexProgress {
                workspace_id: index_id_clone.clone(),
                phase: phase.to_string(),
                processed: progress.processed as i64,
                total: progress.total as i64,
                current_file: progress
                    .current_file
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                percentage: percentage as f64,
            },
        );
    });

    // Use index_or_reindex_workspace - it handles finding existing workspace by path,
    // deleting it if exists, and re-indexing with the same aurora-semantic ID
    let workspace_id = engine
        .index_or_reindex_workspace(ws_config, Some(progress_callback))
        .await
        .map_err(|e| format!("Indexing failed: {}", e))?;

    // Get stats
    let stats = engine
        .get_workspace_stats(&workspace_id)
        .map_err(|e| format!("Failed to get stats: {}", e))?;

    Ok((
        stats.document_count as i64,
        stats.chunk_count as i64,
        stats.total_bytes as i64,
    ))
}

/// Search code chunks in the workspace-local semantic index.
#[tauri::command]
pub async fn semantic_search(
    workspace_path: String,
    query: String,
    limit: Option<i32>,
    mode: Option<String>,
    min_score: Option<f32>,
    // Filter parameters from aurora-semantic SearchFilter
    languages: Option<Vec<String>>,
    chunk_types: Option<Vec<String>>,
    path_patterns: Option<Vec<String>>,
    symbol_names: Option<Vec<String>>,
    directories: Option<Vec<String>>,
    exclude_directories: Option<Vec<String>>,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<SemanticSearchResult>, String> {
    // Get settings and verify workspace is indexed
    let (settings, workspace_index) = {
        let db = db.lock().map_err(|e| e.to_string())?;

        let settings = db
            .semantic()
            .get_settings()
            .map_err(|e| format!("Failed to get settings: {:?}", e))?;

        let workspace_index = db
            .semantic()
            .get_index_by_path(&workspace_path)
            .map_err(|e| format!("Failed to get index: {:?}", e))?
            .ok_or_else(|| {
                "This workspace has not been indexed yet. Index it from Settings > Semantic Search."
                    .to_string()
            })?;

        if workspace_index.status != crate::db::SemanticIndexStatus::Ready {
            return Err(format!(
                "Index not ready: {:?}. Please wait for indexing to complete.",
                workspace_index.status
            ));
        }

        (settings, workspace_index)
    };

    let engine = get_or_create_engine(&workspace_path, &settings, Some(&workspace_index)).await?;
    let workspace_id = load_workspace_for_query(&engine, &workspace_path)?;

    // Determine search mode
    let search_mode = if let Some(mode_str) = mode.as_deref() {
        match mode_str {
            "lexical" => AuroraSearchMode::Lexical,
            "semantic" => AuroraSearchMode::Semantic,
            _ => AuroraSearchMode::Hybrid,
        }
    } else {
        match settings.search_mode {
            crate::db::SearchMode::Lexical => AuroraSearchMode::Lexical,
            crate::db::SearchMode::Semantic => AuroraSearchMode::Semantic,
            crate::db::SearchMode::Hybrid => AuroraSearchMode::Hybrid,
        }
    };

    // Build search query with basic options
    let mut search_query = SearchQuery::new(&query)
        .mode(search_mode)
        .limit(limit.unwrap_or(20) as usize)
        .min_score(min_score.unwrap_or(0.1));

    // Build search filter if any filter parameters are provided
    let has_filters = languages.is_some()
        || chunk_types.is_some()
        || path_patterns.is_some()
        || symbol_names.is_some()
        || directories.is_some()
        || exclude_directories.is_some();

    if has_filters {
        let mut filter = SearchFilter::new();

        // Parse and apply language filter
        if let Some(langs) = languages {
            let parsed_langs: Vec<Language> = langs
                .iter()
                .filter_map(|l| match l.to_lowercase().as_str() {
                    "rust" => Some(Language::Rust),
                    "python" => Some(Language::Python),
                    "typescript" => Some(Language::TypeScript),
                    "javascript" => Some(Language::JavaScript),
                    "go" => Some(Language::Go),
                    "java" => Some(Language::Java),
                    "c" => Some(Language::C),
                    "cpp" | "c++" => Some(Language::Cpp),
                    _ => None,
                })
                .collect();
            if !parsed_langs.is_empty() {
                filter = filter.languages(parsed_langs);
            }
        }

        // Parse and apply chunk type filter
        if let Some(types) = chunk_types {
            let parsed_types: Vec<ChunkType> = types
                .iter()
                .filter_map(|t| match t.to_lowercase().as_str() {
                    "function" => Some(ChunkType::Function),
                    "class" => Some(ChunkType::Class),
                    "struct" => Some(ChunkType::Struct),
                    "enum" => Some(ChunkType::Enum),
                    "interface" => Some(ChunkType::Interface),
                    "module" => Some(ChunkType::Module),
                    "imports" => Some(ChunkType::Imports),
                    "constant" => Some(ChunkType::Constant),
                    "typedef" => Some(ChunkType::TypeDef),
                    "implementation" => Some(ChunkType::Implementation),
                    "block" => Some(ChunkType::Block),
                    "comment" => Some(ChunkType::Comment),
                    _ => None,
                })
                .collect();
            if !parsed_types.is_empty() {
                filter = filter.chunk_types(parsed_types);
            }
        }

        // Apply path patterns filter
        if let Some(patterns) = path_patterns {
            if !patterns.is_empty() {
                filter = filter.path_patterns(patterns);
            }
        }

        // Apply symbol names filter
        if let Some(symbols) = symbol_names {
            if !symbols.is_empty() {
                filter = filter.symbol_names(symbols);
            }
        }

        // Apply directory inclusion filter
        if let Some(dirs) = directories {
            if !dirs.is_empty() {
                filter = filter.in_directories(dirs.into_iter().map(PathBuf::from).collect());
            }
        }

        // Apply directory exclusion filter
        if let Some(exclude_dirs) = exclude_directories {
            if !exclude_dirs.is_empty() {
                filter = filter
                    .exclude_directories(exclude_dirs.into_iter().map(PathBuf::from).collect());
            }
        }

        search_query = search_query.filter(filter);
    }

    // Execute search
    let results = engine
        .search(&workspace_id, search_query)
        .map_err(|e| format!("Search failed: {}", e))?;

    // Convert to our result type
    Ok(results
        .into_iter()
        .map(|r| SemanticSearchResult {
            file_path: r.document.absolute_path.to_string_lossy().to_string(),
            relative_path: r.document.relative_path.to_string_lossy().to_string(),
            start_line: r.chunk.start_line,
            end_line: r.chunk.end_line,
            chunk_type: format!("{:?}", r.chunk.chunk_type),
            symbol_name: r.chunk.symbol_name,
            content: r.chunk.content,
            score: r.score,
            match_type: match r.match_type {
                aurora_semantic::MatchType::Lexical => "lexical".to_string(),
                aurora_semantic::MatchType::Semantic => "semantic".to_string(),
                aurora_semantic::MatchType::Hybrid => "hybrid".to_string(),
            },
        })
        .collect())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeSummary {
    pub id: String,
    pub label: String,
    pub name: String,
    pub qualified_name: Option<String>,
    pub path: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelationshipSummary {
    pub source: String,
    pub target: String,
    pub relationship_type: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticGraphSearchResult {
    pub node: GraphNodeSummary,
    pub score: f32,
    pub match_type: String,
    pub relationships: Vec<GraphRelationshipSummary>,
    pub related_nodes: Vec<GraphNodeSummary>,
}

fn parse_node_label(label: &str) -> Option<NodeLabel> {
    match label.to_lowercase().replace('-', "_").as_str() {
        "workspace" => Some(NodeLabel::Workspace),
        "folder" | "directory" => Some(NodeLabel::Folder),
        "file" => Some(NodeLabel::File),
        "function" => Some(NodeLabel::Function),
        "class" => Some(NodeLabel::Class),
        "interface" => Some(NodeLabel::Interface),
        "method" => Some(NodeLabel::Method),
        "constructor" => Some(NodeLabel::Constructor),
        "property" | "field" => Some(NodeLabel::Property),
        "struct" => Some(NodeLabel::Struct),
        "enum" => Some(NodeLabel::Enum),
        "trait" => Some(NodeLabel::Trait),
        "impl" | "implementation" => Some(NodeLabel::Impl),
        "type_alias" | "typedef" => Some(NodeLabel::TypeAlias),
        "const" | "constant" => Some(NodeLabel::Const),
        "static" => Some(NodeLabel::Static),
        "variable" => Some(NodeLabel::Variable),
        "macro" => Some(NodeLabel::Macro),
        "namespace" | "module" | "package" => Some(NodeLabel::Namespace),
        "community" => Some(NodeLabel::Community),
        "process" | "flow" => Some(NodeLabel::Process),
        "route" => Some(NodeLabel::Route),
        "tool" => Some(NodeLabel::Tool),
        "section" => Some(NodeLabel::Section),
        _ => None,
    }
}

fn graph_node_summary(node: &GraphNode) -> GraphNodeSummary {
    let span = node.span.as_ref();
    GraphNodeSummary {
        id: node.id.to_string(),
        label: node.label.as_str().to_string(),
        name: node.name.clone(),
        qualified_name: node.qualified_name.clone(),
        path: span.map(|span| span.path.to_string_lossy().to_string()),
        start_line: span.map(|span| span.start_line),
        end_line: span.map(|span| span.end_line),
    }
}

/// Search graph nodes directly for symbols, files, routes, tools, and process nodes.
#[tauri::command]
pub async fn semantic_graph_search(
    workspace_path: String,
    query: String,
    limit: Option<i32>,
    mode: Option<String>,
    min_score: Option<f32>,
    labels: Option<Vec<String>>,
    path_patterns: Option<Vec<String>>,
    include_context: Option<bool>,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<SemanticGraphSearchResult>, String> {
    let (settings, workspace_index) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let settings = db
            .semantic()
            .get_settings()
            .map_err(|e| format!("Failed to get settings: {:?}", e))?;
        let workspace_index = db
            .semantic()
            .get_index_by_path(&workspace_path)
            .map_err(|e| format!("Failed to get index: {:?}", e))?
            .ok_or_else(|| {
                "This workspace has not been indexed yet. Index it from Settings > Semantic Search."
                    .to_string()
            })?;

        if workspace_index.status != crate::db::SemanticIndexStatus::Ready {
            return Err(format!(
                "Index not ready: {:?}. Please wait for indexing to complete.",
                workspace_index.status
            ));
        }

        (settings, workspace_index)
    };

    let engine = get_or_create_engine(&workspace_path, &settings, Some(&workspace_index)).await?;
    let workspace_id = load_workspace_for_query(&engine, &workspace_path)?;

    let search_mode = match mode.as_deref() {
        Some("lexical") => AuroraSearchMode::Lexical,
        Some("semantic") => AuroraSearchMode::Semantic,
        _ => AuroraSearchMode::Hybrid,
    };

    let mut graph_query = GraphQuery::new(&query)
        .mode(search_mode)
        .limit(limit.unwrap_or(20).clamp(1, 50) as usize)
        .min_score(min_score.unwrap_or(0.0))
        .include_context(include_context.unwrap_or(true));

    if let Some(labels) = labels {
        let parsed_labels: Vec<NodeLabel> = labels
            .iter()
            .filter_map(|label| parse_node_label(label))
            .collect();
        if !parsed_labels.is_empty() {
            graph_query = graph_query.labels(parsed_labels);
        }
    }

    if let Some(path_patterns) = path_patterns {
        if !path_patterns.is_empty() {
            graph_query = graph_query.path_patterns(path_patterns);
        }
    }

    let results = engine
        .query_graph(&workspace_id, graph_query)
        .map_err(|e| format!("Graph search failed: {}", e))?;

    Ok(results
        .into_iter()
        .map(|result| SemanticGraphSearchResult {
            node: graph_node_summary(&result.node),
            score: result.score,
            match_type: format!("{:?}", result.match_type).to_lowercase(),
            relationships: result
                .relationships
                .iter()
                .map(|relationship| GraphRelationshipSummary {
                    source: relationship.source.to_string(),
                    target: relationship.target.to_string(),
                    relationship_type: relationship.relationship_type.as_str().to_string(),
                })
                .collect(),
            related_nodes: result
                .related_nodes
                .iter()
                .map(graph_node_summary)
                .collect(),
        })
        .collect())
}

/// Cancel ongoing indexing
#[tauri::command]
pub async fn cancel_semantic_indexing(
    index_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    // Mark as cancelled
    {
        let mut tasks = INDEXING_TASKS.write().await;
        tasks.remove(&index_id);
    }

    // Update status in database
    {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.semantic()
            .update_index_status(
                &index_id,
                SemanticIndexStatus::Error,
                Some("Cancelled by user"),
            )
            .map_err(|e| format!("Failed to cancel indexing: {:?}", e))?;
    }

    Ok(())
}

/// Check if indexing is in progress
#[tauri::command]
pub async fn is_semantic_indexing() -> bool {
    let tasks = INDEXING_TASKS.read().await;
    tasks.values().any(|&v| v)
}

/// Get the workspace-local semantic index directory path.
#[tauri::command]
pub fn get_semantic_data_directory(workspace_path: Option<String>) -> Result<String, String> {
    let workspace_path = workspace_path
        .ok_or_else(|| "Open a workspace to resolve its semantic index directory.".to_string())?;
    Ok(workspace_index_dir(&workspace_path)
        .to_string_lossy()
        .to_string())
}

/// Legacy compatibility alias. The argument now expects a workspace path.
#[tauri::command]
pub fn get_semantic_index_path(workspace_id: String) -> Result<String, String> {
    Ok(workspace_index_dir(&workspace_id)
        .to_string_lossy()
        .to_string())
}
