#!/usr/bin/env node

/**
 * DMCP Indexer - Tool Discovery and Indexing CLI
 * 
 * Separate process for discovering and indexing MCP tools in Redis.
 * Run this:
 * - After adding new MCP servers to the gateway
 * - After changing tool configurations
 * - Via cron for periodic refresh
 * 
 * Usage:
 *   npm run index                    # Index tools using default config
 *   npm run index -- --force         # Force re-index even if cached
 *   npm run index -- --config /path  # Use custom config path
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { RedisVSS, ToolMetadata } from './redis-vss.js';
import { EmbeddingClassifier, classifyToolHeuristic, type ToolDomain } from './tool-classifier.js';
import { CapabilityClusterer, formatDomainStats } from './tool-router.js';
import { extractKeywords } from './keyword-extractor.js';
import { readFileSync } from 'fs';
import { join } from 'path';

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

interface IndexerOptions {
  configPath: string;
  gatewayUrl: string;
  force: boolean;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  embeddingURL: string;
  classifyTools: boolean;
}

/**
 * Parse command line arguments
 */
function parseArgs(): IndexerOptions {
  const args = process.argv.slice(2);
  const options: IndexerOptions = {
    configPath: process.env.MCP_CONFIG_PATH || join(process.cwd(), 'mcp.json'),
    gatewayUrl: process.env.MCP_GATEWAY_URL || 'http://127.0.0.1:15000/config_dump',
    force: false,
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT || '6380'),
    redisPassword: process.env.REDIS_PASSWORD,
    embeddingURL: process.env.EMBEDDING_URL || 'http://localhost:5000',
    classifyTools: process.env.CLASSIFY_TOOLS !== 'false',  // Default: true
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--force':
      case '-f':
        options.force = true;
        break;
      case '--config':
      case '-c':
        options.configPath = args[++i];
        break;
      case '--gateway-url':
        options.gatewayUrl = args[++i];
        break;
      case '--redis-host':
        options.redisHost = args[++i];
        break;
      case '--redis-port':
        options.redisPort = parseInt(args[++i]);
        break;
      case '--embedding-url':
        options.embeddingURL = args[++i];
        break;
      case '--no-classify':
        options.classifyTools = false;
        break;
      case '--classify':
        options.classifyTools = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
DMCP Indexer - Index MCP tools in Redis for semantic search

Usage: dmcp-indexer [options]

Options:
  -c, --config <path>       Path to MCP config file (fallback if gateway unreachable)
  --gateway-url <url>       URL to Agent Gateway config dump (default: http://127.0.0.1:15000/config_dump)
  -f, --force               Force re-indexing even if tools are cached
  --redis-host <host>       Redis host (default: localhost, env: REDIS_HOST)
  --redis-port <port>       Redis port (default: 6380, env: REDIS_PORT)
  --embedding-url <url>     Embedding service URL (default: http://localhost:5000, env: EMBEDDING_URL)
  --classify                Enable embedding-based classification (default: on)
  --no-classify             Disable classification, use heuristics only
  -h, --help                Show this help message

Environment Variables:
  MCP_CONFIG_PATH           Default config file path
  MCP_GATEWAY_URL           Agent Gateway URL
  REDIS_HOST                Redis host
  REDIS_PORT                Redis port
  REDIS_PASSWORD            Redis password
  EMBEDDING_URL             Embedding service URL
  CLASSIFY_TOOLS            Set to 'false' to disable classification

Examples:
  npm run index                           # Index from gateway
  npm run index -- --force                # Force re-index
  npm run index -- --gateway-url http://... # Custom gateway URL
`);
}

/**
 * Load MCP configuration file
 */
function loadMCPConfig(configPath: string): MCPConfig {
  console.log(`📄 Loading config from ${configPath}`);
  const content = readFileSync(configPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Discover MCP servers from Agent Gateway
 */
async function discoverServersFromGateway(url: string): Promise<MCPConfig | null> {
  try {
    console.log(`🌐 Discovering servers from gateway: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gateway returned ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as any;
    const mcpServers: Record<string, MCPServerConfig> = {};
    
    if (data.binds && Array.isArray(data.binds)) {
      for (const bind of data.binds) {
        // Extract port from address (e.g., "[::]:3101" -> 3101)
        const addressParts = bind.address.split(':');
        const port = addressParts[addressParts.length - 1];
        
        // Extract name from listeners
        if (bind.listeners) {
          for (const listenerKey in bind.listeners) {
            const listener = bind.listeners[listenerKey];
            if (listener.name) {
              // Remove 'listener-' prefix if present
              const name = listener.name.replace(/^listener-/, '');
              
              mcpServers[name] = {
                type: 'sse',
                url: `http://localhost:${port}/sse`
              };
              console.log(`   Found ${name} on port ${port}`);
            }
          }
        }
      }
    }
    
    const count = Object.keys(mcpServers).length;
    if (count > 0) {
      console.log(`✓ Discovered ${count} servers from gateway`);
      return { mcpServers };
    } else {
      console.log('⚠️  No servers found in gateway config');
      return null;
    }
  } catch (error) {
    console.log(`⚠️  Failed to discover from gateway: ${(error as Error).message}`);
    return null;
  }
}


/**
 * Connect to an SSE MCP Server
 */
async function connectToSSEServer(serverId: string, url: string): Promise<Client | null> {
  try {
    process.stdout.write(`  Connecting to ${serverId}... `);
    const transport = new SSEClientTransport(new URL(url));
    const client = new Client(
      { name: 'dmcp-indexer', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    console.log('✓');
    return client;
  } catch (error) {
    console.log(`✗ ${(error as Error).message}`);
    return null;
  }
}

/**
 * Main indexer function
 */
async function main() {
  const options = parseArgs();
  const startTime = Date.now();

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('         DMCP Indexer - Tool Discovery');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // Initialize Redis
  const redis = new RedisVSS({
    host: options.redisHost,
    port: options.redisPort,
    password: options.redisPassword,
    embeddingURL: options.embeddingURL,
    embeddingDimensions: 1024,  // ToolRet-trained-e5-large-v2 uses 1024 dims
  });

  try {
    // Connect to Redis
    console.log('🔌 Connecting to Redis...');
    await redis.connect();
    await redis.createIndex();
    console.log('   ✓ Redis connected');
    console.log('');

    // Check existing tools
    const existingCount = await redis.getToolCount();
    if (existingCount > 0 && !options.force) {
      console.log(`ℹ️  Found ${existingCount} tools already indexed in Redis`);
      console.log('   Use --force to re-index');
      console.log('');
      await redis.disconnect();
      process.exit(0);
    }

    if (options.force && existingCount > 0) {
      console.log(`🗑️  Clearing ${existingCount} existing tools...`);
      await redis.clearIndex();
    }

    // Load config
    let config: MCPConfig | null = null;
    
    // Try gateway first
    if (options.gatewayUrl) {
      config = await discoverServersFromGateway(options.gatewayUrl);
    }
    
    if (!config) {
      console.error('❌ No MCP configuration found from gateway');
      await redis.disconnect();
      process.exit(1);
    }

    const serverCount = Object.keys(config.mcpServers).length;
    console.log(`   Found ${serverCount} MCP servers`);
    console.log('');

    // Discover tools from all servers
    console.log('🔍 Discovering tools from MCP servers...');
    console.log('');
    
    const tools: ToolMetadata[] = [];
    const clients: Map<string, Client> = new Map();
    let toolIdCounter = 0;
    let successfulServers = 0;
    let failedServers = 0;

    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.type !== 'sse' || !serverConfig.url) {
        console.log(`  ⏭️  Skipping ${serverId} (not SSE)`);
        continue;
      }

      const client = await connectToSSEServer(serverId, serverConfig.url);
      if (!client) {
        failedServers++;
        continue;
      }

      clients.set(serverId, client);

      try {
        const result = await client.listTools();
        console.log(`     → ${result.tools.length} tools`);
        successfulServers++;

        for (const tool of result.tools) {
          tools.push({
            id: `${toolIdCounter++}`,
            serverId,
            serverUrl: serverConfig.url,
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
          });
        }
      } catch (error) {
        console.log(`     → Error: ${(error as Error).message}`);
        failedServers++;
      }

      // Close connection after listing tools
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }

    console.log('');
    console.log(`📊 Discovery Summary:`);
    console.log(`   • Successful servers: ${successfulServers}`);
    console.log(`   • Failed servers: ${failedServers}`);
    console.log(`   • Total tools found: ${tools.length}`);
    console.log('');

    if (tools.length === 0) {
      console.log('⚠️  No tools found! Check your MCP servers.');
      await redis.disconnect();
      process.exit(1);
    }

    // ============ CLASSIFICATION STEP ============
    console.log('🏷️  Classifying tools (category + domain)...');
    
    const classificationStartTime = Date.now();
    
    if (options.classifyTools) {
      console.log('   Using embedding-based classification');
      
      const classifier = new EmbeddingClassifier({
        embeddingURL: options.embeddingURL,
      });

      // Use full classification (category + domain)
      const classifications = await classifier.classifyFullBatch(
        tools.map(t => ({ name: t.name, description: t.description, serverId: t.serverId })),
        (current, total) => {
          const percent = Math.floor((current / total) * 100);
          process.stdout.write(`\r   Classifying: ${percent}% (${current}/${total})     `);
        }
      );
      
      process.stdout.write('\r' + ' '.repeat(60) + '\r');

      // Apply classifications to tools
      for (const tool of tools) {
        const result = classifications.get(tool.name);
        tool.category = result?.category || 'general';
        tool.domain = result?.domain || 'general';
      }

      // Category stats
      const categoryStats = { meta: 0, query: 0, action: 0, general: 0 };
      for (const tool of tools) {
        categoryStats[tool.category as keyof typeof categoryStats]++;
      }
      console.log(`   ✓ Classification complete (${Date.now() - classificationStartTime}ms)`);
      console.log(`     Categories: meta: ${categoryStats.meta} | query: ${categoryStats.query} | action: ${categoryStats.action} | general: ${categoryStats.general}`);
      
      // Domain stats
      const domainStats: Record<ToolDomain, number> = {
        api: 0, terminal: 0, browser: 0, reasoning: 0, 
        filesystem: 0, data: 0, observability: 0, cloud: 0, general: 0
      };
      for (const tool of tools) {
        if (tool.domain) {
          domainStats[tool.domain as ToolDomain]++;
        }
      }
      console.log(`     Domains: ${formatDomainStats(domainStats)}`);
      
      // ============ CAPABILITY CLUSTERING STEP ============
      console.log('');
      console.log('🔗 Clustering similar tools...');
      
      const clusterer = new CapabilityClusterer(classifier.getDomainClassifier().getEmbeddingProvider());
      const clusters = await clusterer.clusterTools(
        tools.map(t => ({ name: t.name, description: t.description }))
      );
      
      // Apply cluster IDs to tools
      for (const tool of tools) {
        tool.clusterId = clusters.get(tool.name);
      }
      
    } else {
      console.log('   Using heuristic classification (--no-classify)');
      
      for (const tool of tools) {
        tool.category = classifyToolHeuristic(tool.name, tool.description);
        tool.domain = 'general';  // Default domain when using heuristics
      }

      // Count categories
      const stats = { meta: 0, query: 0, action: 0, general: 0 };
      for (const tool of tools) {
        stats[tool.category as keyof typeof stats]++;
      }
      
      console.log(`   ✓ Classification complete`);
      console.log(`     • meta: ${stats.meta} | query: ${stats.query} | action: ${stats.action} | general: ${stats.general}`);
    }
    console.log('');

    // ============ KEYWORD EXTRACTION STEP ============
    console.log('🔑 Extracting keywords from descriptions...');
    
    const keywordStartTime = Date.now();
    let keywordCount = 0;
    
    for (const tool of tools) {
      const extraction = extractKeywords(tool.name, tool.description);
      tool.keywords = extraction.keywords;
      keywordCount += extraction.keywords.length;
      
      // Enhance description with searchable text for BM25
      // Append keywords as plain text for better BM25 matching
      if (extraction.searchableText) {
        tool.description = `${tool.description} ${extraction.searchableText}`;
      }
    }
    
    console.log(`   ✓ Keyword extraction complete (${Date.now() - keywordStartTime}ms)`);
    console.log(`     • Extracted ${keywordCount} keywords from ${tools.length} tools`);
    console.log(`     • Average: ${(keywordCount / tools.length).toFixed(1)} keywords per tool`);
    console.log('');

    // Index tools with progress bar
    console.log('📥 Indexing tools in Redis...');
    console.log('');
    
    const indexStartTime = Date.now();
    let lastPercent = -1;
    
    await redis.indexTools(tools, (current, total) => {
      const percent = Math.floor((current / total) * 100);
      const elapsed = (Date.now() - indexStartTime) / 1000;
      const rate = current / elapsed;
      const remaining = (total - current) / rate;
      
      // Only update if percent changed
      if (percent !== lastPercent) {
        lastPercent = percent;
        
        // Create progress bar
        const barWidth = 30;
        const filled = Math.floor((current / total) * barWidth);
        const empty = barWidth - filled;
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        
        // Format ETA
        const etaStr = remaining > 0 && isFinite(remaining) 
          ? `ETA: ${Math.ceil(remaining)}s` 
          : '';
        
        // Write progress (use \r to overwrite line)
        process.stdout.write(`\r   [${bar}] ${percent}% (${current}/${total}) ${etaStr}     `);
      }
    });
    
    // Clear progress line and print completion
    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    // Verify
    const finalCount = await redis.getToolCount();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('                    ✓ Complete');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log(`   📦 Tools indexed: ${finalCount}`);
    console.log(`   ⏱️  Duration: ${duration}s`);
    console.log(`   🔗 Redis: ${options.redisHost}:${options.redisPort}`);
    console.log('');
    console.log('   Next: Start the DMCP server with "npm run start"');
    console.log('');

    await redis.disconnect();
    process.exit(0);

  } catch (error) {
    console.error('');
    console.error('❌ Error:', (error as Error).message);
    console.error('');
    await redis.disconnect();
    process.exit(1);
  }
}

main();
