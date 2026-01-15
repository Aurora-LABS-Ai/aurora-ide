Daedra is a high-performance web search and research Model Context Protocol (MCP) server written in Rust. It provides web search and page fetching capabilities that can be used with AI assistants like Claude.

Features
🔎 Web Search: Search the web using DuckDuckGo with customizable options
📄 Page Fetching: Extract and convert web page content to Markdown
🚀 High Performance: Built in Rust with async I/O and connection pooling
💾 Caching: Built-in response caching for improved performance
🔌 Dual Transport: Support for both STDIO and HTTP (SSE) transports
📦 Library & CLI: Use as a Rust library or standalone command-line tool
Installation
From crates.io
cargo install daedra
From source
git clone https://github.com/dirmacs/daedra.git
cd daedra
cargo install --path .
Using Cargo
Add to your Cargo.toml:

[dependencies]
daedra = "0.1"
Quick Start
As an MCP Server
STDIO Transport (for Claude Desktop)
Add to your Claude Desktop configuration (claude_desktop_config.json):

{
  "mcpServers": {
    "daedra": {
      "command": "daedra",
      "args": ["serve", "--transport", "stdio"]
    }
  }
}
SSE Transport (HTTP)
daedra serve --transport sse --port 3000 --host 127.0.0.1
As a CLI Tool
Search the web
# Basic search
daedra search "rust programming"

# With options
daedra search "rust async" --num-results 20 --region us-en --safe-search moderate

# Output as JSON
daedra search "rust web frameworks" --format json
Fetch a webpage
# Fetch and extract content
daedra fetch https://rust-lang.org

# Fetch with a specific selector
daedra fetch https://example.com --selector "article.main"

# Output as JSON
daedra fetch https://example.com --format json
Server information
daedra info
Configuration check
daedra check
As a Rust Library
use daedra::{DaedraServer, ServerConfig, TransportType};
use daedra::tools::{search, fetch};
use daedra::types::{SearchArgs, SearchOptions, VisitPageArgs};

// Start an MCP server
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = ServerConfig::default();
    let server = DaedraServer::new(config)?;
    server.run(TransportType::Stdio).await?;
    Ok(())
}

// Or use tools directly
async fn search_example() -> anyhow::Result<()> {
    let args = SearchArgs {
        query: "rust programming".to_string(),
        options: Some(SearchOptions {
            num_results: 10,
            region: "wt-wt".to_string(),
            ..Default::default()
        }),
    };

    let results = search::perform_search(&args).await?;
    println!("Found {} results", results.data.len());

    for result in results.data {
        println!("- {} ({})", result.title, result.url);
    }

    Ok(())
}

async fn fetch_example() -> anyhow::Result<()> {
    let args = VisitPageArgs {
        url: "https://rust-lang.org".to_string(),
        selector: None,
        include_images: false,
    };

    let content = fetch::fetch_page(&args).await?;
    println!("Title: {}", content.title);
    println!("Word count: {}", content.word_count);

    Ok(())
}
MCP Tools
search_duckduckgo
Search the web using DuckDuckGo.

Input Schema:

{
  "query": "search terms",
  "options": {
    "region": "wt-wt",
    "safe_search": "MODERATE",
    "num_results": 10,
    "time_range": "w"
  }
}
Options:

region: Search region (e.g., us-en, wt-wt for worldwide)
safe_search: OFF, MODERATE, or STRICT
num_results: Number of results (1-50)
time_range: Time filter (d=day, w=week, m=month, y=year)
visit_page
Fetch and extract content from a web page.

Input Schema:

{
  "url": "https://example.com",
  "selector": "article.main",
  "include_images": false
}
Options:

url: URL to fetch (required)
selector: CSS selector for specific content (optional)
include_images: Include image references (default: false)
Configuration
Environment Variables
RUST_LOG: Set logging level (debug, info, warn, error)
CLI Options
daedra serve [OPTIONS]

Options:
  -t, --transport <TRANSPORT>  Transport type [default: stdio] [possible values: stdio, sse]
  -p, --port <PORT>            Port for SSE transport [default: 3000]
      --host <HOST>            Host to bind to [default: 127.0.0.1]
      --no-cache               Disable result caching
      --cache-ttl <SECONDS>    Cache TTL in seconds [default: 300]
  -v, --verbose                Enable verbose output
  -f, --format <FORMAT>        Output format [default: pretty] [possible values: pretty, json, json-compact]
      --no-color               Disable colored output
Architecture
┌─────────────────────────────────────────────────────────────┐
│                        CLI Binary                           │
│  (clap argument parsing, colored output, TUI)               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Library (daedra)                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Server     │  │    Tools     │  │    Cache     │       │
│  │  (rmcp MCP)  │  │ (search/     │  │   (moka)     │       │
│  │              │  │  fetch)      │  │              │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
├─────────────────────────────────────────────────────────────┤
│  Transport Layer: STDIO | SSE (HTTP)                         │
└─────────────────────────────────────────────────────────────┘
Performance
Daedra is designed for high performance:

Async I/O: Built on Tokio for efficient async operations
Connection Pooling: HTTP connections are pooled and reused
Caching: Results are cached to avoid redundant requests
Concurrent Processing: Parallel search execution support
Efficient Parsing: Fast HTML parsing with the scraper crate
Development
Prerequisites
Rust 1.91 or later
Cargo
Building
# Debug build
cargo build

# Release build
cargo build --release
Testing
# Run all tests
cargo test

# Run unit tests only
cargo test --lib

# Run integration tests (requires network)
cargo test -- integration

# Run with logging
RUST_LOG=debug cargo test
Benchmarks
cargo bench
Documentation
# Generate and open documentation
cargo doc --open
Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

Fork the repository
Create your feature branch (git checkout -b feature/amazing-feature)
Commit your changes (git commit -m 'Add some amazing feature')
Push to the branch (git push origin feature/amazing-feature)
Open a Pull Request
Code Style
This project uses:

rustfmt for formatting
clippy for linting
Run before committing:

cargo fmt
cargo clippy -- -D warnings
License
This project is licensed under the MIT License - see the LICENSE file for details.

Related Projects
rmcp - Rust MCP SDK
mcp-duckduckresearch - TypeScript inspiration
DIRMACS - Parent organization