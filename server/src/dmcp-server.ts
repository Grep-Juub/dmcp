#!/usr/bin/env node

/**
 * DMCP Server - Dynamic Model Context Protocol Runtime (Streamable HTTP)
 * 
 * Lightweight MCP server for query-driven tool discovery.
 * Assumes tools are already indexed in Redis (use dmcp-indexer first).
 * 
 * Key features:
 * - Exposes ONLY search_tools meta-tool (no admin operations)
 * - Connects to backend SSE servers LAZILY (on first tool call)
 * - Dynamic tool list based on semantic search
 * - Sends listChanged notifications when tools update
 * - Streamable HTTP transport for use with docker-compose
 * 
 * Usage:
 *   npm run start                    # Start server
 *   PORT=3000 npm run start          # Custom port
 */

import { randomUUID } from 'node:crypto';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isInitializeRequest, Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RedisVSS, FilteredTool } from './redis-vss.js';

const PORT = parseInt(process.env.PORT || '3000');

/**
 * Sanitize tool names to conform to MCP naming requirements [a-z0-9_-]
 */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

// ============================================================================
// Server State (shared across sessions in stateless mode)
// ============================================================================

// Redis connection for tool search
const redis = new RedisVSS({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  embeddingDimensions: 384,
  embeddingURL: process.env.EMBEDDING_URL || 'http://localhost:5000',
});

// Configuration
const topK = parseInt(process.env.DMCP_TOP_K || '15');
const minScore = parseFloat(process.env.DMCP_MIN_SCORE || '0.3');

// Tool tracking (shared across sessions)
let totalToolCount = 0;
const toolServerUrls = new Map<string, string>();  // toolKey -> serverUrl
const serverClients = new Map<string, Client>();   // serverId -> Client

// Initialization state
let isInitialized = false;
let initializationError: Error | null = null;
let initPromise: Promise<void> | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the search_tools meta-tool definition
 */
function getSearchToolDefinition(): Tool {
  const description = [
    `Search for relevant tools based on your task.`,
    `This server has ${totalToolCount} tools indexed across multiple services`,
    `(GitHub, Google Workspace, AWS, Kubernetes, Datadog, Grafana, Jira, etc.).`,
    `Use this tool FIRST to discover which tools are available for your specific task.`,
    `Returns the top ${topK} most relevant tools.`,
  ].join(' ');
  
  return {
    name: 'search_tools',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: `Describe what you want to do. Examples: "create a GitHub issue", "search emails", "check Kubernetes pod status", "query AWS costs"`,
        },
        limit: {
          type: 'number',
          description: `Maximum number of tools to return (default: ${topK}, max: 50)`,
        },
      },
      required: ['query'],
    },
  };
}

/**
 * Rewrite localhost URLs to host.docker.internal when running in Docker
 */
function rewriteUrlForDocker(url: string): string {
  // Check if we're in Docker (REDIS_HOST would be set to container name)
  const inDocker = process.env.REDIS_HOST && !process.env.REDIS_HOST.includes('localhost');
  if (!inDocker) return url;
  
  // Replace localhost/127.0.0.1 with host.docker.internal
  return url
    .replace(/localhost/g, 'host.docker.internal')
    .replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

/**
 * Connect to an SSE MCP Server (lazy - on demand)
 */
async function connectToBackend(serverId: string, url: string): Promise<Client | null> {
  const rewrittenUrl = rewriteUrlForDocker(url);
  try {
    console.error(`${timestamp()} [DMCP] 🔗 Connecting to ${serverId} at ${rewrittenUrl}...`);
    const transport = new SSEClientTransport(new URL(rewrittenUrl));
    const client = new Client(
      { name: 'dmcp-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    console.error(`${timestamp()} [DMCP] ✓ Connected to ${serverId}`);
    return client;
  } catch (error) {
    console.error(`${timestamp()} [DMCP] ✗ Failed to connect to ${serverId} (${rewrittenUrl}): ${(error as Error).message}`);
    return null;
  }
}

/**
 * Get or create a client connection to a backend server (lazy)
 */
async function getServerClient(serverId: string, serverUrl?: string): Promise<Client | null> {
  if (serverClients.has(serverId)) {
    console.error(`${timestamp()} [DMCP] ↩ Reusing connection to ${serverId}`);
    return serverClients.get(serverId)!;
  }
  if (!serverUrl) {
    console.error(`${timestamp()} [DMCP] ✗ No server URL for: ${serverId}`);
    return null;
  }

  const client = await connectToBackend(serverId, serverUrl);
  if (client) {
    serverClients.set(serverId, client);
  }
  return client;
}

/**
 * Parse tool name to extract serverId and original name
 */
function parseToolName(toolName: string, description?: string): { serverId: string; originalName: string } | null {
  // Description format: [serverId] actual description
  const match = description?.match(/^\[([^\]]+)\]/);
  if (!match) return null;

  const serverId = match[1];
  const prefix = sanitizeToolName(serverId) + '_';
  if (!toolName.startsWith(prefix)) return null;
  
  const originalName = toolName.slice(prefix.length);
  return { serverId, originalName };
}

/**
 * Initialize Redis connection (background)
 */
async function initialize(): Promise<void> {
  try {
    console.error(`${timestamp()} [DMCP] Connecting to Redis...`);
    await redis.connect();
    
    totalToolCount = await redis.getToolCount();
    
    if (totalToolCount === 0) {
      console.error(`${timestamp()} [DMCP] ⚠️  No tools indexed in Redis!`);
      console.error(`${timestamp()} [DMCP] Run indexer first to populate tools.`);
    } else {
      console.error(`${timestamp()} [DMCP] ✓ Found ${totalToolCount} indexed tools`);
    }

    isInitialized = true;
    console.error(`${timestamp()} [DMCP] ✓ Ready - ${totalToolCount} tools searchable`);
  } catch (error) {
    console.error(`${timestamp()} [DMCP] ✗ Initialization error: ${(error as Error).message}`);
    initializationError = error as Error;
  }
}

/**
 * Wait for initialization
 */
async function waitForInit(): Promise<void> {
  if (initPromise && !isInitialized) {
    await initPromise;
  }
  if (initializationError) {
    throw new Error(`Initialization failed: ${initializationError.message}`);
  }
}

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * Create a new MCP server instance for each session
 */
function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'dmcp-server',
      version: '3.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Per-session tool state
  const exposedTools = new Map<string, { tool: Tool; serverUrl?: string }>();

  // Helper function to handle dynamic tool calls
  const handleDynamicToolCall = async (toolName: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    console.error(`${timestamp()} [DMCP] 🔧 Tool call: ${toolName}`);

    // Check if we have this tool exposed
    const toolInfo = exposedTools.get(toolName);
    if (!toolInfo) {
      console.error(`${timestamp()} [DMCP] ✗ Tool not available: ${toolName}`);
      return {
        content: [{
          type: 'text',
          text: `Tool "${toolName}" not available. Use "search_tools" first to discover tools.`,
        }],
        isError: true,
      };
    }

    // Parse tool name to get serverId
    const parsed = parseToolName(toolName, toolInfo.tool.description);
    if (!parsed) {
      console.error(`${timestamp()} [DMCP] ✗ Invalid tool format: ${toolName}`);
      return {
        content: [{
          type: 'text',
          text: `Invalid tool format: ${toolName}`,
        }],
        isError: true,
      };
    }

    const { serverId, originalName } = parsed;

    // Get backend client (lazy connect)
    const client = await getServerClient(serverId, toolInfo.serverUrl);
    if (!client) {
      console.error(`${timestamp()} [DMCP] ✗ Cannot connect to ${serverId}`);
      return {
        content: [{
          type: 'text',
          text: `Cannot connect to backend: ${serverId}. The MCP server may not be running.`,
        }],
        isError: true,
      };
    }

    const argsStr = JSON.stringify(args);
    console.error(`${timestamp()} [DMCP] → ${serverId}::${originalName}`);
    console.error(`${timestamp()} [DMCP]   Args: ${argsStr.slice(0, 300)}${argsStr.length > 300 ? '...' : ''}`);
    
    const startTime = Date.now();
    try {
      const result = await client.callTool({
        name: originalName,
        arguments: args,
      });
      const duration = Date.now() - startTime;
      console.error(`${timestamp()} [DMCP] ✓ ${originalName} completed in ${duration}ms`);
      return result as CallToolResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`${timestamp()} [DMCP] ✗ ${originalName} failed after ${duration}ms: ${(error as Error).message}`);
      return {
        content: [{
          type: 'text',
          text: `Error calling ${originalName}: ${(error as Error).message}`,
        }],
        isError: true,
      };
    }
  };
  
  // Register the search_tools meta-tool
  server.registerTool(
    'search_tools',
    {
      description: getSearchToolDefinition().description,
      inputSchema: {
        query: z.string().describe('Describe what you want to do'),
        limit: z.number().optional().describe(`Maximum tools to return (default: ${topK}, max: 50)`),
      },
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      await waitForInit();
      
      const effectiveLimit = Math.min(limit || topK, 50);
      console.error(`${timestamp()} [DMCP] 🔍 Search: "${query}" (limit: ${effectiveLimit})`);
      const startTime = Date.now();

      const tools = await redis.search(query, {
        topK: effectiveLimit,
        minScore,
      });

      const duration = Date.now() - startTime;
      console.error(`${timestamp()} [DMCP] ✓ Found ${tools.length} tools in ${duration}ms`);
      if (tools.length > 0) {
        console.error(`${timestamp()} [DMCP]   Top: ${tools.slice(0, 3).map(t => `${t.serverId}/${t.name}(${t.score.toFixed(2)})`).join(', ')}`);
      }

      // Store tools and dynamically register them
      let newlyRegistered = 0;
      for (const tool of tools) {
        const toolKey = sanitizeToolName(`${tool.serverId}_${tool.name}`);
        
        // Skip if already registered
        if (exposedTools.has(toolKey)) continue;
        
        newlyRegistered++;
        exposedTools.set(toolKey, {
          tool: {
            name: toolKey,
            description: `[${tool.serverId}] ${tool.description}`,
            inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          },
          serverUrl: tool.serverUrl,
        });
        if (tool.serverUrl) {
          toolServerUrls.set(toolKey, tool.serverUrl);
        }

        // Dynamically register the tool
        // Using the generic z.record for arbitrary input schemas
        server.registerTool(
          toolKey,
          {
            description: `[${tool.serverId}] ${tool.description}`,
            inputSchema: z.record(z.unknown()).optional(),
          },
          async (args): Promise<CallToolResult> => {
            return handleDynamicToolCall(toolKey, args as Record<string, unknown>);
          }
        );
      }
      
      if (newlyRegistered > 0) {
        console.error(`${timestamp()} [DMCP]   📝 Registered ${newlyRegistered} new tools (session total: ${exposedTools.size})`);
      } else {
        console.error(`${timestamp()} [DMCP]   ↩ All ${tools.length} tools already registered`);
      }

      // Format response
      const toolList = tools.map((t, i) => {
        const toolKey = sanitizeToolName(`${t.serverId}_${t.name}`);
        return `${i + 1}. **${toolKey}** (score: ${t.score.toFixed(2)})\n   ${t.description}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${tools.length} relevant tools for "${query}":\n\n${toolList}\n\nThese tools are now available. Call them by name.`,
        }],
      };
    }
  );

  return server;
}

// ============================================================================
// Express Application
// ============================================================================

const app = express();
app.use(express.json());

// Store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Track active sessions for logging
let sessionCounter = 0;
const sessionInfo: Record<string, { id: number; createdAt: Date; requestCount: number }> = {};

/**
 * Format timestamp for logging
 */
function timestamp(): string {
  return new Date().toISOString().split('T')[1].split('.')[0];
}

/**
 * Log with timestamp and session context
 */
function log(message: string, sessionId?: string): void {
  const prefix = sessionId && sessionInfo[sessionId] 
    ? `[DMCP #${sessionInfo[sessionId].id}]`
    : '[DMCP]';
  console.error(`${timestamp()} ${prefix} ${message}`);
}

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  const activeSessions = Object.keys(transports).length;
  res.json({
    status: isInitialized ? 'healthy' : 'initializing',
    toolCount: totalToolCount,
    activeSessions,
    uptime: Math.floor(process.uptime()),
    error: initializationError?.message,
  });
});

// MCP endpoint - handle POST requests
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const method = req.body?.method || 'unknown';
  
  if (sessionId && sessionInfo[sessionId]) {
    sessionInfo[sessionId].requestCount++;
  }
  
  log(`POST /mcp [${method}]`, sessionId);
  
  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
      log(`  → Using existing session`, sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session - create transport
      const newSessionNum = ++sessionCounter;
      log(`📡 New connection request (will be session #${newSessionNum})`);
      
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessionInfo[sid] = { id: newSessionNum, createdAt: new Date(), requestCount: 1 };
          transports[sid] = transport;
          log(`✓ Session initialized: ${sid.slice(0, 8)}...`, sid);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          const info = sessionInfo[sid];
          if (info) {
            const duration = Math.floor((Date.now() - info.createdAt.getTime()) / 1000);
            log(`🔌 Session closed after ${duration}s (${info.requestCount} requests)`, sid);
            delete sessionInfo[sid];
          }
          delete transports[sid];
        }
      };

      // Connect transport to a new server instance
      const server = createServer();
      await server.connect(transport);
      log(`✓ Server connected to transport`);
    } else {
      // Invalid request
      log(`⚠️ Bad request: ${sessionId ? 'Invalid session' : 'Missing session for non-init request'}`);
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    log(`✗ Error handling request: ${(error as Error).message}`, sessionId);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Handle GET for SSE streams (async notifications)
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  log(`GET /mcp (SSE stream request)`, sessionId);
  
  if (!sessionId || !transports[sessionId]) {
    log(`⚠️ SSE rejected: ${sessionId ? 'unknown session' : 'missing session ID'}`);
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: null,
    });
    return;
  }

  log(`📺 Opening SSE stream`, sessionId);
  
  // Track SSE connection for logging
  req.on('close', () => {
    log(`📺 SSE stream closed by client`, sessionId);
  });
  
  req.on('error', (err) => {
    log(`⚠️ SSE stream error: ${err.message}`, sessionId);
  });

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Handle DELETE for session termination
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  log(`DELETE /mcp`, sessionId);
  
  if (sessionId && transports[sessionId]) {
    const transport = transports[sessionId];
    await transport.close();
    delete transports[sessionId];
    log(`✓ Session terminated`, sessionId);
    res.status(200).send();
  } else {
    log(`⚠️ Session not found for DELETE`);
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session not found' },
      id: null,
    });
  }
});

// ============================================================================
// Server Startup
// ============================================================================

// Start background initialization
initPromise = initialize();

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.error(`${timestamp()} [DMCP] ═══════════════════════════════════════`);
  console.error(`${timestamp()} [DMCP] 🚀 Server listening on http://0.0.0.0:${PORT}`);
  console.error(`${timestamp()} [DMCP]    MCP endpoint: http://localhost:${PORT}/mcp`);
  console.error(`${timestamp()} [DMCP]    Health check: http://localhost:${PORT}/health`);
  console.error(`${timestamp()} [DMCP] ═══════════════════════════════════════`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error(`${timestamp()} [DMCP] 🛑 Shutting down (SIGINT)...`);
  
  const sessionCount = Object.keys(transports).length;
  if (sessionCount > 0) {
    console.error(`${timestamp()} [DMCP]    Closing ${sessionCount} active sessions...`);
  }
  
  for (const sessionId of Object.keys(transports)) {
    try {
      await transports[sessionId].close();
    } catch (error) {
      console.error(`${timestamp()} [DMCP] ✗ Error closing session: ${(error as Error).message}`);
    }
  }
  
  try {
    await redis.disconnect();
    console.error(`${timestamp()} [DMCP] ✓ Redis disconnected`);
  } catch (error) {
    console.error(`${timestamp()} [DMCP] ✗ Redis disconnect error: ${(error as Error).message}`);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error(`${timestamp()} [DMCP] 🛑 Shutting down (SIGTERM)...`);
  process.exit(0);
});