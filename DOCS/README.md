# Aurora Project Documentation

This directory contains comprehensive documentation for the Aurora AI-powered code editor project.

## Documentation Files

### [01-ARCHITECTURE.md](./01-ARCHITECTURE.md)
High-level architecture overview covering:
- Project overview and technology stack
- **Comprehensive theming architecture** with strict rules against hardcoded components
- Directory structure and core components
- State management (18 specialized Zustand stores)
- Database persistence system (SQLite)
- Tool system architecture with MCP support
- LLM provider system
- Git integration system
- Checkpoint/restore system
- Semantic search system
- Data flow patterns
- Entry points and external dependencies
- 15 unique features of the editor

### [02-CODE-STYLE-PATTERNS.md](./02-CODE-STYLE-PATTERNS.md)
Code conventions and development standards:
- Naming conventions (camelCase, PascalCase, SCREAMING_SNAKE_CASE)
- Code organization patterns
- Design patterns used throughout the codebase
- Error handling and logging strategies
- Testing patterns and framework configuration
- **Theming and styling rules** - absolute prohibition of hardcoded styles
- Formatting standards and tool configurations
- Performance considerations

### [03-EXPANSION-GUIDE.md](./03-EXPANSION-GUIDE.md)
Development workflow and contribution guide:
- Getting started and environment setup
- Running the application (development/production)
- Testing procedures and requirements
- Adding new features, components, and modules
- State management with 18 specialized stores
- Common workflows (MCP, Git, Checkpoints, Semantic Search)
- Creating custom hooks and tools
- Debugging and troubleshooting
- Build and deployment processes
- Git workflow and performance tips

## Additional Resources

### [theme-dev.md](./theme-dev.md)
Theme development guide for creating custom Aurora themes.

### [../models-provider-docs/](../models-provider-docs/)
Documentation for LLM provider integrations (GLM, DeepSeek, etc.).

### [../README.md](../README.md)
Original project README with development commands and architecture notes.

## Key Architectural Principles

1. **Theme Token Mandatory**: All components must use theme tokens. Hardcoded colors, styles, or Tailwind classes are strictly prohibited.

2. **State Management via Zustand**: 18 specialized stores manage different application domains with proper persistence.

3. **Repository Pattern**: Database access through typed repositories with error handling.

4. **Tool Approval System**: AI tools require user approval with granular per-tool settings.

5. **Cross-Platform Compatibility**: Desktop application built with Tauri, supporting Windows, macOS, and Linux.

6. **MCP Protocol Support**: Extensible tool system via Model Context Protocol servers.

7. **Git Integration**: Full Git operations within the editor.

8. **Checkpoint/Restore**: Workspace state snapshots and restoration.

9. **Semantic Search**: AI-powered code search using embeddings.

10. **Rust-Backed Services**: Thread persistence, token counting, and more via Rust for performance.

## Development Workflow

1. Read relevant documentation sections
2. Follow code style patterns and theming rules
3. Use expansion guide for adding new features
4. Test with multiple themes and providers
5. Follow Git workflow for contributions

## Quick Reference

- **State Stores**: 18 specialized stores in `src/store/`
- **Services**: 25+ services including Git, MCP, Checkpoints, Semantic Search
- **Components**: 66 components organized by feature (agent, chat, editor, git, etc.)
- **Tools**: 23 tool definitions and executors
- **Hooks**: 13 custom hooks for common patterns

For questions or clarifications, refer to the specific documentation files or check existing code examples.
