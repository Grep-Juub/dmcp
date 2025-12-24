/**
 * Tool Router - Smart tool selection with domain-based routing
 * 
 * GENERIC APPROACH - No hardcoded tool/server names!
 * 
 * Based on research from:
 * - ToolLLM: Neural API retriever for tool selection
 * - Semantic Router: Superfast decision layer via embeddings
 * - HuggingGPT: Model selection by description matching
 * - Anthropic: Tool prompt engineering best practices
 * 
 * Architecture:
 * 1. Domain Classification - Analyze tool DESCRIPTION to detect interface type
 * 2. Capability Clustering - Automatically cluster similar tools via embeddings
 * 3. Priority-Based Selection - Return best tool per capability cluster
 * 4. Context Override - Detect explicit domain preference in query
 */

import { LocalEmbeddingProvider } from './custom-embedding-provider.js';
import { cosineSimilarity } from './utils.js';

// ============================================================================
// Types
// ============================================================================

export type ToolDomain = 
  | 'api'           // Structured API calls with JSON responses
  | 'terminal'      // Shell/CLI command execution
  | 'browser'       // Web automation, DOM manipulation
  | 'reasoning'     // LLM enhancement (thinking, planning)
  | 'filesystem'    // File read/write operations
  | 'data'          // Database/storage queries
  | 'observability' // Monitoring, metrics, logs
  | 'cloud'         // Cloud provider resource management
  | 'general';      // Fallback

export interface DomainClassification {
  domain: ToolDomain;
  confidence: number;
}

export interface RoutedTool {
  id: string;
  name: string;
  serverId: string;
  description: string;
  domain: ToolDomain;
  priority: number;
  score: number;  // Original search score
  clusterId?: string;  // Capability cluster ID
  inputSchema?: Record<string, unknown>;
}

export interface RouteResult {
  tools: RoutedTool[];
  detectedIntent?: string;
  forcedDomain?: ToolDomain;
  forcedTenant?: string;  // Detected tenant/server hint from query
  deduplicatedCount: number;
  alternateServers?: Map<string, string[]>;  // clusterId -> [serverIds] for tools with multiple server options
}

// ============================================================================
// Domain Configuration - GENERIC (based on description patterns)
// ============================================================================

/**
 * Priority for each domain (higher = preferred)
 * 
 * Rationale:
 * - API: Structured responses, error codes, rate limiting - predictable
 * - Reasoning: Always useful for complex tasks
 * - Data: Direct database access - fast and precise
 * - Observability: Specialized monitoring data
 * - Cloud: Managed API access to cloud resources
 * - Filesystem: Direct but local-only
 * - Browser: Powerful but fragile (DOM changes)
 * - Terminal: Most flexible but least structured output
 */
export const DOMAIN_PRIORITY: Record<ToolDomain, number> = {
  'api': 10,           // Structured, typed, reliable
  'reasoning': 9,      // LLM enhancement - always valuable
  'data': 8,           // Direct data access
  'observability': 7,  // Specialized monitoring
  'cloud': 6,          // Cloud APIs
  'filesystem': 5,     // File operations
  'browser': 4,        // Web automation
  'terminal': 3,       // Shell - powerful but unstructured
  'general': 1,        // Fallback
};

/**
 * Domain anchor descriptions for GENERIC embedding-based classification
 * 
 * These describe the CHARACTERISTICS of each domain, not specific tools.
 * Classification is based purely on matching tool descriptions to these anchors.
 */
export const DOMAIN_ANCHORS: Record<ToolDomain, string[]> = {
  api: [
    'REST API endpoint that returns structured JSON data with status codes',
    'HTTP request to external service with authentication and typed response schema',
    'Web service call that creates, reads, updates or deletes resources via API',
    'GraphQL or REST endpoint with request/response schema and error handling',
    'External service integration with OAuth, API keys, or tokens for authentication',
  ],
  terminal: [
    'Execute shell command in bash or zsh terminal with stdout and stderr',
    'Run CLI command with arguments and environment variables in a shell',
    'System command execution that returns text output from the terminal',
    'Bash script or shell one-liner that performs system operations',
    'Command line interface tool invocation with flags and options',
  ],
  browser: [
    'Automated browser interaction: click buttons, fill forms, navigate pages',
    'Web page DOM manipulation, element selection, and JavaScript execution',
    'Browser automation for testing, scraping, or web interaction',
    'Take screenshot, generate PDF, or capture web page content',
    'Headless browser control for web automation tasks',
  ],
  reasoning: [
    'Step by step reasoning and chain of thought for complex analysis',
    'Sequential thinking with hypothesis generation and verification',
    'Break down complex problems into smaller manageable reasoning steps',
    'Multi-step analysis that can revise conclusions and explore alternatives',
    'Thinking and planning tool that helps structure problem solving',
  ],
  filesystem: [
    'Read, write, create, or delete files on the local filesystem',
    'Directory operations: list contents, create folders, move files',
    'File content manipulation: read lines, search patterns, edit text',
    'Local disk operations for file and directory management',
    'Filesystem path operations and file metadata access',
  ],
  data: [
    'SQL query to select, insert, update, or delete database records',
    'Database connection and query execution with result sets',
    'Data storage operations: cache, key-value store, document database',
    'Query structured data from tables, collections, or indices',
    'Database schema inspection and data manipulation',
  ],
  observability: [
    'Metrics, logs, and traces from monitoring and observability platforms',
    'Alert management, incident response, and on-call operations',
    'Dashboard visualization of system performance and health',
    'Application performance monitoring and distributed tracing',
    'Log search, metric queries, and system health checks',
  ],
  cloud: [
    'Cloud provider resource management: compute, storage, networking',
    'Container orchestration: pods, deployments, services, namespaces',
    'Infrastructure provisioning and cloud resource configuration',
    'Cloud cost management, billing, and resource optimization',
    'Managed cloud services: functions, queues, storage buckets',
  ],
  general: [
    'Utility tool for formatting, converting, or validating data',
    'Helper function that does not fit specific categories',
    'Miscellaneous tool for general purpose operations',
  ],
};

/**
 * Context patterns that force a specific domain
 * These detect EXPLICIT user intent, not tool characteristics
 */
export const CONTEXT_PATTERNS: Array<{ pattern: RegExp; domain: ToolDomain; signal: string }> = [
  // Terminal/shell explicit requests
  { pattern: /\b(run|execute)\s+(in\s+)?(terminal|shell|bash|cli|command\s*line)\b/i, domain: 'terminal', signal: 'terminal-explicit' },
  { pattern: /\b(bash|shell|zsh)\s+command\b/i, domain: 'terminal', signal: 'shell-command' },
  { pattern: /\brun\s+(the\s+)?command\b/i, domain: 'terminal', signal: 'run-command' },
  
  // API explicit requests
  { pattern: /\b(use|via|through|call)\s+(the\s+)?(api|rest|graphql)\b/i, domain: 'api', signal: 'api-explicit' },
  { pattern: /\bapi\s+(call|request|endpoint)\b/i, domain: 'api', signal: 'api-call' },
  
  // Browser explicit requests
  { pattern: /\b(browser|playwright|puppeteer|selenium)\b/i, domain: 'browser', signal: 'browser-explicit' },
  { pattern: /\b(click|navigate|screenshot)\s+(on\s+)?(web|page|site|button)\b/i, domain: 'browser', signal: 'browser-action' },
  
  // Reasoning explicit requests
  { pattern: /\b(think|reason|analyze)\s+(through|about|step\s*by\s*step)\b/i, domain: 'reasoning', signal: 'reasoning-explicit' },
  { pattern: /\bbreak\s*(it\s+)?down\b/i, domain: 'reasoning', signal: 'break-down' },
  { pattern: /\bstep\s*by\s*step\b/i, domain: 'reasoning', signal: 'step-by-step' },
  
  // File operations
  { pattern: /\b(read|write|create|delete)\s+(the\s+)?file\b/i, domain: 'filesystem', signal: 'file-operation' },
  
  // Database
  { pattern: /\b(sql|query|database|select\s+from)\b/i, domain: 'data', signal: 'database' },
];

// ============================================================================
// Utility Functions
// ============================================================================

// ============================================================================
// Domain Classifier - PURELY DESCRIPTION-BASED
// ============================================================================

/**
 * Domain classifier using ONLY tool descriptions (no server ID heuristics)
 * 
 * This is fully generic and works with any MCP server setup.
 */
export class DomainClassifier {
  private embeddingProvider: LocalEmbeddingProvider;
  private domainEmbeddings: Map<ToolDomain, Float32Array[]> | null = null;
  private initialized = false;

  constructor(embeddingURL?: string) {
    this.embeddingProvider = new LocalEmbeddingProvider({
      provider: 'local',
      baseURL: embeddingURL || process.env.EMBEDDING_URL || 'http://localhost:5000',
      dimensions: 1024,  // ToolRet-trained-e5-large-v2
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.error('[DomainClassifier] Computing domain anchor embeddings...');
    
    this.domainEmbeddings = new Map();
    
    for (const [domain, anchors] of Object.entries(DOMAIN_ANCHORS)) {
      const embeddings = await this.embeddingProvider.embedBatch(anchors, 'passage');
      this.domainEmbeddings.set(domain as ToolDomain, embeddings);
    }
    
    this.initialized = true;
    console.error('[DomainClassifier] ✓ Domain anchors ready');
  }

  /**
   * Classify a tool into a domain based ONLY on its description
   * No server ID heuristics - fully generic
   */
  async classifyTool(name: string, description: string, _serverId?: string): Promise<DomainClassification> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Combine name and description for richer context
    const toolText = `${name}: ${description}`;
    const toolEmbedding = await this.embeddingProvider.embed(toolText, 'passage');

    const scores: Record<ToolDomain, number> = {} as Record<ToolDomain, number>;
    
    for (const [domain, anchors] of this.domainEmbeddings!) {
      let maxSim = -1;
      // Use MAX similarity (best matching anchor) rather than average
      // This handles tools that partially match a domain
      for (const anchor of anchors) {
        const sim = cosineSimilarity(toolEmbedding, anchor);
        if (sim > maxSim) maxSim = sim;
      }
      scores[domain] = maxSim;
    }

    let bestDomain: ToolDomain = 'general';
    let bestScore = -1;

    for (const [domain, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain as ToolDomain;
      }
    }

    // Require minimum confidence to avoid false positives
    if (bestScore < 0.5) {
      bestDomain = 'general';
    }

    return { domain: bestDomain, confidence: bestScore };
  }

  /**
   * Classify multiple tools in batch
   */
  async classifyBatch(
    tools: Array<{ name: string; description: string; serverId?: string }>
  ): Promise<Map<string, DomainClassification>> {
    if (!this.initialized) {
      await this.initialize();
    }

    const results = new Map<string, DomainClassification>();
    
    // Embed all tools
    const toolTexts = tools.map(t => `${t.name}: ${t.description.slice(0, 500)}`);
    const toolEmbeddings = await this.embeddingProvider.embedBatch(toolTexts, 'passage');

    for (let i = 0; i < tools.length; i++) {
      const toolEmbedding = toolEmbeddings[i];
      const scores: Record<ToolDomain, number> = {} as Record<ToolDomain, number>;

      for (const [domain, anchors] of this.domainEmbeddings!) {
        let maxSim = -1;
        for (const anchor of anchors) {
          const sim = cosineSimilarity(toolEmbedding, anchor);
          if (sim > maxSim) maxSim = sim;
        }
        scores[domain] = maxSim;
      }

      let bestDomain: ToolDomain = 'general';
      let bestScore = -1;

      for (const [domain, score] of Object.entries(scores)) {
        if (score > bestScore) {
          bestScore = score;
          bestDomain = domain as ToolDomain;
        }
      }

      if (bestScore < 0.5) {
        bestDomain = 'general';
      }

      results.set(tools[i].name, { domain: bestDomain, confidence: bestScore });
    }

    return results;
  }

  /**
   * Get embedding provider for capability clustering
   */
  getEmbeddingProvider(): LocalEmbeddingProvider {
    return this.embeddingProvider;
  }
}

// ============================================================================
// Capability Clusterer - AUTOMATIC DEDUPLICATION
// ============================================================================

/**
 * Automatically clusters tools with similar capabilities
 * 
 * Instead of hardcoding "github_push = wcgw git push", we:
 * 1. Compute embeddings for all tool descriptions
 * 2. Find pairs with similarity > threshold
 * 3. Assign them the same cluster ID
 * 
 * At query time, if multiple tools from same cluster match, pick highest priority
 */
export class CapabilityClusterer {
  private embeddingProvider: LocalEmbeddingProvider;
  private readonly SIMILARITY_THRESHOLD = 0.95;  // Tools with >95% similarity = truly same capability (e.g. same tool from different Datadog instances)

  constructor(embeddingProvider: LocalEmbeddingProvider) {
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Cluster tools by description similarity
   * Returns a map of tool name -> cluster ID
   */
  async clusterTools(
    tools: Array<{ name: string; description: string }>,
    onProgress?: (current: number, total: number) => void
  ): Promise<Map<string, string>> {
    console.error(`[CapabilityClusterer] Clustering ${tools.length} tools...`);
    
    // Get embeddings for all tools
    const toolTexts = tools.map(t => `${t.name}: ${t.description.slice(0, 500)}`);
    const embeddings = await this.embeddingProvider.embedBatch(toolTexts, 'passage');
    
    // Union-Find for clustering
    const parent: number[] = tools.map((_, i) => i);
    
    function find(i: number): number {
      if (parent[i] !== i) {
        parent[i] = find(parent[i]);
      }
      return parent[i];
    }
    
    function union(i: number, j: number): void {
      const pi = find(i);
      const pj = find(j);
      if (pi !== pj) {
        parent[pi] = pj;
      }
    }
    
    // Compare all pairs (O(n²) but we limit to meaningful comparisons)
    let comparisons = 0;
    const totalComparisons = (tools.length * (tools.length - 1)) / 2;
    
    for (let i = 0; i < tools.length; i++) {
      for (let j = i + 1; j < tools.length; j++) {
        const sim = cosineSimilarity(embeddings[i], embeddings[j]);
        
        if (sim > this.SIMILARITY_THRESHOLD) {
          union(i, j);
          console.error(`[CapabilityClusterer] Clustered: "${tools[i].name}" ≈ "${tools[j].name}" (${(sim * 100).toFixed(1)}%)`);
        }
        
        comparisons++;
        if (onProgress && comparisons % 1000 === 0) {
          onProgress(comparisons, totalComparisons);
        }
      }
    }
    
    // Build cluster map
    const clusters = new Map<string, string>();
    const clusterCounts = new Map<number, number>();
    
    for (let i = 0; i < tools.length; i++) {
      const clusterId = find(i);
      clusters.set(tools[i].name, `cluster_${clusterId}`);
      clusterCounts.set(clusterId, (clusterCounts.get(clusterId) || 0) + 1);
    }
    
    // Count non-singleton clusters
    const multiToolClusters = [...clusterCounts.values()].filter(c => c > 1).length;
    console.error(`[CapabilityClusterer] ✓ Found ${multiToolClusters} capability clusters with multiple tools`);
    
    return clusters;
  }
}

// ============================================================================
// Tool Router - GENERIC
// ============================================================================

export class ToolRouter {
  private domainClassifier: DomainClassifier;

  constructor(embeddingURL?: string) {
    this.domainClassifier = new DomainClassifier(embeddingURL);
  }

  /**
   * Detect if query has explicit domain preference
   */
  detectForcedDomain(query: string): { domain: ToolDomain; signal: string } | null {
    for (const { pattern, domain, signal } of CONTEXT_PATTERNS) {
      if (pattern.test(query)) {
        return { domain, signal };
      }
    }
    return null;
  }

  /**
   * Detect tenant/server hints in query
   * 
   * This is FULLY GENERIC - extracts potential serverId fragments from the query
   * and matches against available serverIds in the tool set.
   * 
   * How it works:
   * 1. Parse each serverId into parts (split by - and _)
   * 2. Build a map of unique terms to serverIds
   * 3. Remove ambiguous terms (appear in multiple serverIds)
   * 4. Match query words against unique terms (longest match wins)
   * 
   * Examples (assuming these serverIds exist in the tool set):
   * - "get metrics from prod-us" → matches "datadog-prod-us" (via "prod-us" or unique parts)
   * - "check kubernetes pods" → matches "kubernetes" (full serverId match)
   * - "AWS billing" → matches server containing "aws" if unique
   */
  private detectTenantHint(
    query: string, 
    availableServerIds: Set<string>
  ): { serverId: string; matchedTerm: string } | null {
    const q = query.toLowerCase();
    
    // Build a map of searchable terms to serverIds
    // Split each serverId into parts and create matchable fragments
    const termToServer = new Map<string, string>();
    const ambiguousTerms = new Set<string>();  // Track terms that appear in multiple servers
    
    // Common terms to ignore (too generic to be useful for tenant identification)
    const IGNORED_TERMS = new Set([
      'mcp', 'server', 'api', 'prod', 'dev', 'staging', 'test',
      'the', 'and', 'for', 'with', 'main', 'default', 'primary',
    ]);
    
    for (const serverId of availableServerIds) {
      // Add full serverId (these are always unique)
      termToServer.set(serverId.toLowerCase(), serverId);
      
      // Split by common separators and add meaningful parts
      const parts = serverId.toLowerCase().split(/[-_]/);
      for (const part of parts) {
        // Skip very short or ignored terms
        if (part.length < 3) continue;
        if (IGNORED_TERMS.has(part)) continue;
        
        // Track if this part is ambiguous
        if (!termToServer.has(part)) {
          termToServer.set(part, serverId);
        } else if (termToServer.get(part) !== serverId) {
          // Part appears in multiple servers - mark as ambiguous
          ambiguousTerms.add(part);
        }
      }
    }
    
    // Remove all ambiguous terms (they can't uniquely identify a tenant)
    for (const term of ambiguousTerms) {
      termToServer.delete(term);
    }
    
    // Check for direct term matches (longest match first for specificity)
    const sortedTerms = [...termToServer.keys()].sort((a, b) => b.length - a.length);
    for (const term of sortedTerms) {
      // Use word boundary matching to avoid partial matches
      const regex = new RegExp(`\\b${term}\\b`, 'i');
      if (regex.test(q)) {
        console.error(`[ToolRouter] Tenant detected via term: "${term}" → ${termToServer.get(term)!}`);
        return { serverId: termToServer.get(term)!, matchedTerm: term };
      }
    }
    
    return null;
  }

  /**
   * Route and deduplicate tools based on domain priority and capability clusters
   * 
   * Tenant-aware: When query contains hints matching a specific serverId,
   * tools from that server are prioritized and duplicates are not removed.
   * 
   * @param tools - Tools from search results (must include domain and optional clusterId)
   * @param query - Original user query
   */
  route(
    tools: Array<{
      id: string;
      name: string;
      serverId: string;
      description: string;
      score: number;
      domain?: string;  // Accept string, cast to ToolDomain
      clusterId?: string;
      inputSchema?: Record<string, unknown>;
    }>,
    query: string
  ): RouteResult {
    // Collect available serverIds for tenant detection
    const availableServerIds = new Set(tools.map(t => t.serverId));
    
    // Detect explicit domain preference
    const forced = this.detectForcedDomain(query);
    
    // Detect tenant/server hint in query
    const tenantHint = this.detectTenantHint(query, availableServerIds);
    
    // Valid domains for type checking
    const validDomains = new Set<string>(['api', 'terminal', 'browser', 'reasoning', 'filesystem', 'data', 'observability', 'cloud', 'general']);
    
    // Add priority to tools based on domain AND tenant match
    const routedTools: RoutedTool[] = tools.map(tool => {
      const rawDomain = tool.domain || 'general';
      const domain: ToolDomain = validDomains.has(rawDomain) ? rawDomain as ToolDomain : 'general';
      let priority = DOMAIN_PRIORITY[domain];
      
      // Boost forced domain
      if (forced && domain === forced.domain) {
        priority += 5;
      }
      
      // TENANT BOOST: If user specified a tenant, boost matching server's tools significantly
      if (tenantHint && tool.serverId === tenantHint.serverId) {
        priority += 10;  // Strong boost to ensure tenant match wins
      }
      
      return {
        ...tool,
        domain,
        priority,
        clusterId: tool.clusterId,
      };
    });

    // Track alternate servers for each cluster (for multi-tenant info)
    const clusterServers = new Map<string, Set<string>>();
    for (const tool of routedTools) {
      if (tool.clusterId) {
        if (!clusterServers.has(tool.clusterId)) {
          clusterServers.set(tool.clusterId, new Set());
        }
        clusterServers.get(tool.clusterId)!.add(tool.serverId);
      }
    }

    // Deduplicate by capability cluster - keep highest priority per cluster
    // BUT: If tenant was specified, don't deduplicate - let the tenant boost do the work
    const seenClusters = new Map<string, RoutedTool>();
    const deduplicatedTools: RoutedTool[] = [];
    let deduplicatedCount = 0;

    // Sort by priority first so we process best tools first
    routedTools.sort((a, b) => b.priority - a.priority || b.score - a.score);

    for (const tool of routedTools) {
      const clusterId = tool.clusterId;
      
      // Only deduplicate if NO tenant hint is present
      // When tenant is specified, we want all results but tenant-matched ones will be at top
      if (!tenantHint && clusterId && seenClusters.has(clusterId)) {
        // This cluster already has a tool (which has higher priority)
        deduplicatedCount++;
        console.error(`[ToolRouter] Deduplicated: "${tool.name}" from ${tool.serverId} (cluster ${clusterId}, prefer "${seenClusters.get(clusterId)!.name}" from ${seenClusters.get(clusterId)!.serverId})`);
      } else {
        if (clusterId) {
          seenClusters.set(clusterId, tool);
        }
        deduplicatedTools.push(tool);
      }
    }

    // Build alternateServers map: clusterId -> serverIds (for clusters with multiple servers)
    const alternateServers = new Map<string, string[]>();
    for (const [clusterId, servers] of clusterServers) {
      if (servers.size > 1) {
        alternateServers.set(clusterId, [...servers]);
      }
    }

    return {
      tools: deduplicatedTools,
      detectedIntent: forced?.signal,
      forcedDomain: forced?.domain,
      forcedTenant: tenantHint?.serverId,
      deduplicatedCount,
      alternateServers: alternateServers.size > 0 ? alternateServers : undefined,
    };
  }

  /**
   * Get domain classifier for indexing
   */
  getDomainClassifier(): DomainClassifier {
    return this.domainClassifier;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get domain statistics from a set of tools
 */
export function getDomainStats(tools: RoutedTool[]): Record<ToolDomain, number> {
  const stats: Record<ToolDomain, number> = {
    api: 0,
    terminal: 0,
    browser: 0,
    reasoning: 0,
    filesystem: 0,
    data: 0,
    observability: 0,
    cloud: 0,
    general: 0,
  };

  for (const tool of tools) {
    stats[tool.domain]++;
  }

  return stats;
}

/**
 * Format domain stats for logging
 */
export function formatDomainStats(stats: Record<ToolDomain, number>): string {
  return Object.entries(stats)
    .filter(([, count]) => count > 0)
    .map(([domain, count]) => `${domain}: ${count}`)
    .join(' | ');
}
