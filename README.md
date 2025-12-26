# DMCP - Dynamic Model Context Protocol

**Semantic tool discovery for MCP** - Solves the "too many tools" problem by making tool discovery query-driven with vector search.

## 🎬 Inspiration & Credits

This project was inspired by:

- 📺 **[MCP Tool Overload Problem](https://www.youtube.com/watch?v=hJY04dV-o7U)** - YouTube video explaining the challenge
- 📝 **[From Reasoning to Retrieval: Solving the MCP Tool Overload Problem](https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/)** - Redis blog post with the vector search solution

## 🔬 Research Foundation

Implementation based on **"Retrieval Models Aren't Tool-Savvy: Benchmarking Tool Retrieval for Large Language Models"**:

- 📄 **Paper**: [ACL 2025 Findings](https://aclanthology.org/2025.findings-acl.1258.pdf) | [DOI](https://doi.org/10.18653/v1/2025.findings-acl.1258)
- 🏠 **Project**: [GitHub](https://github.com/mangopy/tool-retrieval-benchmark) | [Leaderboard](https://huggingface.co/spaces/mangopy/ToolRet-leaderboard)
- 🤗 **Model**: [`mangopy/ToolRet-trained-e5-large-v2`](https://huggingface.co/mangopy/ToolRet-trained-e5-large-v2) (1024 dimensions)
- 🎯 **Key Insight**: General IR models perform poorly on tool retrieval; tool-specific training is essential
- 🏗️ **Architecture**: E5-large-v2 fine-tuned on 200k+ tool-query pairs with contrastive learning

**Citation**:
```bibtex
@inproceedings{shi-etal-2025-retrieval,
  title={Retrieval Models Aren't Tool-Savvy: Benchmarking Tool Retrieval for Large Language Models},
  author={Shi, Zhengliang and Wang, Yuhan and Yan, Lingyong and Ren, Pengjie and Wang, Shuaiqiang and Yin, Dawei and Ren, Zhaochun},
  booktitle={Findings of the Association for Computational Linguistics: ACL 2025},
  pages={24497--24524},
  year={2025},
  address={Vienna, Austria},
  publisher={Association for Computational Linguistics},
  url={https://aclanthology.org/2025.findings-acl.1258}
}
```

## 🎯 The Problem

When you aggregate 20+ MCP servers (~300+ tools):
- **Token explosion**: 100,000+ tokens just listing tools
- **LLM confusion**: Too many choices = poor tool selection  
- **No filtering**: Standard MCP returns ALL tools upfront

## ✨ The Solution

DMCP uses a **two-process architecture** with semantic search:

```
User: "Create a GitHub issue for this bug"

LLM calls: search_tools(query="create GitHub issue")
    → Returns top-30 relevant tools (via semantic vector search)
    → Tools become available for use

LLM calls: github_create_issue(...)
    → Issue created!
```

**Key insight**: The LLM discovers tools by **asking**, not by loading everything upfront.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VS Code / GitHub Copilot                          │
│                                                                             │
│  User: "search for kubernetes tools"                                        │
│        ─────────────────────────────►                                       │
│                                       search_tools("kubernetes")            │
│                                                                             │
│        ◄─────────────────────────────                                       │
│  Returns: 15 k8s tools (get_pods, list_deployments, describe_service...)   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ HTTP (Streamable HTTP Transport)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Server (server/)                               │
│                         http://localhost:3001/mcp                           │
│                                                                             │
│  • Exposes 1 meta-tool: search_tools                                        │
│  • Pure vector search (COSINE similarity, HNSW index)                       │
│  • Sends listChanged notifications when tools discovered                    │
│  • Forwards tool calls to backend MCP servers via SSE                       │
│  • Runs in Docker container (Streamable HTTP transport)                     │
└────────────┬──────────────────────────────────────────────────┬─────────────┘
             │                                                  │
             │ Query embeddings                                 │ Tool calls (SSE)
             ▼                                                  ▼
┌────────────────────────────────┐                ┌────────────────────────────┐
│   Redis Stack (VSS)            │                │     Agent Gateway          │
│   Container: mcp-redis-vss     │                │     Port: 15000            │
│   Host Port: 6380              │                │                            │
│                                │                │  ┌──────────────────────┐  │
│  ┌──────────────────┐          │                │  │  20+ MCP Servers     │  │
│  │  Vector Index    │          │                │  │  (SSE endpoints)     │  │
│  │  HNSW + COSINE   │          │                │  └──────────────────────┘  │
│  │  400+ tools      │          │                │                            │
│  └──────────────────┘          │                │  • GitHub, Jira, Confluence│
└────────────────────────────────┘                │  • Google Workspace        │
             ▲                                    │  • Kubernetes, AWS, Azure  │
             │                                    │  • Grafana, Datadog        │
             │                                    │  • PostgreSQL, and more... │
┌────────────────────────────────┐                └────────────────────────────┘
│  Infinity Embedding Service    │                             ▲
│  Container: mcp-embedding-     │                             │
│             infinity           │                             │
│  Host Port: 5000               │      ┌──────────────────────┘
│                                │      │
│  • ToolRet e5-large-v2         │      │ Fetch config + discover tools
│  • 1024 dimensions             │      │
│  • OpenAI-compatible API       │      │
└────────────────────────────────┘      │
             ▲                          │
             │ Generate                 │
             │ embeddings               │
             │                          │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Indexer (indexer/)                             │
│                         docker compose run --rm indexer                     │
│                                                                             │
│  1. Fetches MCP server config from Agent Gateway (/config_dump)             │
│  2. Connects to servers in parallel (10 concurrent)                         │
│  3. Discovers tools from each server                                        │
│  4. Generates embeddings via Infinity service                               │
│  5. Stores tools + vectors in Redis                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
dmcp/
├── docker-compose.yml        # Full stack (Redis, Embedding, DMCP Server)
├── .env.example              # Environment configuration template
│
├── server/                   # DMCP Server (TypeScript, Streamable HTTP)
│   ├── Dockerfile            # Container build
│   └── src/
│       ├── dmcp-server.ts    # HTTP server with MCP transport
│       ├── redis-vss.ts      # Redis vector search
│       └── custom-embedding-provider.ts  # Embedding API client
│
├── indexer/                  # Standalone Indexer (TypeScript)
│   ├── Dockerfile            # Container build
│   └── src/
│       ├── index.ts          # CLI indexer with parallel discovery
│       ├── redis-vss.ts      # Redis vector search
│       └── custom-embedding-provider.ts  # Embedding API client
│
├── gateway/                  # Agent Gateway Configuration
│   ├── agentgateway          # Binary (download from Agent Gateway)
│   ├── config.yaml           # Generated config (gitignored)
│   ├── config.yaml.example   # Example config structure
│   ├── start.sh              # Start gateway script
│   ├── stop.sh               # Stop gateway script
│   └── config_parts/         # ⚠️ YOUR PRIVATE CONFIGS (gitignored)
│
└── .vscode/
    └── mcp.json              # VS Code MCP configuration
```

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (only for local development)
- [Agent Gateway binary](https://github.com/agentgateway/agentgateway) (for running MCP servers)

### 1. Clone and Setup

```bash
git clone https://github.com/yourusername/dmcp.git
cd dmcp

# Configure environment (optional - defaults work out of the box)
cp .env.example .env
```

### 2. Start Agent Gateway

The Agent Gateway provides your MCP servers (GitHub, Jira, AWS, etc.):

```bash
cd gateway

# Create your config from parts (or use config.yaml.example as template)
cat config_parts/*.yaml > config.yaml

# Start the gateway
./start.sh
# Gateway exposes MCP servers on port 15000
```

### 3. Start Infrastructure + DMCP Server

```bash
# Start everything: Redis, Embedding Service, and DMCP Server
docker compose up -d

# Check status
docker compose ps

# Verify services are healthy
curl http://localhost:3001/health
# → {"status":"healthy","toolCount":0,"activeSessions":0,"uptime":10}
```

### 4. Index Tools

```bash
# Run the indexer to populate Redis with tools from Agent Gateway
docker compose run --rm indexer

# Verify tools are indexed
curl http://localhost:3001/health
# → {"status":"healthy","toolCount":420,"activeSessions":0,"uptime":60}
```

### 5. Configure VS Code

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

**That's it!** The DMCP server is now available in VS Code / GitHub Copilot with the `search_tools` meta-tool.

## 🐳 Docker Commands

```bash
# Start full stack (Redis + Embedding + DMCP Server)
docker compose up -d

# View logs
docker compose logs -f dmcp-server

# Run one-shot indexing
docker compose run --rm indexer

# Start indexer worker (continuous sync)
docker compose --profile worker up -d

# View worker logs
docker compose logs -f indexer-worker

# Rebuild after code changes
docker compose build dmcp-server
docker compose up -d dmcp-server

# Stop everything
docker compose down

# Stop everything including volumes (⚠️ deletes indexed data)
docker compose down -v
```

## 🔧 Local Development

For developing the server or indexer locally:

```bash
# Start only infrastructure (Redis + Embedding)
docker compose up -d redis-vss embedding-service

# Build and run server locally
cd server
npm install
npm run build
REDIS_PORT=6380 npm run start

# Or run indexer locally
cd indexer
npm install
REDIS_PORT=6380 EMBEDDING_URL=http://localhost:5000 npm run index
```

## 🔍 How Search Works

DMCP uses **pure vector search** with the ToolRet embedding model:

- Model was trained specifically on tool-query pairs
- Encodes semantic intent directly (no keyword matching needed)
- Returns top-k tools by COSINE similarity

Example queries and what they find:
| Query | Finds | Why |
|-------|-------|-----|
| `"create GitHub issue"` | GitHub tools | Semantic match |
| `"ticket management"` | Jira tools | Semantic similarity |
| `"check pod logs"` | Kubernetes tools | Semantic match |
| `"search emails"` | Google Workspace | Semantic match |
| `"query AWS costs"` | AWS Cost Explorer | Semantic match |

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | DMCP server port (inside container) |
| `MCP_GATEWAY_URL` | http://host.docker.internal:15000/config_dump | Agent Gateway config endpoint |
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6379 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | ToolRet model (1024 dims) |
| `DMCP_TOP_K` | 15 | Max tools returned per search |
| `DMCP_MIN_SCORE` | 0.3 | Minimum similarity threshold |
| `SYNC_INTERVAL` | 60 | Worker mode sync interval (seconds) |

### Docker Compose Services

| Service | Container Name | Host Port | Description |
|---------|----------------|-----------|-------------|
| `redis-vss` | mcp-redis-vss | 6380 | Redis Stack with vector search |
| `embedding-service` | mcp-embedding-infinity | 5000 | Infinity embedding service |
| `dmcp-server` | dmcp-server | 3001 | DMCP MCP server (HTTP) |
| `indexer` | dmcp-indexer | - | One-shot indexer (manual) |
| `indexer-worker` | dmcp-indexer-worker | - | Continuous sync worker |

### VS Code MCP Configuration

The server uses **Streamable HTTP transport**, configure in `.vscode/mcp.json`:

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

### Health & Monitoring

```bash
# Check server health
curl http://localhost:3001/health
# → {"status":"healthy","toolCount":420,"activeSessions":1,"uptime":3600}

# View server logs
docker compose logs -f dmcp-server

# Example log output:
# 16:38:36 [DMCP] ═══════════════════════════════════════
# 16:38:36 [DMCP] 🚀 Server listening on http://0.0.0.0:3000
# 16:38:36 [DMCP] ✓ Found 420 indexed tools
# 16:38:52 [DMCP] POST /mcp [initialize]
# 16:38:52 [DMCP] 📡 New connection request (will be session #1)
# 16:39:01 [DMCP] 🔍 Search: "kubernetes pods" (limit: 15)
# 16:39:01 [DMCP] ✓ Found 12 tools in 45ms
```

### Indexer CLI

```bash
# Using Docker (recommended)
docker compose run --rm indexer                    # Index all tools
docker compose run --rm indexer -- -f              # Force re-index
docker compose run --rm indexer -- -s github       # Index specific server

# Or locally
cd indexer
npm run index             # Index all tools from gateway
npm run index:force       # Force re-index (clear existing)
npm run index -- -s name  # Index only specific server

# Worker mode (continuous sync)
npm run worker            # Sync every 60s (default)
npm run worker -- -i 30   # Sync every 30s
```

## 🖥️ Server Deployment

### Docker Compose (Recommended)

The simplest way to deploy - everything runs in containers:

```bash
# 1. Clone and configure
git clone https://github.com/yourusername/dmcp.git
cd dmcp

# 2. Set up Agent Gateway with your MCP server configs
cd gateway
cat config_parts/*.yaml > config.yaml
./start.sh

# 3. Start DMCP stack
cd ..
docker compose up -d

# 4. Index tools
docker compose run --rm indexer

# 5. (Optional) Start continuous sync worker
docker compose --profile worker up -d
```

### Production Considerations

- **Apple Silicon (M1/M2/M3)**: The embedding service image is `linux/amd64` - Docker will emulate it automatically
- **Persistence**: Redis data is stored in a Docker volume (`redis-vss-data`)
- **Resource limits**: Embedding service needs ~6GB RAM, Redis needs ~2GB
- **Re-indexing**: Run `docker compose run --rm indexer` whenever you add/remove MCP servers

### Endpoint Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC requests |
| `/mcp` | GET | SSE stream for async notifications |
| `/mcp` | DELETE | Terminate session |
| `/health` | GET | Health check with tool count |

## 📊 Performance

| Metric | Value |
|--------|-------|
| **Tools indexed** | 429 |
| **Index time** | ~45 seconds |
| **Search latency** | ~50ms |
| **Token reduction** | 98% (from ~100k to ~2k) |
| **Embedding model** | ToolRet-e5-large-v2 (1024 dims) |

## 📐 MCP Spec Compliance

Implements [MCP Tool Discovery](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) with [Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http):

- ✅ `listChanged: true` capability
- ✅ `notifications/tools/list_changed` notifications
- ✅ Dynamic tool availability based on search
- ✅ Streamable HTTP transport (POST/GET/DELETE on `/mcp`)
- ✅ Session management with UUID session IDs
- ✅ SSE for async server-to-client notifications

## 📄 License

MIT
