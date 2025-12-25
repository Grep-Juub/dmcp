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
  
  // Always-exposed meta tools (LLM enhancement)
  private metaTools: Map<string, Tool> = new Map();
  
  // Map toolKey -> serverUrl for direct connection
  private toolServerUrls: Map<string, string> = new Map();
  
  // Tool usage tracking for eviction
  private toolLastUsed: Map<string, number> = new Map();  // toolKey -> request counter
  private requestCounter = 0;
  private readonly EVICTION_THRESHOLD = 5;  // Remove tools not used in N requests
  
  // Lazy connection pool for backend servers
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
    this.topK = parseInt(process.env.DMCP_TOP_K || '15');
    this.minScore = parseFloat(process.env.DMCP_MIN_SCORE || '0.3');
    
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
   * 
   * Based on Anthropic's official Tool Search Tool pattern:
   * https://github.com/anthropics/claude-cookbooks/blob/main/tool_use/tool_search_with_embeddings.ipynb
   * 
   * Key principle: Generic, action-oriented description that tells the LLM
   * "use this when you need a tool but don't have it available yet"
   */
  private getSearchToolDefinition(): Tool {
    // More assertive description that competes with built-in tools
    // Key: Make it clear this provides BETTER/MORE capabilities than defaults
    const description = [
      `Search for relevant tools based on your task.`,
      `This server has ${this.totalToolCount} tools indexed across multiple services`,
      `(GitHub, Google Workspace, AWS, Kubernetes, Datadog, Grafana, Jira, etc.).`,
      `Use this tool FIRST to discover which tools are available for your specific task.`,
      `Returns the top ${this.topK} most relevant tools.`,
    ].join(' ');
    
    return {
      name: 'mcp_dmcp_search_tools',
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
   * Merges new tools with recently-used tools and evicts stale ones
   * Always includes meta tools (LLM enhancement)
   */
  private updateExposedTools(filteredTools: FilteredTool[]) {
    const newExposed = new Map<string, Tool>();
    
    // Always include the search meta-tool
    newExposed.set('mcp_dmcp_search_tools', this.getSearchToolDefinition());
    
    // Always include meta tools (LLM enhancement - sequential-thinking, etc.)
    for (const [toolKey, tool] of this.metaTools) {
      newExposed.set(toolKey, tool);
    }
    
    // Add new filtered tools from search
    for (const tool of filteredTools) {
      const toolKey = sanitizeToolName(`${tool.serverId}_${tool.name}`);
      newExposed.set(toolKey, {
        name: toolKey,
        description: `[${tool.serverId}] ${tool.description}`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      });
      
      if (tool.serverUrl) {
        this.toolServerUrls.set(toolKey, tool.serverUrl);
      }
      
      // Mark as fresh (will be kept)
      this.toolLastUsed.set(toolKey, this.requestCounter);
    }
    
    // Keep recently-used tools that aren't in the new search results
    for (const [toolKey, tool] of this.exposedTools) {
      if (toolKey === 'mcp_dmcp_search_tools') continue;
      if (this.metaTools.has(toolKey)) continue;  // Skip meta tools (always kept)
      if (newExposed.has(toolKey)) continue;
      
      const lastUsed = this.toolLastUsed.get(toolKey) || 0;
      const age = this.requestCounter - lastUsed;
      
      if (age < this.EVICTION_THRESHOLD) {
        // Keep this tool - it was used recently
        newExposed.set(toolKey, tool);
      } else {
        // Evict this stale tool
        this.toolLastUsed.delete(toolKey);
        console.error(`[DMCP] Evicted stale tool: ${toolKey} (unused for ${age} requests)`);
      }
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
  private async getServerClient(serverId: string, serverUrl?: string): Promise<Client | null> {
    // Return existing connection
    if (this.serverClients.has(serverId)) {
      return this.serverClients.get(serverId)!;
    }

    // Lazy connect
    if (!serverUrl) {
      console.error(`[DMCP] No server URL provided for: ${serverId}`);
      return null;
    }

    const client = await this.connectToSSEServer(serverId, serverUrl);
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
   * Parse query to detect CRUD intent for smarter filtering
   * Returns intent type: 'read', 'create', 'update', 'delete', or null (no specific intent)
   */
  private parseQueryIntent(query: string): 'read' | 'create' | 'update' | 'delete' | null {
    const q = query.toLowerCase();
    
    // Read intent
    if (/\b(get|read|fetch|list|search|find|show|view|query|check|retrieve)\b/.test(q)) {
      return 'read';
    }
    // Create intent
    if (/\b(create|add|new|post|insert|make|write)\b/.test(q)) {
      return 'create';
    }
    // Update intent
    if (/\b(update|edit|modify|change|patch|put|set|assign)\b/.test(q)) {
      return 'update';
    }
    // Delete intent
    if (/\b(delete|remove|drop|destroy|clear|unset)\b/.test(q)) {
      return 'delete';
    }
    
    return null;
  }

  /**
   * Filter tools by intent (CRUD operation matching)
   */
  private filterByIntent(tools: FilteredTool[], intent: 'read' | 'create' | 'update' | 'delete'): FilteredTool[] {
    const patterns: Record<string, RegExp> = {
      read: /\b(get|read|list|search|find|query|fetch|retrieve|show)\b/i,
      create: /\b(create|add|post|insert|new|write)\b/i,
      update: /\b(update|edit|put|patch|modify|set|assign)\b/i,
      delete: /\b(delete|remove|drop|destroy|clear)\b/i,
    };
    
    const pattern = patterns[intent];
    
    // Filter to tools matching the intent
    const matching = tools.filter(t => {
      const text = `${t.name} ${t.description}`.toLowerCase();
      return pattern.test(text);
    });
    
    // If we found matching tools, return them; otherwise return all (fallback)
    return matching.length > 0 ? matching : tools;
  }

  /**
   * Handle the search_tools meta-tool with smart routing
   */
  private async handleSearchTools(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const query = args.query as string;
    const limit = Math.min(args.limit as number || this.topK, 50);

    console.error(`[DMCP] Searching: "${query}" (limit: ${limit})`);

    // Detect intent from query
    const intent = this.parseQueryIntent(query);
    if (intent) {
      console.error(`[DMCP] Detected intent: ${intent}`);
    }

    // Get more candidates from Redis for routing
    const rawTools = await this.redis.search(query, {
      topK: limit * 3,  // Get more candidates for routing/dedup
      minScore: this.minScore,
    });

    console.error(`[DMCP] Found ${rawTools.length} candidate tools from Redis`);

    // NO FILTERING - Trust the vector embeddings completely
    // The ToolRet model is specifically trained for tool selection
    const finalTools = rawTools.slice(0, limit);

    // Update exposed tools and notify
    this.updateExposedTools(finalTools);

    // Return formatted results - simple and clean
    const toolList = finalTools.map((t, i) => {
      const toolKey = sanitizeToolName(`${t.serverId}_${t.name}`);
      const domainInfo = t.domain ? ` [${t.domain}]` : '';
      return `${i + 1}. **${toolKey}**${domainInfo} (score: ${t.score.toFixed(2)})\n   ${t.description}`;
    }).join('\n\n');

    const response = `Found ${finalTools.length} relevant tools for "${query}":\n\n${toolList}\n\nThese tools are now available. You can call them directly by name.`;

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
    // Increment request counter on each tool call
    this.requestCounter++;
    
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
    
    // Mark tool as used (prevents eviction)
    this.toolLastUsed.set(toolName, this.requestCounter);

    // Get server URL from our map
    const serverUrl = this.toolServerUrls.get(toolName);

    // Lazy connect to backend server
    const client = await this.getServerClient(serverId, serverUrl);
    if (!client) {
      throw new Error(`Cannot connect to server: ${serverId} (URL: ${serverUrl || 'unknown'})`);
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
  async start() {
    try {
      // Initialize with search meta-tool
      this.exposedTools.set('mcp_dmcp_search_tools', this.getSearchToolDefinition());
      
      // Connect MCP server immediately (fast startup)
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('[DMCP] Server connected via stdio');

      // Background initialization
      this.initializationPromise = this.initializeInBackground();
    } catch (error) {
      console.error('[DMCP] Fatal error:', error);
      process.exit(1);
    }
  }

  /**
   * Background initialization - LAZY: only connects to Redis, not to backends
   * Backend connections are made on-demand when tools are called
   */
  private async initializeInBackground(): Promise<void> {
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

      // Meta tools are handled through regular search - no special loading needed

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
console.error(`[DMCP] Starting server (using Redis for configuration)`);
new DMCPServer().start();
