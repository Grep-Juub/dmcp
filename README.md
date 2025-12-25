# DMCP - Dynamic Model Context Protocol

**Semantic tool discovery for MCP** - Solves the "too many tools" problem by making tool discovery query-driven with vector search.

## 🎬 Inspiration & Credits

This project was inspired by:

- 📺 **[MCP Tool Overload Problem](https://www.youtube.com/watch?v=hJY04dV-o7U)** - YouTube video explaining the challenge
- 📝 **[From Reasoning to Retrieval: Solving the MCP Tool Overload Problem](https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/)** - Redis blog post with the vector search solution

## 🔬 Research Foundation

Implementation based on **ToolRet: Toolbox Retrieval for Large Language Models**:

- 📄 **Paper**: [ACL 2025 Findings](https://aclanthology.org/2025.findings-acl.1258.pdf)
- 🎯 **Key Insight**: Tool-specific contrastive learning significantly improves LLM tool selection
- 🤗 **Model**: [`mangopy/ToolRet-trained-e5-large-v2`](https://huggingface.co/mangopy/ToolRet-trained-e5-large-v2) (1024 dimensions)
- ⚡ **Performance**: Superior retrieval accuracy compared to general-purpose embeddings
- 🏗️ **Architecture**: E5-large-v2 base, fine-tuned on tool-query pairs with contrastive learning

**Citation**:
```bibtex
@inproceedings{li2025toolret,
  title={ToolRet: Toolbox Retrieval for Large Language Models},
  author={Li, Ziang and Chen, Zhiyu and others},
  booktitle={Findings of the Association for Computational Linguistics: ACL 2025},
  year={2025},
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
                                  │ stdio
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Server (server/)                               │
│                                                                             │
│  • Exposes 1 meta-tool: search_tools                                        │
│  • Pure vector search (COSINE similarity)                                   │
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
│  Infinity Embedding    │                                     ▲
│  Port: 5000            │                                     │
│                        │                                     │
│  • Tool-optimized      │      ┌──────────────────────────────┘
│  • ToolRet e5-large-v2 │      │
│  • 1024 dimensions     │      │ Index tools at startup
│  • OpenAI-compatible   │      │
└────────────────────────┘      │
             ▲                  │
             │                  │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DMCP Indexer (indexer/)                             │
│                         npm run index                                       │
│                                                                             │
│  1. Connects to MCP servers in parallel (10 concurrent)                     │
│  2. Discovers tools from each server                                        │
│  3. Generates embeddings via embedding service                              │
│  4. Stores in Redis with vector index                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
dmcp/
├── docker-compose.yml        # Infrastructure (Redis VSS + infinity-emb)
├── .env.example              # Environment configuration template
│
├── server/                   # DMCP Server (TypeScript)
│   └── src/
│       ├── dmcp-server.ts    # Runtime server (stdio)
│       ├── redis-vss.ts      # Redis vector search
│       └── custom-embedding-provider.ts  # Embedding API client
│
├── indexer/                  # Standalone Indexer (TypeScript)
│   └── src/
│       ├── index.ts          # CLI indexer with parallel discovery
│       ├── redis-vss.ts      # Redis vector search
│       └── custom-embedding-provider.ts  # Embedding API client
│
├── gateway/                  # Agent Gateway Configuration
│   ├── agentgateway          # Binary (download from Agent Gateway)
│   ├── config.yaml           # Generated config (gitignored)
│   ├── config.yaml.example   # Example config structure
│   └── config_parts/         # ⚠️ YOUR PRIVATE CONFIGS (gitignored)
```

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 18+
- [Agent Gateway binary](https://github.com/agentgateway/agentgateway) (for running MCP servers)

### 1. Clone and Setup

```bash
git clone https://github.com/yourusername/dmcp.git
cd dmcp

# Configure embedding model (optional - defaults to tool-optimized model)
cp .env.example .env
```

### 2. Start Infrastructure

```bash
# Start Redis VSS + Embedding Service
docker-compose up -d

# Verify services are healthy
```bash
# Start Redis VSS + Embedding Service
docker-compose up -d

# Verify services are healthy
curl http://localhost:5000/health
# → {"unix": 1703452800.0}

# Test embedding model
curl -X POST http://localhost:5000/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"create a GitHub issue","model":"mangopy/ToolRet-trained-e5-large-v2","encoding_format":"float"}' \
  | jq '.data[0].embedding | length'
# → 1024

docker exec mcp-redis-vss redis-cli ping
# → PONG
```

### 3. Start Agent Gateway

```bash
cd gateway
./start.sh
# Gateway exposes MCP servers on ports 3101-3120
```

### 4. Index Tools

```bash
cd indexer
npm install
npm run index

# Output:
# ╔════════════════════════════════════════════════════════════════╗
# ║                    DMCP Tool Indexer                           ║
# ╚════════════════════════════════════════════════════════════════╝
# ✔ Connected to Redis at localhost:6380
# ✔ Discovering tools from MCP servers... (parallel, 10 concurrent)
# ...
# ✔ Indexed 429 tools in 45.2s
```

### 5. Configure VS Code

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "dmcp": {
      "command": "node",
      "args": [
        "/path/to/dmcp/server/dist/dmcp-server.js"
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
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL (indexer only) |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | ToolRet model (1024 dims) |
| `DMCP_TOP_K` | 30 | Max tools returned per search |
| `DMCP_MIN_SCORE` | 0.25 | Minimum similarity threshold |

### Indexer CLI

```bash
cd indexer
npm run index         # Index all tools
npm run index:force   # Force re-index (clear existing)
```

## 🖥️ Server Deployment

For deploying to your own server:

1. **Copy your private configs** to `gateway/config_parts/` on your server
2. **Generate gateway config**: `cat gateway/config_parts/*.yaml > gateway/config.yaml`
3. **Start services**: `docker-compose up -d`
4. **Start gateway**: `cd gateway && ./start.sh`
5. **Index tools**: `cd indexer && npm run index`
6. **Build server**: `cd server && npm run build`

For Apple Silicon (M1/M2/M3), uncomment the `platform: linux/arm64` line in `docker-compose.yml`.

## 📊 Performance

| Metric | Value |
|--------|-------|
| **Tools indexed** | 429 |
| **Index time** | ~45 seconds |
| **Search latency** | ~50ms |
| **Token reduction** | 98% (from ~100k to ~2k) |
| **Embedding model** | ToolRet-e5-large-v2 (1024 dims) |

## 📐 MCP Spec Compliance

Implements [MCP Tool Discovery](https://modelcontextprotocol.io/specification/2025-06-18/server/tools):

- ✅ `listChanged: true` capability
- ✅ `notifications/tools/list_changed` notifications
- ✅ Dynamic tool availability based on search

## 📄 License

MIT
