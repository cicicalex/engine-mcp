/**
 * Meta tools — 3 utility tools for batch, export, and usage tracking.
 */

import { z } from "zod";
import type { Server } from "./helpers.js";
import { clampD, ainSignal } from "./helpers.js";
import { ZPLEngineClient } from "../engine-client.js";
import { getHistory, addHistory } from "../store.js";

export function registerMetaTools(server: Server, getClient: () => ZPLEngineClient) {

  // --- zpl_batch: run multiple computations at once ---
  server.tool(
    "zpl_batch",
    "Run multiple ZPL Engine computations in a single call. Provide an array of (d, bias) pairs. Returns all AIN scores. Efficient for bulk analysis.",
    {
      jobs: z.array(z.object({
        label: z.string().describe("Label for this computation"),
        d: z.number().int().min(3).max(100),
        bias: z.number().min(0).max(1),
        samples: z.number().int().min(100).max(50000).optional(),
      })).min(1).max(50).describe("Computation jobs"),
    },
    async ({ jobs }) => {
      try {
        const client = getClient();
        let text = `## Batch Results (${jobs.length} jobs)\n\n`;
        text += `| # | Label | d | Bias | AIN | Status | Tokens |\n`;
        text += `|---|-------|---|------|-----|--------|--------|\n`;

        let totalTokens = 0;
        const scores: Record<string, number> = {};

        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i];
          try {
            const result = await client.compute({
              d: job.d,
              bias: job.bias,
              samples: job.samples ?? 1000,
            });
            const ain = Math.round(result.ain * 100);
            totalTokens += result.tokens_used;
            scores[job.label] = ain;
            text += `| ${i + 1} | ${job.label} | ${job.d} | ${job.bias.toFixed(2)} | ${ain}/100 | ${result.ain_status} | ${result.tokens_used} |\n`;
          } catch (err) {
            text += `| ${i + 1} | ${job.label} | ${job.d} | ${job.bias.toFixed(2)} | ERROR | ${(err as Error).message.slice(0, 30)} | 0 |\n`;
          }
        }

        text += `\n**Total tokens:** ${totalTokens}`;
        addHistory({ tool: "zpl_batch", results: { job_count: jobs.length }, ain_scores: scores });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // --- zpl_export: export history as structured data ---
  server.tool(
    "zpl_export",
    "Export ZPL analysis history as structured JSON or CSV-formatted text. Useful for creating reports or importing into spreadsheets.",
    {
      format: z.enum(["json", "csv"]).default("csv").describe("Export format"),
      limit: z.number().int().min(1).max(500).optional().default(50).describe("Number of entries to export"),
    },
    async ({ format, limit }) => {
      const history = getHistory(limit);
      if (history.length === 0) {
        return { content: [{ type: "text" as const, text: "No history to export." }] };
      }

      if (format === "json") {
        return { content: [{ type: "text" as const, text: "```json\n" + JSON.stringify(history, null, 2) + "\n```" }] };
      }

      // CSV format
      let csv = "id,timestamp,tool,question,domain,ain_scores\n";
      for (const h of history) {
        const scores = Object.entries(h.ain_scores).map(([k, v]) => `${k}:${v}`).join(";");
        csv += `${h.id},${h.timestamp},${h.tool},"${(h.question ?? "").replace(/"/g, '""')}",${h.domain ?? ""},${scores}\n`;
      }

      return { content: [{ type: "text" as const, text: "```csv\n" + csv + "```\n\n" + `Exported ${history.length} entries.` }] };
    }
  );

  // --- zpl_usage: token usage estimation ---
  server.tool(
    "zpl_usage",
    "Estimate token usage and remaining budget. Shows how many tokens you've used in history, estimated monthly usage, and what operations you can still do with remaining tokens.",
    {
      monthly_limit: z.number().optional().describe("Your monthly token limit (check your plan). Free=5000, Basic=10000, Pro=50000."),
    },
    async ({ monthly_limit }) => {
      const history = getHistory(500);
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Count tokens from history this month
      let monthTokens = 0;
      let totalTokens = 0;
      let monthOps = 0;

      for (const h of history) {
        const results = h.results as Record<string, unknown>;
        const tokens = typeof results.totalTokens === "number" ? results.totalTokens : 0;
        totalTokens += tokens;
        if (new Date(h.timestamp) >= monthStart) {
          monthTokens += tokens;
          monthOps++;
        }
      }

      const limit = monthly_limit ?? 5000;
      const remaining = Math.max(0, limit - monthTokens);

      let text = `## Token Usage\n\n`;
      text += `| Metric | Value |\n|--------|-------|\n`;
      text += `| This month ops | ${monthOps} |\n`;
      text += `| This month tokens (est.) | ~${monthTokens} |\n`;
      text += `| Monthly limit | ${limit.toLocaleString()} |\n`;
      text += `| Remaining (est.) | ~${remaining.toLocaleString()} |\n`;
      text += `| All-time ops | ${history.length} |\n`;

      text += `\n### What you can do with ${remaining} tokens:\n\n`;
      text += `| Operation | Token Cost | Count |\n|-----------|-----------|-------|\n`;
      text += `| Compute (d=3) | 12 | ${Math.floor(remaining / 12)} |\n`;
      text += `| Compute (d=9) | 90 | ${Math.floor(remaining / 90)} |\n`;
      text += `| Compute (d=16) | 272 | ${Math.floor(remaining / 272)} |\n`;
      text += `| Sweep (d=9) | 1,710 | ${Math.floor(remaining / 1710)} |\n`;

      text += `\n*Note: Token tracking is estimated from local history. Check engine dashboard for exact usage.*`;

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
