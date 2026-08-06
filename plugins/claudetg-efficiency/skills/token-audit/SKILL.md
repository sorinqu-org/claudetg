---
name: token-audit
description: Inspect which repository paths are expensive to include in an LLM context and recommend narrower includes or exclusions.
---

# Repository token audit

Use Repomix's token tree as a measurement tool. Do not send the complete repository pack to the model.

```bash
repomix --token-count-tree 1000 --no-file-summary
```

From the output:

- identify generated, vendored, minified or duplicated paths;
- separate source, tests, fixtures, documentation and build artifacts;
- suggest task-specific `--include` patterns rather than one permanent broad pack;
- suggest `.repomixignore` entries only for paths that are consistently irrelevant;
- keep lockfiles and snapshots excluded by default, but include them when the task concerns dependencies or snapshot behavior.

Report the largest paths and a practical search strategy. Do not claim a fixed percentage of savings; compare measured token counts for the original and proposed scopes when a numeric estimate is needed.
