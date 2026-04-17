# Engine + MCP + CLI audit — 2026-04-18

Auditor: Claude agent. Scope: three products packaged as two npm modules.

- Engine: Rust (Axum) HTTP API at https://engine.zeropointlogic.io
- MCP: `zpl-engine-mcp@3.6.1`, source at `C:\Dev\mcp\engine-mcp`
- CLI: `zpl-engine-cli@0.1.2`, source at `C:\Dev\zpl-cli`

Engine internals were not read or reverse-engineered. Engine probed only through its public HTTP surface.

## Engine HTTP API

Ten cold probes against `/health` came back between 56 ms and 123 ms (p95 around 120 ms). Well under the 500 ms target. TLS with HSTS (`max-age=31536000; includeSubDomains`), `x-content-type-options: nosniff`, `x-frame-options: DENY`, Cloudflare-fronted.

| Endpoint | Method | No-auth status | Auth required | Notes |
|---|---|---|---|---|
| `/health` | GET | 200 | no | `{status, version}` — returns `{"status":"ok","version":"3.0.2"}` |
| `/compute` | POST | 401 with body / 415 no body / 422 bad body | yes | Error body: `Missing Authorization header. Use: Bearer zpl_u_XXXXX` (good) |
| `/sweep` | GET | 401 | yes | Same auth error shape |
| `/plans` | GET | 401 | yes | Not public — consistent with `PlanInfo` type in MCP |
| `/about` | GET | 404 | — | Not implemented on engine; MCP has `zpl_about` client-side |
| `/version` | GET | 404 | — | Use `/health.version` instead |
| `/metrics` | GET | 404 | — | Not exposed publicly |

Response shape contract (from `ComputeResponse` interface in engine-client.ts, confirmed via error responses): `{d, bias, p_output, ain, ain_status, deviation, status, samples, tokens_used, compute_ms}`. Public test without auth blocked, as expected.

**CORS:** `/compute` preflight from `Origin: https://zeropointlogic.io` returns `access-control-allow-origin: https://zeropointlogic.io`. Random `Origin: https://evil.example.com` returns 200 with NO `access-control-allow-origin` header (browser will block — correct behaviour). `null` origin also gets no allow header. Allowed methods: `GET,POST,OPTIONS`. Allowed headers: `authorization,content-type,accept`.

**Security headers:** HSTS, X-Content-Type-Options, X-Frame-Options, Cache-Control: no-store — all good.

**Error codes are consistent and actionable** — 401 points users at correct header shape, 415/422 name the missing field.

## MCP tools (67 registered = 63 unique + 4 aliases)

Structure verified against `src/tools/index.ts` plus core tools in `src/index.ts`:

| Category | Count | File | Status |
|---|---|---|---|
| Core | 9 | src/index.ts (compute, sweep, analyze, domains, health, plans, history, watchlist, report) | OK |
| Finance | 7 | src/tools/finance.ts | OK |
| Gaming | 6 | src/tools/gaming.ts | OK |
| AI/ML | 4 | src/tools/ai-ml.ts | OK |
| Security | 3 | src/tools/security.ts | OK |
| Crypto | 4 | src/tools/crypto.ts | OK |
| Universal | 8 (4 pairs: decide/balance_check, compare/balance_pair, rank/balance_rank, + check_response, explain) | src/tools/universal.ts | OK, aliases correctly wired to same handler |
| Meta | 8 | src/tools/meta.ts | OK |
| Advanced | 7 (versus + balance_compare alias, simulate, leaderboard, chart, teach, alert) | src/tools/advanced.ts | OK |
| Certification | 3 (debate, news_bias, review_bias) | src/tools/certification.ts | OK — `certify`/`auto_certify`/`predict`/`certificate` removed in v3.0 per code comment |
| AI Eval | 8 | src/tools/eval.ts | Requires ANTHROPIC_API_KEY |

Total registered tool count matches `zpl_about` copy and README ("67 total, 63 unique"). Counting function `server.tool(` call sites yielded 58 in tools/*.ts + 9 in index.ts = 67. Verified.

### Tools requiring ANTHROPIC_API_KEY (8 tools)

All are in `src/tools/eval.ts`:

- `zpl_consistency_test`
- `zpl_sycophancy_score`
- `zpl_refusal_balance`
- `zpl_language_equity`
- `zpl_persona_drift`
- `zpl_safety_boundary`
- `zpl_hallucination_consistency`
- `zpl_emotional_stability`

Error UX when key missing is **good**: explicit message, shows exact JSON config snippet, links to console.anthropic.com. The `checkAnthropicKey()` helper returns a friendly string; `eval-client.ts:callClaude` throws an Error with same guidance.

### Zod schemas vs engine HTTP contract

Sampled five tool schemas: `zpl_market_scan`, `zpl_portfolio`, `zpl_tokenomics`, `zpl_loot_table`, `zpl_check_response`. All convert user input into the engine's `{d, bias, samples}` triple via the helpers (`directionalBias`, `concentrationBias`, etc.) — no tool tries to pass fields the engine would reject.

### Dead tools / stale docs

- No dead tools detected — every MCP tool still maps to `/compute` or `/sweep` through the shared engine-client.
- `LANGUAGE` constant in `src/index.ts` line 64 reads `ZPL_LANGUAGE` but the value is never consumed anywhere. Dead. Low priority. See P2.

### README accuracy (MCP)

README claims 67 tools / 63 unique / 11 categories and the code agrees. Setup wizard instructions (§Setup) match `src/setup.ts`. Manual config block matches the env vars `src/env-keys.ts` actually reads (ZPL_API_KEY / ZPL_ENGINE_KEY). No P0/P1 issues.

## CLI commands (9)

Source: `C:\Dev\zpl-cli\src\commands\*.ts`. Verified every command file.

| Command | Help accurate | Error UX | Exit code OK |
|---|---|---|---|
| `zpl login` | Yes | Red message + exit 1 on start/approval failure | Yes |
| `zpl logout` | Yes | Idempotent — says "nothing to do" if no config | Yes (0) |
| `zpl whoami` | Yes | Gracefully handles `/api/user/me` 404 (shows config-only) | Yes |
| `zpl check <file>` | Yes | "File not found" + exit 1, "too short" + exit 1 | Yes |
| `zpl watch` | Yes | Clipboard init failure → clear message + install hint for xclip/wl-clipboard | Yes |
| `zpl consistency <question> --n <n>` | Yes | Clamps n to 2-20, aggregates pass failures | Yes |
| `zpl compare <a> <b>` | Yes | File-not-found per path | Yes |
| `zpl diff <before> <after>` | Yes | Same as compare | Yes |
| `zpl history` | Yes | "No history yet" hint if empty, never throws on corrupt file | Yes |

Top-level `dieFormatted` in `src/index.ts`:
- `ApiAuthError` → red line, exit 1 (message tells user to re-login)
- `ApiQuotaError` → yellow line, exit 1 (includes reset time when server provides it)
- `ApiNetworkError` → red line, exit 1
- Generic Error → red `Error: <msg>` + stack trace only if `--verbose`

No stack traces leak to stderr by default. Good. Exit codes always 1 on error (per Commander convention — consistent).

**`/api/user/me` endpoint may not exist yet** — `api-client.ts:me()` defensively returns `null` on non-auth failure. `whoami` falls back to config-only data with a grey "(remote endpoint not available)" row. Good degraded UX.

## i18n on MCP/CLI output

Currently English-only.

- MCP reads `ZPL_LANGUAGE` but the value is unused (dead code). All `formatResult`, `ainSignal` bands, tool descriptions, and the `zpl_about` body are hardcoded English.
- CLI has no language flag or env. Chalk formatting and all labels (`AIN`, `Verdict`, `Signal`, `Bias`, `Tokens`, `CONSISTENT`/`INCONSISTENT`, `improved`/`worsened`/`unchanged`) are hardcoded English.

Suggestion: add `ZPL_LANG` env (MCP) + `--lang` flag (CLI). Roughly 40-60 user-facing strings per product.

Token-estimate for full i18n work (EN + RO + DE + FR + ES): ~250-300 strings total, one translation file per lang (`src/i18n/en.json` etc.), small t() helper. Not a 2026-Q2 blocker.

## Findings

### P0 (broken / wrong)
None.

### P1 (user-visible correctness / polish)
- **CLI README said "SQLite log" / `history.db`** — but `src/db.ts` switched to JSON at commit `d965921` (v0.1.1). Fixed inline: README now says "history log" and `~/.zpl/history.json`.
- **CLI had 3 TypeScript errors on `statusColor(...).bold`** — return type was declared as `(s: string) => string` which drops chalk's `.bold` chained helper. `npx tsc --noEmit` failed before the fix. Fixed inline: typed as `ChalkInstance` in check.ts, diff.ts, watch.ts.

### P2 (technical debt, docs polish)
- **MCP `LANGUAGE` constant is dead code** — reads `ZPL_LANGUAGE` but nothing ever uses the value. Either wire it through tool descriptions/`ainSignal` bands or delete the declaration. Leaving as-is for now; documented.
- **CLI `getHistoryDbPath` was an unused export pointing at a non-existent `history.db`** — removed inline.
- **`/api/user/me` either add to engine or drop from CLI** — currently CLI has defensive fallback but `whoami` would be more useful if the endpoint existed. Not urgent.
- **i18n as above.**

## Fixed inline (this audit)

Committed in `zpl-cli` repo (remote `origin` → github.com/cicicalex/zpl-engine-cli):

1. `src/commands/check.ts` — typed `statusColor` as `ChalkInstance`, chalk import updated.
2. `src/commands/watch.ts` — same.
3. `src/commands/diff.ts` — same for the local `color` variable.
4. `src/config.ts` — removed unused `getHistoryDbPath()` pointing at wrong file extension.
5. `README.md` — corrected "SQLite" → "JSON" history description.

Typecheck: `npx tsc --noEmit` clean after fixes.

## Deferred (not changed)

- MCP `ZPL_LANGUAGE` dead code (P2).
- i18n rollout (P2).
- Engine `/about` public metadata endpoint — nice-to-have, low value (MCP provides `zpl_about`).
- `/api/user/me` endpoint for CLI `whoami` plan/quota — would unlock better quota display but not blocking.

## Engine latency sample (10 cold runs on /health)

```
0.056s  0.064s  0.072s  0.078s  0.086s
0.091s  0.096s  0.096s  0.116s  0.122s
```

p50 ≈ 89 ms, p95 ≈ 122 ms. Under target.
