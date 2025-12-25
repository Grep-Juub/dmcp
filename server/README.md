# DMCP Server

Runtime MCP server for dynamic tool discovery via semantic vector search.

## Research Foundation

Based on **"Retrieval Models Aren't Tool-Savvy"** (Shi et al., ACL 2025 Findings):

- 📄 [Paper](https://aclanthology.org/2025.findings-acl.1258.pdf) | [GitHub](https://github.com/mangopy/tool-retrieval-benchmark)
- 🤗 [Model: mangopy/ToolRet-trained-e5-large-v2](https://huggingface.co/mangopy/ToolRet-trained-e5-large-v2) (1024 dimensions)
- **Approach**: Pure vector search - no heuristic filtering

## Quick Start

```bash
npm install
npm run build
npm run start  # or: npm run start:prod
```

## Source Files

| File | Purpose |
|------|---------|
| `src/dmcp-server.ts` | Runtime MCP server |
| `src/redis-vss.ts` | Redis vector search |
| `src/custom-embedding-provider.ts` | Embedding service client |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | localhost | Redis server host |
| `REDIS_PORT` | 6380 | Redis server port |
| `EMBEDDING_URL` | http://localhost:5000 | Embedding service URL |
| `EMBEDDING_MODEL` | mangopy/ToolRet-trained-e5-large-v2 | Model ID |
| `DMCP_TOP_K` | 30 | Max tools per search |
| `DMCP_MIN_SCORE` | 0.25 | Min similarity score |

## How It Works

1. Connects to Redis at startup
2. Exposes `search_tools` meta-tool via stdio
3. On search: generates embedding → vector search → returns top-k tools
4. On tool call: lazy-connects to backend SSE server and forwards

See the [root README](../README.md) for full project documentation.
