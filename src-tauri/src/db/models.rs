use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

// ============================================================
// WORKSPACE STATE
// ============================================================

/// Workspace state representing open tabs and panel layout
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub workspace_path: Option<String>,
    pub open_tabs: Vec<TabState>,
    pub panel_sizes: Option<PanelSizes>,
    pub last_opened_at: String, // ISO timestamp string from frontend
    #[serde(default = "default_checkpoint_enabled")]
    pub checkpoint_enabled: bool, // Whether checkpoints are enabled for this workspace (default: true)
}

fn default_checkpoint_enabled() -> bool {
    true
}

impl WorkspaceState {
    /// Convert the ISO timestamp string to OffsetDateTime
    #[allow(dead_code)]
    pub fn get_last_opened_at(&self) -> OffsetDateTime {
        OffsetDateTime::parse(&self.last_opened_at, &time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }
}

/// Individual tab state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabState {
    pub path: String,
    pub is_active: bool,
    pub is_dirty: bool,
}

/// Panel size configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelSizes {
    pub explorer: f64,  // Percentage (0-100)
    pub editor: f64,    // Percentage (0-100)
    pub chat: f64,      // Percentage (0-100)
}

// ============================================================
// EDITOR STATE
// ============================================================

/// Editor state for a specific file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorState {
    pub file_path: String,
    pub cursor_line: Option<u32>,
    pub cursor_col: Option<u32>,
    pub scroll_offset: Option<f64>,
    pub folded_regions: Option<Vec<FoldedRegion>>,
    pub last_edited_at: String, // ISO timestamp string from frontend
}

impl EditorState {
    /// Convert the ISO timestamp string to OffsetDateTime
    #[allow(dead_code)]
    pub fn get_last_edited_at(&self) -> OffsetDateTime {
        OffsetDateTime::parse(&self.last_edited_at, &time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }
}

/// A folded/collapsed code region
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoldedRegion {
    pub start_line: u32,
    pub end_line: u32,
}

// ============================================================
// EXPLORER STATE
// ============================================================

/// File explorer state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorerState {
    pub workspace_path: String,
    pub expanded_folders: Vec<String>,
    pub selected_file: Option<String>,
}

// ============================================================
// THREAD STATE
// ============================================================

/// Token usage tracking for a thread
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// Context usage tracking for a thread
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: i64,
    pub context_window: i64,
    pub percentage: f64,
}

/// Thread/conversation state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadState {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub messages: Vec<Message>,
    pub token_usage: Option<TokenUsage>,
    pub context_usage: Option<ContextUsage>,
    pub created_at: String, // ISO string or timestamp string
    pub updated_at: String, // ISO string or timestamp string
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    #[serde(alias = "sender")]
    pub role: String, // "user", "assistant", "system", "tool"
    pub content: String,
    pub timestamp: String, // ISO string or timestamp string
    pub tool_calls: Option<Vec<ToolCall>>,
    pub thinking: Option<String>,
    #[serde(default, alias = "isThinking")]
    pub is_thinking: Option<bool>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub timeline: Option<serde_json::Value>,
    #[serde(rename = "toolProposal", default)]
    pub tool_proposal: Option<serde_json::Value>,
}

/// Tool call in a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub result: Option<String>,
}

// ============================================================
// APP SETTINGS
// ============================================================

/// Application setting (key-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSetting {
    pub key: String,
    pub value: String,  // JSON string value
    pub updated_at: String,
}

// ============================================================
// LLM PROVIDER
// ============================================================

/// LLM Provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub context_window: i64,
    pub max_output_tokens: i64,
    pub supports_thinking: bool,
    pub supports_tool_stream: bool,
    pub enabled: bool,
    pub is_custom: bool,
    pub custom_models: Option<Vec<String>>,
    pub custom_headers: Option<serde_json::Value>,
    pub custom_params: Option<serde_json::Value>,
    pub provider_type: Option<String>,
    pub default_temperature: Option<f64>,
    pub default_max_tokens: Option<i64>,
    pub requires_api_key: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================================
// TOOL SETTINGS
// ============================================================

/// Per-tool approval setting
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSetting {
    pub tool_name: String,
    pub approval_mode: String,  // 'auto' | 'always_ask' | 'deny'
    pub updated_at: String,
}

// ============================================================
// SETTINGS STATE (Complete app settings)
// ============================================================

/// Complete application settings state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // General settings
    pub selected_model: String,
    pub auto_approve_tools: bool,
    pub auto_accept_changes: bool,
    pub font_size: i32,
    pub wrap_mode: bool,
    pub theme: String,
    pub thinking_enabled: bool,
    pub syntax_validation_enabled: bool,
    pub project_layout_enabled: bool,
    pub ui_font_family: String,
    pub ui_scale: f64,
    pub max_tokens: i32,
    pub temperature: f64,
    
    // Autosave settings
    pub auto_save: String,
    pub auto_save_delay: i32,
    
    // Tool settings
    pub max_tool_calls_per_request: i32,
}


impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_model: "glm:glm-4.7".to_string(),
            auto_approve_tools: false,
            auto_accept_changes: false,
            font_size: 14,
            wrap_mode: true,
            theme: "dark".to_string(),
            thinking_enabled: true,
            syntax_validation_enabled: true,
            project_layout_enabled: true,
            ui_font_family: "system".to_string(),
            ui_scale: 1.1,
            max_tokens: 8192,
            temperature: 1.0,
            auto_save: "off".to_string(),
            auto_save_delay: 1000,
            max_tool_calls_per_request: 25,
        }

    }
}

// ============================================================
// CUSTOM THEMES
// ============================================================

/// Custom theme definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    #[serde(rename = "type")]
    pub theme_type: String, // "light" or "dark" (mapped from 'type' in JSON)
    pub colors: String,     // JSON string of colors object
    pub token_colors: String, // JSON string of tokenColors array
    pub created_at: String,
    pub updated_at: String,
}

// ============================================================
// SEMANTIC SEARCH
// ============================================================

/// Semantic index status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SemanticIndexStatus {
    Pending,
    Indexing,
    Ready,
    Error,
}

impl Default for SemanticIndexStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::fmt::Display for SemanticIndexStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Indexing => write!(f, "indexing"),
            Self::Ready => write!(f, "ready"),
            Self::Error => write!(f, "error"),
        }
    }
}

impl std::str::FromStr for SemanticIndexStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(Self::Pending),
            "indexing" => Ok(Self::Indexing),
            "ready" => Ok(Self::Ready),
            "error" => Ok(Self::Error),
            _ => Err(format!("Unknown status: {}", s)),
        }
    }
}

/// Semantic index record for a workspace
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndex {
    pub id: String,
    pub workspace_path: String,
    pub workspace_name: String,
    pub document_count: i64,
    pub chunk_count: i64,
    pub total_bytes: i64,
    pub status: SemanticIndexStatus,
    pub error_message: Option<String>,
    pub last_indexed_at: Option<String>,
    /// Workspace-specific file exclusions (relative paths)
    #[serde(default)]
    pub excluded_files: Vec<String>,
    /// Workspace-specific directory exclusions (relative paths)
    #[serde(default)]
    pub excluded_directories: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Search mode for semantic search
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Lexical,
    Semantic,
    Hybrid,
}

impl Default for SearchMode {
    fn default() -> Self {
        Self::Hybrid
    }
}

impl std::fmt::Display for SearchMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Lexical => write!(f, "lexical"),
            Self::Semantic => write!(f, "semantic"),
            Self::Hybrid => write!(f, "hybrid"),
        }
    }
}

impl std::str::FromStr for SearchMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "lexical" => Ok(Self::Lexical),
            "semantic" => Ok(Self::Semantic),
            "hybrid" => Ok(Self::Hybrid),
            _ => Err(format!("Unknown search mode: {}", s)),
        }
    }
}

/// Global semantic search settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSettings {
    pub model_path: Option<String>,
    pub enabled: bool,
    pub auto_index: bool,
    pub auto_reindex_interval: Option<i64>, // Minutes, null = disabled
    pub ignored_patterns: Vec<String>,
    pub ignored_directories: Vec<String>,
    /// Specific file paths to exclude (relative to workspace root)
    /// e.g., ["src/generated/types.rs", "src/proto/generated.rs"]
    #[serde(default)]
    pub excluded_files: Vec<String>,
    /// Specific directory paths to exclude (relative to workspace root)
    /// e.g., ["vendor/third-party", "generated"]
    #[serde(default)]
    pub excluded_directories: Vec<String>,
    pub max_file_size: i64, // Bytes
    pub search_mode: SearchMode,
    pub lexical_weight: f64,
    pub semantic_weight: f64,
    pub updated_at: String,
}

impl Default for SemanticSettings {
    fn default() -> Self {
        Self {
            model_path: None,
            enabled: true,
            auto_index: false,
            auto_reindex_interval: None,
            ignored_patterns: vec![
                // ============================================
                // LOCK FILES (CRITICAL - These bloat context!)
                // ============================================
                "*.lock".to_string(),
                "*.lockb".to_string(),
                "package-lock.json".to_string(),
                "pnpm-lock.yaml".to_string(),
                "yarn.lock".to_string(),
                "Cargo.lock".to_string(),
                "Gemfile.lock".to_string(),
                "composer.lock".to_string(),
                "poetry.lock".to_string(),
                "Pipfile.lock".to_string(),
                "pubspec.lock".to_string(),
                "packages.lock.json".to_string(),
                "shrinkwrap.yaml".to_string(),
                "bun.lockb".to_string(),
                
                // ============================================
                // MINIFIED / BUNDLED FILES
                // ============================================
                "*.min.js".to_string(),
                "*.min.css".to_string(),
                "*.bundle.js".to_string(),
                "*.chunk.js".to_string(),
                "*.map".to_string(),
                
                // ============================================
                // BINARY / COMPILED
                // ============================================
                "*.exe".to_string(), "*.dll".to_string(), "*.so".to_string(),
                "*.dylib".to_string(), "*.a".to_string(), "*.lib".to_string(),
                "*.obj".to_string(), "*.o".to_string(), "*.ko".to_string(),
                "*.bin".to_string(), "*.out".to_string(), "*.elf".to_string(),
                "*.msi".to_string(), "*.dmg".to_string(), "*.pkg".to_string(),
                "*.deb".to_string(), "*.rpm".to_string(),
                "*.apk".to_string(), "*.ipa".to_string(), "*.aab".to_string(),
                "*.class".to_string(), "*.jar".to_string(), "*.war".to_string(), "*.ear".to_string(),
                "*.pyc".to_string(), "*.pyo".to_string(), "*.pyd".to_string(), "*.whl".to_string(),
                "*.wasm".to_string(), "*.wat".to_string(),
                "*.rlib".to_string(), "*.rmeta".to_string(),
                
                // ============================================
                // IMAGES
                // ============================================
                "*.png".to_string(), "*.jpg".to_string(), "*.jpeg".to_string(),
                "*.gif".to_string(), "*.bmp".to_string(), "*.ico".to_string(),
                "*.icns".to_string(), "*.svg".to_string(), "*.webp".to_string(),
                "*.avif".to_string(), "*.tiff".to_string(), "*.tif".to_string(),
                "*.psd".to_string(), "*.ai".to_string(), "*.eps".to_string(),
                "*.raw".to_string(), "*.cr2".to_string(), "*.nef".to_string(),
                "*.heic".to_string(), "*.heif".to_string(),
                
                // ============================================
                // VIDEO
                // ============================================
                "*.mp4".to_string(), "*.avi".to_string(), "*.mov".to_string(),
                "*.wmv".to_string(), "*.flv".to_string(), "*.mkv".to_string(),
                "*.webm".to_string(), "*.m4v".to_string(), "*.mpeg".to_string(),
                "*.mpg".to_string(), "*.3gp".to_string(), "*.ogv".to_string(),
                
                // ============================================
                // AUDIO
                // ============================================
                "*.mp3".to_string(), "*.wav".to_string(), "*.ogg".to_string(),
                "*.flac".to_string(), "*.aac".to_string(), "*.wma".to_string(),
                "*.m4a".to_string(), "*.opus".to_string(), "*.aiff".to_string(),
                
                // ============================================
                // FONTS
                // ============================================
                "*.woff".to_string(), "*.woff2".to_string(), "*.ttf".to_string(),
                "*.otf".to_string(), "*.eot".to_string(),
                
                // ============================================
                // ARCHIVES
                // ============================================
                "*.zip".to_string(), "*.tar".to_string(), "*.gz".to_string(),
                "*.bz2".to_string(), "*.xz".to_string(), "*.rar".to_string(),
                "*.7z".to_string(), "*.tgz".to_string(), "*.tbz2".to_string(),
                "*.lz".to_string(), "*.lzma".to_string(), "*.cab".to_string(),
                "*.iso".to_string(), "*.zst".to_string(), "*.lz4".to_string(), "*.br".to_string(),
                
                // ============================================
                // DOCUMENTS
                // ============================================
                "*.pdf".to_string(), "*.doc".to_string(), "*.docx".to_string(),
                "*.xls".to_string(), "*.xlsx".to_string(), "*.ppt".to_string(),
                "*.pptx".to_string(), "*.odt".to_string(), "*.ods".to_string(),
                "*.odp".to_string(), "*.rtf".to_string(),
                
                // ============================================
                // DATABASE FILES
                // ============================================
                "*.db".to_string(), "*.sqlite".to_string(), "*.sqlite3".to_string(),
                "*.mdb".to_string(), "*.accdb".to_string(),
                
                // ============================================
                // LOG / BACKUP / TEMP
                // ============================================
                "*.log".to_string(), "*.bak".to_string(), "*.backup".to_string(),
                "*.tmp".to_string(), "*.temp".to_string(),
                "*.swp".to_string(), "*.swo".to_string(), "*.swn".to_string(),
                
                // ============================================
                // OS SPECIFIC
                // ============================================
                ".DS_Store".to_string(), "Thumbs.db".to_string(), "desktop.ini".to_string(),
                
                // ============================================
                // CERTIFICATES / KEYS
                // ============================================
                "*.pem".to_string(), "*.crt".to_string(), "*.cer".to_string(),
                "*.p12".to_string(), "*.pfx".to_string(), "*.jks".to_string(),
            ],
            ignored_directories: vec![
                // ============================================
                // VERSION CONTROL
                // ============================================
                ".git".to_string(), ".svn".to_string(), ".hg".to_string(),
                ".bzr".to_string(), "_darcs".to_string(), ".fossil".to_string(),
                
                // ============================================
                // JAVASCRIPT / NODE.JS / WEB
                // ============================================
                "node_modules".to_string(),
                ".npm".to_string(), ".pnpm".to_string(), ".pnpm-store".to_string(),
                ".yarn".to_string(), ".yarn-cache".to_string(),
                "bower_components".to_string(),
                ".parcel-cache".to_string(), ".cache".to_string(),
                ".turbo".to_string(), ".vercel".to_string(), ".netlify".to_string(),
                ".next".to_string(), ".nuxt".to_string(), ".output".to_string(),
                ".svelte-kit".to_string(), ".astro".to_string(),
                ".docusaurus".to_string(), ".vuepress".to_string(), ".vitepress".to_string(),
                "storybook-static".to_string(),
                
                // ============================================
                // PYTHON
                // ============================================
                "__pycache__".to_string(), ".pytest_cache".to_string(), ".mypy_cache".to_string(),
                ".ruff_cache".to_string(), ".pytype".to_string(),
                "venv".to_string(), ".venv".to_string(), "env".to_string(), ".env".to_string(),
                "virtualenv".to_string(), ".virtualenv".to_string(),
                ".conda".to_string(), "conda-meta".to_string(),
                ".tox".to_string(), ".nox".to_string(),
                "*.egg-info".to_string(), ".eggs".to_string(),
                "site-packages".to_string(), "dist-packages".to_string(),
                ".ipynb_checkpoints".to_string(),
                "htmlcov".to_string(),
                
                // ============================================
                // RUST
                // ============================================
                "target".to_string(), ".cargo".to_string(),
                
                // ============================================
                // GO
                // ============================================
                "vendor".to_string(), "pkg".to_string(),
                
                // ============================================
                // JAVA / KOTLIN / GRADLE / MAVEN
                // ============================================
                ".gradle".to_string(), "gradle".to_string(),
                ".m2".to_string(), ".mvn".to_string(),
                "bin".to_string(),
                ".apt_generated".to_string(),
                "generated-sources".to_string(),
                
                // ============================================
                // .NET / C#
                // ============================================
                "obj".to_string(), "packages".to_string(), ".nuget".to_string(),
                "Debug".to_string(), "Release".to_string(),
                "x64".to_string(), "x86".to_string(), "ARM".to_string(), "ARM64".to_string(),
                "TestResults".to_string(),
                
                // ============================================
                // C / C++
                // ============================================
                "CMakeFiles".to_string(),
                "cmake-build-debug".to_string(), "cmake-build-release".to_string(),
                ".ccache".to_string(), ".sccache".to_string(),
                "MinSizeRel".to_string(), "RelWithDebInfo".to_string(),
                
                // ============================================
                // RUBY
                // ============================================
                ".bundle".to_string(), ".gem".to_string(), "gems".to_string(),
                
                // ============================================
                // PHP
                // ============================================
                ".phpunit.cache".to_string(),
                
                // ============================================
                // SWIFT / IOS / MACOS
                // ============================================
                ".build".to_string(), "Build".to_string(),
                "DerivedData".to_string(), "Pods".to_string(),
                ".swiftpm".to_string(), "Carthage".to_string(),
                "xcuserdata".to_string(),
                
                // ============================================
                // ANDROID
                // ============================================
                "app/build".to_string(),
                ".cxx".to_string(), ".externalNativeBuild".to_string(),
                "captures".to_string(), ".navigation".to_string(),
                
                // ============================================
                // FLUTTER / DART
                // ============================================
                ".dart_tool".to_string(), ".pub-cache".to_string(), ".pub".to_string(),
                ".flutter-plugins".to_string(), "ephemeral".to_string(),
                
                // ============================================
                // ELECTRON / TAURI
                // ============================================
                "release".to_string(), "src-tauri/target".to_string(),
                ".webpack".to_string(), ".electron".to_string(),
                
                // ============================================
                // UNITY / GAME DEV
                // ============================================
                "Library".to_string(), "Temp".to_string(), "Obj".to_string(),
                "Builds".to_string(), "Logs".to_string(),
                "UserSettings".to_string(), "MemoryCaptures".to_string(),
                
                // ============================================
                // UNREAL ENGINE
                // ============================================
                "Binaries".to_string(), "Intermediate".to_string(), "Saved".to_string(),
                "DerivedDataCache".to_string(),
                
                // ============================================
                // JUCE (Audio Development)
                // ============================================
                "JuceLibraryCode".to_string(),
                
                // ============================================
                // TIZEN
                // ============================================
                ".sign".to_string(), "Debug-Tizen".to_string(), "Release-Tizen".to_string(),
                
                // ============================================
                // IDE / EDITOR CONFIGS
                // ============================================
                ".idea".to_string(), ".vscode".to_string(), ".vs".to_string(),
                ".cursor".to_string(), ".atom".to_string(), ".sublime".to_string(),
                ".eclipse".to_string(), ".settings".to_string(),
                ".metals".to_string(), ".bloop".to_string(), ".bsp".to_string(),
                
                // ============================================
                // BUILD OUTPUTS (GENERIC)
                // ============================================
                "dist".to_string(), "build".to_string(), "out".to_string(), "output".to_string(),
                "_build".to_string(),
                "generated".to_string(), "gen".to_string(), "auto-generated".to_string(),
                
                // ============================================
                // TESTING / COVERAGE
                // ============================================
                "coverage".to_string(), ".nyc_output".to_string(),
                "test-results".to_string(), "test-output".to_string(),
                "__tests__".to_string(), "__mocks__".to_string(),
                ".jest".to_string(), "jest-cache".to_string(),
                "cypress/videos".to_string(), "cypress/screenshots".to_string(),
                "playwright-report".to_string(),
                
                // ============================================
                // DOCUMENTATION (Generated)
                // ============================================
                "docs/_build".to_string(), "site".to_string(), "_site".to_string(),
                "javadoc".to_string(), "apidoc".to_string(), "doxygen".to_string(),
                "typedoc".to_string(), "rustdoc".to_string(),
                
                // ============================================
                // LOGS / TEMP
                // ============================================
                "logs".to_string(), "log".to_string(),
                "tmp".to_string(), "temp".to_string(), ".tmp".to_string(), ".temp".to_string(),
                
                // ============================================
                // AURORA / PROJECT SPECIFIC
                // ============================================
                ".aurora".to_string(),
                
                // ============================================
                // CLOUD / INFRASTRUCTURE
                // ============================================
                ".terraform".to_string(), ".pulumi".to_string(),
                ".serverless".to_string(), ".amplify".to_string(),
                "cdk.out".to_string(), ".aws-sam".to_string(),
                ".docker".to_string(), ".vagrant".to_string(),
            ],
            // Specific file paths to exclude (user can add workspace-specific files)
            excluded_files: vec![],
            // Specific directory paths to exclude (user can add workspace-specific dirs)
            excluded_directories: vec![],
            max_file_size: 524_288, // 512KB - reduced from 1MB to prevent large files
            search_mode: SearchMode::Hybrid,
            lexical_weight: 0.4,
            semantic_weight: 0.6,
            updated_at: String::new(),
        }
    }
}

/// Indexing progress update
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub workspace_id: String,
    pub phase: String,
    pub processed: i64,
    pub total: i64,
    pub current_file: Option<String>,
    pub percentage: f64,
}

/// Search result from semantic search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchResult {
    pub file_path: String,
    pub relative_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub chunk_type: String,
    pub symbol_name: Option<String>,
    pub content: String,
    pub score: f32,
    pub match_type: String, // "lexical" | "semantic" | "hybrid"
}