/**
 * Resolve ZPL API key from environment (MCP / shell / Coolify naming variants).
 */
export function resolveZplApiKey(): string {
  return (
    process.env.ZPL_API_KEY ??
    process.env.ZPL_ENGINE_KEY ??
    process.env.ZPL_SERVICE_KEY ??
    ""
  );
}
