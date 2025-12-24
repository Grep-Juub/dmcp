# DMCP Improvement Ideas

## Automatic MCP Detection and Indexing

### Problem
Currently, when new MCP servers are added to the agent gateway config, they need to be manually indexed using the dmcp-indexer. This creates a maintenance burden and potential for the search index to become stale.

### Proposed Solution: Auto-Discovery and Indexing

#### 1. Config Watcher Service
Create a new service that monitors the gateway config for changes:

```typescript
// src/config-watcher.ts
import { watch } from 'fs';
import { createHash } from 'crypto';

class ConfigWatcher {
  private lastConfigHash: string = '';
  private gatewayUrl: string;
  
  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async checkForChanges(): Promise<string[]> {
    const config = await fetch(`${this.gatewayUrl}/config_dump`);
    const data = await config.json();
    
    const currentHash = createHash('md5')
      .update(JSON.stringify(data))
      .digest('hex');
    
    if (currentHash !== this.lastConfigHash) {
      // Detect new servers
      const newServers = this.detectNewServers(data);
      this.lastConfigHash = currentHash;
      return newServers;
    }
    
    return [];
  }
  
  private detectNewServers(config: any): string[] {
    // Compare with indexed servers in Redis
    // Return list of new server names
  }
}
```

#### 2. Scheduled Polling
Add a background task that periodically checks for new MCPs:

```typescript
// Add to dmcp-server.ts
async function startAutoIndexer(interval: number = 60000) {
  const watcher = new ConfigWatcher(GATEWAY_URL);
  
  setInterval(async () => {
    const newServers = await watcher.checkForChanges();
    
    for (const server of newServers) {
      console.log(`[AutoIndexer] New MCP detected: ${server}`);
      await indexSingleServer(server);
    }
  }, interval);
}
```

#### 3. Webhook Integration
Alternative: The gateway could emit events when config changes:

```yaml
# Gateway config enhancement
webhooks:
  config_change:
    url: http://localhost:DMCP_PORT/webhook/config-changed
    events: [server_added, server_removed, server_updated]
```

#### 4. Redis Metadata Tracking
Store metadata about indexed servers to detect changes:

```typescript
// Store in Redis
interface IndexedServerMeta {
  serverId: string;
  port: number;
  lastIndexed: number;
  toolCount: number;
  configHash: string;
}

// Keys: meta:server:{serverId}
```

### Implementation Steps

1. **Phase 1: Manual with CLI** ✅ (Done)
   - Added `--server` flag to index specific MCPs
   - Supports additive indexing without clearing existing

2. **Phase 2: Config Change Detection**
   - Create ConfigWatcher class
   - Store server metadata in Redis
   - Detect added/removed/modified servers

3. **Phase 3: Auto-Indexing**
   - Add polling loop to dmcp-server
   - Index only changed/new servers
   - Clean up removed server tools

4. **Phase 4: Real-time Updates**
   - Implement webhook endpoint
   - Gateway integration for push notifications
   - Near-instant indexing of new MCPs

### Additional Improvements

#### Health Monitoring
```typescript
// Check if MCP servers are still alive
async function healthCheck(servers: MCPServerConfig[]) {
  for (const server of servers) {
    const healthy = await pingServer(server.url);
    if (!healthy) {
      // Mark tools as unavailable
      await redis.markServerUnavailable(server.name);
    }
  }
}
```

#### Version Tracking
Track tool versions to detect when tools are updated:
```typescript
interface ToolVersion {
  name: string;
  descriptionHash: string;
  schemaHash: string;
  lastSeen: number;
}
```

#### Lazy Loading
Don't index all tools at startup - discover and index on first search:
```typescript
async function searchWithLazyIndex(query: string) {
  const results = await redis.search(query);
  
  // If no results, try to discover from gateway
  if (results.length === 0) {
    const newTools = await discoverFromGateway(query);
    if (newTools.length > 0) {
      await indexTools(newTools);
      return redis.search(query);
    }
  }
  
  return results;
}
```

### Configuration
Add to `dmcp-server` config:
```json
{
  "autoIndex": {
    "enabled": true,
    "pollInterval": 60000,
    "onStartup": true,
    "indexNewOnly": true
  }
}
```

### Benefits
- **Zero maintenance**: New MCPs auto-discovered and indexed
- **Always fresh**: Index stays in sync with gateway config
- **Efficient**: Only index what changed
- **Resilient**: Health checks remove stale tools

---

## Other Ideas

### Tool Quality Scoring
- Track tool usage frequency
- Measure response times
- Score tool reliability
- Surface better tools first

### Semantic Aliases
- Learn that "create file" → filesystem tools
- Build synonym mappings from usage patterns
- Improve search relevance

### Tool Composition
- Detect tools that work well together
- Suggest tool chains for complex tasks
- Pre-build common workflows

### Usage Analytics
- Track which tools get selected
- Learn from user corrections
- Improve classifier over time
