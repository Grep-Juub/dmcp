# DMCP - Dynamic MCP Tool Discovery

This workspace includes a **search_tools** meta-tool that provides access to a large collection of dynamically indexed tools.

## How it works

The `search_tools` tool searches a vector database of tool descriptions and returns matching tools. Found tools are immediately available to call.

**The tool collection is dynamic**—it may include external APIs, local operations, reasoning helpers, memory systems, web tools, databases, and more. Search by describing your goal.

## Examples

| Goal | Query |
|------|-------|
| Create a GitHub PR | `"create pull request"` |
| Think through a complex problem | `"reasoning step by step"` |
| Check system processes | `"process management"` |
| Send an email | `"send email gmail"` |
| Query Kubernetes | `"kubernetes pods"` |
