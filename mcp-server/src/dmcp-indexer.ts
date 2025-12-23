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

interface IndexerOptions {
  configPath: string;
  force: boolean;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  embeddingURL: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): IndexerOptions {
  const args = process.argv.slice(2);
  const options: IndexerOptions = {
    configPath: process.env.MCP_CONFIG_PATH || join(homedir(), 'Work/mcp/mcp-tools/one-mcp/mcp.json'),
    force: false,
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT || '6380'),
    redisPassword: process.env.REDIS_PASSWORD,
    embeddingURL: process.env.EMBEDDING_URL || 'http://localhost:5000',
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
      case '--redis-host':
        options.redisHost = args[++i];
        break;
      case '--redis-port':
        options.redisPort = parseInt(args[++i]);
        break;
      case '--embedding-url':
        options.embeddingURL = args[++i];
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
  -c, --config <path>       Path to MCP config file (default: ~/Work/mcp/mcp-tools/one-mcp/mcp.json)
  -f, --force               Force re-indexing even if tools are cached
  --redis-host <host>       Redis host (default: localhost, env: REDIS_HOST)
  --redis-port <port>       Redis port (default: 6380, env: REDIS_PORT)
  --embedding-url <url>     Embedding service URL (default: http://localhost:5000, env: EMBEDDING_URL)
  -h, --help                Show this help message

Environment Variables:
  MCP_CONFIG_PATH           Default config file path
  REDIS_HOST                Redis host
  REDIS_PORT                Redis port
  REDIS_PASSWORD            Redis password
  EMBEDDING_URL             Embedding service URL

Examples:
  npm run index                           # Index with defaults
  npm run index -- --force                # Force re-index
  npm run index -- -c /path/to/mcp.json   # Custom config
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
    embeddingDimensions: 384,
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
    const config = loadMCPConfig(options.configPath);
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
