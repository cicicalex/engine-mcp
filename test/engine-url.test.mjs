/**
 * Security regression tests for engine URL validation (run after `npm run build`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getValidatedEngineBaseUrl,
  resetValidatedEngineUrlCache,
} from "../dist/engine-url.js";

function setEnv(updates) {
  resetValidatedEngineUrlCache();
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
}

test.afterEach(() => {
  resetValidatedEngineUrlCache();
  delete process.env.ZPL_ENGINE_URL;
  delete process.env.ZPL_ENGINE_HOST_ALLOWLIST;
  delete process.env.ZPL_ENGINE_DISABLE_URL_GUARD;
  delete process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL;
});

test("default allows production engine host", () => {
  setEnv({});
  const url = getValidatedEngineBaseUrl();
  assert.match(url, /^https:\/\/engine\.zeropointlogic\.io$/);
});

test("hostile host rejected", () => {
  setEnv({ ZPL_ENGINE_URL: "https://evil-token-harvest.example/" });
  assert.throws(() => getValidatedEngineBaseUrl(), /not allowed/);
});

test("credentials in URL rejected", () => {
  setEnv({ ZPL_ENGINE_URL: "https://user:secret@engine.zeropointlogic.io/" });
  assert.throws(() => getValidatedEngineBaseUrl(), /credentials/);
});

test("extra hostname via allowlist", () => {
  setEnv({
    ZPL_ENGINE_URL: "https://staging.example.org/",
    ZPL_ENGINE_HOST_ALLOWLIST: "staging.example.org",
  });
  assert.equal(getValidatedEngineBaseUrl(), "https://staging.example.org");
});

test("local HTTP allowed with ZPL_ENGINE_ALLOW_INSECURE_LOCAL", () => {
  setEnv({
    ZPL_ENGINE_URL: "http://127.0.0.1:9999",
    ZPL_ENGINE_ALLOW_INSECURE_LOCAL: "1",
  });
  assert.equal(getValidatedEngineBaseUrl(), "http://127.0.0.1:9999");
});

test("remote HTTP rejected even with insecure-local flag", () => {
  setEnv({
    ZPL_ENGINE_URL: "http://example.com/",
    ZPL_ENGINE_ALLOW_INSECURE_LOCAL: "1",
  });
  assert.throws(() => getValidatedEngineBaseUrl(), /https/);
});
