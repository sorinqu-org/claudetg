---
name: serena-navigation
description: Use Serena's semantic symbol tools for navigation, reference analysis and precise edits in medium or large codebases when the Serena MCP server is available.
---

# Serena navigation

Use Serena when symbol-level navigation is likely to avoid broad file reads: unfamiliar modules, inheritance, call relationships, cross-file references and changes centered on named declarations.

Recommended sequence:

1. Get a symbol overview for the relevant file or namespace.
2. Find the smallest matching symbol without its body when locating code.
3. Fetch a body only after the target symbol is known.
4. Use reference lookup before changing public or widely used symbols.
5. Prefer symbolic replacement or insertion when it is clearer and safer than line-oriented editing.
6. Run focused tests and inspect the normal git diff after the edit.

Do not use Serena for every trivial lookup. Exact strings, configuration keys and small one-file tasks are usually faster with `rg`, `sg` or the normal file tools. Avoid calling overlapping generic Serena shell/read tools when Claude Code's built-in tools already provide the same result.

If Serena is unavailable, slow to initialize or does not support the project's language, continue with `sg`, `rg`, `Glob`, `Grep` and bounded `Read` calls.
