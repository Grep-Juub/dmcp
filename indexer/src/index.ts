#!/usr/bin/env node

/**
 * DMCP Indexer - Tool Discovery and Indexing Worker
 * 
 * Modes:
 * - Manual: Run once and exit (npm run index)
 * - Worker: Run continuously and sync periodically (npm run worker)
 * 
 * Beautiful terminal UI for discovering and indexing MCP tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { RedisVSS, ToolMetadata } from './redis-vss.js';
import { Listr, ListrTask } from 'listr2';
import cliProgress from 'cli-progress';
import chalk from 'chalk';

interface MCPServerConfig {
  type?: string;
  url?: string;
  port?: string;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

interface IndexerOptions {
  gatewayUrl: string;
  force: boolean;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  embeddingURL: string;
  targetServer?: string;
  // Worker mode options
  worker: boolean;
  interval: number;  // Sync interval in seconds
}

interface ServerResult {
  serverId: string;
  status: 'ok' | 'failed';
  toolCount: number;
  tools: ToolMetadata[];
  error?: string;
}

interface SyncResult {
  added: number;
  removed: number;
  updated: number;
  unchanged: number;
  errors: string[];
}

function parseArgs(): IndexerOptions {
  const args = process.argv.slice(2);
  const options: IndexerOptions = {
    gatewayUrl: process.env.MCP_GATEWAY_URL || 'http://127.0.0.1:15000/config_dump',
    force: false,
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT || '6380'),
    redisPassword: process.env.REDIS_PASSWORD,
    embeddingURL: process.env.EMBEDDING_URL || 'http://localhost:5000',
    targetServer: process.env.TARGET_SERVER,
    worker: false,
    interval: parseInt(process.env.SYNC_INTERVAL || '60'),  // Default 60 seconds
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--force':
      case '-f':
        options.force = true;
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
      case '--server':
      case '-s':
        options.targetServer = args[++i];
        break;
      case '--worker':
      case '-w':
        options.worker = true;
        break;
      case '--interval':
      case '-i':
        options.interval = parseInt(args[++i]);
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
${chalk.bold('DMCP Indexer')} - Index MCP tools in Redis for semantic search

${chalk.dim('Usage:')} npm run index [options]
        npm run worker [options]

${chalk.dim('Modes:')}
  ${chalk.bold('Manual')} (default)     Run once, index all tools, exit
  ${chalk.bold('Worker')} (-w)          Run continuously, sync changes periodically

${chalk.dim('Options:')}
  -f, --force               Force re-indexing even if tools are cached
  -s, --server <name|port>  Index only a specific server
  -w, --worker              Run in worker mode (continuous sync)
  -i, --interval <sec>      Sync interval in seconds (default: 60)
  --gateway-url <url>       Agent Gateway URL
  --redis-host <host>       Redis host (default: localhost)
  --redis-port <port>       Redis port (default: 6380)
  --embedding-url <url>     Embedding service URL
  -h, --help                Show this help

${chalk.dim('Worker Mode:')}
  The worker runs continuously and:
  • Detects new tools added to MCP servers
  • Removes tools from servers that are gone
  • Updates tools whose descriptions changed
  • Logs changes to stdout for monitoring

${chalk.dim('Examples:')}
  npm run index              # Full index (first time)
  npm run index -- -f        # Force re-index all
  npm run index -- -s github # Index only github server
  npm run worker             # Run as daemon (60s interval)
  npm run worker -- -i 30    # Sync every 30 seconds
`);
}

async function discoverServersFromGateway(url: string): Promise<MCPConfig | null> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Gateway returned ${response.status}`);
  }
  
  const data = await response.json() as any;
  const mcpServers: Record<string, MCPServerConfig> = {};
  
  if (data.binds && Array.isArray(data.binds)) {
    for (const bind of data.binds) {
      const addressParts = bind.address.split(':');
      const port = addressParts[addressParts.length - 1];
      
      if (bind.listeners) {
        for (const listenerKey in bind.listeners) {
          const listener = bind.listeners[listenerKey];
          if (listener.name) {
            const name = listener.name.replace(/^listener-/, '');
            mcpServers[name] = {
              type: 'sse',
              url: `http://localhost:${port}/sse`,
              port: port,
            };
          }
        }
      }
    }
  }
  
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : null;
}

async function connectAndListTools(serverId: string, url: string): Promise<{ tools: any[], client: Client }> {
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client(
    { name: 'dmcp-indexer', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  const result = await client.listTools();
  return { tools: result.tools, client };
}

/**
 * Generate a fingerprint for a tool to detect changes
 */
function toolFingerprint(tool: ToolMetadata): string {
  return `${tool.name}:${tool.description}:${JSON.stringify(tool.inputSchema || {})}`;
}

/**
 * Sync tools with Redis - detect and apply changes
 */
async function syncTools(
  redis: RedisVSS,
  newTools: ToolMetadata[],
  existingTools: ToolMetadata[],
  onProgress?: (current: number, total: number) => void
): Promise<SyncResult> {
  const result: SyncResult = {
    added: 0,
    removed: 0,
    updated: 0,
    unchanged: 0,
    errors: []
  };

  // Build maps for comparison
  const existingMap = new Map<string, ToolMetadata>();
  for (const tool of existingTools) {
    const key = `${tool.serverId}:${tool.name}`;
    existingMap.set(key, tool);
  }

  const newMap = new Map<string, ToolMetadata>();
  for (const tool of newTools) {
    const key = `${tool.serverId}:${tool.name}`;
    newMap.set(key, tool);
  }

  // Find tools to add (in new but not in existing)
  const toAdd: ToolMetadata[] = [];
  for (const [key, tool] of newMap) {
    if (!existingMap.has(key)) {
      toAdd.push(tool);
    }
  }

  // Find tools to remove (in existing but not in new)
  const toRemove: ToolMetadata[] = [];
  for (const [key, tool] of existingMap) {
    if (!newMap.has(key)) {
      toRemove.push(tool);
    }
  }

  // Find tools to update (in both but changed)
  const toUpdate: ToolMetadata[] = [];
  for (const [key, newTool] of newMap) {
    const existingTool = existingMap.get(key);
    if (existingTool && toolFingerprint(newTool) !== toolFingerprint(existingTool)) {
      toUpdate.push(newTool);
    }
  }

  result.unchanged = newTools.length - toAdd.length - toUpdate.length;

  // Apply changes
  const totalChanges = toAdd.length + toRemove.length + toUpdate.length;
  let processed = 0;

  // Remove deleted tools
  for (const tool of toRemove) {
    try {
      await redis.removeTool(tool.serverId, tool.id);
      result.removed++;
    } catch (error) {
      result.errors.push(`Remove ${tool.name}: ${(error as Error).message}`);
    }
    processed++;
    if (onProgress) onProgress(processed, totalChanges);
  }

  // Add new tools
  if (toAdd.length > 0) {
    try {
      await redis.indexTools(toAdd, (current, total) => {
        if (onProgress) onProgress(processed + current, totalChanges);
      });
      result.added = toAdd.length;
      processed += toAdd.length;
    } catch (error) {
      result.errors.push(`Add tools: ${(error as Error).message}`);
    }
  }

  // Update changed tools (remove + add)
  for (const tool of toUpdate) {
    try {
      await redis.removeTool(tool.serverId, tool.id);
      await redis.indexTools([tool]);
      result.updated++;
    } catch (error) {
      result.errors.push(`Update ${tool.name}: ${(error as Error).message}`);
    }
    processed++;
    if (onProgress) onProgress(processed, totalChanges);
  }

  return result;
}

/**
 * Discover all tools from gateway
 */
async function discoverAllTools(
  config: MCPConfig,
  options: { quiet?: boolean } = {}
): Promise<{ tools: ToolMetadata[], results: ServerResult[] }> {
  const serverEntries = Object.entries(config.mcpServers).filter(
    ([_, cfg]) => cfg.type === 'sse' && cfg.url
  );

  const results: ServerResult[] = [];
  let toolIdCounter = Date.now();

  // Process servers concurrently
  await Promise.all(
    serverEntries.map(async ([serverId, serverConfig]) => {
      try {
        const { tools, client } = await connectAndListTools(serverId, serverConfig.url!);
        
        const serverTools: ToolMetadata[] = tools.map(tool => ({
          id: `${toolIdCounter++}`,
          serverId,
          serverUrl: serverConfig.url!,
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema,
        }));
        
        results.push({
          serverId,
          status: 'ok',
          toolCount: tools.length,
          tools: serverTools,
        });
        
        try { await client.close(); } catch {}
      } catch (error) {
        results.push({
          serverId,
          status: 'failed',
          toolCount: 0,
          tools: [],
          error: (error as Error).message,
        });
      }
    })
  );

  const allTools = results.flatMap(r => r.tools);
  return { tools: allTools, results };
}

async function main() {
  const options = parseArgs();
  const startTime = Date.now();

  // Header
  console.log('');
  console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('         DMCP Indexer - Tool Discovery          ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════════════╝'));
  if (options.targetServer) {
    console.log(chalk.dim(`  Target: ${options.targetServer}`));
  }
  console.log('');

  let redis: RedisVSS;
  let config: MCPConfig;
  let existingCount = 0;

  // Phase 1: Setup
  const setupTasks = new Listr([
    {
      title: 'Connecting to Redis',
      task: async (ctx) => {
        redis = new RedisVSS({
          host: options.redisHost,
          port: options.redisPort,
          password: options.redisPassword,
          embeddingURL: options.embeddingURL,
          embeddingDimensions: 1024,
        });
        await redis.connect();
        await redis.createIndex();
        ctx.redis = redis;
      }
    },
    {
      title: 'Checking existing index',
      task: async (ctx) => {
        existingCount = await redis.getToolCount();
        if (existingCount > 0 && !options.force && !options.targetServer) {
          throw new Error(`Found ${existingCount} tools. Use --force to re-index.`);
        }
        ctx.existingCount = existingCount;
      }
    },
    {
      title: 'Clearing existing index',
      skip: () => !options.force || existingCount === 0 || !!options.targetServer,
      task: async () => {
        await redis.clearIndex();
      }
    },
    {
      title: 'Discovering servers from gateway',
      task: async (ctx) => {
        config = await discoverServersFromGateway(options.gatewayUrl) as MCPConfig;
        if (!config) {
          throw new Error('No MCP servers found from gateway');
        }
        
        if (options.targetServer) {
          const filtered: Record<string, MCPServerConfig> = {};
          for (const [name, cfg] of Object.entries(config.mcpServers)) {
            if (name === options.targetServer || name.includes(options.targetServer) || cfg.port === options.targetServer) {
              filtered[name] = cfg;
            }
          }
          if (Object.keys(filtered).length === 0) {
            throw new Error(`No server found matching: ${options.targetServer}`);
          }
          config.mcpServers = filtered;
        }
        
        ctx.serverCount = Object.keys(config.mcpServers).length;
      }
    }
  ], {
    concurrent: false,
    rendererOptions: {
      collapseSubtasks: false,
    }
  });

  try {
    await setupTasks.run();
  } catch (error) {
    console.log('');
    console.log(chalk.red(`  ✗ ${(error as Error).message}`));
    console.log('');
    process.exit(1);
  }

  // Phase 2: Discover tools from servers (parallel)
  console.log('');
  console.log(chalk.bold('  Discovering tools from MCP servers...'));
  console.log('');

  const serverEntries = Object.entries(config!.mcpServers).filter(
    ([_, cfg]) => cfg.type === 'sse' && cfg.url
  );

  const results: ServerResult[] = [];
  let toolIdCounter = Date.now();
  
  // Create tasks for each server
  const serverTasks = new Listr(
    serverEntries.map(([serverId, serverConfig]) => ({
      title: `${serverId}`,
      task: async (ctx: any, task: any) => {
        try {
          const { tools, client } = await connectAndListTools(serverId, serverConfig.url!);
          
          const serverTools: ToolMetadata[] = tools.map(tool => ({
            id: `${toolIdCounter++}`,
            serverId,
            serverUrl: serverConfig.url!,
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
          }));
          
          results.push({
            serverId,
            status: 'ok',
            toolCount: tools.length,
            tools: serverTools,
          });
          
          task.title = `${serverId} ${chalk.green('✓')} ${chalk.dim(`${tools.length} tools`)}`;
          
          try { await client.close(); } catch {}
        } catch (error) {
          results.push({
            serverId,
            status: 'failed',
            toolCount: 0,
            tools: [],
            error: (error as Error).message,
          });
          task.title = `${serverId} ${chalk.red('✗')} ${chalk.dim((error as Error).message.slice(0, 40))}`;
        }
      }
    })),
    {
      concurrent: 10,
      exitOnError: false,
      rendererOptions: {
        collapseSubtasks: false,
      }
    }
  );

  await serverTasks.run();

  // Summary
  const successServers = results.filter(r => r.status === 'ok');
  const failedServers = results.filter(r => r.status === 'failed');
  const allTools = results.flatMap(r => r.tools);

  console.log('');
  console.log(chalk.bold('  Discovery Summary'));
  console.log(chalk.dim('  ─────────────────────────────────────────────────'));
  console.log(`  ${chalk.green('✓')} Servers connected: ${chalk.bold(successServers.length.toString())}`);
  if (failedServers.length > 0) {
    console.log(`  ${chalk.red('✗')} Servers failed: ${chalk.bold(failedServers.length.toString())}`);
    for (const failed of failedServers) {
      console.log(chalk.dim(`      └─ ${failed.serverId}: ${failed.error?.slice(0, 50)}`));
    }
  }
  console.log(`  ${chalk.cyan('◉')} Total tools found: ${chalk.bold(allTools.length.toString())}`);
  console.log('');

  if (allTools.length === 0) {
    console.log(chalk.yellow('  ⚠ No tools found!'));
    await redis!.disconnect();
    process.exit(1);
  }

  // Top servers by tool count
  const topServers = [...successServers]
    .sort((a, b) => b.toolCount - a.toolCount)
    .slice(0, 5);
  
  console.log(chalk.dim('  Top servers:'));
  for (const server of topServers) {
    const bar = '█'.repeat(Math.min(Math.ceil(server.toolCount / 10), 20));
    console.log(chalk.dim(`    ${server.serverId.padEnd(20)} ${bar} ${server.toolCount}`));
  }
  console.log('');

  // Phase 3: Indexing with progress bar
  console.log(chalk.bold('  Indexing tools in Redis...'));
  console.log('');

  const progressBar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {value}/{total} tools | {rate}/s | ETA: {eta}s',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
    clearOnComplete: false,
    barsize: 40,
  }, cliProgress.Presets.shades_classic);

  progressBar.start(allTools.length, 0, { rate: 'N/A' });

  const indexStartTime = Date.now();
  let lastUpdate = Date.now();
  
  try {
    await redis!.indexTools(allTools, (current, total) => {
      const now = Date.now();
      if (now - lastUpdate > 50) { // Update every 50ms for smoother progress
        const elapsed = (now - indexStartTime) / 1000;
        const rate = elapsed > 0 ? (current / elapsed).toFixed(1) : '0';
        progressBar.update(current, { rate });
        lastUpdate = now;
      }
    });
    
    progressBar.update(allTools.length, { rate: ((allTools.length / ((Date.now() - indexStartTime) / 1000)).toFixed(1)) });
    progressBar.stop();
  } catch (error) {
    progressBar.stop();
    console.log('');
    console.log(chalk.red(`  ✗ Indexing failed: ${(error as Error).message}`));
    await redis!.disconnect();
    process.exit(1);
  }

  // Final summary
  const finalCount = await redis!.getToolCount();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const throughput = (allTools.length / parseFloat(duration)).toFixed(1);

  console.log('');
  console.log(chalk.bold.green('  ╔══════════════════════════════════════════════════╗'));
  console.log(chalk.bold.green('  ║') + chalk.bold.white('                   ✓ Complete                     ') + chalk.bold.green('║'));
  console.log(chalk.bold.green('  ╚══════════════════════════════════════════════════╝'));
  console.log('');
  console.log(`  ${chalk.cyan('📦')} Tools indexed:  ${chalk.bold(finalCount.toString())}`);
  console.log(`  ${chalk.cyan('⏱️')}  Duration:      ${chalk.bold(duration + 's')}`);
  console.log(`  ${chalk.cyan('⚡')} Throughput:    ${chalk.bold(throughput + ' tools/s')}`);
  console.log(`  ${chalk.cyan('🔗')} Redis:         ${chalk.dim(options.redisHost + ':' + options.redisPort)}`);
  console.log('');

  await redis!.disconnect();
  process.exit(0);
}

/**
 * Worker Mode - Runs continuously and syncs changes periodically
 */
async function workerMode() {
  const options = parseArgs();
  
  // Header
  console.log('');
  console.log(chalk.bold.magenta('  ╔══════════════════════════════════════════════════╗'));
  console.log(chalk.bold.magenta('  ║') + chalk.bold.white('          DMCP Indexer - Worker Mode            ') + chalk.bold.magenta('║'));
  console.log(chalk.bold.magenta('  ╚══════════════════════════════════════════════════╝'));
  console.log(chalk.dim(`  Sync interval: ${options.interval}s`));
  console.log('');

  // Initialize Redis
  const redis = new RedisVSS({
    host: options.redisHost,
    port: options.redisPort,
    password: options.redisPassword,
    embeddingURL: options.embeddingURL,
    embeddingDimensions: 1024,
  });

  await redis.connect();
  await redis.createIndex();

  const existingCount = await redis.getToolCount();
  console.log(chalk.dim(`  Found ${existingCount} existing tools in Redis`));
  console.log('');

  let syncCount = 0;
  let isRunning = true;

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('');
    console.log(chalk.yellow('  Shutting down worker...'));
    isRunning = false;
    await redis.disconnect();
    console.log(chalk.green('  ✓ Worker stopped gracefully'));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Sync function
  const performSync = async () => {
    syncCount++;
    const syncStart = Date.now();
    const timestamp = new Date().toISOString().slice(11, 19);
    
    try {
      // Get current config from gateway
      const config = await discoverServersFromGateway(options.gatewayUrl);
      if (!config) {
        console.log(chalk.yellow(`  [${timestamp}] ⚠ No servers found from gateway`));
        return;
      }

      // Discover current tools
      const { tools: newTools, results } = await discoverAllTools(config);
      const successServers = results.filter(r => r.status === 'ok').length;
      const failedServers = results.filter(r => r.status === 'failed').length;

      // Get existing tools from Redis
      const existingTools = await redis.getAllTools();

      // Perform sync
      const syncResult = await syncTools(redis, newTools, existingTools);
      
      const duration = ((Date.now() - syncStart) / 1000).toFixed(1);
      const hasChanges = syncResult.added > 0 || syncResult.removed > 0 || syncResult.updated > 0;

      if (hasChanges) {
        console.log(
          chalk.cyan(`  [${timestamp}]`) +
          chalk.green(` +${syncResult.added}`) +
          chalk.red(` -${syncResult.removed}`) +
          chalk.yellow(` ~${syncResult.updated}`) +
          chalk.dim(` (${syncResult.unchanged} unchanged)`) +
          chalk.dim(` [${duration}s, ${successServers}/${successServers + failedServers} servers]`)
        );
        
        // Log details for significant changes
        if (syncResult.added > 0) {
          console.log(chalk.green(`           └─ Added ${syncResult.added} new tools`));
        }
        if (syncResult.removed > 0) {
          console.log(chalk.red(`           └─ Removed ${syncResult.removed} tools`));
        }
        if (syncResult.updated > 0) {
          console.log(chalk.yellow(`           └─ Updated ${syncResult.updated} tools`));
        }
      } else {
        // Only log every 10th sync when no changes (to reduce noise)
        if (syncCount % 10 === 0) {
          const toolCount = await redis.getToolCount();
          console.log(chalk.dim(`  [${timestamp}] No changes (${toolCount} tools, ${successServers} servers) [${duration}s]`));
        }
      }

      // Log errors if any
      if (syncResult.errors.length > 0) {
        for (const error of syncResult.errors) {
          console.log(chalk.red(`           └─ Error: ${error}`));
        }
      }
    } catch (error) {
      console.log(chalk.red(`  [${timestamp}] ✗ Sync failed: ${(error as Error).message}`));
    }
  };

  // Initial sync
  console.log(chalk.dim('  Starting initial sync...'));
  await performSync();
  console.log('');
  console.log(chalk.dim(`  Worker running. Press Ctrl+C to stop.`));
  console.log(chalk.dim('  ─────────────────────────────────────────────────'));
  console.log('');

  // Periodic sync
  while (isRunning) {
    await new Promise(resolve => setTimeout(resolve, options.interval * 1000));
    if (isRunning) {
      await performSync();
    }
  }
}

// Entry point
const options = parseArgs();
if (options.worker) {
  workerMode().catch((error) => {
    console.error(chalk.red(`\n  ✗ Worker error: ${error.message}\n`));
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(chalk.red(`\n  ✗ Fatal error: ${error.message}\n`));
    process.exit(1);
  });
}
