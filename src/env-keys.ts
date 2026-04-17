/**
 * Resolve ZPL user API key from environment (MCP / shell / Coolify naming variants).
 *
 * IMPORTANT (v3.5.0): Service keys (`zpl_s_...`) are NOT accepted here.
 * Service keys are server-side only and must be scoped to a known IP on the
 * engine (see ZPL_MASTER_PLAN_V2 §7.1). MCP clients (Claude Desktop, Claude
 * Code, Cursor, etc.) must authenticate with a USER key (`zpl_u_...`) so
 * plan limits apply per account.
 *
 * `ZPL_SERVICE_KEY` is intentionally removed as a fallback — if users paste
 * a service key into that env, the MCP will fail format validation with a
 * clear error pointing them to create a user key at
 * https://zeropointlogic.io/dashboard/api-keys.
 */
export function resolveZplApiKey(): string {
  return (
    process.env.ZPL_API_KEY ??
    process.env.ZPL_ENGINE_KEY ??
    ""
  );
}
