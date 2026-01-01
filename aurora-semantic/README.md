# Aurora Semantic

A **local, embedded semantic search engine** for source code, designed to be bundled directly inside desktop IDEs.

Pure Rust implementation using ONNX Runtime for embedding inference - no Python required.

## Features

- **Hybrid Search** - Combines lexical (keyword) and semantic (AI) search
- **Fast Indexing** - Parallel file processing with progress reporting
- **Persistent Indexes** - Save/reload indexes efficiently
- **Smart Chunking** - Extracts functions, classes, structs by language
- **Ignore Rules** - Respects .gitignore and custom patterns
- **Extensible** - Trait-based design for custom embedders
- **Pure Rust** - No Python, uses ONNX Runtime
- **GPU Support** - Optional CUDA, TensorRT, DirectML, CoreML acceleration

## Quick Start

### Installation

```bash
# Clone and build
git clone https://github.com/aurora-editor/aurora-semantic
cd aurora-semantic
cargo build --release

# Install CLI
cargo install --path .
```

### CLI Usage

```bash
# Index a codebase (uses hash embeddings by default)
aurora index ./my-project

# Index with an ONNX model for semantic search
aurora --model ./models/jina-code index ./my-project

# Search
aurora search "authentication middleware"

# Search with options
aurora search "error handling" --limit 20 --mode semantic

# List indexed workspaces
aurora list

# Show statistics
aurora stats

# Delete a workspace
aurora delete <workspace-id>
```

### Library Usage

```rust
use aurora_semantic::{Engine, EngineConfig, WorkspaceConfig, SearchQuery, ModelConfig};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> aurora_semantic::Result<()> {
    // Option 1: Use hash embeddings (fast, no model needed)
    let config = EngineConfig::new(PathBuf::from(".aurora"));
    let engine = Engine::new(config)?;

    // Option 2: Use ONNX model for semantic search
    let embedder = ModelConfig::from_directory("./models/jina-code")
        .with_max_length(8192)
        .load()?;
    let engine = Engine::with_embedder(config, embedder)?;

    // Index a workspace
    let ws_config = WorkspaceConfig::new(PathBuf::from("./my-project"));
    let workspace_id = engine.index_workspace(ws_config, None).await?;

    // Search
    let results = engine.search_text(&workspace_id, "database connection")?;

    for result in results {
        println!("{}: {} (score: {:.2})",
            result.document.relative_path.display(),
            result.chunk.symbol_name.as_deref().unwrap_or("unknown"),
            result.score
        );
    }

    Ok(())
}
```

## Using ONNX Models

Aurora uses ONNX Runtime for local model inference. You need to download models yourself.

### Recommended Models

| Model | Dimension | Max Length | Use Case |
|-------|-----------|------------|----------|
| `jina-code-embeddings-1.5b` | 1536 | 32768 | **Best for code** (15+ languages, task prefixes) |
| `jina-embeddings-v2-base-code` | 768 | 8192 | Code search (30 languages) |
| `all-MiniLM-L6-v2` | 384 | 512 | General text |

### Jina Code Embeddings 1.5B (Recommended)

The jina-code-embeddings-1.5b model offers:
- **Task-specific prefixes** for NL2Code, Code2Code, Code2NL, Code2Completion, QA
- **Matryoshka dimensions** - truncate to 128, 256, 512, 1024, or 1536
- **32K context window** - handles large code files
- **Last-token pooling** - optimized for Qwen2.5-Coder backbone

```rust
use aurora_semantic::{JinaCodeEmbedder, EmbeddingTask, MatryoshkaDimension};

// Load the model
let embedder = JinaCodeEmbedder::from_directory("./models/jina-code-1.5b")?
    .with_task(EmbeddingTask::NL2Code)
    .with_dimension(MatryoshkaDimension::D512);  // 512-dim for faster search

// Index code with PASSAGE prefix
let code_embedding = embedder.embed_passage("fn parse_json(s: &str) -> Value { serde_json::from_str(s).unwrap() }")?;

// Search with QUERY prefix (asymmetric retrieval)
let query_embedding = embedder.embed_query("function to parse JSON string")?;
```

#### Task Types

| Task | Query Use Case | Passage Use Case |
|------|---------------|------------------|
| `NL2Code` | Natural language query | Code snippets |
| `Code2Code` | Code snippet | Similar code |
| `Code2NL` | Code snippet | Comments/docs |
| `Code2Completion` | Partial code | Completions |
| `QA` | Tech question | Answers |

### Model Directory Structure

```
models/jina-code-1.5b/
├── model.onnx          # ONNX model file
├── tokenizer.json      # HuggingFace tokenizer
└── config.json         # Optional: model config
```

### Downloading Models

**Download Jina Code 1.5B:**

```bash
# Create directory
mkdir -p models/jina-code-1.5b

# Download from HuggingFace (export with optimum first)
pip install optimum[exporters]
optimum-cli export onnx --model jinaai/jina-code-embeddings-1.5b ./models/jina-code-1.5b
```

### Loading Models in Code

```rust
use aurora_semantic::{OnnxEmbedder, ModelConfig, JinaCodeConfig, EmbeddingTask};

// Generic ONNX model
let embedder = OnnxEmbedder::from_directory("./models/jina-v2")?;

// Jina Code 1.5B with full configuration
let embedder = JinaCodeConfig::from_directory("./models/jina-code-1.5b")
    .with_task(EmbeddingTask::NL2Code)
    .with_dimension(MatryoshkaDimension::D1024)
    .with_max_length(8192)  // Limit context if needed
    .load()?;
```

## Project Structure

```
aurora-semantic/
├── src/
│   ├── lib.rs              # Public API exports
│   ├── types.rs            # Core types (Document, Chunk, SearchResult)
│   ├── config.rs           # Configuration types
│   ├── error.rs            # Error types
│   ├── bin/
│   │   └── aurora.rs       # CLI binary
│   ├── chunker/
│   │   ├── mod.rs          # Code chunking trait + default
│   │   └── strategies.rs   # Chunking strategies
│   ├── embeddings/
│   │   ├── mod.rs          # Embedder trait
│   │   ├── providers.rs    # ONNX + Hash embedders
│   │   └── pooling.rs      # Pooling strategies
│   ├── search/
│   │   ├── mod.rs          # Search coordination
│   │   ├── lexical.rs      # Tantivy-based search
│   │   ├── semantic.rs     # Vector similarity search
│   │   └── query.rs        # Query types + filters
│   ├── storage/
│   │   ├── mod.rs          # Storage trait
│   │   ├── disk.rs         # Disk persistence
│   │   └── metadata.rs     # Workspace metadata
│   ├── ignore/
│   │   └── mod.rs          # File filtering
│   └── engine/
│       └── mod.rs          # Main Engine API
├── Cargo.toml
└── README.md
```

## Configuration

### EngineConfig

```rust
let config = EngineConfig::new(PathBuf::from(".aurora"))
    .with_chunking(ChunkingConfig {
        max_chunk_size: 2000,
        min_chunk_size: 50,
        ..Default::default()
    })
    .with_search(SearchConfig {
        default_mode: SearchMode::Hybrid,
        lexical_weight: 0.4,
        semantic_weight: 0.6,
        min_score: 0.1,
        ..Default::default()
    })
    .with_ignore(IgnoreConfig::default()
        // Exclude specific files by path (relative to workspace root)
        .with_excluded_file("src/generated/types.rs")
        .with_excluded_files(vec![
            "src/proto/generated.rs".into(),
            "src/bindings/ffi.rs".into(),
        ])
        // Exclude specific directories by path
        .with_excluded_directory("vendor/third-party")
        .with_excluded_directories(vec![
            "generated".into(),
            "node_modules/@types".into(),
        ])
        // Add extra ignored directory names (matched anywhere in path)
        .with_ignored_directory("my-custom-vendor")
    );
```

> **Note:** The `.aurora` index directory is automatically excluded by default to prevent self-indexing.

### Search Modes

- **Lexical** - Keyword-based search using Tantivy (fast, exact matches)
- **Semantic** - Embedding similarity search (understands meaning)
- **Hybrid** - Combines both with configurable weights (default)

```rust
use aurora_semantic::{SearchQuery, SearchMode, SearchFilter};

let query = SearchQuery::new("authentication")
    .mode(SearchMode::Hybrid)
    .limit(20)
    .min_score(0.3)
    .filter(SearchFilter::new()
        .languages(vec![Language::Rust, Language::TypeScript])
        .chunk_types(vec![ChunkType::Function]));
```

## Supported Languages

Aurora extracts semantic chunks (functions, classes, etc.) from:

- Rust
- Python
- JavaScript / TypeScript
- Go
- Java
- C / C++

Other languages use generic line-based chunking.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AURORA_MODEL_PATH` | Path to ONNX model directory | None |
| `RUST_LOG` | Logging level | `info` |

## Developer Integration

### Implementing Custom Embedder

```rust
use aurora_semantic::{Embedder, Result};

struct MyEmbedder {
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

    fn dimension(&self) -> usize {
        self.dimension
    }

    fn name(&self) -> &'static str {
        "my-embedder"
    }
}

// Use it
let engine = Engine::with_embedder(config, MyEmbedder { dimension: 768 })?;
```

### Progress Reporting

```rust
let progress_callback = Box::new(|progress: IndexProgress| {
    match progress.phase {
        IndexPhase::Scanning => println!("Scanning files..."),
        IndexPhase::Parsing => println!("Parsing {}/{}", progress.processed, progress.total),
        IndexPhase::Embedding => println!("Generating embeddings..."),
        IndexPhase::Complete => println!("Done!"),
        _ => {}
    }
});

engine.index_workspace(ws_config, Some(progress_callback)).await?;
```

## GPU Acceleration

Aurora supports GPU acceleration via ONNX Runtime execution providers:

| Feature | Platform | Requirements |
|---------|----------|--------------|
| `cuda` | NVIDIA GPUs | CUDA 11.x/12.x toolkit |
| `tensorrt` | NVIDIA GPUs | TensorRT 8.x |
| `directml` | Windows (AMD/Intel/NVIDIA) | DirectX 12 |
| `coreml` | macOS (Apple Silicon) | macOS 11+ |

Build with GPU support:

```bash
# NVIDIA CUDA
cargo build --release --features cuda

# Windows DirectML (works with any GPU)
cargo build --release --features directml

# macOS Apple Silicon
cargo build --release --features coreml
```

### Detecting GPU at Runtime

```rust
use aurora_semantic::{OnnxEmbedder, ExecutionProviderInfo};

let embedder = OnnxEmbedder::from_directory("./models/jina-code")?;
let provider_info = embedder.execution_provider_info();

println!("Using: {} ({})", provider_info.name, provider_info.provider_type);
// Output: "Using: CUDA (gpu)" or "Using: CPU (cpu)"
```

The embedder automatically uses GPU when available, falling back to CPU otherwise.

## Performance

- **Indexing**: ~1000 files/second (without embeddings), ~100 files/second (with ONNX on CPU)
- **Indexing with GPU**: ~500+ files/second (with ONNX on GPU)
- **Search**: <10ms for lexical, <50ms for semantic
- **Memory**: ~100MB base + ~1KB per indexed chunk
- **Disk**: ~2x source size for full index

## License

MIT

## Contributing

Contributions welcome! Please read CONTRIBUTING.md first.
