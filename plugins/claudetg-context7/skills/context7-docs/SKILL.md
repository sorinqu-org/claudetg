---
name: context7-docs
description: Use when implementation depends on a third-party library API and focused, version-aware documentation can replace broad web searches or loading complete documentation pages.
---

# Focused library documentation

Context7 is an external documentation service. Use it only for public library names, versions, and API questions. Never include source code, secrets, internal URLs, customer data, or private project details in a query.

1. Resolve the library once when its Context7 ID is unknown:

```bash
ctx7 library "grammy" "callback query handling"
```

2. Query the exact library ID with one focused question:

```bash
ctx7 docs "/grammyjs/grammy" "How are callback_query:data handlers typed?"
```

3. Ask for the installed version when version differences matter. Reuse the resolved library ID during the turn instead of resolving it repeatedly.
4. Retrieve only the API surface needed for the change. Do not request broad tutorials or entire manuals.
5. Verify behavior against local types, package source, or tests before changing production code.

If `ctx7` is unavailable or the service fails, use official documentation through normal web access. `CONTEXT7_API_KEY` is optional but recommended for higher limits; it must be supplied through the project's allowed environment configuration.
