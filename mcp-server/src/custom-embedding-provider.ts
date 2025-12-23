/**
 * Local Embedding Provider
 * HTTP client for the local embedding service (Docker container)
 * Supports any sentence-transformers compatible model configured via EMBEDDING_MODEL env var
 */

export interface EmbeddingProvider {
  embed(text: string, prefix?: 'query' | 'passage'): Promise<Float32Array>;
  embedBatch(texts: string[], prefix?: 'query' | 'passage'): Promise<Float32Array[]>;
  getDimensions(): number;
}

export interface LocalEmbeddingConfig {
  provider: 'local';
  baseURL?: string;
  dimensions?: number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private baseURL: string;
  private dimensions: number;

  constructor(config: LocalEmbeddingConfig) {
    this.baseURL = config.baseURL || 'http://localhost:5000';
    this.dimensions = config.dimensions || 384; // Most small models use 384 dims
  }

  /**
   * Embed a single text.
   * @param text The text to embed
   * @param prefix "query" for search queries, "passage" for documents (default)
   */
  async embed(text: string, prefix: 'query' | 'passage' = 'passage'): Promise<Float32Array> {
    try {
      const response = await fetch(`${this.baseURL}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, prefix }),
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
      }

      const data: any = await response.json();
      
      if (!data.embeddings || !data.embeddings[0]) {
        throw new Error('Invalid response from embedding service');
      }

      return new Float32Array(data.embeddings[0]);
    } catch (error) {
      console.error('Error calling embedding service:', error);
      throw error;
    }
  }

  /**
   * Embed multiple texts in batch with retry logic.
   * @param texts Array of texts to embed
   * @param prefix "query" for search queries, "passage" for documents (default)
   */
  async embedBatch(texts: string[], prefix: 'query' | 'passage' = 'passage'): Promise<Float32Array[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseURL}/embed`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ texts, prefix }),
        });

        if (!response.ok) {
          throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
        }

        const data: any = await response.json();
        
        if (!data.embeddings) {
          throw new Error('Invalid response from embedding service');
        }

        return data.embeddings.map((emb: number[]) => new Float32Array(emb));
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const delay = attempt * 1000; // 1s, 2s, 3s backoff
          console.error(`[Retry ${attempt}/${maxRetries}] Embedding service error, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    console.error('Error calling embedding service after retries:', lastError);
    throw lastError;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Health check to verify the service is running
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/health`);
      const data: any = await response.json();
      return data.status === 'healthy';
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }
}
