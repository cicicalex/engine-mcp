/**
 * `npx zpl-engine-mcp setup` — interactive device-flow auth.
 *
 * Why this exists:
 *   The MCP runs over stdio JSON-RPC inside Claude Desktop / Cursor / Windsurf.
 *   It cannot show UI, cannot open a browser, and cannot prompt for input — any
 *   stdout write corrupts the JSON-RPC stream. So the user was previously
 *   forced to: sign up on the website, find the dashboard, create an API key,
 *   copy-paste it into a JSON config file by hand. 10+ minutes, high drop-off.
 *
 *   `setup` is a separate CLI entry point invoked *outside* the MCP loop.
 *   It drives the RFC 8628-style device flow against
 *   zeropointlogic.io/api/auth/cli/*, stores the resulting user key in
 *   ~/.zpl/config.toml (which the MCP picks up automatically at next launch),
 *   and auto-patches every supported client's MCP config (Claude Desktop,
 *   Cursor, Windsurf) so the user doesn't have to touch JSON at all. Clients
 *   that aren't installed are skipped silently; the snippet is printed once
 *   as a fallback for non-standard setups (Claude Code, VS Code, Zed).
 *   Install-to-working in ~15 seconds.
 *
 * Safety:
 *   - Never logs the API key.
 *   - Chmod 600 on the config file (no-op on Windows, which is fine; NTFS ACLs
 *     default to per-user home anyway).
 *   - Preserves existing mcpServers entries across all patched configs.
 *   - On malformed config JSON, refuses to write and prints instructions
 *     instead of destroying the file.
 *   - Each client patch is isolated — one failing doesn't abort the others.
 *   - Bounded polling (10 min max) and always uses `interval_s` from the
 *     backend so a misbehaving server can't DoS itself.
 */

import { mkdir, writeFile, readFile, chmod, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getMcpPackageVersion } from "./package-meta.js";

const BACKEND_BASE = process.env.ZPL_BACKEND_URL ?? "https://zeropointlogic.io";
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard cap — matches device_code expiry
const POLL_MAX_INTERVAL_MS = 10_000;    // cap interval_s so a stuck server doesn't stall us forever

// Cloudflare Bot Fight Mode is enabled on zeropointlogic.io and blocks any
// User-Agent that doesn't start with "Mozilla/". Node's default fetch UA
// ("node") gets a 403 challenge page, which silently breaks the wizard.
// Using the browser-compat "Mozilla/5.0 (compatible; ...)" pattern — same
// convention used by well-behaved crawlers (bingbot, slackbot, etc.) — lets
// us identify the tool while still clearing the challenge.
const USER_AGENT = `Mozilla/5.0 (compatible; zpl-engine-mcp/${getMcpPackageVersion()}; +https://github.com/cicicalex/zpl-engine-mcp)`;

// ---------------------------------------------------------------------------
// Backend shape — mirrors /api/auth/cli/start and /api/auth/cli/status
// ---------------------------------------------------------------------------

interface StartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval_s: number;
  expires_at: string; // ISO timestamp
}

interface StatusPending {
  status: "pending";
}
interface StatusApproved {
  status: "approved";
  api_key: string;
  user_email: string;
}
interface StatusDenied {
  status: "denied" | "expired";
  reason?: string;
}
type StatusResponse = StatusPending | StatusApproved | StatusDenied;

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  // Setup prints to stdout since this is a standalone CLI, not the MCP stdio loop.
  process.stdout.write(msg + "\n");
}

function logErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

/**
 * Best-effort open a URL in the user's default browser. Never throws —
 * the verification URL is always printed so the user can paste it manually.
 */
function openInBrowser(url: string): void {
  try {
    const plat = platform();
    if (plat === "win32") {
      // `start` is a cmd.exe builtin, not an exe. Use shell.
      // The empty "" first arg is a cmd quirk: it's the window title when
      // the next arg contains spaces.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (plat === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Swallow. User will paste the URL manually.
  }
}

/**
 * Absolute path to the user-scoped Claude Desktop config for the current OS.
 */
function claudeDesktopConfigPath(): string {
  const home = homedir();
  const plat = platform();
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (plat === "win32") {
    // %APPDATA% is usually C:\Users\<name>\AppData\Roaming. Prefer the env
    // var so we respect roaming-profile redirects.
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appdata, "Claude", "claude_desktop_config.json");
  }
  // Linux / other
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/**
 * Absolute path to the Cursor MCP config. Cursor uses the same
 * `{ mcpServers: {...} }` shape as Claude Desktop. Path is cross-platform
 * (`~/.cursor/mcp.json`) — Cursor normalises it on Windows via its own home
 * resolution, so homedir() is correct on all three OSes.
 */
function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

/**
 * Absolute path to the Windsurf (Codeium) MCP config. Same
 * `{ mcpServers: {...} }` shape as Claude/Cursor. Path is cross-platform
 * (`~/.codeium/windsurf/mcp_config.json`).
 */
function windsurfConfigPath(): string {
  return join(homedir(), ".codeium", "windsurf", "mcp_config.json");
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

async function startDeviceFlow(): Promise<StartResponse> {
  const res = await fetch(`${BACKEND_BASE}/api/auth/cli/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ client: "mcp" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Backend returned ${res.status}. ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as Partial<StartResponse>;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Backend /auth/cli/start returned an unexpected shape.");
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    interval_s: Math.max(1, Math.min(30, data.interval_s ?? 2)),
    expires_at: data.expires_at ?? new Date(Date.now() + POLL_TIMEOUT_MS).toISOString(),
  };
}

async function pollStatus(deviceCode: string): Promise<StatusResponse> {
  const url = `${BACKEND_BASE}/api/auth/cli/status?device_code=${encodeURIComponent(deviceCode)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Surface as a pending-like object so the caller keeps polling on transient 5xx;
    // a final "expired" will end the loop correctly.
    if (res.status >= 500) return { status: "pending" };
    const body = await res.text().catch(() => "");
    throw new Error(`Backend returned ${res.status}. ${body.slice(0, 200)}`);
  }
  return (await res.json()) as StatusResponse;
}

async function waitForApproval(start: StartResponse): Promise<StatusApproved> {
  const intervalMs = Math.min(POLL_MAX_INTERVAL_MS, start.interval_s * 1000);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  log("Waiting for approval in your browser...");

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let status: StatusResponse;
    try {
      status = await pollStatus(start.device_code);
    } catch (err) {
      // Transient failure — keep polling until deadline.
      logErr(`  (network issue, retrying: ${(err as Error).message})`);
      continue;
    }
    if (status.status === "approved") return status;
    if (status.status === "denied") {
      throw new Error("You denied the request in the browser. Run setup again to retry.");
    }
    if (status.status === "expired") {
      throw new Error("Code expired before approval. Run setup again to retry.");
    }
    // status === "pending" — loop
  }
  throw new Error("Timed out waiting for approval (10 min). Run setup again to retry.");
}

// ---------------------------------------------------------------------------
// Config file writers
// ---------------------------------------------------------------------------

async function writeConfigToml(apiKey: string, userEmail: string): Promise<string> {
  const home = homedir();
  const dir = join(home, ".zpl");
  const path = join(dir, "config.toml");
  await mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const content =
    `# ZPL config — written by \`npx zpl-engine-mcp setup\`\n` +
    `# This file is read by the MCP at startup. Keep it private (mode 600).\n` +
    `api_key = "${apiKey}"\n` +
    `user_email = "${userEmail}"\n` +
    `created_at = "${createdAt}"\n`;
  await writeFile(path, content, "utf-8");
  // chmod is a no-op on Windows (NTFS ACLs handle privacy at the home-dir level).
  // We still try so POSIX installs are properly locked down.
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

/**
 * Patch a standard MCP config file (Claude Desktop / Cursor / Windsurf all
 * share the same `{ mcpServers: {...} }` shape). Returns:
 *   - "updated" if we wrote a merged file,
 *   - "created" if the parent dir existed but the file didn't (we wrote fresh),
 *   - "manual" if the parent dir doesn't exist (client not installed)
 *      — caller decides whether to print a snippet.
 *   - "malformed" if JSON didn't parse — we refuse to write, caller explains.
 *
 * Design note: one function for all three clients is intentional. They all
 * accept the same shape (`{mcpServers: {"zpl-engine-mcp": {command, args, env}}}`),
 * and keeping the merge logic in one place means malformed/missing handling
 * can't drift between clients over time.
 */
type PatchResult = "updated" | "created" | "manual" | "malformed";

export async function patchMcpConfigFile(
  path: string,
  apiKey: string,
): Promise<{ result: PatchResult; path: string }> {
  // Does the file exist?
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Permission error etc — don't try to write, tell user.
      return { result: "manual", path };
    }
  }

  const entry = {
    command: "npx",
    args: ["-y", "zpl-engine-mcp"],
    env: {
      ZPL_API_KEY: apiKey,
    },
  };

  // If file exists: merge. If malformed, bail.
  if (existing !== undefined) {
    // Empty files are common when a client pre-creates the path but leaves
    // it blank. Treat the same as "file didn't exist" to keep the flow clean.
    if (existing.trim().length === 0) {
      const fresh: ClaudeDesktopConfig = { mcpServers: { "zpl-engine-mcp": entry } };
      await writeFile(path, JSON.stringify(fresh, null, 2), "utf-8");
      return { result: "created", path };
    }
    let parsed: ClaudeDesktopConfig;
    try {
      parsed = JSON.parse(existing) as ClaudeDesktopConfig;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { result: "malformed", path };
      }
    } catch {
      return { result: "malformed", path };
    }
    parsed.mcpServers = parsed.mcpServers ?? {};
    parsed.mcpServers["zpl-engine-mcp"] = entry;
    await writeFile(path, JSON.stringify(parsed, null, 2), "utf-8");
    return { result: "updated", path };
  }

  // File doesn't exist. Check parent dir.
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  try {
    await stat(dir);
  } catch {
    // Client likely not installed on this machine.
    return { result: "manual", path };
  }

  // Parent exists, file doesn't — write a fresh config.
  const fresh: ClaudeDesktopConfig = { mcpServers: { "zpl-engine-mcp": entry } };
  await writeFile(path, JSON.stringify(fresh, null, 2), "utf-8");
  return { result: "created", path };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
  log("");
  log("Welcome to ZPL MCP setup.");
  log("");

  let start: StartResponse;
  try {
    start = await startDeviceFlow();
  } catch (err) {
    logErr(`Could not contact ${BACKEND_BASE}: ${(err as Error).message}`);
    logErr("Check your internet connection and try again.");
    process.exit(1);
  }

  // Build the full URL with the code pre-filled so the user only has to click "Approve".
  const sep = start.verification_uri.includes("?") ? "&" : "?";
  const approveUrl = `${start.verification_uri}${sep}code=${encodeURIComponent(start.user_code)}`;

  log(`Opening ${approveUrl} in your browser...`);
  log(`(If it doesn't open, paste that URL manually.)`);
  log("");
  openInBrowser(approveUrl);

  let approved: StatusApproved;
  try {
    approved = await waitForApproval(start);
  } catch (err) {
    logErr(`Setup failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Save config.toml
  let configPath: string;
  try {
    configPath = await writeConfigToml(approved.api_key, approved.user_email);
  } catch (err) {
    logErr(`Could not write config file: ${(err as Error).message}`);
    logErr("Your API key was approved, but we couldn't save it locally.");
    logErr(`Set this env var in your MCP config instead:  ZPL_API_KEY=${approved.api_key}`);
    process.exit(1);
  }

  // Patch all three supported clients in parallel. Each client failing (or
  // simply not being installed) should never block the others — so every
  // patch is wrapped in its own catch-to-manual.
  const CLIENTS: Array<{ name: string; path: string; restartHint: string }> = [
    { name: "Claude Desktop", path: claudeDesktopConfigPath(), restartHint: "Restart Claude Desktop" },
    { name: "Cursor",         path: cursorConfigPath(),         restartHint: "Restart Cursor" },
    { name: "Windsurf",       path: windsurfConfigPath(),       restartHint: "Restart Windsurf" },
  ];

  const patches = await Promise.all(
    CLIENTS.map(async (c) => {
      try {
        const r = await patchMcpConfigFile(c.path, approved.api_key);
        return { client: c, ...r };
      } catch (err) {
        logErr(`(${c.name} config patch failed: ${(err as Error).message})`);
        return { client: c, result: "manual" as PatchResult, path: c.path };
      }
    }),
  );

  log("");
  log(`Connected as ${approved.user_email}`);
  log(`Key saved to ${configPath}`);
  log("");

  const configured = patches.filter((p) => p.result === "updated" || p.result === "created");
  const malformed  = patches.filter((p) => p.result === "malformed");
  const manual     = patches.filter((p) => p.result === "manual");

  if (configured.length > 0) {
    log("Configured clients:");
    for (const p of configured) {
      log(`  - ${p.client.name}: ${p.path}`);
    }
    log("");
    const restartLines = Array.from(new Set(configured.map((p) => p.client.restartHint)));
    for (const line of restartLines) log(`${line} to activate.`);
  } else {
    log("No MCP-compatible clients detected at default paths.");
  }

  if (malformed.length > 0) {
    log("");
    log("Couldn't auto-patch these configs (existing file isn't valid JSON):");
    for (const p of malformed) {
      log(`  - ${p.client.name}: ${p.path}`);
    }
    log("Open each file manually and paste the snippet below under mcpServers.");
  }

  // If at least one client is unresolved (not installed, or malformed),
  // print the snippet once so the user has a paste-ready fallback.
  if (malformed.length > 0 || (configured.length === 0 && manual.length > 0)) {
    if (manual.length > 0 && configured.length === 0) {
      log("");
      log("If you're using a client we don't auto-detect (Claude Code, VS Code, Zed, ...), add this to its MCP config:");
    }
    printSnippet(approved.api_key);
  }

  log("");
}

function printSnippet(apiKey: string): void {
  log("");
  log("  {");
  log('    "mcpServers": {');
  log('      "zpl-engine-mcp": {');
  log('        "command": "npx",');
  log('        "args": ["-y", "zpl-engine-mcp"],');
  log('        "env": {');
  log(`          "ZPL_API_KEY": "${apiKey}"`);
  log("        }");
  log("      }");
  log("    }");
  log("  }");
}
