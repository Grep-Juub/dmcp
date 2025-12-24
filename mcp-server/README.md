# DMCP Server

Two-process architecture for dynamic MCP tool discovery using semantic vector search.

## Research Foundation

This implementation is based on **ToolRet: Toolbox Retrieval for Large Language Models** ([ACL 2025](https://aclanthology.org/2025.findings-acl.1258.pdf)):

- **Paper**: ToolRet enhances LLM tool selection using contrastive learning
- **Model**: `mangopy/ToolRet-trained-e5-large-v2` (1024 dimensions)
- **Performance**: Superior retrieval accuracy for tool discovery tasks

## Technical Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| **Vector Database** | Redis Stack (VSS) | `redis/redis-stack-server:latest` |
| **Embedding Service** | Infinity | `michaelf34/infinity:latest-cpu` |
| **Embedding Model** | ToolRet-trained-e5-large-v2 | 1024 dimensions |
| **Search Strategy** | Hybrid (BM25 + Vector) | HNSW + COSINE |

## Processes

| Process | File | Purpose |
|---------|------|---------|
| **Indexer** | `dmcp-indexer.ts` | CLI tool - reads `mcp.json`, discovers tools, and indexes them in Redis with connection info |
| **Server** | `dmcp-server.ts` | Runtime - serves search queries via stdio, connects to backends using Redis info |

## Quick Start

```bash
# Install dependencies
npm install

# 1. Index tools (run once, or after config changes)
npm run index

# 2. Start server
npm run start
```

## Scripts

```bash
npm run index        # Index tools (skip if cached)
npm run index:force  # Force re-index
npm run start        # Start server (development)
npm run start:prod   # Build + start (production)
npm run build        # TypeScript build only
```

## Source Files

| File | Purpose |
|------|---------|
| `src/dmcp-indexer.ts` | CLI tool for indexing |
| `src/dmcp-server.ts` | Runtime MCP server |
| `src/redis-vss.ts` | Redis vector search (hybrid text + semantic) |
| `src/custom-embedding-provider.ts` | HTTP client for embedding service |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | HuggingFace model ID |
| `DMCP_TOP_K` | 30 | Max tools per search |
| `DMCP_MIN_SCORE` | 0.25 | Min similarity score |
| `MCP_CONFIG_PATH` | ~/Work/mcp/.../mcp.json | Config path for indexer |

## Indexer CLI

```bash
# Show help
npm run index -- --help

# Options
-c, --config <path>   # Config file path
-f, --force           # Force re-index
--redis-host <host>   # Redis host
--redis-port <port>   # Redis port
--embedding-url <url> # Embedding service URL
```

## How It Works

### Indexer (npm run index)
1. Connects to all SSE servers defined in mcp.json
2. Discovers tools from each server
3. Generates embeddings via local embedding service
4. Stores tools + vectors in Redis
5. Exits after completion

### Server (npm run start)
1. Connects to Redis (read-only)
2. Connects to backend SSE servers
3. Exposes `mcp_dmcp_search_tools` meta-tool
4. Handles search queries via hybrid search
5. Forwards tool calls to backend servers

## Why Two Processes?

| Single Process | Two Processes |
|----------------|---------------|
| LLM can trigger re-indexing | LLM only searches |
| Refresh disrupts conversation | Index is always ready |
| Mixed admin + runtime | Clean separation |
| Complex server | Simple server, simple indexer |

See the [root README](../README.md) for full project documentation.
