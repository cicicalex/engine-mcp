/**
 * Universal tools — 4 tools for any question/decision.
 * (zpl_ask already exists in index.ts, these are additional)
 */

import { z } from "zod";
import type { Server } from "./helpers.js";
import { distributionBias, clampD, ainSignal } from "./helpers.js";
import { ZPLEngineClient } from "../engine-client.js";
import { addHistory } from "../store.js";

export function registerUniversalTools(server: Server, getClient: () => ZPLEngineClient) {

  // --- zpl_decide: quick 2-option decision ---
  server.tool(
    "zpl_decide",
    "Quick decision helper for 2 options. Simpler than zpl_ask — just name two options and their pros/cons scores. Perfect for 'should I do A or B?' questions.",
    {
      question: z.string().describe("The decision question"),
      option_a: z.string().describe("First option name"),
      option_b: z.string().describe("Second option name"),
      a_pros: z.number().min(0).max(10).describe("Option A overall pros score (0-10)"),
      a_cons: z.number().min(0).max(10).describe("Option A overall cons score (0-10, higher = more cons)"),
      b_pros: z.number().min(0).max(10).describe("Option B overall pros score"),
      b_cons: z.number().min(0).max(10).describe("Option B overall cons score"),
    },
    async ({ question, option_a, option_b, a_pros, a_cons, b_pros, b_cons }) => {
      try {
        const client = getClient();

        // Option A: balance between pros and cons
        const a_scores = [a_pros, 10 - a_cons, (a_pros + (10 - a_cons)) / 2];
        const b_scores = [b_pros, 10 - b_cons, (b_pros + (10 - b_cons)) / 2];

        const paramA = { d: 3, bias: distributionBias(a_scores), samples: 1000 };
        const paramB = { d: 3, bias: distributionBias(b_scores), samples: 1000 };

        const [resultA, resultB] = await Promise.all([
          client.compute(paramA),
          client.compute(paramB),
        ]);

        const ainA = Math.round(resultA.ain * 100);
        const ainB = Math.round(resultB.ain * 100);

        let text = `## ${question}\n\n`;
        text += `| | ${option_a} | ${option_b} |\n`;
        text += `|---|---|---|\n`;
        text += `| Pros | ${a_pros}/10 | ${b_pros}/10 |\n`;
        text += `| Cons | ${a_cons}/10 | ${b_cons}/10 |\n`;
        text += `| **AIN** | **${ainA}/100** | **${ainB}/100** |\n`;
        text += `| Signal | ${ainSignal(ainA)} | ${ainSignal(ainB)} |\n`;

        const diff = Math.abs(ainA - ainB);
        const winner = ainA > ainB ? option_a : ainB > ainA ? option_b : "Tie";

        if (diff <= 5) text += `\n**Result:** Practically equal. Go with your gut.\n`;
        else if (diff <= 15) text += `\n**Result:** **${winner}** is slightly more balanced (${Math.max(ainA, ainB)} vs ${Math.min(ainA, ainB)}).\n`;
        else text += `\n**Result:** **${winner}** is clearly the more balanced choice.\n`;

        text += `**Tokens:** ${resultA.tokens_used + resultB.tokens_used}`;

        addHistory({ tool: "zpl_decide", results: { question }, ain_scores: { [option_a]: ainA, [option_b]: ainB } });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // --- zpl_compare: structured comparison ---
  server.tool(
    "zpl_compare",
    "Structured comparison of 2 items on the same criteria. Provide scores for both items across multiple dimensions. Returns which is more mathematically balanced.",
    {
      item_a: z.string().describe("First item name"),
      item_b: z.string().describe("Second item name"),
      criteria: z.array(z.object({
        name: z.string(),
        score_a: z.number().min(0).max(10),
        score_b: z.number().min(0).max(10),
      })).min(3).max(20).describe("Comparison criteria with scores for both items"),
    },
    async ({ item_a, item_b, criteria }) => {
      try {
        const client = getClient();
        const scoresA = criteria.map((c) => c.score_a);
        const scoresB = criteria.map((c) => c.score_b);
        const d = clampD(criteria.length);

        const biasA = distributionBias(scoresA);
        const biasB = distributionBias(scoresB);

        const [resultA, resultB] = await Promise.all([
          client.compute({ d, bias: biasA, samples: 1000 }),
          client.compute({ d, bias: biasB, samples: 1000 }),
        ]);

        const ainA = Math.round(resultA.ain * 100);
        const ainB = Math.round(resultB.ain * 100);

        let text = `## ${item_a} vs ${item_b}\n\n`;
        text += `| Criteria | ${item_a} | ${item_b} |\n|----------|---|---|\n`;
        for (const c of criteria) {
          text += `| ${c.name} | ${c.score_a}/10 | ${c.score_b}/10 |\n`;
        }
        text += `| **AIN** | **${ainA}** | **${ainB}** |\n`;

        const winner = ainA > ainB ? item_a : ainB > ainA ? item_b : "Tie";
        text += `\n**More balanced:** ${winner}\n`;
        text += `**Tokens:** ${resultA.tokens_used + resultB.tokens_used}`;

        addHistory({ tool: "zpl_compare", results: { item_a, item_b }, ain_scores: { [item_a]: ainA, [item_b]: ainB } });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // --- zpl_rank: rank N options by AIN ---
  server.tool(
    "zpl_rank",
    "Rank multiple options by mathematical balance. Provide a list of options with their attribute scores. Returns AIN-ranked list from most to least balanced.",
    {
      options: z.array(z.object({
        name: z.string(),
        scores: z.array(z.number().min(0).max(10)).min(3).describe("Attribute scores (0-10)"),
      })).min(2).max(20).describe("Options to rank"),
      attributes: z.array(z.string()).optional().describe("Attribute names (for table headers)"),
    },
    async ({ options, attributes }) => {
      try {
        const client = getClient();
        const results: { name: string; ain: number; tokens: number }[] = [];

        for (const opt of options) {
          const d = clampD(opt.scores.length);
          const bias = distributionBias(opt.scores);
          const r = await client.compute({ d, bias, samples: 1000 });
          results.push({ name: opt.name, ain: Math.round(r.ain * 100), tokens: r.tokens_used });
        }

        results.sort((a, b) => b.ain - a.ain);
        let text = `## AIN Ranking\n\n`;
        text += `| Rank | Option | AIN | Signal |\n|------|--------|-----|--------|\n`;
        for (let i = 0; i < results.length; i++) {
          text += `| ${i + 1} | ${results[i].name} | ${results[i].ain}/100 | ${ainSignal(results[i].ain)} |\n`;
        }

        text += `\n**Best:** ${results[0].name} (${results[0].ain}) | **Worst:** ${results[results.length - 1].name} (${results[results.length - 1].ain})\n`;
        text += `**Tokens:** ${results.reduce((s, r) => s + r.tokens, 0)}`;

        const scores: Record<string, number> = {};
        for (const r of results) scores[r.name] = r.ain;
        addHistory({ tool: "zpl_rank", results: { options: options.map((o) => o.name) }, ain_scores: scores });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // --- zpl_explain: explain AIN for any context ---
  server.tool(
    "zpl_explain",
    "Explain what an AIN score means in a specific context. Provide a score and context, get a human-readable interpretation of what that neutrality level means for your domain.",
    {
      ain_score: z.number().min(0).max(100).describe("AIN score to explain"),
      context: z.string().describe("Context for explanation (e.g. 'game economy', 'stock portfolio', 'AI model', 'hiring process')"),
    },
    async ({ ain_score, context }) => {
      const signal = ainSignal(ain_score);
      let meaning: string;
      let analogy: string;
      let action: string;

      if (ain_score >= 80) {
        meaning = `In ${context}: Exceptional neutrality. All factors are balanced — no dominant element distorts the system.`;
        analogy = `Like a perfectly weighted coin — no bias toward any outcome.`;
        action = `No corrective action needed. This is the gold standard.`;
      } else if (ain_score >= 60) {
        meaning = `In ${context}: Good balance with minor deviations. The system leans slightly but remains functional and fair.`;
        analogy = `Like a slightly warm room — not perfect but comfortable for everyone.`;
        action = `Monitor for drift. Small adjustments may improve long-term stability.`;
      } else if (ain_score >= 40) {
        meaning = `In ${context}: Noticeable imbalance. Some elements are clearly stronger or weaker than others.`;
        analogy = `Like a team where 2 players carry everyone — functional but fragile.`;
        action = `Review the weakest factors. Targeted improvements will have big impact.`;
      } else if (ain_score >= 20) {
        meaning = `In ${context}: Significant bias. The system strongly favors certain outcomes over others.`;
        analogy = `Like a loaded die — results look random but consistently favor one side.`;
        action = `Major rebalancing needed. Current state creates unfair or unstable conditions.`;
      } else {
        meaning = `In ${context}: Extreme bias. The system is effectively broken — one element dominates everything.`;
        analogy = `Like a monopoly — one player owns the board, others can't compete.`;
        action = `Emergency intervention required. System is non-functional for its intended purpose.`;
      }

      const text = [
        `## AIN ${ain_score}/100 — ${signal}`,
        ``,
        `**Context:** ${context}`,
        ``,
        `### What it means`,
        meaning,
        ``,
        `### Analogy`,
        analogy,
        ``,
        `### Recommended action`,
        action,
        ``,
        `---`,
        `*AIN (AI Neutrality Index) measures mathematical balance on a scale from 0.1 (extreme bias) to 99.9 (perfect neutrality). Computed by the ZPL Engine at engine.zeropointlogic.io.*`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
