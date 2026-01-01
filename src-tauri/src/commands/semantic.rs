use tauri::{State, AppHandle, Emitter, Manager};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::collections::HashMap;
use tokio::sync::RwLock;

use crate::db::{
    Database, SemanticIndex, SemanticIndexStatus, SemanticSettings,
    IndexProgress, SemanticSearchResult,
};

// Import aurora-semantic (v1.2.1 with full filtering support)
use aurora_semantic::{
    Engine, EngineConfig, WorkspaceConfig, SearchQuery, SearchFilter,
    SearchMode as AuroraSearchMode, IndexProgress as AuroraProgress,
    IgnoreConfig, SearchConfig, ExecutionProviderInfo,
    Language, ChunkType,
    // Jina Code 1.5B embedder (recommended for code search)
    JinaCodeEmbedder, EmbeddingTask, MatryoshkaDimension,
    // Legacy model support
    ModelConfig, OnnxEmbedder,
};

// ============================================================
// USER-LEVEL SEMANTIC DATA DIRECTORY
// ============================================================
// Semantic index files are stored at user level, NOT in workspace .aurora folder
// Structure: {APP_DATA}/aurora_agent/semantic/{workspace-uuid}/
//
// Windows: %APPDATA%/aurora_agent/semantic/{uuid}/
// macOS:   ~/Library/Application Support/aurora_agent/semantic/{uuid}/
// Linux:   ~/.local/share/aurora_agent/semantic/{uuid}/

/// Get the user-level semantic data directory
/// This is a SINGLE shared directory for ALL workspaces
/// aurora-semantic manages its own internal workspace IDs based on paths
fn get_semantic_data_dir() -> Result<PathBuf, String> {
    // Use platform-specific app data directory
    let base_dir = dirs::data_dir()
        .or_else(|| dirs::config_dir())
        .ok_or_else(|| "Could not determine user data directory".to_string())?;
    
    let semantic_dir = base_dir.join("aurora_agent").join("semantic");
    
    // Ensure directory exists
    std::fs::create_dir_all(&semantic_dir)
        .map_err(|e| format!("Failed to create semantic data directory: {}", e))?;
    
    Ok(semantic_dir)
}

// ============================================================
// ENGINE CACHE (Singleton pattern for engine instances)
// ============================================================

lazy_static::lazy_static! {
    static ref ENGINE_CACHE: RwLock<Option<Arc<Engine>>> = RwLock::new(None);
    static ref INDEXING_TASKS: RwLock<HashMap<String, bool>> = RwLock::new(HashMap::new());
}

/// Get or create the semantic engine
/// Uses a SINGLE shared directory - aurora-semantic manages workspace IDs internally by path
async fn get_or_create_engine(
    settings: &SemanticSettings,
) -> Result<Arc<Engine>, String> {
    // Check if we already have an engine cached
    {
        let cache = ENGINE_CACHE.read().await;
        if let Some(engine) = cache.as_ref() {
            return Ok(engine.clone());
        }
    }

    // Use shared semantic data directory for ALL workspaces
    // aurora-semantic will create its own workspace UUIDs internally based on paths
    let index_dir = get_semantic_data_dir()?;

    // Build ignore config with all exclusion options from aurora-semantic v1.2.1
    let mut ignore_config = IgnoreConfig {
        use_gitignore: true,
        ignored_directories: settings.ignored_directories.clone(),
        ignored_extensions: settings.ignored_patterns.iter()
            .filter_map(|p| p.strip_prefix("*.").map(|s| s.to_string()))
            .collect(),
        max_file_size: settings.max_file_size as u64,
        // Glob patterns for file matching
        patterns: settings.ignored_patterns.iter()
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

    let config = EngineConfig::new(index_dir.clone())
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
        .with_ignore(ignore_config);

    // Create engine with or without ONNX model
    let engine = if let Some(model_path) = &settings.model_path {
        if !model_path.is_empty() {
            let model_dir = PathBuf::from(model_path);
            let has_model = model_dir.join("model.onnx").exists() || model_dir.join("model_optimized.onnx").exists();
            let has_tokenizer = model_dir.join("tokenizer.json").exists();
            
            if has_model && has_tokenizer {
                // Detect model type from directory name/path
                let path_lower = model_path.to_lowercase();
                let is_jina_1_5b = path_lower.contains("jina-code-1.5b") 
                    || path_lower.contains("jina-code-embeddings-1.5b");
                
                if is_jina_1_5b {
                    // Use JinaCodeEmbedder for jina-code-embeddings-1.5b
                    // This model has 1536 dimensions and supports Matryoshka truncation
                    let embedder = JinaCodeEmbedder::from_directory(&model_dir)
                        .map_err(|e| format!("Failed to load Jina Code 1.5B model: {}", e))?
                        .with_task(EmbeddingTask::NL2Code)  // Best for natural language -> code search
                        .with_dimension(MatryoshkaDimension::D512)  // Good balance of quality/speed
                        .with_max_length(8192);  // Support long code files
                    
                    Engine::with_embedder(config, embedder)
                        .map_err(|e| format!("Failed to create engine with Jina Code 1.5B: {}", e))?
                } else {
                    // Use legacy OnnxEmbedder for other models (jina-v2, minilm, etc.)
                    let embedder = ModelConfig::from_directory(&model_dir)
                        .with_max_length(8192)
                        .load()
                        .map_err(|e| format!("Failed to load model: {}", e))?;
                    
                    Engine::with_embedder(config, embedder)
                        .map_err(|e| format!("Failed to create engine with model: {}", e))?
                }
            } else {
                // Model path invalid, use hash embeddings
                Engine::new(config)
                    .map_err(|e| format!("Failed to create engine: {}", e))?
            }
        } else {
            Engine::new(config)
                .map_err(|e| format!("Failed to create engine: {}", e))?
        }
    } else {
        // No model configured, use hash embeddings (fast, lexical-focused)
        Engine::new(config)
            .map_err(|e| format!("Failed to create engine: {}", e))?
    };

    let engine = Arc::new(engine);
    
    // Cache the engine
    {
        let mut cache = ENGINE_CACHE.write().await;
        *cache = Some(engine.clone());
    }

    Ok(engine)
}

/// Clear the engine cache (call when settings change)
async fn clear_engine_cache() {
    let mut cache = ENGINE_CACHE.write().await;
    *cache = None;
}

// ============================================================
// SEMANTIC INDEX COMMANDS
// ============================================================

/// Get all semantic indexes
#[tauri::command]
pub fn get_all_semantic_indexes(db: State<'_, Mutex<Database>>) -> Result<Vec<SemanticIndex>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.semantic()
        .get_all_indexes()
        .map_err(|e| format!("Failed to get indexes: {:?}", e))
}

/// Get a semantic index by ID
#[tauri::command]
pub fn get_semantic_index(id: String, db: State<'_, Mutex<Database>>) -> Result<Option<SemanticIndex>, String> {
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

/// Delete a semantic index (also removes index files from user-level storage)
#[tauri::command]
pub async fn delete_semantic_index(
    id: String,
    _workspace_path: String, // Kept for API compatibility, but not used for path
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    // Get workspace path and settings before any async operations
    let (workspace_path, settings) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        
        let workspace_path = db.semantic()
            .get_index(&id)
            .map_err(|e| format!("Failed to get index: {:?}", e))?
            .map(|idx| idx.workspace_path);
        
        let settings = db.semantic()
            .get_settings()
            .map_err(|e| format!("Failed to get settings: {:?}", e))?;
        
        // Delete from database
        db.semantic()
            .delete_index(&id)
            .map_err(|e| format!("Failed to delete index: {:?}", e))?;
        
        (workspace_path, settings)
    }; // db lock released here

    // Delete from aurora-semantic engine by workspace path (async operation)
    if let Some(ws_path) = workspace_path {
        if let Ok(engine) = get_or_create_engine(&settings).await {
            // Use aurora-semantic's built-in find_workspace_by_path
            if let Ok(Some(ws_id)) = engine.find_workspace_by_path(std::path::Path::new(&ws_path)) {
                let _ = engine.delete_workspace(&ws_id);
            }
        }
    }

    // Clear engine cache since index was deleted
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
    let status = status.parse::<SemanticIndexStatus>()
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

/// Validate model directory (check if model.onnx and tokenizer.json exist)
#[tauri::command]
pub fn validate_semantic_model_path(path: String) -> Result<bool, String> {
    let path = PathBuf::from(&path);
    
    if !path.exists() {
        return Ok(false);
    }
    
    let model_file = path.join("model.onnx");
    let tokenizer_file = path.join("tokenizer.json");
    
    Ok(model_file.exists() && tokenizer_file.exists())
}

/// Get model info if valid (lightweight - does NOT load the ONNX model)
/// For execution provider info, use get_execution_provider_info separately
#[tauri::command]
pub fn get_semantic_model_info(path: String) -> Result<Option<ModelInfo>, String> {
    let path = PathBuf::from(&path);
    
    if !path.exists() {
        return Ok(None);
    }
    
    let model_file = path.join("model.onnx");
    let model_optimized = path.join("model_optimized.onnx");
    let tokenizer_file = path.join("tokenizer.json");
    let config_file = path.join("config.json");
    
    // Check for either model.onnx or model_optimized.onnx
    let actual_model_file = if model_optimized.exists() {
        model_optimized
    } else if model_file.exists() {
        model_file
    } else {
        return Ok(None);
    };
    
    if !tokenizer_file.exists() {
        return Ok(None);
    }

    // Get model file size (fast filesystem operation)
    let model_size = std::fs::metadata(&actual_model_file)
        .map(|m| m.len())
        .unwrap_or(0);

    // Try to read config for model name (fast - just reads small JSON)
    let model_name = if config_file.exists() {
        std::fs::read_to_string(&config_file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("_name_or_path").and_then(|n| n.as_str()).map(|s| s.to_string()))
    } else {
        None
    };

    // NOTE: We intentionally do NOT load the ONNX model here to avoid UI freezing
    // Execution provider info is loaded lazily only when actually needed
    // (e.g., when starting indexing or searching)
    
    Ok(Some(ModelInfo {
        path: path.to_string_lossy().to_string(),
        name: model_name.unwrap_or_else(|| path.file_name().unwrap_or_default().to_string_lossy().to_string()),
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
    
    if !path.exists() {
        return Err("Model path does not exist".to_string());
    }
    
    // Try to load the model to get execution provider info
    let embedder = OnnxEmbedder::from_directory(&path)
        .map_err(|e| format!("Failed to load model: {}", e))?;
    
    Ok(ExecutionProviderDetails::from(embedder.execution_provider()))
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

/// Start indexing a workspace
/// Index files are stored at user-level: {APP_DATA}/aurora_agent/semantic/{workspace-uuid}/
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

    // Create or get existing index record (UUID is the key for storage)
    let index_id = {
        let db = db.lock().map_err(|e| e.to_string())?;
        
        // Check if index already exists for this workspace path
        if let Some(existing) = db.semantic()
            .get_index_by_path(&workspace_path)
            .map_err(|e| format!("Failed to check existing index: {:?}", e))? 
        {
            // Update status to indexing
            db.semantic()
                .update_index_status(&existing.id, SemanticIndexStatus::Indexing, None)
                .map_err(|e| format!("Failed to update status: {:?}", e))?;
            existing.id
        } else {
            // Create new index record with UUID
            // This UUID will be used as the directory name in user-level storage
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
            
            new_index.id
        }
    };
    
    // Ensure the shared semantic data directory exists
    let _index_dir = get_semantic_data_dir()?;
    
    // Mark as indexing
    {
        let mut tasks = INDEXING_TASKS.write().await;
        tasks.insert(index_id.clone(), true);
    }

    let index_id_clone = index_id.clone();
    let workspace_path_clone = workspace_path.clone();
    let app_clone = app.clone();
    
    // Spawn indexing task in background
    tokio::spawn(async move {
        let result = run_indexing(
            &app_clone,
            &workspace_path_clone,
            &index_id_clone,
            &settings,
        ).await;

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
                let _ = app_clone.emit("semantic-index-progress", IndexProgress {
                    workspace_id: index_id_clone.clone(),
                    phase: "complete".to_string(),
                    processed: doc_count,
                    total: doc_count,
                    current_file: None,
                    percentage: 100.0,
                });

                // Emit complete event for frontend to refresh
                let _ = app_clone.emit("semantic-index-complete", serde_json::json!({
                    "workspaceId": index_id_clone,
                    "documentCount": doc_count,
                    "chunkCount": chunk_count,
                    "totalBytes": total_bytes,
                }));
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
                let _ = app_clone.emit("semantic-index-error", serde_json::json!({
                    "workspaceId": index_id_clone,
                    "error": e,
                }));
            }
        }
    });
    
    Ok(index_id)
}

/// Internal function to run the actual indexing
/// Uses workspace UUID (index_id) for user-level storage location
async fn run_indexing(
    app: &AppHandle,
    workspace_path: &str,
    index_id: &str,  // Our database record ID (for progress events)
    settings: &SemanticSettings,
) -> Result<(i64, i64, i64), String> {
    // Clear any cached engine to ensure fresh config
    clear_engine_cache().await;

    // Get or create engine (uses shared directory, aurora-semantic manages workspace IDs by path)
    let engine = get_or_create_engine(settings).await?;

    // Emit scanning phase
    let _ = app.emit("semantic-index-progress", IndexProgress {
        workspace_id: index_id.to_string(),
        phase: "scanning".to_string(),
        processed: 0,
        total: 0,
        current_file: None,
        percentage: 0.0,
    });

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
        let _ = app_clone.emit("semantic-index-progress", IndexProgress {
            workspace_id: index_id_clone.clone(),
            phase: phase.to_string(),
            processed: progress.processed as i64,
            total: progress.total as i64,
            current_file: progress.current_file.as_ref().map(|p| p.to_string_lossy().to_string()),
            percentage: percentage as f64,
        });
    });

    // Use index_or_reindex_workspace - it handles finding existing workspace by path,
    // deleting it if exists, and re-indexing with the same aurora-semantic ID
    let workspace_id = engine.index_or_reindex_workspace(ws_config, Some(progress_callback))
        .await
        .map_err(|e| format!("Indexing failed: {}", e))?;

    // Get stats
    let stats = engine.get_workspace_stats(&workspace_id)
        .map_err(|e| format!("Failed to get stats: {}", e))?;

    Ok((
        stats.document_count as i64,
        stats.chunk_count as i64,
        stats.total_bytes as i64,
    ))
}

/// Search using semantic index with full filtering support
/// Supports aurora-semantic v1.2.1 SearchQuery and SearchFilter features
/// Looks up workspace by path to get UUID, then uses user-level storage
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
    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        
        let settings = db.semantic()
            .get_settings()
            .map_err(|e| format!("Failed to get settings: {:?}", e))?;
        
        // Check database for index status (optional - we'll verify with actual engine)
        if let Some(index) = db.semantic()
            .get_index_by_path(&workspace_path)
            .map_err(|e| format!("Failed to get index: {:?}", e))? 
        {
            if index.status != crate::db::SemanticIndexStatus::Ready {
                return Err(format!("Index not ready: {:?}. Please wait for indexing to complete.", index.status));
            }
        }
        
        settings
    };

    // Get or create engine (uses shared directory)
    let engine = get_or_create_engine(&settings).await?;

    // Find workspace by path using aurora-semantic's built-in method
    let workspace_id = engine.find_workspace_by_path(std::path::Path::new(&workspace_path))
        .map_err(|e| format!("Failed to find workspace: {}", e))?
        .ok_or_else(|| {
            format!(
                "Workspace '{}' not found in semantic index. Please index this workspace first from Settings > Semantic Search.",
                workspace_path
            )
        })?;
    
    // Load workspace into memory if not already loaded
    if engine.load_workspace(&workspace_id).is_err() {
        // Workspace might already be loaded, continue
    }

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
    let has_filters = languages.is_some() || chunk_types.is_some() || path_patterns.is_some() 
        || symbol_names.is_some() || directories.is_some() || exclude_directories.is_some();
    
    if has_filters {
        let mut filter = SearchFilter::new();
        
        // Parse and apply language filter
        if let Some(langs) = languages {
            let parsed_langs: Vec<Language> = langs.iter()
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
            let parsed_types: Vec<ChunkType> = types.iter()
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
                filter = filter.exclude_directories(exclude_dirs.into_iter().map(PathBuf::from).collect());
            }
        }
        
        search_query = search_query.filter(filter);
    }

    // Execute search
    let results = engine.search(&workspace_id, search_query)
        .map_err(|e| format!("Search failed: {}", e))?;

    // Convert to our result type
    Ok(results.into_iter().map(|r| SemanticSearchResult {
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
    }).collect())
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
            .update_index_status(&index_id, SemanticIndexStatus::Error, Some("Cancelled by user"))
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

/// Get the user-level semantic data directory path
#[tauri::command]
pub fn get_semantic_data_directory() -> Result<String, String> {
    let dir = get_semantic_data_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

/// Get the semantic data directory path (same as get_semantic_data_directory)
/// All workspaces share this directory, aurora-semantic manages internal structure
#[tauri::command]
pub fn get_semantic_index_path(_workspace_id: String) -> Result<String, String> {
    // All indexes are in the same shared directory now
    let dir = get_semantic_data_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

