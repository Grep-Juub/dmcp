# DMCP Indexer

Standalone CLI tool for indexing MCP tools into Redis for semantic search.

## Research Foundation

Based on **"Retrieval Models Aren't Tool-Savvy"** (Shi et al., ACL 2025 Findings):

- 📄 [Paper](https://aclanthology.org/2025.findings-acl.1258.pdf) | [GitHub](https://github.com/mangopy/tool-retrieval-benchmark) | [Leaderboard](https://huggingface.co/spaces/mangopy/ToolRet-leaderboard)
- 🤗 [Model: mangopy/ToolRet-trained-e5-large-v2](https://huggingface.co/mangopy/ToolRet-trained-e5-large-v2)

## Features

- **Auto-discovery**: Reads MCP server config from Agent Gateway
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
| `MCP_GATEWAY_URL` | http://127.0.0.1:15000/config_dump | Agent Gateway config endpoint |
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | Model ID |

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI with parallel discovery |
| `src/redis-vss.ts` | Redis vector search |
| `src/custom-embedding-provider.ts` | Embedding service client |

## How It Works

1. Fetches MCP server config from Agent Gateway (`/config_dump`)
2. Connects to servers in parallel (10 concurrent)
3. Discovers all available tools from each server
4. Generates embeddings via local embedding service
5. Stores tools + vectors in Redis with HNSW index

## CLI Options

```bash
npm run index -- --help

Options:
  --gateway-url <url>   Agent Gateway config URL
  --redis-host <host>   Redis server host
  --redis-port <port>   Redis server port
  --embedding-url <url> Embedding service URL
  --server, -s <name>   Index only specific server
  --force, -f           Force re-index (clear existing)
```

See the [root README](../README.md) for full project documentation.
