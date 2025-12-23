# Copilot Instructions

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
   
   # FORBIDDEN - breaks TTY
   node << 'EOF'
   console.log("hello")
   EOF
   ```

3. **Do NOT use any `BEGINOFSCRIPT`/`ENDOFSCRIPT` or similar heredoc patterns**

## Correct Approaches

- **To create or edit files:** Use VS Code's file editing tools (`create_file`, `replace_string_in_file`, `multi_replace_string_in_file`)
- **To run scripts:** Create the script file first using VS Code tools, then execute it with a simple command
