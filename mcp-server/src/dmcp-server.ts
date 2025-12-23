#!/usr/bin/env node

/**
 * DMCP Server - Dynamic Model Context Protocol Runtime
 * 
 * Lightweight MCP server for query-driven tool discovery.
 * Assumes tools are already indexed in Redis (use dmcp-indexer first).
 * 
 * Key features:
 * - Exposes ONLY search_tools meta-tool (no admin operations)
 * - Connects to backend SSE servers for tool forwarding
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
 */
class DMCPServer {
  private server: Server;
  private redis: RedisVSS;
  
  // Currently exposed tools (dynamic subset)
  private exposedTools: Map<string, Tool> = new Map();
  
  // Mappings for tool forwarding
  private toolToServer: Map<string, string> = new Map();
  private toolOriginalNames: Map<string, string> = new Map();
  private serverClients: Map<string, Client> = new Map();
  
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
      embeddingURL: process.env.EMBEDDING_URL || 'http://localhost:5000',
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
   * Connect to an SSE MCP Server
   */
  private async connectToSSEServer(serverId: string, url: string): Promise<Client | null> {
    try {
      console.error(`[DMCP] Connecting to ${serverId}...`);
      const transport = new SSEClientTransport(new URL(url));
      const client = new Client(
        { name: 'dmcp-client', version: '1.0.0' },
        { capabilities: {} }
      );
      await client.connect(transport);
      return client;
    } catch (error) {
      console.error(`[DMCP] Failed to connect to ${serverId}:`, (error as Error).message);
      return null;
    }
  }

  /**
   * Connect to backend servers and build tool mapping
   * Does NOT index - assumes tools are already in Redis
   */
  private async connectToBackends(config: MCPConfig): Promise<void> {
    console.error('[DMCP] Connecting to backend MCP servers...');

    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.type !== 'sse' || !serverConfig.url) {
        continue;
      }

      const client = await this.connectToSSEServer(serverId, serverConfig.url);
      if (!client) continue;

      this.serverClients.set(serverId, client);

      try {
        const result = await client.listTools();
        console.error(`[DMCP] ${serverId}: ${result.tools.length} tools`);

        // Build mappings for tool forwarding
        for (const tool of result.tools) {
          const toolKey = sanitizeToolName(`${serverId}_${tool.name}`);
          this.toolToServer.set(toolKey, serverId);
          this.toolOriginalNames.set(toolKey, tool.name);
        }
      } catch (error) {
        console.error(`[DMCP] Failed to list tools from ${serverId}:`, (error as Error).message);
      }
    }

    console.error(`[DMCP] Connected to ${this.serverClients.size} backend servers`);
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
   * Forward tool call to backend MCP server
   */
  private async forwardToolCall(toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const serverId = this.toolToServer.get(toolName);
    if (!serverId) {
      return {
        content: [{
          type: 'text',
          text: `Tool "${toolName}" is not currently available. Use "mcp_dmcp_search_tools" first to discover relevant tools for your task.`,
        }],
      };
    }

    const client = this.serverClients.get(serverId);
    if (!client) {
      throw new Error(`Server not connected: ${serverId}`);
    }

    const originalName = this.toolOriginalNames.get(toolName);
    if (!originalName) {
      throw new Error(`Original name not found for: ${toolName}`);
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
   * Background initialization
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

      // Load config and connect to backends
      const config = this.loadMCPConfig(configPath);
      await this.connectToBackends(config);
      
      // Update search tool description with actual count
      this.exposedTools.set('mcp_dmcp_search_tools', this.getSearchToolDefinition());
      
      this.isInitialized = true;
      console.error(`[DMCP] ✓ Ready - ${this.totalToolCount} tools searchable, 1 meta-tool exposed`);
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
