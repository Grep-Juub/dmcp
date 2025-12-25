/**
 * Infinity Embedding Provider
 * OpenAI-compatible HTTP client for infinity-emb embedding service
 * Uses tool-optimized ToolRet-trained-e5-large-v2 model (1024 dims)
 * API: https://michaelfeil.github.io/infinity/
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
  modelName?: string;  // OpenAI-compatible model name
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private baseURL: string;
  private dimensions: number;
  private modelName: string;

  constructor(config: LocalEmbeddingConfig) {
    this.baseURL = config.baseURL || 'http://localhost:5000';
    this.dimensions = config.dimensions || 1024; // ToolRet-trained-e5-large-v2 uses 1024 dims
    this.modelName = config.modelName || process.env.EMBEDDING_MODEL || 'mangopy/ToolRet-trained-e5-large-v2';
  }

  /**
   * Embed a single text.
   * @param text The text to embed
   * @param prefix "query" for search queries, "passage" for documents (default) - for E5 models
   */
  async embed(text: string, prefix: 'query' | 'passage' = 'passage'): Promise<Float32Array> {
    try {
      // Add E5 prefix for better performance (ToolRet models are based on E5)
      const prefixedText = `${prefix}: ${text}`;
      
      // OpenAI-compatible API format used by infinity-emb
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          input: prefixedText,
          model: this.modelName,
          encoding_format: 'float'
        }),
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
      }

      const data: any = await response.json();
      
      // OpenAI format returns: { data: [{ embedding: [...] }] }
      if (!data.data || !data.data[0] || !data.data[0].embedding) {
        throw new Error('Invalid response from embedding service');
      }

      return new Float32Array(data.data[0].embedding);
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
        // Add E5 prefix for better performance (ToolRet models are based on E5)
        const prefixedTexts = texts.map(t => `${prefix}: ${t}`);
        
        // OpenAI-compatible API format used by infinity-emb
        const response = await fetch(`${this.baseURL}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ 
            input: prefixedTexts,  // Array of texts
            model: this.modelName,
            encoding_format: 'float'
          }),
        });

        if (!response.ok) {
          throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
        }

        const data: any = await response.json();
        
        // OpenAI format returns: { data: [{ embedding: [...] }, { embedding: [...] }] }
        if (!data.data || !Array.isArray(data.data)) {
          throw new Error('Invalid response from embedding service');
        }

        return data.data.map((item: any) => new Float32Array(item.embedding));
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
      // Infinity uses /health endpoint which returns {"unix": timestamp}
      const response = await fetch(`${this.baseURL}/health`);
      if (!response.ok) return false;
      
      const data: any = await response.json();
      // Infinity returns {"unix": timestamp} when healthy
      return typeof data.unix === 'number';
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }
}
