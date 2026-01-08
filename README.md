# DMCP - Dynamic Model Context Protocol

**Semantic tool discovery for MCP** - Solves the "too many tools" problem by making tool discovery query-driven with vector search.

[![Tests](https://img.shields.io/badge/tests-56%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## 🎯 The Problem

When you aggregate 20+ MCP servers (~300+ tools):
- **Token explosion**: 100,000+ tokens just listing tools
- **LLM confusion**: Too many choices = poor tool selection  
- **No filtering**: Standard MCP returns ALL tools upfront

## ✨ The Solution

DMCP uses **semantic vector search** to discover tools on-demand:

```
User: "Create a GitHub issue for this bug"

LLM calls: search_tools(query="create GitHub issue")
    → Returns top-15 relevant tools (via semantic vector search)
    → Tools become available for use

LLM calls: github_create_issue(...)
    → Issue created!
```

**Key insight**: The LLM discovers tools by **asking**, not by loading everything upfront.

## ✨ Features

- **🔍 Semantic Search**: ToolRet-trained E5 model for accurate tool retrieval
- **⚡ Fast**: ~50ms search latency, 98% token reduction
- **🔄 Connection Resilience**: Auto-retry, health checks, reconnection
- **🐳 Docker Ready**: Full stack with Redis VSS + Embedding service
- **📊 Observable**: Health endpoints, session logging, connection status
- **✅ Tested**: 56 unit tests with vitest

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VS Code / GitHub Copilot                          │
│                                                                             │
│  User: "search for kubernetes tools"                                        │
│        → search_tools("kubernetes")                                         │
│        ← Returns: 15 k8s tools (get_pods, list_deployments, ...)           │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ HTTP (Streamable HTTP Transport)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Server (port 3001)                             │
│                                                                             │
│  • Exposes 1 meta-tool: search_tools                                        │
│  • Pure vector search (COSINE similarity, HNSW index)                       │
│  • Sends listChanged notifications when tools discovered                    │
│  • Connection keep-alive with health checks (30s interval)                  │
│  • Auto-retry on connection failures (3 attempts, exponential backoff)      │
└────────────┬──────────────────────────────────────────────────┬─────────────┘
             │                                                  │
             │ Query embeddings                                 │ Tool calls (SSE)
             ▼                                                  ▼
┌────────────────────────────────┐                ┌────────────────────────────┐
│   Redis Stack (port 6380)      │                │     Backend MCP Servers    │
│                                │                │     (via Agent Gateway)    │
│  • Vector Index (HNSW)         │                │                            │
│  • COSINE similarity           │                │  • GitHub, Jira, Confluence│
│  • 400+ tools indexed          │                │  • Google Workspace        │
└────────────────────────────────┘                │  • Kubernetes, AWS, Azure  │
             ▲                                    │  • And more...             │
             │                                    └────────────────────────────┘
┌────────────────────────────────┐
│  Infinity Embedding Service    │
│  (port 5000)                   │
│                                │
│  • ToolRet e5-large-v2 model   │
│  • 1024 dimensions             │
│  • OpenAI-compatible API       │
└────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- An MCP server gateway exposing your tools (e.g., [Agent Gateway](https://github.com/agentgateway/agentgateway))

### 1. Clone and Start

```bash
git clone https://github.com/yourusername/dmcp.git
cd dmcp

# Start everything: Redis, Embedding Service, and DMCP Server
docker compose up -d

# Wait for services to be healthy (~2-3 minutes for embedding model to load)
docker compose ps
```

### 2. Index Your Tools

```bash
# Run the indexer to populate Redis with tools from your MCP gateway
docker compose run --rm indexer

# Verify tools are indexed
curl http://localhost:3001/health
# → {"status":"healthy","toolCount":420,...}
```

### 3. Configure VS Code

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "dmcp": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

**That's it!** The `search_tools` meta-tool is now available in VS Code / GitHub Copilot.

## 📁 Project Structure

```
dmcp/
├── docker-compose.yml          # Full stack configuration
├── server/                     # DMCP Server (TypeScript)
│   ├── src/
│   │   ├── dmcp-server.ts      # Main server with connection management
│   │   ├── redis-vss.ts        # Redis vector similarity search
│   │   ├── custom-embedding-provider.ts
│   │   ├── dmcp-server.test.ts # Unit tests (28 tests)
│   │   └── redis-vss.test.ts   # Unit tests (28 tests)
│   ├── vitest.config.ts
│   └── package.json
├── indexer/                    # Tool Indexer (TypeScript)
│   └── src/
│       └── index.ts            # CLI indexer with parallel discovery
└── README.md
```

## 🐳 Docker Commands

```bash
# Start full stack
docker compose up -d

# View logs
docker compose logs -f dmcp-server

# Run one-shot indexing
docker compose run --rm indexer

# Start continuous sync worker
docker compose --profile worker up -d

# Rebuild after code changes
docker compose build dmcp-server && docker compose up -d dmcp-server

# Stop everything
docker compose down

# Stop and delete indexed data
docker compose down -v
```

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port (inside container) |
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6379 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `DMCP_TOP_K` | 15 | Max tools returned per search |
| `DMCP_MIN_SCORE` | 0.3 | Minimum similarity threshold |

#### Connection Resilience

| Variable | Default | Description |
|----------|---------|-------------|
| `DMCP_RETRY_ATTEMPTS` | 3 | Max connection retry attempts |
| `DMCP_RETRY_DELAY_MS` | 1000 | Base delay between retries (exponential backoff) |
| `DMCP_HEALTH_INTERVAL_MS` | 30000 | Health check interval for backend connections |
| `DMCP_CONNECTION_TIMEOUT_MS` | 10000 | Connection timeout |

### Docker Compose Services

| Service | Container | Host Port | Description |
|---------|-----------|-----------|-------------|
| `redis-vss` | mcp-redis-vss | 6380 | Redis Stack with vector search |
| `embedding-service` | mcp-embedding-infinity | 5000 | Infinity embedding service |
| `dmcp-server` | dmcp-server | 3001 | DMCP MCP server |
| `indexer` | dmcp-indexer | - | One-shot indexer |
| `indexer-worker` | dmcp-indexer-worker | - | Continuous sync (optional) |

## 🔍 How Search Works

DMCP uses **pure vector search** with the ToolRet embedding model:

1. Query is embedded using ToolRet-trained E5-large-v2
2. Redis performs HNSW nearest neighbor search
3. Top-K results are returned sorted by COSINE similarity
4. Tools become available via `notifications/tools/list_changed`

Example queries:
| Query | Finds |
|-------|-------|
| `"create GitHub issue"` | GitHub tools |
| `"ticket management"` | Jira tools |
| `"check pod logs"` | Kubernetes tools |
| `"search emails"` | Google Workspace |

## 🏥 Health & Monitoring

### Health Endpoint

```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "status": "healthy",
  "toolCount": 440,
  "activeSessions": 2,
  "backendConnections": {
    "total": 5,
    "healthy": 5,
    "details": [
      {"serverId": "github", "healthy": true, "lastCheck": 1704700000000},
      {"serverId": "serena", "healthy": true, "lastCheck": 1704700000000}
    ]
  },
  "config": {
    "retryAttempts": 3,
    "retryDelayMs": 1000,
    "healthIntervalMs": 30000,
    "connectionTimeoutMs": 10000
  },
  "uptime": 3600
}
```

### Server Logs

```bash
docker compose logs -f dmcp-server

# Example output:
# 16:38:36 [DMCP] 🚀 Server listening on http://0.0.0.0:3000
# 16:38:36 [DMCP] ✓ Found 440 indexed tools
# 16:38:52 [DMCP] POST /mcp [initialize]
# 16:38:52 [DMCP] 📡 New connection request (session #1)
# 16:39:01 [DMCP] 🔍 Search: "kubernetes pods" (limit: 15)
# 16:39:01 [DMCP] ✓ Found 12 tools in 45ms
```

## 🧪 Testing

```bash
cd server

# Run tests
npm test

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

**Test Coverage**: 56 tests covering:
- Tool name sanitization and parsing
- Connection retry and health check logic
- Redis vector search operations
- Embedding operations

## 🔧 Local Development

```bash
# Start only infrastructure
docker compose up -d redis-vss embedding-service

# Run server locally
cd server
npm install
REDIS_PORT=6380 EMBEDDING_URL=http://localhost:5000 npm run start

# Run tests
npm test
```

## 📊 Performance

| Metric | Value |
|--------|-------|
| Tools indexed | 440 |
| Index time | ~45 seconds |
| Search latency | ~50ms |
| Token reduction | 98% |
| Embedding model | ToolRet-e5-large-v2 (1024 dims) |

## 📐 MCP Spec Compliance

Implements [MCP Specification](https://modelcontextprotocol.io/specification) with [Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http):

- ✅ `listChanged: true` capability
- ✅ `notifications/tools/list_changed` notifications
- ✅ Dynamic tool availability based on search
- ✅ Streamable HTTP transport (POST/GET/DELETE)
- ✅ Session management with UUID session IDs
- ✅ SSE for async notifications

## 🔬 Research Foundation

Implementation based on **"Retrieval Models Aren't Tool-Savvy"** (ACL 2025):

- 📄 [Paper](https://aclanthology.org/2025.findings-acl.1258.pdf)
- 🤗 [Model: mangopy/ToolRet-trained-e5-large-v2](https://huggingface.co/mangopy/ToolRet-trained-e5-large-v2)
- 🏠 [GitHub](https://github.com/mangopy/tool-retrieval-benchmark)

**Key Insight**: General IR models perform poorly on tool retrieval; tool-specific training is essential.

## 🎬 Inspiration

- 📺 [MCP Tool Overload Problem](https://www.youtube.com/watch?v=hJY04dV-o7U) - YouTube
- 📝 [Redis Blog: From Reasoning to Retrieval](https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/)

## 📄 License

MIT
