/**
 * Validates ZPL_ENGINE_URL before any request with the API key.
 * Mitigates misconfiguration / phishing configs that would send Bearer tokens to a hostile host.
 */

const DEFAULT_ENGINE_HOST = "engine.zeropointlogic.io";

function parseExtraHosts(): Set<string> {
  const raw = process.env.ZPL_ENGINE_HOST_ALLOWLIST ?? "";
  const set = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const h = part.trim().toLowerCase();
    if (h) set.add(h);
  }
  return set;
}

function buildBaseUrl(u: URL): string {
  let path = u.pathname;
  if (path.endsWith("/") && path.length > 1) path = path.slice(0, -1);
  if (!path || path === "/") return u.origin;
  return `${u.origin}${path}`;
}

function assertProtocolAndNoUserInfo(u: URL, host: string): void {
  if (u.username || u.password) {
    throw new Error(
      "ZPL_ENGINE_URL must not embed credentials — use ZPL_API_KEY in env instead"
    );
  }

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";

  if (u.protocol === "https:") return;

  if (u.protocol === "http:" && isLocal && process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL === "1") {
    return;
  }

  if (u.protocol === "http:") {
    throw new Error(
      "ZPL_ENGINE_URL must use https://. For local engine only: http://127.0.0.1 with ZPL_ENGINE_ALLOW_INSECURE_LOCAL=1"
    );
  }

  throw new Error(`ZPL_ENGINE_URL protocol "${u.protocol}" is not allowed — use https://`);
}

function isLocalDevHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function assertHostAllowed(host: string): void {
  if (process.env.ZPL_ENGINE_DISABLE_URL_GUARD === "1") {
    if ((process.env.NODE_ENV ?? "").toLowerCase() === "production") {
      throw new Error(
        "ZPL_ENGINE_DISABLE_URL_GUARD=1 is blocked in production. " +
          "Use ZPL_ENGINE_HOST_ALLOWLIST for approved hosts."
      );
    }
    return;
  }
  if (process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL === "1" && isLocalDevHost(host)) {
    return;
  }
  const allowed = new Set([DEFAULT_ENGINE_HOST, ...parseExtraHosts()]);
  if (!allowed.has(host)) {
    const list = [...allowed].sort().join(", ");
    throw new Error(
      `ZPL_ENGINE_URL host "${host}" is not allowed. Default allowlist: ${DEFAULT_ENGINE_HOST}. ` +
        `Configured allowlist: ${list}. ` +
        `Set ZPL_ENGINE_HOST_ALLOWLIST=staging.example.com (comma-separated) for self-hosted engines, ` +
        `or ZPL_ENGINE_DISABLE_URL_GUARD=1 only if you accept exfiltration risk from a mistyped URL.`
    );
  }
}

/**
 * Parses env, validates host + scheme, returns normalized base (no trailing slash on path).
 * Cached for process lifetime.
 */
let cachedBase: string | null = null;

export function getValidatedEngineBaseUrl(): string {
  if (cachedBase !== null) return cachedBase;

  const raw = (process.env.ZPL_ENGINE_URL ?? `https://${DEFAULT_ENGINE_HOST}`).trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(
      "ZPL_ENGINE_URL must be a valid absolute URL (example: https://engine.zeropointlogic.io)"
    );
  }

  const host = u.hostname.toLowerCase();
  assertProtocolAndNoUserInfo(u, host);
  assertHostAllowed(host);

  cachedBase = buildBaseUrl(u);
  return cachedBase;
}

/** Clears cached URL (for tests or dynamic env reload). Not used in normal MCP operation. */
export function resetValidatedEngineUrlCache(): void {
  cachedBase = null;
}
