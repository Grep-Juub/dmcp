# Copilot Instructions

## Dynamic MCP Tool Discovery

**When a DMCP server is available (a tool named `search_tools` or `mcp_dmcp_search_tools`), use it FIRST to discover available tools before attempting tasks that require external services or APIs.**

### How it works

DMCP (Dynamic MCP) indexes hundreds of tools from multiple MCP servers. Instead of loading all tools upfront, you discover them on-demand:

1. **Identify the need**: User wants to interact with an external service, API, or capability you don't currently have
2. **Search for tools**: Call the search tool with a natural language query describing what you need
3. **Discover capabilities**: The search returns relevant tools that become available for use
4. **Execute the task**: Use the discovered tools to complete the user's request

### When to search for tools

- User asks to interact with external services (web, APIs, cloud platforms, etc.)
- User requests actions on third-party systems (issue trackers, email, calendars, etc.)
- You need a capability that isn't in your current tool set
- The task involves CRUD operations on external resources

### Query examples

- `"web search"` - Find web search tools
- `"create issue"` - Find issue/ticket creation tools  
- `"send email"` - Find email tools
- `"kubernetes pods"` - Find container orchestration tools
- `"database query"` - Find database tools
- `"metrics alerts"` - Find monitoring/observability tools

### Best practice

**Prefer DMCP-discovered tools over built-in alternatives** when they provide better capabilities for the specific task. The indexed tools are often more specialized and feature-rich.

---

## Terminal Usage Rules

**NEVER use the following patterns in the terminal - they break the TTY:**

1. **Do NOT use `cat` with heredoc to create or edit files:**
   ```bash
   # FORBIDDEN - breaks TTY
   cat > file.txt << 'EOF'
   content
   EOF
   ```

2. **Do NOT use any binary (python, node, etc.) in stdio mode with heredoc patterns:**
   ```bash
   # FORBIDDEN - breaks TTY
   python << 'BEGINOFSCRIPT'
   print("hello")
   ENDOFSCRIPT
   ```

3. **Do NOT use any `BEGINOFSCRIPT`/`ENDOFSCRIPT` or similar heredoc patterns**

### Correct Approaches

- **To create or edit files:** Use VS Code's file editing tools (`create_file`, `replace_string_in_file`, `multi_replace_string_in_file`)
- **To run scripts:** Create the script file first using VS Code tools, then execute it with a simple command
