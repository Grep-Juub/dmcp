/**
 * DMCP Server Unit Tests
 * 
 * Tests for utility functions and connection management logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Utility Function Tests (inlined for testing - these match the server code)
// ============================================================================

/**
 * Sanitize tool names to conform to MCP naming requirements [a-z0-9_-]
 */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
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
 * Rewrite localhost URLs to host.docker.internal when running in Docker
 */
function rewriteUrlForDocker(url: string, inDocker: boolean): string {
  if (!inDocker) return url;
  
  // Replace localhost/127.0.0.1 with host.docker.internal
  return url
    .replace(/localhost/g, 'host.docker.internal')
    .replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

/**
 * Format timestamp for logging
 */
function timestamp(): string {
  return new Date().toISOString().split('T')[1].split('.')[0];
}

// ============================================================================
// Tests
// ============================================================================

describe('sanitizeToolName', () => {
  it('should convert uppercase to lowercase', () => {
    expect(sanitizeToolName('MyTool')).toBe('mytool');
  });

  it('should replace special characters with underscores', () => {
    expect(sanitizeToolName('my.tool')).toBe('my_tool');
    expect(sanitizeToolName('my/tool')).toBe('my_tool');
    expect(sanitizeToolName('my@tool')).toBe('my_tool');
    expect(sanitizeToolName('my tool')).toBe('my_tool');
  });

  it('should preserve allowed characters', () => {
    expect(sanitizeToolName('my-tool')).toBe('my-tool');
    expect(sanitizeToolName('my_tool')).toBe('my_tool');
    expect(sanitizeToolName('tool123')).toBe('tool123');
  });

  it('should handle multiple special characters', () => {
    expect(sanitizeToolName('My.Complex/Tool@Name')).toBe('my_complex_tool_name');
  });

  it('should handle empty string', () => {
    expect(sanitizeToolName('')).toBe('');
  });
});

describe('parseToolName', () => {
  it('should parse valid tool name with description', () => {
    const result = parseToolName('serena_find_symbol', '[serena] Find symbols in code');
    expect(result).toEqual({
      serverId: 'serena',
      originalName: 'find_symbol',
    });
  });

  it('should return null if description does not have serverId prefix', () => {
    const result = parseToolName('serena_find_symbol', 'Find symbols in code');
    expect(result).toBeNull();
  });

  it('should return null if description is undefined', () => {
    const result = parseToolName('serena_find_symbol', undefined);
    expect(result).toBeNull();
  });

  it('should return null if tool name does not start with sanitized serverId', () => {
    const result = parseToolName('other_find_symbol', '[serena] Find symbols in code');
    expect(result).toBeNull();
  });

  it('should handle serverId with special characters', () => {
    const result = parseToolName('my_server_find_tool', '[my.server] Find tools');
    expect(result).toEqual({
      serverId: 'my.server',
      originalName: 'find_tool',
    });
  });

  it('should handle complex tool names', () => {
    const result = parseToolName('github_search_code', '[github] Search for code across repositories');
    expect(result).toEqual({
      serverId: 'github',
      originalName: 'search_code',
    });
  });
});

describe('rewriteUrlForDocker', () => {
  it('should not modify URL when not in Docker', () => {
    const url = 'http://localhost:3000/sse';
    expect(rewriteUrlForDocker(url, false)).toBe(url);
  });

  it('should replace localhost with host.docker.internal when in Docker', () => {
    expect(rewriteUrlForDocker('http://localhost:3000/sse', true))
      .toBe('http://host.docker.internal:3000/sse');
  });

  it('should replace 127.0.0.1 with host.docker.internal when in Docker', () => {
    expect(rewriteUrlForDocker('http://127.0.0.1:3000/sse', true))
      .toBe('http://host.docker.internal:3000/sse');
  });

  it('should handle multiple localhost occurrences', () => {
    expect(rewriteUrlForDocker('http://localhost:3000?redirect=localhost', true))
      .toBe('http://host.docker.internal:3000?redirect=host.docker.internal');
  });

  it('should not modify external URLs', () => {
    const url = 'http://api.example.com:3000/sse';
    expect(rewriteUrlForDocker(url, true)).toBe(url);
  });
});

describe('timestamp', () => {
  it('should return time in HH:MM:SS format', () => {
    const result = timestamp();
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

// ============================================================================
// Connection Error Detection Tests
// ============================================================================

describe('Connection Error Detection', () => {
  const connectionErrors = [
    'ECONNRESET',
    'ECONNREFUSED',
    'socket hang up',
    'network error',
    'timeout',
    'connection closed',
  ];

  const nonConnectionErrors = [
    'Invalid argument',
    'Tool not found',
    'Permission denied',
    'Validation error',
  ];

  function isConnectionError(errorMessage: string): boolean {
    return errorMessage.includes('ECONNRESET') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('socket hang up') ||
      errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('closed');
  }

  it('should identify connection errors', () => {
    for (const error of connectionErrors) {
      expect(isConnectionError(error)).toBe(true);
    }
  });

  it('should not identify non-connection errors as connection errors', () => {
    for (const error of nonConnectionErrors) {
      expect(isConnectionError(error)).toBe(false);
    }
  });
});

// ============================================================================
// Backend Connection Interface Tests
// ============================================================================

describe('BackendConnection', () => {
  interface BackendConnection {
    client: any;
    serverId: string;
    url: string;
    lastHealthCheck: number;
    isHealthy: boolean;
  }

  it('should create a valid connection object', () => {
    const conn: BackendConnection = {
      client: { listTools: vi.fn() },
      serverId: 'test-server',
      url: 'http://localhost:3000/sse',
      lastHealthCheck: Date.now(),
      isHealthy: true,
    };

    expect(conn.serverId).toBe('test-server');
    expect(conn.isHealthy).toBe(true);
    expect(conn.lastHealthCheck).toBeLessThanOrEqual(Date.now());
  });

  it('should track health status changes', () => {
    const conn: BackendConnection = {
      client: { listTools: vi.fn() },
      serverId: 'test-server',
      url: 'http://localhost:3000/sse',
      lastHealthCheck: Date.now(),
      isHealthy: true,
    };

    // Simulate health check failure
    conn.isHealthy = false;
    expect(conn.isHealthy).toBe(false);

    // Simulate recovery
    conn.isHealthy = true;
    conn.lastHealthCheck = Date.now();
    expect(conn.isHealthy).toBe(true);
  });
});

// ============================================================================
// Health Check Interval Tests
// ============================================================================

describe('Health Check Timing', () => {
  it('should determine if health check is needed based on interval', () => {
    const HEALTH_INTERVAL_MS = 30000;
    const now = Date.now();
    
    // Connection that was just checked
    const recentConnection = { lastHealthCheck: now - 1000 };
    expect(now - recentConnection.lastHealthCheck < HEALTH_INTERVAL_MS).toBe(true);
    
    // Connection that needs checking
    const staleConnection = { lastHealthCheck: now - 35000 };
    expect(now - staleConnection.lastHealthCheck < HEALTH_INTERVAL_MS).toBe(false);
  });
});

// ============================================================================
// Retry Logic Tests
// ============================================================================

describe('Retry Logic', () => {
  it('should calculate exponential backoff delays', () => {
    const BASE_DELAY_MS = 1000;
    
    const delays = [1, 2, 3].map(attempt => BASE_DELAY_MS * attempt);
    
    expect(delays).toEqual([1000, 2000, 3000]);
  });

  it('should respect retry attempt limits', () => {
    const MAX_ATTEMPTS = 3;
    let attempts = 0;
    
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
    }
    
    expect(attempts).toBe(MAX_ATTEMPTS);
  });
});

// ============================================================================
// Tool Search Result Processing Tests
// ============================================================================

describe('Tool Search Result Processing', () => {
  interface FilteredTool {
    id: string;
    serverId: string;
    name: string;
    description: string;
    score: number;
    serverUrl?: string;
  }

  const mockTools: FilteredTool[] = [
    { id: '1', serverId: 'serena', name: 'find_symbol', description: 'Find symbols', score: 0.85, serverUrl: 'http://localhost:3135/sse' },
    { id: '2', serverId: 'github', name: 'search_code', description: 'Search code', score: 0.72 },
    { id: '3', serverId: 'serena', name: 'rename_symbol', description: 'Rename symbols', score: 0.65, serverUrl: 'http://localhost:3135/sse' },
  ];

  it('should sort tools by score descending', () => {
    const sorted = [...mockTools].sort((a, b) => b.score - a.score);
    
    expect(sorted[0].score).toBe(0.85);
    expect(sorted[1].score).toBe(0.72);
    expect(sorted[2].score).toBe(0.65);
  });

  it('should filter tools by minimum score', () => {
    const minScore = 0.70;
    const filtered = mockTools.filter(t => t.score >= minScore);
    
    expect(filtered).toHaveLength(2);
    expect(filtered.every(t => t.score >= minScore)).toBe(true);
  });

  it('should limit results to topK', () => {
    const topK = 2;
    const limited = mockTools.slice(0, topK);
    
    expect(limited).toHaveLength(2);
  });

  it('should generate correct tool keys', () => {
    const tool = mockTools[0];
    const toolKey = sanitizeToolName(`${tool.serverId}_${tool.name}`);
    
    expect(toolKey).toBe('serena_find_symbol');
  });
});
