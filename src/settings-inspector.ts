import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { redactUnknown, safeJson } from "./security.js";
import { truncate } from "./telegram/format.js";

export interface InspectedSettings {
  path: string;
  content: string;
}

export function inspectProjectSettings(projectPath: string, secrets: string[] = []): InspectedSettings[] {
  const candidates = [
    path.join(projectPath, ".claude", "settings.json"),
    path.join(projectPath, ".claude", "settings.local.json"),
    path.join(projectPath, ".mcp.json"),
    path.join(projectPath, "CLAUDE.md"),
  ];
  const results: InspectedSettings[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).size > 1_000_000) {
        results.push({ path: candidate, content: "[file is larger than 1 MB]" });
        continue;
      }
      const raw = readFileSync(candidate, "utf8");
      let content: string;
      if (candidate.endsWith(".json")) {
        try {
          content = safeJson(redactUnknown(JSON.parse(raw) as unknown, secrets), [], 2);
        } catch {
          content = "[invalid JSON]";
        }
      } else {
        content = raw;
        for (const secret of secrets) content = content.split(secret).join("[redacted]");
      }
      results.push({ path: candidate, content: truncate(content, 3000) });
    } catch (error) {
      results.push({ path: candidate, content: `[unreadable: ${error instanceof Error ? error.message : String(error)}]` });
    }
  }
  return results;
}
