---
name: structured-data-symbols
description: Use when large JSON files, command JSON output, or unfamiliar source trees can be narrowed with jq or Universal Ctags before reading full content.
---

# Structured data and symbol indexes

## JSON

Use `jq` to select only required fields and rows. Avoid `cat` on large JSON, lockfiles, API responses, test fixtures, or command output.

Examples:

```bash
jq '{name, scripts, dependencies}' package.json
jq -c '.items[] | select(.status == "failed") | {id, error}' result.json | head -n 30
```

Use streaming mode for very large arrays when practical. Preserve the original file and validate any edit with the project's parser or tests.

## Symbols

Universal Ctags is a cheap local fallback when Serena or an LSP is unavailable. Emit JSON to stdout and filter before showing results:

```bash
ctags -R --output-format=json --fields=+nK src 2>/dev/null \
  | jq -c 'select(.name == "AgentRunner") | {name,path,line,kind}' \
  | head -n 20
```

Index only relevant directories. Do not generate or read a complete tags file for the whole repository when `rg`, `sg`, or a known path can answer the question faster.
