#!/usr/bin/env node

/**
 * DMCP Indexer - Tool Discovery and Indexing Worker
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
}

interface ServerResult {
  serverId: string;
  status: 'ok' | 'failed';
  toolCount: number;
  tools: ToolMetadata[];
  error?: string;
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

${chalk.dim('Options:')}
  -f, --force               Force re-indexing even if tools are cached
  -s, --server <name|port>  Index only a specific server
  --gateway-url <url>       Agent Gateway URL
  --redis-host <host>       Redis host (default: localhost)
  --redis-port <port>       Redis port (default: 6380)
  --embedding-url <url>     Embedding service URL
  -h, --help                Show this help
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
      showTimer: true,
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
        showTimer: true,
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

main().catch((error) => {
  console.error(chalk.red(`\n  ✗ Fatal error: ${error.message}\n`));
  process.exit(1);
});
