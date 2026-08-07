import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|password|cookie|credential)/i;

export function redactUnknown(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 8) return "[max-depth]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactUnknown(item, secrets, depth + 1);
    }
    return output;
  }
  return value;
}

export function redactText(text: string, secrets: string[] = []): string {
  let output = text;
  for (const secret of secrets.filter((item) => item.length >= 6)) {
    output = output.split(secret).join("[redacted]");
  }
  output = output
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["'])[^"'\s]{6,}/gi, "$1[redacted]");
  return output;
}

export function safeJson(value: unknown, secrets: string[] = [], space = 2): string {
  try {
    return JSON.stringify(redactUnknown(value, secrets), null, space);
  } catch {
    return "[unserializable]";
  }
}

function resolveExistingPath(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let resolved = current;
  try {
    resolved = realpathSync.native(current);
  } catch {
    resolved = path.resolve(current);
  }
  return path.resolve(resolved, ...suffix);
}

function resolveCandidate(candidate: string, cwd: string): string {
  if (candidate === "~") return resolveExistingPath(process.env.HOME ?? cwd);
  if (candidate.startsWith(`~${path.sep}`) || candidate.startsWith("~/")) {
    return resolveExistingPath(path.join(process.env.HOME ?? cwd, candidate.slice(2)));
  }
  return resolveExistingPath(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
}

export function isPathInside(parent: string, candidate: string): boolean {
  const resolvedParent = resolveExistingPath(parent);
  const resolvedCandidate = resolveExistingPath(candidate);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function collectPathViolations(
  input: Record<string, unknown>,
  allowedRoots: string[],
  cwd = allowedRoots[0] ?? process.cwd(),
): string[] {
  const violations: string[] = [];
  const pathKey = /(^|_)(path|paths|file|files|directory|directories|cwd|folder|folders)$/i;
  const roots = allowedRoots.map(resolveExistingPath);
  const visit = (value: unknown, key = "", depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === "string" && pathKey.test(key) && value.trim()) {
      const resolved = resolveCandidate(value, cwd);
      if (!roots.some((root) => isPathInside(root, resolved))) violations.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        visit(childValue, childKey, depth + 1);
      }
    }
  };
  visit(input);
  return [...new Set(violations)];
}
