---
name: context-efficient-coding
description: Use for coding, debugging, review and refactoring tasks that require navigating a repository without loading unnecessary files into context.
---

# Context-efficient coding

Work from the smallest useful slice of the repository. The goal is not to read less at any cost; it is to avoid sending irrelevant code and repeated command output through the model.

## Repository navigation

1. Locate before reading. Start with file names, exact identifiers, call sites and tests.
2. Use `rg` for exact text, literals, configuration keys and filenames.
3. Use `sg` (`ast-grep`) when the question is structural: function calls, declarations, imports, JSX, decorators, control flow or syntax-aware replacements.
4. Read bounded ranges around matches. Do not print an entire large file when one symbol or block is enough.
5. Reuse facts already established in the current turn. Do not rerun the same broad search unless the code changed.

When Serena tools are available, prefer symbol overview, symbol lookup and reference lookup for medium or large codebases. Use symbolic edits when they are safer than line-based edits. Fall back to `sg`, `rg` and normal file tools when Serena is unavailable or the task is small.

## Tool output discipline

- Limit search results with file globs, directories and result counts.
- Exclude generated code, build output, dependencies, lockfiles and vendored sources unless the task specifically concerns them.
- For commands with noisy output, request the failing section, summary or first relevant matches rather than the complete log.
- Inspect the focused diff after editing. Run the narrowest relevant tests first, then broader checks when warranted.
- Do not paste binary data, minified bundles or complete dependency trees into context.

## User-visible output

- Do not narrate routine tool use, repeat the user's request or announce an obvious plan. Use tools directly.
- Between tool calls, write only when a blocking issue or user decision requires attention.
- Put the result first in the final answer. Then report changed files, checks performed and unresolved risks.
- Prefer a few short paragraphs or at most eight compact bullets. Do not reproduce full diffs, unchanged code, long logs or complete command output unless the user asks for them.
- Keep confirmation questions focused and singular. Avoid speculative follow-up suggestions unrelated to the task.
- Do not add comments, docstrings or documentation merely to explain obvious code; add them only when they improve maintainability.

## Repomix

Repomix is for an architecture map or a bounded handoff, not for automatically packing the whole repository into every prompt.

Use `repomix --compress` with a targeted `--include` set. Prefer `--token-count-tree` first to identify expensive paths. Read the generated summary, tree and selected files only. Delete temporary packs after the task.

Compression is a lossy overview. Before changing code, inspect the original source and tests.

## Quality rule

Do not trade correctness for a smaller context or shorter answer. Expand the search or explanation when evidence is incomplete, behavior crosses subsystem boundaries, a focused test contradicts the current hypothesis, or the user needs operational instructions.
