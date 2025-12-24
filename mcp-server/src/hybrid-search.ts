/**
 * Hybrid Search - BM25 + Vector Embeddings
 * 
 * Implements ToolLLM-style hybrid retrieval:
 * - BM25 for exact keyword matching
 * - Vector embeddings for semantic similarity
 * - Score fusion to combine both approaches
 * 
 * Based on research:
 * - ToolLLM (ICLR 2023): Hybrid BM25 + dense retrieval
 * - Semantic Router: Ultra-fast embedding-based routing
 */

import natural from 'natural';

export interface ScoredResult {
  id: string;
  score: number;
  source: 'bm25' | 'vector' | 'hybrid';
}

export interface HybridSearchConfig {
  bm25Weight?: number;      // Weight for BM25 scores (default: 0.3)
  vectorWeight?: number;    // Weight for vector scores (default: 0.7)
  k1?: number;              // BM25 k1 parameter (default: 1.2)
  b?: number;               // BM25 b parameter (default: 0.75)
}

/**
 * Hybrid Search Engine combining BM25 and vector embeddings
 */
export class HybridSearchEngine {
  private tfidf: any;
  private documents: Map<string, string> = new Map();
  private config: Required<HybridSearchConfig>;

  constructor(config: HybridSearchConfig = {}) {
    this.config = {
      bm25Weight: config.bm25Weight ?? 0.3,
      vectorWeight: config.vectorWeight ?? 0.7,
      k1: config.k1 ?? 1.2,
      b: config.b ?? 0.75,
    };

    this.tfidf = new natural.TfIdf();
  }

  /**
   * Index documents for BM25 search
   */
  indexDocuments(documents: Array<{ id: string; text: string }>): void {
    console.error(`[HybridSearch] Indexing ${documents.length} documents for BM25...`);
    
    // Clear existing index
    this.documents.clear();
    this.tfidf = new natural.TfIdf();

    // Add documents to TF-IDF index
    for (const doc of documents) {
      this.documents.set(doc.id, doc.text);
      this.tfidf.addDocument(doc.text);
    }

    console.error(`[HybridSearch] ✓ BM25 index ready with ${this.documents.size} documents`);
  }

  /**
   * Perform BM25 search
   * Returns normalized scores [0-1]
   */
  searchBM25(query: string, topK: number = 10): ScoredResult[] {
    const scores: Array<{ id: string; score: number }> = [];
    const docIds = Array.from(this.documents.keys());

    this.tfidf.tfidfs(query, (i: number, measure: number) => {
      if (i < docIds.length && measure > 0) {
        scores.push({
          id: docIds[i],
          score: measure,
        });
      }
    });

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Normalize scores to [0-1]
    const maxScore = scores[0]?.score || 1;
    const normalized = scores.slice(0, topK).map(item => ({
      id: item.id,
      score: item.score / maxScore,
      source: 'bm25' as const,
    }));

    return normalized;
  }

  /**
   * Fuse BM25 and vector scores using weighted combination
   * 
   * Implements reciprocal rank fusion (RRF) variant:
   * score = bm25_weight * bm25_score + vector_weight * vector_score
   */
  fuseScores(
    bm25Results: ScoredResult[],
    vectorResults: Array<{ id: string; score: number }>,
    topK: number = 10
  ): ScoredResult[] {
    const fusedScores = new Map<string, number>();

    // Add BM25 scores
    for (const result of bm25Results) {
      const score = this.config.bm25Weight * result.score;
      fusedScores.set(result.id, score);
    }

    // Add/combine vector scores
    for (const result of vectorResults) {
      const existing = fusedScores.get(result.id) || 0;
      const score = existing + this.config.vectorWeight * result.score;
      fusedScores.set(result.id, score);
    }

    // Sort by fused score
    const sorted = Array.from(fusedScores.entries())
      .map(([id, score]) => ({
        id,
        score,
        source: 'hybrid' as const,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return sorted;
  }

  /**
   * Get configuration for inspection
   */
  getConfig(): Required<HybridSearchConfig> {
    return { ...this.config };
  }

  /**
   * Update weights dynamically (useful for threshold optimization)
   */
  updateWeights(bm25Weight: number, vectorWeight: number): void {
    // Normalize weights to sum to 1
    const sum = bm25Weight + vectorWeight;
    this.config.bm25Weight = bm25Weight / sum;
    this.config.vectorWeight = vectorWeight / sum;
    
    console.error(
      `[HybridSearch] Updated weights: BM25=${this.config.bm25Weight.toFixed(2)}, ` +
      `Vector=${this.config.vectorWeight.toFixed(2)}`
    );
  }
}
