# DMCP - Dynamic Model Context Protocol

**Semantic tool discovery for MCP** - Solves the "too many tools" problem by making tool discovery query-driven with vector search.

## 🎬 Inspiration & Credits

This project was inspired by:

- 📺 **[MCP Tool Overload Problem](https://www.youtube.com/watch?v=hJY04dV-o7U)** - YouTube video explaining the challenge
- 📝 **[From Reasoning to Retrieval: Solving the MCP Tool Overload Problem](https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/)** - Redis blog post with the vector search solution

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
                                  │ stdio
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Server (dmcp-server.ts)                        │
│                                                                             │
│  • Exposes 1 meta-tool: search_tools                                        │
│  • Hybrid search: text (exact) + vector (semantic)                          │
│  • Sends listChanged notifications when tools discovered                    │
│  • Forwards tool calls to backend MCP servers                               │
└────────────┬──────────────────────────────────────────────────┬─────────────┘
             │                                                  │
             │ Query embeddings                                 │ Tool calls
             ▼                                                  ▼
┌────────────────────────┐                        ┌────────────────────────────┐
│   Redis Stack (VSS)    │                        │     Agent Gateway          │
│   Port: 6380           │                        │     (1MCP/agentgateway)    │
│                        │                        │                            │
│  ┌──────────────────┐  │                        │  ┌──────────────────────┐  │
│  │  Vector Index    │  │                        │  │  20+ MCP Servers     │  │
│  │  (HNSW, COSINE)  │  │                        │  │  via SSE endpoints   │  │
│  │  318 tool embeds │  │                        │  │  Ports 3101-3120     │  │
│  └──────────────────┘  │                        │  └──────────────────────┘  │
│                        │                        │                            │
│  ┌──────────────────┐  │                        │  • GitHub                  │
│  │  Text Index      │  │                        │  • Google Workspace        │
│  │  (Full-text)     │  │                        │  • Jira/Confluence         │
│  └──────────────────┘  │                        │  • Kubernetes              │
└────────────────────────┘                        │  • Grafana/Datadog         │
             ▲                                    │  • AWS/Azure               │
             │ Generate embeddings                │  • PostgreSQL              │
             │                                    │  • And more...             │
┌────────────────────────┐                        └────────────────────────────┘
│  Embedding Service     │                                     ▲
│  Port: 5000            │                                     │
│                        │                                     │
│  • E5-small-v2 model   │      ┌──────────────────────────────┘
│  • 384 dimensions      │      │
│  • ONNX Runtime        │      │ Index tools at startup
│  • ~33s for 318 tools  │      │
└────────────────────────┘      │
             ▲                  │
             │                  │
┌────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Indexer (CLI)                                  │
│                         npm run index                                       │
│                                                                             │
│  1. Connects to all MCP servers via Agent Gateway                          │
│  2. Discovers tools from each server                                        │
│  3. Generates embeddings via embedding service                              │
│  4. Stores in Redis with vector index                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
dmcp/
├── docker-compose.yml        # Infrastructure (Redis VSS + Embedding)
├── Dockerfile                # ONNX-optimized embedding service
├── app.py                    # Flask embedding API (E5-small-v2)
├── requirements.txt          # Python dependencies
│
├── mcp-server/               # DMCP Server (TypeScript)
│   ├── src/
│   │   ├── dmcp-server.ts    # Runtime server (stdio)
│   │   ├── dmcp-indexer.ts   # Indexer CLI
│   │   └── redis-vss.ts      # Redis vector search
│   └── package.json
│
├── gateway/                  # Agent Gateway Configuration
│   ├── agentgateway          # Binary (download from 1MCP)
│   ├── config.yaml           # Generated config (gitignored)
│   ├── config.yaml.example   # Example config structure
│   └── config_parts/         # ⚠️ YOUR PRIVATE CONFIGS (gitignored)
│
└── one-mcp/                  # MCP Server Registry
    ├── mcp.json              # Backend SSE endpoints (gitignored)
    ├── mcp.json.example      # Example config
    ├── start.sh              # Start gateway
    └── stop.sh               # Stop gateway
```

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 18+
- [Agent Gateway binary](https://github.com/1mcp/agentgateway) (for running MCP servers)

### 1. Clone and Setup

```bash
git clone https://github.com/yourusername/dmcp.git
cd dmcp

# Copy example configs
cp one-mcp/mcp.json.example one-mcp/mcp.json
cp gateway/config.yaml.example gateway/config.yaml

# Edit with your MCP server configurations
# (Add your API keys, tokens, etc.)
```

### 2. Start Infrastructure

```bash
# Start Redis VSS + Embedding Service
docker-compose up -d

# Verify services are healthy
curl http://localhost:5000/health
# → {"status": "healthy", "model": "intfloat/e5-small-v2", "runtime": "onnx"}

docker exec mcp-redis-vss redis-cli ping
# → PONG
```

### 3. Start Agent Gateway

```bash
cd one-mcp
./start.sh
# Gateway exposes MCP servers on ports 3101-3120
```

### 4. Index Tools

```bash
cd mcp-server
npm install

# Index all tools in Redis (~33 seconds for 318 tools)
npm run index

# Output:
# ═══════════════════════════════════════════════════
#          DMCP Indexer - Tool Discovery
# ═══════════════════════════════════════════════════
# [██████████████████████████████] 100% (318/318)
# ✓ Indexed 318 tools in 33522ms
```

### 5. Configure VS Code

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "dmcp": {
      "command": "node",
      "args": [
        "/path/to/dmcp/mcp-server/node_modules/.bin/tsx",
        "/path/to/dmcp/mcp-server/src/dmcp-server.ts",
        "/path/to/dmcp/one-mcp/mcp.json"
      ],
      "env": {
        "REDIS_PORT": "6380",
        "DMCP_TOP_K": "30",
        "DMCP_MIN_SCORE": "0.25"
      }
    }
  }
}
```

## 🔍 How Search Works

DMCP uses **hybrid search** combining:

1. **Text Search** (fast, exact) - "jira" → `jira_get`, `jira_post`, `jira_search`
2. **Vector Search** (semantic) - "ticket management" → Jira tools via embeddings

Example queries and what they find:
| Query | Finds | Why |
|-------|-------|-----|
| `"jira"` | Jira tools | Exact text match |
| `"ticket management"` | Jira tools | Semantic similarity |
| `"check pod logs"` | Kubernetes tools | Semantic match |
| `"search emails"` | Google Workspace | Semantic match |
| `"query AWS costs"` | AWS Cost Explorer | Semantic match |

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL (indexer only) |
| `EMBEDDING_MODEL` | intfloat/e5-small-v2 | Embedding model name |
| `DMCP_TOP_K` | 30 | Max tools returned per search |
| `DMCP_MIN_SCORE` | 0.25 | Minimum similarity threshold |

### Indexer CLI

```bash
npm run index                # Index (skip if already cached)
npm run index:force          # Force re-index all tools
```

## 🖥️ Server Deployment

For deploying to your own server:

1. **Copy your private configs** to `gateway/config_parts/` on your server
2. **Generate gateway config**: `cat gateway/config_parts/*.yaml > gateway/config.yaml`
3. **Start services**: `docker-compose up -d`
4. **Start gateway**: `cd one-mcp && ./start.sh`
5. **Index tools**: `cd mcp-server && npm run index`

For Apple Silicon (M1/M2/M3), uncomment the `platform: linux/arm64` line in `docker-compose.yml`.

## 📊 Performance

| Metric | Value |
|--------|-------|
| **Tools indexed** | 318 |
| **Index time** | ~33 seconds |
| **Search latency** | ~50ms |
| **Token reduction** | 98% (from ~100k to ~2k) |
| **Embedding model** | E5-small-v2 (33M params, 384 dims) |

## 📐 MCP Spec Compliance

Implements [MCP Tool Discovery](https://modelcontextprotocol.io/specification/2025-06-18/server/tools):

- ✅ `listChanged: true` capability
- ✅ `notifications/tools/list_changed` notifications
- ✅ Dynamic tool availability based on search

## 📄 License

MIT
