/**
 * Keyword Extractor for Tool Descriptions
 * 
 * Extracts meaningful keywords from tool names and descriptions
 * to improve BM25 search accuracy without modifying original text.
 * 
 * Strategy: TF-IDF style extraction focusing on:
 * - Action verbs
 * - Domain nouns
 * - Technology terms
 * - No bias injection - only extract what's already there
 */

import natural from 'natural';

const tokenizer = new natural.WordTokenizer();
const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'will', 'with',
  'this', 'can', 'all', 'or', 'but', 'not', 'you', 'your', 'we', 'they', 'them',
]);

// Common action verbs in tool descriptions
const actionVerbs = new Set([
  'search', 'find', 'get', 'list', 'retrieve', 'fetch', 'query', 'lookup',
  'create', 'add', 'insert', 'update', 'modify', 'edit', 'change', 'set',
  'delete', 'remove', 'destroy', 'clear', 'reset',
  'send', 'post', 'put', 'submit', 'execute', 'run', 'invoke', 'call',
  'read', 'write', 'load', 'save', 'download', 'upload',
  'analyze', 'process', 'transform', 'convert', 'format', 'parse',
  'monitor', 'watch', 'track', 'log', 'audit',
]);

// Domain-specific important terms
const domainTerms = new Set([
  'web', 'internet', 'online', 'url', 'http', 'api', 'rest', 'graphql',
  'database', 'sql', 'query', 'table', 'record', 'data', 'json', 'xml',
  'file', 'directory', 'folder', 'path', 'storage', 'disk',
  'user', 'account', 'auth', 'permission', 'role', 'access',
  'email', 'message', 'notification', 'alert',
  'server', 'service', 'endpoint', 'resource', 'backend',
  'github', 'git', 'repository', 'commit', 'branch', 'issue', 'pull',
  'aws', 'azure', 'cloud', 'container', 'kubernetes', 'docker',
  'metrics', 'logs', 'monitoring', 'observability', 'performance',
]);

export interface KeywordExtractionResult {
  keywords: string[];           // Extracted keywords
  actionVerbs: string[];         // Action verbs found
  domainTerms: string[];         // Domain-specific terms
  searchableText: string;        // Combined text for BM25
}

/**
 * Extract keywords from tool name and description
 * Uses TF-IDF-like approach to identify important terms
 */
export function extractKeywords(name: string, description: string): KeywordExtractionResult {
  // Combine name and description, name gets more weight
  const fullText = `${name} ${name} ${description}`.toLowerCase();
  
  // Tokenize
  const tokens = tokenizer.tokenize(fullText) || [];
  
  // Filter and categorize
  const foundActionVerbs: Set<string> = new Set();
  const foundDomainTerms: Set<string> = new Set();
  const otherKeywords: Set<string> = new Set();
  
  for (const token of tokens) {
    // Skip stopwords and very short tokens
    if (stopWords.has(token) || token.length < 3) {
      continue;
    }
    
    // Skip pure numbers
    if (/^\d+$/.test(token)) {
      continue;
    }
    
    // Categorize token
    if (actionVerbs.has(token)) {
      foundActionVerbs.add(token);
    } else if (domainTerms.has(token)) {
      foundDomainTerms.add(token);
    } else {
      // Keep other meaningful tokens (nouns, tech terms, etc.)
      otherKeywords.add(token);
    }
  }
  
  // Combine for frequency analysis
  const allKeywords = [
    ...Array.from(foundActionVerbs),
    ...Array.from(foundDomainTerms),
    ...Array.from(otherKeywords),
  ];
  
  // Build searchable text: prioritize action verbs and domain terms
  const searchableText = [
    ...Array.from(foundActionVerbs).map(v => v.repeat(2)), // Weight action verbs 2x
    ...Array.from(foundDomainTerms).map(t => t.repeat(2)), // Weight domain terms 2x
    ...Array.from(otherKeywords),
  ].join(' ');
  
  return {
    keywords: allKeywords,
    actionVerbs: Array.from(foundActionVerbs),
    domainTerms: Array.from(foundDomainTerms),
    searchableText,
  };
}

/**
 * Batch extract keywords for multiple tools
 */
export function extractKeywordsBatch(
  tools: Array<{ name: string; description: string }>
): Map<string, KeywordExtractionResult> {
  const results = new Map<string, KeywordExtractionResult>();
  
  for (const tool of tools) {
    const key = tool.name;
    results.set(key, extractKeywords(tool.name, tool.description));
  }
  
  return results;
}
