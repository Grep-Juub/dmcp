#!/usr/bin/env node

/**
 * Redis Vector Similarity Search Integration
 * 
 * Implements the Redis blog architecture for MCP tool filtering:
 * - Stores tool embeddings in Redis
 * - Performs semantic search at query-time
 * - Returns top-K most relevant tools
 * 
 * Based on: https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/
 */

import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { LocalEmbeddingProvider } from './custom-embedding-provider.js';

export interface ToolMetadata {
  id: string;
  serverId: string;
  serverUrl?: string;   // Direct connection URL for the server hosting this tool
  name: string;
  description: string;
  inputSchema?: any;
  keywords?: string[];
}

export interface FilteredTool extends ToolMetadata {
  score: number;
}

export interface RedisVSSConfig {
  host?: string;
  port?: number;
  password?: string;
  indexName?: string;
  embeddingDimensions?: number;
  embeddingURL?: string;
}

/**
 * Redis Vector Similarity Search for MCP Tool Filtering
 * 
 * Provides 98% token reduction, 8x speed improvement, 2x accuracy boost
 * as demonstrated in Redis blog post.
 */
export class RedisVSS {
  private client: RedisClientType;
  private embeddingProvider: LocalEmbeddingProvider;
  private indexName: string;
  private dimensions: number;
  private isConnected: boolean = false;

  constructor(config: RedisVSSConfig = {}) {
    const {
      host = 'localhost',
      port = 6379,
      password,
      indexName = 'idx:mcp_tools',
      embeddingDimensions = 384,
      embeddingURL = 'http://localhost:5000'
    } = config;

    this.indexName = indexName;
    this.dimensions = embeddingDimensions;

    // Initialize Redis client with better retry strategy
    this.client = createClient({
      socket: {
        host,
        port,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('[RedisVSS] Max reconnection attempts reached');
            return new Error('Max reconnection attempts reached');
          }
          // Exponential backoff: 50ms, 100ms, 200ms, 400ms, etc.
          const delay = Math.min(retries * 50, 3000);
          console.error(`[RedisVSS] Reconnecting in ${delay}ms...`);
          return delay;
        },
        connectTimeout: 10000, // 10 seconds
      },
      password,
    });

    // Initialize embedding provider
    this.embeddingProvider = new LocalEmbeddingProvider({
      provider: 'local',
      baseURL: embeddingURL,
      dimensions: embeddingDimensions,
    });

    // Suppress repeated error logs (they're expected during reconnect)
    this.client.on('error', (err) => {
      if (!err.message.includes('Socket closed unexpectedly')) {
        console.error('[RedisVSS] Redis Client Error:', err);
      }
    });
  }

  /**
   * Connect to Redis and verify embedding service is healthy
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    console.error('[RedisVSS] Connecting to Redis...');
    await this.client.connect();
    
    console.error('[RedisVSS] Verifying embedding service...');
    const isHealthy = await this.embeddingProvider.healthCheck();
    if (!isHealthy) {
      throw new Error('Embedding service is not healthy. Start with: docker-compose up -d');
    }

    this.isConnected = true;
    console.error('[RedisVSS] ✓ Connected and ready');
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.client.quit();
      this.isConnected = false;
    }
  }

  /**
   * Create the vector search index
   * Call this once during initialization
   */
  async createIndex(): Promise<void> {
    try {
      // Check if index exists
      try {
        await this.client.ft.info(this.indexName);
        console.error(`[RedisVSS] Index ${this.indexName} already exists`);
        return;
      } catch (err) {
        // Index doesn't exist, create it
      }

      console.error(`[RedisVSS] Creating index ${this.indexName}...`);

      await this.client.ft.create(
        this.indexName,
        {
          '$.serverId': {
            type: 'TAG' as any,
            AS: 'serverId'
          },
          '$.serverUrl': {
            type: 'TAG' as any,
            AS: 'serverUrl'
          },
          '$.name': {
            type: 'TEXT' as any,
            AS: 'name'
          },
          '$.description': {
            type: 'TEXT' as any,
            AS: 'description'
          },
          '$.vector': {
            type: 'VECTOR' as any,
            ALGORITHM: 'HNSW' as any,
            TYPE: 'FLOAT32',
            DIM: this.dimensions,
            DISTANCE_METRIC: 'COSINE',
            AS: 'vector'
          }
        },
        {
          ON: 'JSON',
          PREFIX: 'tool:'
        }
      );

      console.error('[RedisVSS] ✓ Index created successfully');
    } catch (error) {
      console.error('[RedisVSS] Error creating index:', error);
      throw error;
    }
  }

  /**
   * Index a single tool with its embedding
   */
  async indexTool(tool: ToolMetadata): Promise<void> {
    // Generate embedding for tool description with "passage" prefix for E5
    const toolText = `${tool.name}: ${tool.description}`;
    const embedding = await this.embeddingProvider.embed(toolText, 'passage');

    // Store in Redis as JSON with vector
    const key = `tool:${tool.serverId}:${tool.id}`;
    await this.client.json.set(key, '$', {
      ...tool,
      vector: Array.from(embedding),
    });
  }

  /**
   * Index multiple tools in batch with progress reporting
   * Uses chunked processing with concurrent requests for speed
   */
  async indexTools(tools: ToolMetadata[], onProgress?: (current: number, total: number) => void): Promise<void> {
    const startTime = Date.now();
    const total = tools.length;

    // Process in chunks with concurrency for better throughput
    const CHUNK_SIZE = 16;
    const CONCURRENCY = 2; // Process 2 chunks in parallel (reduced for stability)
    
    const allEmbeddings: Float32Array[] = new Array(tools.length);
    let processed = 0;
    
    // Create chunk boundaries
    const chunks: { start: number; end: number }[] = [];
    for (let i = 0; i < tools.length; i += CHUNK_SIZE) {
      chunks.push({ start: i, end: Math.min(i + CHUNK_SIZE, tools.length) });
    }

    // Process chunks with concurrency
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      
      await Promise.all(batch.map(async (chunk) => {
        const toolTexts = tools.slice(chunk.start, chunk.end).map(t => `${t.name}: ${t.description}`);
        const embeddings = await this.embeddingProvider.embedBatch(toolTexts, 'passage');
        
        for (let j = 0; j < embeddings.length; j++) {
          allEmbeddings[chunk.start + j] = embeddings[j];
        }
      }));
      
      // Update progress after each concurrent batch completes
      processed = Math.min((i + CONCURRENCY) * CHUNK_SIZE, total);
      if (onProgress) {
        onProgress(processed, total);
      }
    }

    // Store all tools in Redis using pipeline
    const pipeline = this.client.multi();
    
    for (let i = 0; i < tools.length; i++) {
      const key = `tool:${tools[i].serverId}:${tools[i].id}`;
      pipeline.json.set(key, '$', {
        ...tools[i],
        vector: Array.from(allEmbeddings[i]),
      });
    }

    await pipeline.exec();

    const duration = Date.now() - startTime;
    console.error(`[RedisVSS] ✓ Indexed ${tools.length} tools in ${duration}ms (${(duration / tools.length).toFixed(1)}ms per tool)`);
  }

  /**
   * Search for tools semantically similar to the query
   * 
   * Uses pure vector search with ToolRet embeddings for semantic understanding.
   * 
   * @param query - User query or context
   * @param options - Search options
   * @returns Filtered tools with similarity scores
   */
  async search(
    query: string,
    options: {
      topK?: number;
      minScore?: number;
      serverIds?: string[];
    } = {}
  ): Promise<FilteredTool[]> {
    const {
      topK = 5,
      minScore = 0.3,
      serverIds
    } = options;

    const startTime = Date.now();
    const toolScores = new Map<string, { tool: FilteredTool; vectorScore: number }>();

    // Build filter for vector search
    const filters: string[] = [];
    if (serverIds && serverIds.length > 0) {
      filters.push(`@serverId:{${serverIds.join('|')}}`);
    }

    // ============ VECTOR SEARCH ============
    const queryEmbedding = await this.embeddingProvider.embed(query, 'query');
    console.error(`[RedisVSS] Vector search for: "${query}"`);
    const vectorBytes = Buffer.from(queryEmbedding.buffer);

    let searchQuery = '*';
    if (filters.length > 0) {
      searchQuery = filters.join(' ');
    }

    let results;
    try {
      results = await this.client.ft.search(
        this.indexName,
        `${searchQuery}=>[KNN ${topK * 2} @vector $query_vector AS __vector_score]`,
        {
          RETURN: ['serverId', 'name', 'description', 'inputSchema', 'serverUrl', '__vector_score'],
          SORTBY: {
            BY: '__vector_score',
            DIRECTION: 'ASC'
          },
          DIALECT: 2,
          PARAMS: {
            query_vector: vectorBytes
          },
          LIMIT: {
            from: 0,
            size: topK * 2
          }
        } as any
      );
    } catch (error) {
      console.error('[RedisVSS] Vector search error:', error);
      throw error;
    }

    console.error(`[RedisVSS] Vector search returned ${results.documents.length} documents`);

    // Process vector results
    for (const doc of results.documents) {
      const toolKey = `${doc.value.serverId}:${doc.value.name}`;
      const vectorScore: any = doc.value['__vector_score'];
      const score = 1 - parseFloat(typeof vectorScore === 'string' ? vectorScore : String(vectorScore || '1'));
      
      const tool: FilteredTool = {
        id: doc.id.split(':')[2],
        serverId: doc.value.serverId as string,
        serverUrl: doc.value.serverUrl as string,
        name: doc.value.name as string,
        description: doc.value.description as string,
        inputSchema: doc.value.inputSchema,
        score: score
      };

      toolScores.set(toolKey, {
        tool,
        vectorScore: score,
      });
    }

    // Filter and sort by score
    const filteredResults: FilteredTool[] = Array.from(toolScores.values())
      .filter(({ vectorScore }) => vectorScore >= minScore)
      .map(({ tool }) => tool)
      .sort((a, b) => b.score - a.score);
    const finalResults = filteredResults.slice(0, topK);

    const duration = Date.now() - startTime;
    console.error(`[RedisVSS] Found ${finalResults.length} relevant tools in ${duration}ms (pure vector search)`);
    
    if (finalResults.length > 0) {
      console.error(`[RedisVSS] Top tool: ${finalResults[0].name} (score: ${finalResults[0].score.toFixed(3)})`);
    }

    return finalResults;
  }

  /**
   * Get total number of indexed tools
   */
  async getToolCount(): Promise<number> {
    try {
      const info = await this.client.ft.info(this.indexName);
      return parseInt((info as any).num_docs || '0');
    } catch (error) {
      return 0;
    }
  }

  /**
   * Clear all indexed tools
   * Useful for re-indexing
   */
  async clearIndex(): Promise<void> {
    console.error('[RedisVSS] Clearing all indexed tools...');
    
    const keys = await this.client.keys('tool:*');
    if (keys.length > 0) {
      await this.client.del(keys);
    }
    
    console.error(`[RedisVSS] ✓ Cleared ${keys.length} tools`);
  }

  /**
   * Drop the index entirely
   */
  async dropIndex(): Promise<void> {
    try {
      await this.client.ft.dropIndex(this.indexName);
      console.error(`[RedisVSS] ✓ Dropped index ${this.indexName}`);
    } catch (error) {
      // Index might not exist
    }
  }
  /**
   * Get all tools from Redis (for quality auditing and analysis)
   */
  async getAllTools(): Promise<ToolMetadata[]> {
    const tools: ToolMetadata[] = [];

    try {
      // Search with wildcard to get all tools
      const results = await this.client.ft.search(
        this.indexName,
        '*',
        {
          RETURN: ['serverId', 'name', 'description', 'inputSchema', 'serverUrl', 'keywords'],
          LIMIT: { from: 0, size: 10000 }  // Adjust if you have more tools
        }
      );

      for (const doc of results.documents) {
        tools.push({
          id: doc.id.split(':')[2],
          serverId: doc.value.serverId as string,
          serverUrl: doc.value.serverUrl as string,
          name: doc.value.name as string,
          description: doc.value.description as string,
          inputSchema: doc.value.inputSchema,
          keywords: doc.value.keywords ? JSON.parse(doc.value.keywords as string) : undefined,
        });
      }

      console.error(`[RedisVSS] Retrieved ${tools.length} total tools`);
    } catch (error) {
      console.error(`[RedisVSS] Error fetching all tools:`, (error as Error).message);
    }

    return tools;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    redis: boolean;
    embedding: boolean;
    toolCount: number;
  }> {
    const redisHealthy = this.isConnected && this.client.isReady;
    const embeddingHealthy = await this.embeddingProvider.healthCheck();
    const toolCount = await this.getToolCount();

    return {
      redis: redisHealthy,
      embedding: embeddingHealthy,
      toolCount
    };
  }
}
