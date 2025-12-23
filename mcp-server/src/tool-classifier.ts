/**
 * LLM-based Tool Classifier
 * 
 * Uses embeddings to categorize MCP tools into semantic categories.
 * Categories help the DMCP server expose the right tools at the right time.
 * 
 * Classification methods:
 * 1. Embedding-based (default): Uses the local embedding model for zero-shot classification
 * 2. Heuristic fallback: Pattern matching on tool names/descriptions
 * 
 * Categories:
 * - meta: LLM enhancement tools (sequential-thinking, reasoning, planning)
 * - query: Read-only data retrieval (get, list, search, fetch)
 * - action: State-changing operations (create, update, delete)
 * - general: Everything else
 */

import { LocalEmbeddingProvider } from './custom-embedding-provider.js';

export type ToolCategory = 'meta' | 'query' | 'action' | 'general';

export interface ClassificationResult {
  category: ToolCategory;
  confidence: number;
  reasoning?: string;
}

export interface EmbeddingClassifierConfig {
  embeddingURL?: string;
  embeddingDimensions?: number;
}

/**
 * Category anchor descriptions for embedding-based classification
 * These are embedded once and compared against tool descriptions
 */
const CATEGORY_ANCHORS: Record<ToolCategory, string[]> = {
  meta: [
    // Match sequential-thinking style descriptions
    'A detailed tool for dynamic and reflective problem-solving through thoughts',
    'Breaking down complex problems into steps with room for revision',
    'Chain of thought, hypothesis generation and verification for multi-step solutions',
    'Sequential thinking that can branch, backtrack and adjust total thoughts',
    'A tool for analysis that maintains context over multiple steps',
    'Thinking process that can adapt, evolve, question or revise previous insights',
  ],
  query: [
    'Get, retrieve, or fetch data from a system without making any changes',
    'List, search, or find information from a database or API',
    'Read and query data, view records, describe resources',
    'Fetch metrics, logs, or status information for monitoring',
    'Search and filter results to find specific items',
  ],
  action: [
    'Create, add, or insert new records or resources',
    'Update, modify, edit, or change existing data',
    'Delete, remove, or destroy resources',
    'Send, submit, or post data to create side effects',
    'Execute commands that change system state',
  ],
  general: [
    'A utility tool for formatting, converting, or validating data',
    'Helper function that does not fit other categories',
    'Miscellaneous tool for general purpose use',
  ],
};

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embedding-based tool classifier using local model
 * Uses zero-shot classification via cosine similarity to category anchors
 */
export class EmbeddingClassifier {
  private embeddingProvider: LocalEmbeddingProvider;
  private categoryEmbeddings: Map<ToolCategory, Float32Array[]> | null = null;
  private initialized = false;

  constructor(config: EmbeddingClassifierConfig = {}) {
    this.embeddingProvider = new LocalEmbeddingProvider({
      provider: 'local',
      baseURL: config.embeddingURL || process.env.EMBEDDING_URL || 'http://localhost:5000',
      dimensions: config.embeddingDimensions || 384,
    });
  }

  /**
   * Initialize by computing category anchor embeddings
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.error('[Classifier] Computing category anchor embeddings...');
    
    this.categoryEmbeddings = new Map();
    
    for (const [category, anchors] of Object.entries(CATEGORY_ANCHORS)) {
      const embeddings = await this.embeddingProvider.embedBatch(anchors, 'passage');
      this.categoryEmbeddings.set(category as ToolCategory, embeddings);
    }
    
    this.initialized = true;
    console.error('[Classifier] ✓ Category anchors ready');
  }

  /**
   * Classify a single tool by comparing its embedding to category anchors
   */
  async classifyTool(name: string, description: string): Promise<ClassificationResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const toolText = `${name}: ${description}`;
    const toolEmbedding = await this.embeddingProvider.embed(toolText, 'passage');

    // Compare against all category anchors
    const scores: Record<ToolCategory, number> = {
      meta: 0,
      query: 0,
      action: 0,
      general: 0,
    };

    for (const [category, anchors] of this.categoryEmbeddings!) {
      // Average similarity across all anchors for this category
      let totalSim = 0;
      for (const anchor of anchors) {
        totalSim += cosineSimilarity(toolEmbedding, anchor);
      }
      scores[category] = totalSim / anchors.length;
    }

    // Find best category
    let bestCategory: ToolCategory = 'general';
    let bestScore = -1;

    for (const [category, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category as ToolCategory;
      }
    }

    // Apply stricter threshold for 'meta' - it should be very clearly a meta tool
    // If meta wins but the margin is small, downgrade to the second best
    if (bestCategory === 'meta') {
      const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      const margin = sortedScores[0][1] - sortedScores[1][1];
      
      // Require at least 0.05 margin for meta classification
      if (margin < 0.05) {
        bestCategory = sortedScores[1][0] as ToolCategory;
        bestScore = sortedScores[1][1];
      }
    }

    return {
      category: bestCategory,
      confidence: bestScore,
    };
  }

  /**
   * Classify multiple tools in batch (more efficient)
   */
  async classifyBatch(
    tools: Array<{ name: string; description: string }>,
    onProgress?: (current: number, total: number) => void
  ): Promise<Map<string, ClassificationResult>> {
    if (!this.initialized) {
      await this.initialize();
    }

    const results = new Map<string, ClassificationResult>();
    
    // Embed all tools in batch
    const toolTexts = tools.map(t => `${t.name}: ${t.description.slice(0, 500)}`);
    
    console.error(`[Classifier] Embedding ${tools.length} tools...`);
    const toolEmbeddings = await this.embeddingProvider.embedBatch(toolTexts, 'passage');
    
    // Classify each tool
    for (let i = 0; i < tools.length; i++) {
      const toolEmbedding = toolEmbeddings[i];
      
      // Compare against all category anchors
      const scores: Record<ToolCategory, number> = {
        meta: 0,
        query: 0,
        action: 0,
        general: 0,
      };

      for (const [category, anchors] of this.categoryEmbeddings!) {
        let totalSim = 0;
        for (const anchor of anchors) {
          totalSim += cosineSimilarity(toolEmbedding, anchor);
        }
        scores[category] = totalSim / anchors.length;
      }

      // Find best category
      let bestCategory: ToolCategory = 'general';
      let bestScore = -1;

      for (const [category, score] of Object.entries(scores)) {
        if (score > bestScore) {
          bestScore = score;
          bestCategory = category as ToolCategory;
        }
      }

      // Stricter threshold for meta
      if (bestCategory === 'meta') {
        const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const margin = sortedScores[0][1] - sortedScores[1][1];
        if (margin < 0.05) {
          bestCategory = sortedScores[1][0] as ToolCategory;
          bestScore = sortedScores[1][1];
        }
      }

      results.set(tools[i].name, {
        category: bestCategory,
        confidence: bestScore,
      });

      if (onProgress && (i + 1) % 50 === 0) {
        onProgress(i + 1, tools.length);
      }
    }
    
    if (onProgress) {
      onProgress(tools.length, tools.length);
    }

    return results;
  }

  /**
   * Get classification statistics
   */
  getStats(results: Map<string, ClassificationResult>): Record<ToolCategory, number> {
    const stats: Record<ToolCategory, number> = {
      meta: 0,
      query: 0,
      action: 0,
      general: 0,
    };

    for (const result of results.values()) {
      stats[result.category]++;
    }

    return stats;
  }
}

/**
 * Heuristic fallback classifier (no API calls)
 * Use when embedding service is not available
 */
export function classifyToolHeuristic(name: string, description: string): ToolCategory {
  const text = `${name} ${description}`.toLowerCase();

  // Meta: LLM enhancement tools - be very strict
  if (/\b(sequential.?thinking|chain.?of.?thought|step.?by.?step.?reason|thinking.?tool|reasoning.?tool)\b/i.test(text)) {
    return 'meta';
  }

  // Action: State-changing operations
  if (/\b(create|add|new|post|insert|update|modify|edit|change|patch|put|set|assign|delete|remove|destroy|clear|send|submit)\b/i.test(text)) {
    return 'action';
  }

  // Query: Read-only operations
  if (/\b(get|list|search|find|read|fetch|query|show|describe|view|retrieve|look|check)\b/i.test(text)) {
    return 'query';
  }

  return 'general';
}
