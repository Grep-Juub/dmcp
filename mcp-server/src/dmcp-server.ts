#!/usr/bin/env node

/**
 * DMCP Server - Dynamic Model Context Protocol Runtime
 * 
 * Lightweight MCP server for query-driven tool discovery.
 * Assumes tools are already indexed in Redis (use dmcp-indexer first).
 * 
 * Key features:
 * - Exposes ONLY search_tools meta-tool (no admin operations)
 * - Connects to backend SSE servers LAZILY (on first tool call)
 * - Dynamic tool list based on semantic search
 * - Sends listChanged notifications when tools update
 * 
 * Usage:
 *   npm run start                    # Start server
 *   npm run start -- /path/to/config # Custom config path
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { RedisVSS, FilteredTool } from './redis-vss.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Sanitize tool names to conform to MCP naming requirements [a-z0-9_-]
 */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

/**
 * DMCP Server - Runtime for dynamic tool discovery
 * 
 * LAZY ARCHITECTURE:
 * - Only connects to Redis at startup (fast!)
 * - Backend MCP servers are connected ON-DEMAND when a tool is called
 * - Tool metadata comes from Redis, not from querying backends
 */
class DMCPServer {
  private server: Server;
  private redis: RedisVSS;
  
  // Currently exposed tools (dynamic subset)
  private exposedTools: Map<string, Tool> = new Map();
  
  // Lazy connection pool for backend servers
  private serverClients: Map<string, Client> = new Map();
  private serverConfig: MCPConfig | null = null;
  
  // Configuration
  private topK: number;
  private minScore: number;
  
  // State
  private initializationPromise: Promise<void> | null = null;
  private isInitialized = false;
  private initializationError: Error | null = null;
  private totalToolCount = 0;

  constructor() {
    this.topK = parseInt(process.env.DMCP_TOP_K || '30');
    this.minScore = parseFloat(process.env.DMCP_MIN_SCORE || '0.25');
    
    this.server = new Server(
      {
        name: 'dmcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {
            listChanged: true,  // We send notifications when tools change
          },
        },
      }
    );

    this.redis = new RedisVSS({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6380'),
      password: process.env.REDIS_PASSWORD,
      embeddingDimensions: 384,
    });

    this.setupHandlers();
  }

  /**
   * The search_tools meta-tool definition
   */
  private getSearchToolDefinition(): Tool {
    return {
      name: 'mcp_dmcp_search_tools',
      description: `Search for relevant tools based on your task. This server has ${this.totalToolCount} tools indexed across multiple services (GitHub, Google Workspace, AWS, Kubernetes, Datadog, Grafana, Jira, etc.). Use this tool FIRST to discover which tools are available for your specific task. Returns the top ${this.topK} most relevant tools.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Describe what you want to do. Examples: "create a GitHub issue", "search emails", "check Kubernetes pod status", "query AWS costs"',
          },
          limit: {
            type: 'number',
            description: `Maximum number of tools to return (default: ${this.topK}, max: 50)`,
          },
        },
        required: ['query'],
      },
    };
  }

  /**
   * Notify clients that the tool list has changed
   */
  private notifyToolsChanged() {
    try {
      this.server.notification({
        method: 'notifications/tools/list_changed',
        params: {},
      });
      console.error(`[DMCP] Sent tools/list_changed notification (${this.exposedTools.size} tools now exposed)`);
    } catch (error) {
      console.error('[DMCP] Failed to send notification:', error);
    }
  }

  /**
   * Update exposed tools based on search results
   */
  private updateExposedTools(filteredTools: FilteredTool[]) {
    const newExposed = new Map<string, Tool>();
    
    // Always include the search meta-tool
    newExposed.set('mcp_dmcp_search_tools', this.getSearchToolDefinition());
    
    // Add filtered tools
    for (const tool of filteredTools) {
      const toolKey = sanitizeToolName(`${tool.serverId}_${tool.name}`);
      newExposed.set(toolKey, {
        name: toolKey,
        description: `[${tool.serverId}] ${tool.description}`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      });
    }
    
    // Check if tools actually changed
    const oldKeys = new Set(this.exposedTools.keys());
    const newKeys = new Set(newExposed.keys());
    
    const changed = oldKeys.size !== newKeys.size || 
      [...oldKeys].some(k => !newKeys.has(k)) ||
      [...newKeys].some(k => !oldKeys.has(k));
    
    if (changed) {
      this.exposedTools = newExposed;
      this.notifyToolsChanged();
    }
  }

  /**
   * Load MCP configuration file
   */
  private loadMCPConfig(configPath: string): MCPConfig {
    console.error(`[DMCP] Loading config from ${configPath}`);
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Connect to an SSE MCP Server (lazy - on demand)
   */
  private async connectToSSEServer(serverId: string, url: string): Promise<Client | null> {
    try {
      console.error(`[DMCP] Lazy connecting to ${serverId}...`);
      const transport = new SSEClientTransport(new URL(url));
      const client = new Client(
        { name: 'dmcp-client', version: '1.0.0' },
        { capabilities: {} }
      );
      await client.connect(transport);
      console.error(`[DMCP] ✓ Connected to ${serverId}`);
      return client;
    } catch (error) {
      console.error(`[DMCP] Failed to connect to ${serverId}:`, (error as Error).message);
      return null;
    }
  }

  /**
   * Get or create a client connection to a backend server (lazy)
   */
  private async getServerClient(serverId: string): Promise<Client | null> {
    // Return existing connection
    if (this.serverClients.has(serverId)) {
      return this.serverClients.get(serverId)!;
    }

    // Lazy connect
    if (!this.serverConfig) {
      throw new Error('Server config not loaded');
    }

    const serverCfg = this.serverConfig.mcpServers[serverId];
    if (!serverCfg || serverCfg.type !== 'sse' || !serverCfg.url) {
      console.error(`[DMCP] No SSE config for server: ${serverId}`);
      return null;
    }

    const client = await this.connectToSSEServer(serverId, serverCfg.url);
    if (client) {
      this.serverClients.set(serverId, client);
    }
    return client;
  }

  /**
   * Setup MCP protocol handlers
   */
  private setupHandlers() {
    // List currently exposed tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.waitForInit();
      console.error(`[DMCP] tools/list - returning ${this.exposedTools.size} tools`);
      return { tools: Array.from(this.exposedTools.values()) };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await this.waitForInit();

      const toolName = request.params.name;
      const args = request.params.arguments || {};

      console.error(`[DMCP] Tool call: ${toolName}`);

      // Handle the search_tools meta-tool
      if (toolName === 'mcp_dmcp_search_tools') {
        return this.handleSearchTools(args);
      }

      // Forward to backend MCP server
      return this.forwardToolCall(toolName, args);
    });
  }

  /**
   * Handle the search_tools meta-tool
   */
  private async handleSearchTools(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const query = args.query as string;
    const limit = Math.min(args.limit as number || this.topK, 50);

    console.error(`[DMCP] Searching: "${query}" (limit: ${limit})`);

    const filteredTools = await this.redis.search(query, {
      topK: limit,
      minScore: this.minScore,
    });

    console.error(`[DMCP] Found ${filteredTools.length} relevant tools`);

    // Update exposed tools and notify
    this.updateExposedTools(filteredTools);

    // Return formatted results for LLM
    const toolList = filteredTools.map((t, i) => {
      const toolKey = sanitizeToolName(`${t.serverId}_${t.name}`);
      return `${i + 1}. **${toolKey}** (score: ${t.score.toFixed(2)})\n   ${t.description}`;
    }).join('\n\n');

    const response = `Found ${filteredTools.length} relevant tools for "${query}":\n\n${toolList}\n\n` +
      `These tools are now available. You can call them directly by name.`;

    return {
      content: [{ type: 'text', text: response }],
    };
  }

  /**
   * Parse tool name to extract serverId and original name
   * Format: serverId_originalName (sanitized)
   */
  private parseToolName(toolName: string): { serverId: string; originalName: string } | null {
    // Tool names are formatted as: serverId_originalToolName (all lowercase, sanitized)
    // We need to find the server from the exposed tools map
    const tool = this.exposedTools.get(toolName);
    if (!tool) return null;

    // Extract serverId from the description which has format: [serverId] description
    const match = tool.description?.match(/^\[([^\]]+)\]/);
    if (!match) return null;

    const serverId = match[1];
    // Original name is toolName with serverId prefix removed
    const prefix = sanitizeToolName(serverId) + '_';
    if (!toolName.startsWith(prefix)) return null;
    
    const originalName = toolName.slice(prefix.length);
    return { serverId, originalName };
  }

  /**
   * Forward tool call to backend MCP server (lazy connection)
   */
  private async forwardToolCall(toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const parsed = this.parseToolName(toolName);
    if (!parsed) {
      return {
        content: [{
          type: 'text',
          text: `Tool "${toolName}" is not currently available. Use "mcp_dmcp_search_tools" first to discover relevant tools for your task.`,
        }],
      };
    }

    const { serverId, originalName } = parsed;

    // Lazy connect to backend server
    const client = await this.getServerClient(serverId);
    if (!client) {
      throw new Error(`Cannot connect to server: ${serverId}`);
    }

    console.error(`[DMCP] Forwarding to ${serverId}: ${originalName}`);
    
    const result = await client.callTool({
      name: originalName,
      arguments: args,
    });

    return result as { content: Array<{ type: string; text: string }> };
  }

  /**
   * Wait for initialization to complete
   */
  private async waitForInit(): Promise<void> {
    if (this.initializationPromise && !this.isInitialized) {
      await this.initializationPromise;
    }
    if (this.initializationError) {
      throw new Error(`Initialization failed: ${this.initializationError.message}`);
    }
  }

  /**
   * Start the DMCP server
   */
  async start(configPath: string) {
    try {
      // Initialize with search meta-tool
      this.exposedTools.set('mcp_dmcp_search_tools', this.getSearchToolDefinition());
      
      // Connect MCP server immediately (fast startup)
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('[DMCP] Server connected via stdio');

      // Background initialization
      this.initializationPromise = this.initializeInBackground(configPath);
    } catch (error) {
      console.error('[DMCP] Fatal error:', error);
      process.exit(1);
    }
  }

  /**
   * Background initialization - LAZY: only connects to Redis, not to backends
   * Backend connections are made on-demand when tools are called
   */
  private async initializeInBackground(configPath: string): Promise<void> {
    try {
      // Connect to Redis (read-only for searching)
      console.error('[DMCP] Connecting to Redis...');
      await this.redis.connect();
      
      // Get tool count from existing index
      this.totalToolCount = await this.redis.getToolCount();
      
      if (this.totalToolCount === 0) {
        console.error('[DMCP] ⚠️  No tools indexed in Redis!');
        console.error('[DMCP] Run "npm run index" first to index tools.');
      } else {
        console.error(`[DMCP] ✓ Found ${this.totalToolCount} indexed tools`);
      }

      // Load config for lazy backend connections (NO connections yet!)
      this.serverConfig = this.loadMCPConfig(configPath);
      const serverCount = Object.keys(this.serverConfig.mcpServers).length;
      console.error(`[DMCP] Loaded config with ${serverCount} backend servers (lazy connection)`);
      
      // Update search tool description with actual count
      this.exposedTools.set('mcp_dmcp_search_tools', this.getSearchToolDefinition());
      
      this.isInitialized = true;
      console.error(`[DMCP] ✓ Ready - ${this.totalToolCount} tools searchable, backends connect on-demand`);
    } catch (error) {
      console.error('[DMCP] Initialization error:', error);
      this.initializationError = error as Error;
    }
  }
}

// Start the server
const configPath = process.argv[2] || join(homedir(), 'Work/mcp/mcp-tools/one-mcp/mcp.json');
console.error(`[DMCP] Starting with config: ${configPath}`);
new DMCPServer().start(configPath);
