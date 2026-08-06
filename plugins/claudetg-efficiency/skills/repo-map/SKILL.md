---
name: repo-map
description: Build a compact architecture map for an unfamiliar or large repository without loading the complete source tree into context.
---

# Compact repository map

Use this when the task needs a high-level understanding of a repository before inspecting individual symbols.

1. Run a token tree before creating a pack:

```bash
repomix --token-count-tree 1000 --no-file-summary
```

2. Choose only the relevant directories and file types. Exclude dependencies, generated output, caches, fixtures with large payloads, snapshots and lockfiles unless they are directly relevant.
3. Generate a temporary compressed map, for example:

```bash
repomix \
  --compress \
  --style markdown \
  --include "src/**,tests/**,package.json,README.md" \
  --output "/tmp/repomix-map.md"
```

4. Read the summary and file tree first. Read compressed file sections only for subsystems implicated by the task.
5. Verify any implementation detail against the original file before editing.
6. Remove the temporary map when finished.

Never treat a compressed map as an exact representation of runtime behavior. Do not generate or read a full-repository pack when targeted searches can answer the question.
