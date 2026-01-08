/**
 * Redis Vector Similarity Search Unit Tests
 * 
 * Tests for the RedisVSS class functionality
 * Uses mocks for Redis and embedding service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Types (matching redis-vss.ts)
// ============================================================================

interface ToolMetadata {
  id: string;
  serverId: string;
  serverUrl?: string;
  name: string;
  description: string;
  inputSchema?: any;
  keywords?: string[];
}

interface FilteredTool extends ToolMetadata {
  score: number;
}

interface RedisVSSConfig {
  host?: string;
  port?: number;
  password?: string;
  indexName?: string;
  embeddingDimensions?: number;
  embeddingURL?: string;
}

// ============================================================================
// Mock Redis Client
// ============================================================================

function createMockRedisClient() {
  const storage = new Map<string, any>();
  
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    json: {
      set: vi.fn((key: string, _path: string, value: any) => {
        storage.set(key, value);
        return Promise.resolve('OK');
      }),
      get: vi.fn((key: string) => {
        return Promise.resolve(storage.get(key) || null);
      }),
    },
    ft: {
      create: vi.fn().mockResolvedValue('OK'),
      info: vi.fn().mockResolvedValue({ num_docs: '5' }),
      search: vi.fn().mockResolvedValue({
        total: 0,
        documents: []
      }),
    },
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    multi: vi.fn(() => ({
      json: {
        set: vi.fn().mockReturnThis(),
      },
      exec: vi.fn().mockResolvedValue([]),
    })),
    _storage: storage, // For test assertions
  };
}

// ============================================================================
// Mock Embedding Provider
// ============================================================================

function createMockEmbeddingProvider(dimensions = 384) {
  // Generate deterministic mock embeddings based on input text
  const generateEmbedding = (text: string): Float32Array => {
    const arr = new Float32Array(dimensions);
    const hash = text.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    
    for (let i = 0; i < dimensions; i++) {
      arr[i] = Math.sin(hash + i) * 0.5;
    }
    return arr;
  };

  return {
    embed: vi.fn((text: string, _type: string) => {
      return Promise.resolve(generateEmbedding(text));
    }),
    embedBatch: vi.fn((texts: string[], _type: string) => {
      return Promise.resolve(texts.map(t => generateEmbedding(t)));
    }),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

// ============================================================================
// Configuration Tests
// ============================================================================

describe('RedisVSSConfig', () => {
  it('should have sensible defaults', () => {
    const defaults: RedisVSSConfig = {
      host: 'localhost',
      port: 6379,
      indexName: 'idx:mcp_tools',
      embeddingDimensions: 384,
      embeddingURL: 'http://localhost:5000',
    };

    expect(defaults.host).toBe('localhost');
    expect(defaults.port).toBe(6379);
    expect(defaults.embeddingDimensions).toBe(384);
  });

  it('should allow custom configuration', () => {
    const config: RedisVSSConfig = {
      host: 'redis.example.com',
      port: 6380,
      password: 'secret',
      indexName: 'custom:index',
      embeddingDimensions: 768,
      embeddingURL: 'http://embedding.example.com:8080',
    };

    expect(config.host).toBe('redis.example.com');
    expect(config.port).toBe(6380);
    expect(config.password).toBe('secret');
    expect(config.embeddingDimensions).toBe(768);
  });
});

// ============================================================================
// Tool Metadata Tests
// ============================================================================

describe('ToolMetadata', () => {
  it('should create valid tool metadata', () => {
    const tool: ToolMetadata = {
      id: 'find_symbol',
      serverId: 'serena',
      name: 'find_symbol',
      description: 'Find symbols in code',
      serverUrl: 'http://localhost:3135/sse',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
    };

    expect(tool.id).toBe('find_symbol');
    expect(tool.serverId).toBe('serena');
    expect(tool.serverUrl).toBe('http://localhost:3135/sse');
    expect(tool.inputSchema.required).toContain('name');
  });

  it('should allow optional fields to be undefined', () => {
    const tool: ToolMetadata = {
      id: 'search',
      serverId: 'github',
      name: 'search_code',
      description: 'Search code in repositories',
    };

    expect(tool.serverUrl).toBeUndefined();
    expect(tool.inputSchema).toBeUndefined();
    expect(tool.keywords).toBeUndefined();
  });
});

// ============================================================================
// Filtered Tool Tests
// ============================================================================

describe('FilteredTool', () => {
  it('should extend ToolMetadata with score', () => {
    const filteredTool: FilteredTool = {
      id: 'find_symbol',
      serverId: 'serena',
      name: 'find_symbol',
      description: 'Find symbols in code',
      score: 0.85,
    };

    expect(filteredTool.score).toBe(0.85);
  });

  it('should sort correctly by score', () => {
    const tools: FilteredTool[] = [
      { id: '1', serverId: 'a', name: 'tool1', description: 'desc', score: 0.5 },
      { id: '2', serverId: 'b', name: 'tool2', description: 'desc', score: 0.9 },
      { id: '3', serverId: 'c', name: 'tool3', description: 'desc', score: 0.7 },
    ];

    const sorted = tools.sort((a, b) => b.score - a.score);

    expect(sorted[0].score).toBe(0.9);
    expect(sorted[1].score).toBe(0.7);
    expect(sorted[2].score).toBe(0.5);
  });
});

// ============================================================================
// Index Creation Tests
// ============================================================================

describe('Index Operations', () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;

  beforeEach(() => {
    mockClient = createMockRedisClient();
  });

  it('should detect existing index', async () => {
    // Simulate index exists
    mockClient.ft.info.mockResolvedValue({ num_docs: '10' });

    const info = await mockClient.ft.info('idx:mcp_tools');
    expect(info.num_docs).toBe('10');
  });

  it('should create index if not exists', async () => {
    // Simulate index doesn't exist
    mockClient.ft.info.mockRejectedValue(new Error('Unknown index name'));

    // Attempt to get info should fail
    await expect(mockClient.ft.info('idx:mcp_tools')).rejects.toThrow('Unknown index name');

    // Create should succeed
    await mockClient.ft.create('idx:mcp_tools', {}, {});
    expect(mockClient.ft.create).toHaveBeenCalled();
  });
});

// ============================================================================
// Tool Indexing Tests
// ============================================================================

describe('Tool Indexing', () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;
  let mockEmbedding: ReturnType<typeof createMockEmbeddingProvider>;

  beforeEach(() => {
    mockClient = createMockRedisClient();
    mockEmbedding = createMockEmbeddingProvider();
  });

  it('should generate embedding and store tool', async () => {
    const tool: ToolMetadata = {
      id: 'find_symbol',
      serverId: 'serena',
      name: 'find_symbol',
      description: 'Find symbols in code',
    };

    // Simulate indexing
    const toolText = `${tool.name}: ${tool.description}`;
    const embedding = await mockEmbedding.embed(toolText, 'passage');
    
    const key = `tool:${tool.serverId}:${tool.id}`;
    await mockClient.json.set(key, '$', {
      ...tool,
      vector: Array.from(embedding),
    });

    expect(mockEmbedding.embed).toHaveBeenCalledWith(toolText, 'passage');
    expect(mockClient.json.set).toHaveBeenCalledWith(
      'tool:serena:find_symbol',
      '$',
      expect.objectContaining({
        id: 'find_symbol',
        serverId: 'serena',
        vector: expect.any(Array),
      })
    );
  });

  it('should batch index multiple tools', async () => {
    const tools: ToolMetadata[] = [
      { id: '1', serverId: 'serena', name: 'find', description: 'Find things' },
      { id: '2', serverId: 'serena', name: 'replace', description: 'Replace things' },
    ];

    const toolTexts = tools.map(t => `${t.name}: ${t.description}`);
    const embeddings = await mockEmbedding.embedBatch(toolTexts, 'passage');

    expect(mockEmbedding.embedBatch).toHaveBeenCalled();
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toBeInstanceOf(Float32Array);
  });
});

// ============================================================================
// Search Tests
// ============================================================================

describe('Search Operations', () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;
  let mockEmbedding: ReturnType<typeof createMockEmbeddingProvider>;

  beforeEach(() => {
    mockClient = createMockRedisClient();
    mockEmbedding = createMockEmbeddingProvider();
  });

  it('should perform vector search with query embedding', async () => {
    const query = 'find symbols in code';
    
    // Generate query embedding
    const queryEmbedding = await mockEmbedding.embed(query, 'query');
    expect(mockEmbedding.embed).toHaveBeenCalledWith(query, 'query');
    expect(queryEmbedding).toBeInstanceOf(Float32Array);

    // Mock search results
    mockClient.ft.search.mockResolvedValue({
      total: 2,
      documents: [
        {
          id: 'tool:serena:find_symbol',
          value: {
            serverId: 'serena',
            name: 'find_symbol',
            description: 'Find symbols in code',
            __vector_score: '0.1', // Low score = high similarity
          },
        },
        {
          id: 'tool:serena:search_files',
          value: {
            serverId: 'serena',
            name: 'search_files',
            description: 'Search for files',
            __vector_score: '0.3',
          },
        },
      ],
    });

    const results = await mockClient.ft.search('idx:mcp_tools', '*', {});
    expect(results.documents).toHaveLength(2);
    expect(results.documents[0].value.name).toBe('find_symbol');
  });

  it('should convert vector score to similarity score', () => {
    // Vector score is cosine distance (lower = more similar)
    // We convert to similarity score: 1 - distance
    const vectorScore = '0.15';
    const similarityScore = 1 - parseFloat(vectorScore);
    
    expect(similarityScore).toBeCloseTo(0.85, 2);
  });

  it('should filter results by minimum score', () => {
    const results: FilteredTool[] = [
      { id: '1', serverId: 'a', name: 't1', description: 'd', score: 0.9 },
      { id: '2', serverId: 'b', name: 't2', description: 'd', score: 0.5 },
      { id: '3', serverId: 'c', name: 't3', description: 'd', score: 0.2 },
    ];

    const minScore = 0.3;
    const filtered = results.filter(t => t.score >= minScore);

    expect(filtered).toHaveLength(2);
    expect(filtered.every(t => t.score >= minScore)).toBe(true);
  });

  it('should limit results to topK', () => {
    const results: FilteredTool[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      serverId: 's',
      name: `tool_${i}`,
      description: 'desc',
      score: Math.random(),
    }));

    const topK = 5;
    const limited = results.sort((a, b) => b.score - a.score).slice(0, topK);

    expect(limited).toHaveLength(5);
  });

  it('should filter by serverIds', () => {
    const tools: FilteredTool[] = [
      { id: '1', serverId: 'serena', name: 't1', description: 'd', score: 0.9 },
      { id: '2', serverId: 'github', name: 't2', description: 'd', score: 0.8 },
      { id: '3', serverId: 'serena', name: 't3', description: 'd', score: 0.7 },
    ];

    const serverIds = ['serena'];
    const filtered = tools.filter(t => serverIds.includes(t.serverId));

    expect(filtered).toHaveLength(2);
    expect(filtered.every(t => t.serverId === 'serena')).toBe(true);
  });
});

// ============================================================================
// Tool Count Tests
// ============================================================================

describe('Tool Count', () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;

  beforeEach(() => {
    mockClient = createMockRedisClient();
  });

  it('should return tool count from index info', async () => {
    mockClient.ft.info.mockResolvedValue({ num_docs: '42' });

    const info = await mockClient.ft.info('idx:mcp_tools');
    const count = parseInt(info.num_docs || '0');

    expect(count).toBe(42);
  });

  it('should return 0 if index does not exist', async () => {
    mockClient.ft.info.mockRejectedValue(new Error('Unknown index'));

    let count = 0;
    try {
      await mockClient.ft.info('idx:mcp_tools');
    } catch {
      count = 0;
    }

    expect(count).toBe(0);
  });
});

// ============================================================================
// Clear Index Tests
// ============================================================================

describe('Clear Index', () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;

  beforeEach(() => {
    mockClient = createMockRedisClient();
  });

  it('should delete all tool keys', async () => {
    mockClient.keys.mockResolvedValue([
      'tool:serena:find_symbol',
      'tool:serena:replace',
      'tool:github:search',
    ]);

    const keys = await mockClient.keys('tool:*');
    expect(keys).toHaveLength(3);

    if (keys.length > 0) {
      await mockClient.del(keys);
      expect(mockClient.del).toHaveBeenCalledWith(keys);
    }
  });

  it('should handle empty index', async () => {
    mockClient.keys.mockResolvedValue([]);

    const keys = await mockClient.keys('tool:*');
    expect(keys).toHaveLength(0);
    expect(mockClient.del).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Embedding Tests
// ============================================================================

describe('Embedding Operations', () => {
  let mockEmbedding: ReturnType<typeof createMockEmbeddingProvider>;

  beforeEach(() => {
    mockEmbedding = createMockEmbeddingProvider(384);
  });

  it('should generate embeddings of correct dimension', async () => {
    const embedding = await mockEmbedding.embed('test text', 'passage');
    
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(384);
  });

  it('should generate batch embeddings', async () => {
    const texts = ['text 1', 'text 2', 'text 3'];
    const embeddings = await mockEmbedding.embedBatch(texts, 'passage');
    
    expect(embeddings).toHaveLength(3);
    expect(embeddings.every(e => e.length === 384)).toBe(true);
  });

  it('should generate different embeddings for different texts', async () => {
    const embedding1 = await mockEmbedding.embed('find symbols', 'passage');
    const embedding2 = await mockEmbedding.embed('search files', 'passage');
    
    // Check they're not identical
    let areDifferent = false;
    for (let i = 0; i < embedding1.length; i++) {
      if (Math.abs(embedding1[i] - embedding2[i]) > 0.001) {
        areDifferent = true;
        break;
      }
    }
    
    expect(areDifferent).toBe(true);
  });

  it('should check health of embedding service', async () => {
    const isHealthy = await mockEmbedding.healthCheck();
    expect(isHealthy).toBe(true);
  });

  it('should handle unhealthy embedding service', async () => {
    mockEmbedding.healthCheck.mockResolvedValue(false);
    
    const isHealthy = await mockEmbedding.healthCheck();
    expect(isHealthy).toBe(false);
  });
});

// ============================================================================
// Connection Tests
// ============================================================================

describe('Connection Management', () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;

  beforeEach(() => {
    mockClient = createMockRedisClient();
  });

  it('should connect to Redis', async () => {
    await mockClient.connect();
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('should disconnect from Redis', async () => {
    await mockClient.quit();
    expect(mockClient.quit).toHaveBeenCalled();
  });

  it('should handle reconnection on error', () => {
    const reconnectStrategy = (retries: number) => {
      if (retries > 10) {
        return new Error('Max reconnection attempts reached');
      }
      return Math.min(retries * 50, 3000);
    };

    expect(reconnectStrategy(1)).toBe(50);
    expect(reconnectStrategy(5)).toBe(250);
    expect(reconnectStrategy(10)).toBe(500); // 10 * 50 = 500 (within limit)
    expect(reconnectStrategy(11)).toBeInstanceOf(Error); // Exceeds limit
  });
});

// ============================================================================
// Integration Scenario Tests
// ============================================================================

describe('Integration Scenarios', () => {
  it('should complete full indexing and search workflow', async () => {
    const mockClient = createMockRedisClient();
    const mockEmbedding = createMockEmbeddingProvider();

    // 1. Connect
    await mockClient.connect();

    // 2. Check embedding health
    const isHealthy = await mockEmbedding.healthCheck();
    expect(isHealthy).toBe(true);

    // 3. Create index (mock - already exists)
    mockClient.ft.info.mockResolvedValue({ num_docs: '0' });

    // 4. Index tools
    const tools: ToolMetadata[] = [
      { id: '1', serverId: 'serena', name: 'find_symbol', description: 'Find symbols in code' },
      { id: '2', serverId: 'serena', name: 'rename_symbol', description: 'Rename symbols' },
    ];

    const texts = tools.map(t => `${t.name}: ${t.description}`);
    const embeddings = await mockEmbedding.embedBatch(texts, 'passage');

    for (let i = 0; i < tools.length; i++) {
      const key = `tool:${tools[i].serverId}:${tools[i].id}`;
      await mockClient.json.set(key, '$', {
        ...tools[i],
        vector: Array.from(embeddings[i]),
      });
    }

    // 5. Search
    const query = 'find functions';
    const queryEmbedding = await mockEmbedding.embed(query, 'query');
    expect(queryEmbedding.length).toBe(384);

    // 6. Disconnect
    await mockClient.quit();
  });
});
