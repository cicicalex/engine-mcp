// Integration tests for patchMcpConfigFile — the generic merger used by
// `npx zpl-engine-mcp setup` for all three supported clients (Claude Desktop,
// Cursor, Windsurf). All three share the same `{mcpServers: {...}}` shape,
// so one function handles them. These tests exercise that function's four
// result branches: "created", "updated", "manual", "malformed".
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { patchMcpConfigFile } from "../dist/setup.js";

const FAKE_KEY = "zpl_u_" + "a".repeat(48);

async function mkTmpDir() {
  const dir = join(tmpdir(), `zpl-patch-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test("created: parent dir exists, file doesn't", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "created");
    const written = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(written.mcpServers["zpl-engine-mcp"]);
    assert.equal(written.mcpServers["zpl-engine-mcp"].env.ZPL_API_KEY, FAKE_KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual: parent dir missing (client not installed)", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "does-not-exist-subdir", "mcp.json");
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "manual");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updated: existing config merges, preserves sibling entries", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    const existing = {
      mcpServers: {
        "other-server": { command: "node", args: ["/tmp/foo.js"] },
      },
      unrelatedField: "should survive",
    };
    await writeFile(path, JSON.stringify(existing, null, 2));
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "updated");
    const merged = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(merged.mcpServers["other-server"], "sibling mcp server preserved");
    assert.ok(merged.mcpServers["zpl-engine-mcp"], "our entry added");
    assert.equal(merged.unrelatedField, "should survive", "top-level unknown keys preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updated: empty mcpServers object gets entry added", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: {} }));
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "updated");
    const merged = JSON.parse(await readFile(path, "utf-8"));
    assert.deepEqual(Object.keys(merged.mcpServers), ["zpl-engine-mcp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("created: empty file (zero bytes) treated as missing, written fresh", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, "");
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "created");
    const written = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(written.mcpServers["zpl-engine-mcp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("created: whitespace-only file treated as empty", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, "   \n\t  \n");
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed: invalid JSON returns 'malformed' and doesn't overwrite", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    const bad = "{ this is not json }";
    await writeFile(path, bad);
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "malformed");
    const after = await readFile(path, "utf-8");
    assert.equal(after, bad, "malformed file not overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed: top-level array rejected (expects object)", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify([1, 2, 3]));
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "malformed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updated: re-running the patch is idempotent (same key, same result)", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    await patchMcpConfigFile(path, FAKE_KEY);
    const res = await patchMcpConfigFile(path, FAKE_KEY);
    assert.equal(res.result, "updated");
    const after = JSON.parse(await readFile(path, "utf-8"));
    assert.equal(after.mcpServers["zpl-engine-mcp"].env.ZPL_API_KEY, FAKE_KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updated: patching with new key overwrites the env var", async () => {
  const dir = await mkTmpDir();
  try {
    const path = join(dir, "mcp.json");
    await patchMcpConfigFile(path, "zpl_u_" + "b".repeat(48));
    await patchMcpConfigFile(path, FAKE_KEY);
    const after = JSON.parse(await readFile(path, "utf-8"));
    assert.equal(after.mcpServers["zpl-engine-mcp"].env.ZPL_API_KEY, FAKE_KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
