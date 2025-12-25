# DMCP Indexer

Standalone CLI tool for indexing MCP tools into Redis for semantic search.

Supports two modes:
- **Manual**: Run once and exit (first-time setup, force refresh)
- **Worker**: Run continuously and sync changes (production daemon)

## Research Foundation

Based on **"Retrieval Models Aren't Tool-Savvy"** (Shi et al., ACL 2025 Findings):

- 📄 [Paper](https://aclanthology.org/2025.findings-acl.1258.pdf) | [GitHub](https://github.com/mangopy/tool-retrieval-benchmark) | [Leaderboard](https://huggingface.co/spaces/mangopy/ToolRet-leaderboard)
- 🤗 [Model: mangopy/ToolRet-trained-e5-large-v2](https://huggingface.co/mangopy/ToolRet-trained-e5-large-v2)

## Features

- **Auto-discovery**: Reads MCP server config from Agent Gateway
- **Parallel discovery**: Connects to 10 MCP servers concurrently
- **Worker mode**: Continuous sync with change detection
- **Beautiful CLI**: Progress bars, colored output, summary stats
- **Change detection**: Detects added, removed, and updated tools

## Quick Start

```bash
npm install

# Manual mode - run once
npm run index           # First-time indexing
npm run index:force     # Force re-index (clear existing)

# Worker mode - run continuously
npm run worker          # Sync every 60s (default)
npm run worker -- -i 30 # Sync every 30s
```

## Worker Mode

The worker runs continuously and:
- ✅ Detects **new tools** added to MCP servers
- ✅ Removes tools from **deleted servers**
- ✅ Updates tools whose **descriptions changed**
- ✅ Logs all changes with timestamps

```bash
# Start worker (runs as daemon)
npm run worker

# Output:
# [14:32:15] +3 -1 ~0 (425 unchanged) [2.1s, 18/20 servers]
#            └─ Added 3 new tools
#            └─ Removed 1 tool
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_GATEWAY_URL` | http://127.0.0.1:15000/config_dump | Agent Gateway config endpoint |
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | Model ID |
| `SYNC_INTERVAL` | 60 | Worker sync interval (seconds) |

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI with manual + worker modes |
| `src/redis-vss.ts` | Redis vector search |
| `src/custom-embedding-provider.ts` | Embedding service client |

## How It Works

### Manual Mode
1. Fetches MCP server config from Agent Gateway (`/config_dump`)
2. Connects to servers in parallel (10 concurrent)
3. Discovers all available tools from each server
4. Generates embeddings via local embedding service
5. Stores tools + vectors in Redis with HNSW index

### Worker Mode
1. Performs initial sync (same as manual)
2. Every N seconds:
   - Fetches current config from gateway
   - Compares with tools in Redis
   - Adds new tools, removes deleted, updates changed
   - Logs changes to stdout

## CLI Options

```bash
npm run index -- --help

Manual mode options:
  -f, --force           Force re-index (clear existing)
  -s, --server <name>   Index only specific server

Worker mode options:
  -w, --worker          Run in worker mode (continuous sync)
  -i, --interval <sec>  Sync interval in seconds (default: 60)

Common options:
  --gateway-url <url>   Agent Gateway config URL
  --redis-host <host>   Redis server host
  --redis-port <port>   Redis server port
  --embedding-url <url> Embedding service URL
```

See the [root README](../README.md) for full project documentation.
