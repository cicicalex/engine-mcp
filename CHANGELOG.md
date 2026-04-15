# Changelog

All notable changes to `zpl-engine-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] — 2026-04-15

Onboarding tools + hard disclaimers + safety polish.

### Added
- `zpl_about` — project info, doc links, no auth required. Works before signup so new users can discover what the server does.
- `zpl_quota` — show remaining tokens this month plus reset date.
- `zpl_score_only` — minimal JSON output (`{ain, status}`) for CI/CD pipelines and programmatic consumers.
- `zpl_validate_input` — free input validation with no token cost. Sanity-check your payload before paying for a compute call.
- Auto-update check on startup (logs a hint when a newer version is available on npm).
- RNG sample-size warnings on `zpl_rng_test` when sample count is too small to draw reliable conclusions.

### Changed
- Signup message made friendlier for users without an API key.
- Hard disclaimers added to hypothetical/bias tools (`zpl_check_response`, `zpl_news_bias`, `zpl_review_bias`) clarifying that AIN measures *language balance*, not truth or factuality.
- Bias tools re-framed: language described as "language balance" instead of "fake/biased" to avoid moral-judgement framing.
- Tool count now **55** (up from 51).

## [3.1.0] — 2026-04-15

Observer-effect mitigation via runtime mode switch.

### Added
- `ZPL_MODE` environment variable with two values:
  - `pure` (default) — hides the raw AIN score from the AI on `zpl_check_response`, `zpl_news_bias`, and `zpl_review_bias`. The AI receives a verdict category only; the numeric score is surfaced to the user separately.
  - `coach` — exposes the AIN score to the AI on all tools (legacy behavior).

### Changed
- Text-evaluation tools now route through the mode check before returning. Rationale: when an AI sees "AIN = 42" in the tool result and then continues writing, its subsequent output can drift toward justifying the score. Pure mode breaks that feedback loop so stability measurements stay uncontaminated by downstream AI output.

## [3.0.0] — 2026-04-15 — BREAKING

Removed 5 tools that created false-authority risk. AIN is a STABILITY measurement only — never a prediction or a recommendation.

### Removed
- `zpl_ask` — accepted user-provided scores and returned "official AIN," which could be misrepresented as a ZPL endorsement of arbitrary user inputs. Replacement: `zpl_decide`, `zpl_compare`, `zpl_rank`.
- `zpl_certify` — generated "ZPL Certified" badges on arbitrary text. Scam-tool risk. Replacement: `zpl_check_response` (raw balance score, no certification claim).
- `zpl_certificate` — generated "Certificate IDs" and A+/F grades. Enabled forged ZPL endorsements. No replacement — manual review only.
- `zpl_predict` — name implied forecasting; users misused it for stock/lottery "predictions." Replacement: `zpl_chart` (historical visualization, no forecast).
- `zpl_auto_certify` — forced an AIN badge on every Claude response. Spam + false authority at scale. No replacement — explicit requests only.

### Changed
- Tool count **56 → 51**.
- IP Protection section in README expanded to make the scope of the v3.0 removals explicit.

## [2.3.0] — 2026-04-14

### Changed (security)
- Normalized filter input across all text-evaluation tools to defeat leet-speak bypass attempts (`h4ck`, `crypt0`, etc.).

## [2.2.0] — 2026-04-14

### Added
- `zpl_versus`, `zpl_simulate`, `zpl_certificate`, `zpl_predict`, `zpl_leaderboard`, `zpl_chart`, `zpl_teach`, `zpl_alert` — advanced tools.
- `zpl_check_response` — verify any text or AI response for bias.
- 5 certification tools (later consolidated; `zpl_certify`/`zpl_certificate`/`zpl_predict`/`zpl_auto_certify` were removed in 3.0).
- Package renamed to `zpl-engine-mcp` (no npm scope).
- IP protection section in README.

### Changed (security)
- All engine internals stripped from tool outputs. Responses now return `{ain, status, tokens_used}` only — no bias, deviation, p-output, dimension, or timing values.
- Blocked IP-extraction attempts in `zpl_ask` (removed entirely in 3.0).
- Smithery scanner support: `createSandboxServer` + stdin.isTTY detection so the server is scannable without leaking config at build time.

## [2.1.0] — 2026-04-13

### Added
- Full security hardening pass.
- Token sync between engine and frontend (tokens represent compute power, not currency).
- npm publish readiness: package metadata, keywords, files whitelist.
- `zpl_account` tool + enhanced `zpl_usage` dashboard with plan limits and reset date.
- 8 Smithery config options.
- Timeouts on all engine HTTP calls.
- Plan-based dimension caps enforced client-side (fail-fast before wasted tokens).

### Changed (security)
- Fixed all LOW-severity vulnerabilities reported by `npm audit`.
- Exponential backoff retry for transient engine failures (5xx only, never 4xx).

## [2.0.0] — 2026-04-12

### Added
- 41 tools across 7 domain lenses: Finance, Gaming, AI/ML, Security, Crypto, Certification, Universal.
- `zpl_ask` (universal AI), `zpl_history`, `zpl_watchlist`, `zpl_report`.

### Changed
- AIN range corrected to full engine precision 0.1–99.9 (was artificially clamped before).

## [1.0.0] — 2026-04-12

### Added
- Initial ZPL Engine MCP server: 6 tools, 5 domain lenses.

[3.2.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v3.2.0
[3.1.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v3.1.0
[3.0.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v3.0.0
[2.3.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v2.3.0
[2.2.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v2.2.0
[2.1.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v2.1.0
[2.0.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v2.0.0
[1.0.0]: https://github.com/cicicalex/engine-mcp/releases/tag/v1.0.0
