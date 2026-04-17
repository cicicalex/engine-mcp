/**
 * Single source of truth for MCP package version (reads package.json at runtime).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

export function getMcpPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(dir, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const v = (JSON.parse(raw) as { version?: string }).version;
  if (!v || typeof v !== "string") {
    throw new Error("package.json is missing a valid \"version\" field");
  }
  cachedVersion = v;
  return cachedVersion;
}
