---
name: semantic-code-search
description: Use for unfamiliar codebases or intent-based questions where exact identifiers are not known and a small set of relevant code chunks can replace broad grep and full-file reads.
---

# Semantic code search with Semble

Use Semble for intent search such as “where is authentication state persisted?” or “what code retries failed jobs?”. It runs locally and returns code-aware chunks instead of whole files.

1. Confirm the command exists:

```bash
command -v semble
```

2. Search the current repository with a bounded result count:

```bash
semble search "authentication flow" "$PWD" --top-k 8
```

3. Read the original source around only the strongest matches. Verify definitions and call sites with `rg`, `sg`, Serena, or language tooling before editing.
4. Refine the query or restrict it to a subsystem rather than increasing `--top-k` without a reason.
5. Use `semble find-related <file> <line> "$PWD"` when a known location should lead to similar implementations.

Use exact `rg` or `sg` when the identifier, literal, import, or AST pattern is already known. Do not run Semble and several overlapping semantic search tools for the same question unless the first result is incomplete.

Semble may download its compact local retrieval model on first use. If the command is unavailable, initialization fails, or the language is unsupported, continue with `sg`, `rg`, bounded `Read`, or Serena.
