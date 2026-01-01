# Aurora Semantic - Developer Integration Guide

This guide covers integrating Aurora Semantic into your IDE or application.

## Table of Contents

1. [Installation](#installation)
2. [Basic Integration](#basic-integration)
3. [Embedding Models](#embedding-models)
   - [Jina Code 1.5B (Recommended)](#jina-code-embeddings-15b-recommended)
   - [Legacy ONNX Models](#legacy-onnx-models)
4. [Custom Embedders](#custom-embedders)
5. [Search API](#search-api)
6. [File Exclusion](#file-exclusion)
7. [Progress Reporting](#progress-reporting)
8. [Workspace Management](#workspace-management)
9. [Best Practices](#best-practices)
10. [Troubleshooting](#troubleshooting)

---

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
aurora-semantic = "1.2"
tokio = { version = "1", features = ["full"] }
```

For GPU acceleration:

```toml
[dependencies.aurora-semantic]
version = "1.2"
features = ["cuda"]  # or "directml" for AMD/Intel, "coreml" for Apple
```

---

## Basic Integration

### Minimal Example

```rust
use aurora_semantic::{Engine, EngineConfig, WorkspaceConfig};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> aurora_semantic::Result<()> {
    // Create engine with default config
    let engine = Engine::new(EngineConfig::default())?;

    // Index current directory
    let ws_config = WorkspaceConfig::new(PathBuf::from("."));
    let workspace_id = engine.index_workspace(ws_config, None).await?;

    // Search
    let results = engine.search_text(&workspace_id, "main function")?;

    println!("Found {} results", results.len());
    Ok(())
}
```

### IDE Integration Pattern

```rust
use aurora_semantic::{
    Engine, EngineConfig, WorkspaceConfig,
    JinaCodeEmbedder, EmbeddingTask, MatryoshkaDimension
};
use std::path::PathBuf;
use std::sync::Arc;

pub struct CodeSearchService {
    engine: Arc<Engine>,
    workspace_id: Option<aurora_semantic::WorkspaceId>,
}

impl CodeSearchService {
    /// Initialize with Jina Code 1.5B model
    pub fn new(index_dir: PathBuf, model_dir: PathBuf) -> aurora_semantic::Result<Self> {
        let config = EngineConfig::new(index_dir);

        let embedder = JinaCodeEmbedder::from_directory(model_dir)?
            .with_task(EmbeddingTask::NL2Code)
            .with_dimension(MatryoshkaDimension::D512);

        let engine = Engine::with_embedder(config, embedder)?;

        Ok(Self {
            engine: Arc::new(engine),
            workspace_id: None,
        })
    }
}
```

---

## Embedding Models

Aurora supports multiple embedding models through its flexible embedder architecture.

### Jina Code Embeddings 1.5B (Recommended)

The **jina-code-embeddings-1.5b** model is the recommended choice for code search:

| Feature | Value |
|---------|-------|
| Base Model | Qwen2.5-Coder-1.5B |
| Dimensions | 1536 (truncatable to 128, 256, 512, 1024) |
| Max Context | 32,768 tokens |
| Languages | 15+ programming languages |
| Pooling | Last-token |

#### Task-Specific Instruction Prefixes

The model uses different instruction prefixes for queries and passages (asymmetric retrieval):

| Task | Query Prefix | Passage Prefix |
|------|-------------|----------------|
| **NL2Code** | `Find the most relevant code snippet given the following query:\n` | `Candidate code snippet:\n` |
| **Code2Code** | `Find an equivalent code snippet given the following code snippet:\n` | `Candidate code snippet:\n` |
| **Code2NL** | `Find the most relevant comment given the following code snippet:\n` | `Candidate comment:\n` |
| **Code2Completion** | `Find the most relevant completion given the following start of code snippet:\n` | `Candidate completion:\n` |
| **QA** | `Find the most relevant answer given the following question:\n` | `Candidate answer:\n` |

#### Basic Usage

```rust
use aurora_semantic::{
    JinaCodeEmbedder, JinaCodeConfig,
    EmbeddingTask, MatryoshkaDimension
};

// Method 1: Direct loading
let embedder = JinaCodeEmbedder::from_directory("./models/jina-code-1.5b")?
    .with_task(EmbeddingTask::NL2Code)
    .with_dimension(MatryoshkaDimension::D512);

// Method 2: Config-based loading
let embedder = JinaCodeConfig::from_directory("./models/jina-code-1.5b")
    .with_task(EmbeddingTask::NL2Code)
    .with_dimension(MatryoshkaDimension::D1024)
    .with_max_length(8192)
    .load()?;
```

#### Asymmetric Embedding (Important!)

For optimal search quality, use different methods for queries and documents:

```rust
// When INDEXING code - use embed_passage()
let code_embedding = embedder.embed_passage("fn parse_json(s: &str) -> Value { ... }")?;

// When SEARCHING - use embed_query()
let query_embedding = embedder.embed_query("function to parse JSON string")?;

// Batch operations
let code_embeddings = embedder.embed_passages(&["fn foo() {}", "fn bar() {}"])?;
let query_embeddings = embedder.embed_queries(&["find foo", "find bar"])?;
```

#### Matryoshka Dimension Truncation

Reduce storage and increase speed with minimal quality loss:

```rust
use aurora_semantic::MatryoshkaDimension;

// Available dimensions
MatryoshkaDimension::D128   // Smallest, fastest
MatryoshkaDimension::D256
MatryoshkaDimension::D512   // Good balance
MatryoshkaDimension::D1024
MatryoshkaDimension::D1536  // Full quality (default)
```

#### Downloading Jina Code 1.5B

```bash
# Create directory
mkdir -p models/jina-code-1.5b

# Export with optimum (Python required)
pip install optimum[exporters]
optimum-cli export onnx --model jinaai/jina-code-embeddings-1.5b ./models/jina-code-1.5b
```

---

### Legacy ONNX Models

Aurora also supports any standard ONNX embedding model:

| Model | Dimension | Context | Use Case |
|-------|-----------|---------|----------|
| `jina-embeddings-v2-base-code` | 768 | 8192 | Code (30 languages) |
| `all-MiniLM-L6-v2` | 384 | 512 | General text |
| `bge-small-en-v1.5` | 384 | 512 | English text |

#### Loading Legacy Models

```rust
use aurora_semantic::{OnnxEmbedder, ModelConfig};

// Simple loading
let embedder = OnnxEmbedder::from_directory("./models/jina-v2")?;

// With custom settings
let embedder = ModelConfig::from_directory("./models/jina-v2")
    .with_max_length(8192)
    .with_dimension(768)
    .load()?;

// Create engine
let engine = Engine::with_embedder(config, embedder)?;
```

#### Downloading Legacy Models

```bash
# Option 1: Direct download
mkdir -p models/jina-v2
curl -L -o models/jina-v2/model.onnx \
    "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/onnx/model.onnx"
curl -L -o models/jina-v2/tokenizer.json \
    "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/tokenizer.json"

# Option 2: Export with optimum
optimum-cli export onnx --model jinaai/jina-embeddings-v2-base-code ./models/jina-v2
```

---

## Custom Embedders

Implement the `Embedder` trait for custom providers:

```rust
use aurora_semantic::{Embedder, Result};

pub struct MyEmbedder {
    dimension: usize,
}

impl Embedder for MyEmbedder {
    fn embed(&self, text: &str) -> Result<Vec<f32>> {
        // Your embedding logic
        Ok(vec![0.0; self.dimension])
    }

    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        texts.iter().map(|t| self.embed(t)).collect()
    }

    fn dimension(&self) -> usize { self.dimension }
    fn name(&self) -> &'static str { "my-embedder" }
}
```

---

## Search API

### Basic Search

```rust
use aurora_semantic::{SearchQuery, SearchMode};

// Simple
let results = engine.search_text(&workspace_id, "error handling")?;

// With options
let query = SearchQuery::new("authentication")
    .mode(SearchMode::Hybrid)
    .limit(50)
    .min_score(0.3);

let results = engine.search(&workspace_id, query)?;
```

### Filtered Search

```rust
use aurora_semantic::{SearchFilter, Language, ChunkType};

let query = SearchQuery::new("database")
    .filter(SearchFilter::new()
        .languages(vec![Language::Rust, Language::TypeScript])
        .chunk_types(vec![ChunkType::Function])
        .path_patterns(vec!["**/src/**".into()]));
```

---

## File Exclusion

### Path-Based Exclusion

Exclude specific files and directories by path:

```rust
use aurora_semantic::IgnoreConfig;
use std::path::PathBuf;

let config = EngineConfig::new(index_dir)
    .with_ignore(IgnoreConfig::default()
        // Exclude specific files
        .with_excluded_file("src/generated/types.rs")
        .with_excluded_files(vec![
            "src/proto/generated.rs".into(),
            "src/bindings/ffi.rs".into(),
        ])
        // Exclude specific directories (by path)
        .with_excluded_directory("vendor/third-party")
        .with_excluded_directories(vec![
            "generated".into(),
            "node_modules/@types".into(),
        ])
        // Exclude directories by name (matched anywhere)
        .with_ignored_directory("my-vendor")
    );
```

> **Note:** The `.aurora` index directory is automatically excluded by default.

---

## Progress Reporting

```rust
use aurora_semantic::{IndexProgress, IndexPhase};

let callback = Box::new(|progress: IndexProgress| {
    match progress.phase {
        IndexPhase::Scanning => println!("Scanning files..."),
        IndexPhase::Parsing => println!("Parsing: {:?}", progress.current_file),
        IndexPhase::Embedding => println!("Embedding {}/{}", progress.processed, progress.total),
        IndexPhase::Indexing => println!("Building index..."),
        IndexPhase::Persisting => println!("Saving..."),
        IndexPhase::Complete => println!("Done!"),
    }
});

engine.index_workspace(ws_config, Some(callback)).await?;
```

---

## Workspace Management

```rust
// List workspaces
let workspaces = engine.list_workspaces()?;

// Get stats
let stats = engine.get_workspace_stats(&workspace_id)?;
println!("Documents: {}, Chunks: {}", stats.document_count, stats.chunk_count);

// Load existing
engine.load_workspace(&workspace_id)?;

// Delete
engine.delete_workspace(&workspace_id)?;
```

---

## Best Practices

### Model Selection

| Use Case | Recommended Model | Dimension |
|----------|-------------------|-----------|
| **Best quality** | jina-code-embeddings-1.5b | 1536 |
| **Balanced** | jina-code-embeddings-1.5b | 512 (Matryoshka) |
| **Fast/lightweight** | jina-embeddings-v2-base-code | 768 |
| **Testing** | HashEmbedder | N/A |

### Search Weights

```rust
// Keyword-heavy (exact matches)
SearchConfig { lexical_weight: 0.7, semantic_weight: 0.3, .. }

// Conceptual (similar meaning)
SearchConfig { lexical_weight: 0.2, semantic_weight: 0.8, .. }
```

### Search Quality Features

Aurora includes automatic optimizations for high-quality search results:

- **Asymmetric Retrieval**: When using `JinaCodeEmbedder`, queries use query-specific instruction prefixes while indexed code uses passage prefixes. This is handled automatically.

- **Length Penalty**: Short code chunks (< 200 chars) are down-weighted to prevent them from dominating results. This helps surface meaningful code over trivial snippets.

---

## Troubleshooting

### Model Loading Fails

Ensure your model directory contains:
- `model.onnx` (or `model_optimized.onnx`)
- `tokenizer.json`

### Out of Memory

```rust
.with_embedding(EmbeddingConfig { batch_size: 8, .. })
```

### Slow Indexing

1. Use Matryoshka dimension truncation (512 or lower)
2. Enable parallel processing
3. Exclude large directories (`node_modules`, `target`)

---

## API Reference

See the [rustdoc documentation](https://docs.rs/aurora-semantic) for complete API reference.
