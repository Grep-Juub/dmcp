# DMCP Indexer

Standalone CLI tool for indexing MCP tools into Redis for semantic search.

## Features

- **Parallel discovery**: Connects to 10 MCP servers concurrently
- **Beautiful CLI**: Progress bars, colored output, summary stats
- **Independent**: No shared dependencies with server

## Quick Start

```bash
npm install
npm run index         # Index all tools
npm run index:force   # Force re-index (clear existing)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | Model ID |
| `MCP_CONFIG_PATH` | ./mcp.json | Path to MCP servers config |

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI with parallel discovery |
| `src/redis-vss.ts` | Redis vector search |
| `src/custom-embedding-provider.ts` | Embedding service client |

## How It Works

1. Reads MCP server config from `mcp.json`
2. Connects to servers in parallel (10 concurrent)
3. Discovers all available tools
4. Generates embeddings via embedding service
5. Stores tools + vectors in Redis

See the [root README](../README.md) for full project documentation.
