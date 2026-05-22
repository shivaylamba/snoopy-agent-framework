import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineAgent, defineTrigger } from "@snoopy/core";
import { extractTextFromUrl } from "../tools/extract.js";

/**
 * Content-team workflow orchestrator — iii-primitive-direct.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  This handler uses iii primitives DIRECTLY via `ctx.iii`. There is no
 *  framework abstraction between this code and the iii engine.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Sub-agent invocation:
 *     await ctx.iii.trigger({ function_id: "content.serp-analyze", payload, timeoutMs });
 *
 *   State persistence:
 *     await ctx.iii.trigger({ function_id: "state::set",
 *                             payload: { scope, key, value } });
 *
 *   Anything iii exposes — registerFunction, registerTrigger, trigger with
 *   any action, state, streams, queues, cron, sandbox — is on `ctx.iii`.
 *
 *  What snoopy contributes here:
 *   - defineAgent → registers this handler as an iii Function via iii.registerFunction
 *   - defineTrigger → produces TriggerDef → iii.registerTrigger
 *   - dedupe gate (cached result in iii state)
 *   - role markdown discovery → system prompts
 *   - Zod structured-output parsing with auto-retry
 *   - trace span emission
 *   - the reasoning loop inside sub-agents that have `tools:`
 * ═══════════════════════════════════════════════════════════════════════════
 */

const WorkflowInput = z.object({
  topic: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  url: z.string().url().optional(),
});

const WorkflowOutput = z.object({
  mode: z.enum(["brief", "audit"]),
  searchQuery: z.string(),
  articleTitle: z.string().nullable(),
  reportsWritten: z.array(z.string()),
  runId: z.string(),
  summary: z.string(),
});

const REPORTS_DIR = join(process.cwd(), ".tmp/reports/content_seo");
const STATE_SCOPE = "content.workflow:runs"; // iii state scope for run records

export const contentSeoWorkflow = defineAgent<
  z.infer<typeof WorkflowInput>,
  z.infer<typeof WorkflowOutput>
>({
  id: "content.workflow",
  model: "openai/gpt-5-mini",
  tools: [extractTextFromUrl],
  triggers: [defineTrigger.http({ path: "/content-seo", method: "POST" })],
  dedupe: (p) => `${p.topic ?? ""}|${p.url ?? ""}|${p.title ?? ""}`,
  dedupeTtlSec: 60 * 10,

  handler: async (input, ctx) => {
    await mkdir(REPORTS_DIR, { recursive: true });

    // ── helper: persist a run-step record into iii state ─────────────────
    // Calls `state::set` DIRECTLY on the iii SDK exposed via ctx.iii. No
    // wrapping, no StateKV, no IIIStore — this is the standard iii primitive
    // surface that `iii worker add iii-state` provides. Survives engine
    // restart when iii-state is configured with `store_method: file_based`.
    const recordStep = async (step: string, data: Record<string, unknown>) => {
      await ctx.iii.trigger({
        function_id: "state::set",
        payload: {
          scope: STATE_SCOPE,
          key: `${ctx.runId}:${step}`,
          value: { step, data, ts: Date.now() },
        },
      }).catch(() => {}); // state worker missing? non-fatal — keep running
    };

    let articleText: string | undefined;
    let articleTitle: string | null = input.title ?? null;
    let isExisting = false;

    // ── Step 1: normalize inputs ────────────────────────────────────────
    if (input.url) {
      ctx.log.info("extracting URL content", { url: input.url });
      const r = await extractTextFromUrl.handler({ url: input.url });
      if ((r as any).text) {
        articleText = (r as any).text;
        isExisting = true;
      }
    }
    if (input.title && input.content) {
      articleTitle = input.title;
      articleText = input.content;
      isExisting = true;
    }
    if (!input.topic && !isExisting) {
      throw new Error("Provide one of: { topic } | { url } | { title, content }");
    }
    await recordStep("inputs-normalized", { hasUrl: !!input.url, hasContent: isExisting });

    // ── Step 2: topic extraction (only when we have raw content) ────────
    // Direct iii primitive — `iii.trigger({function_id, payload})`. Calling
    // another snoopy agent is just calling any iii function: it's registered
    // under the same engine and dispatched the same way as state::set.
    let searchQuery: string;
    if (isExisting && !input.topic) {
      ctx.log.info("extracting topic from article");
      const extracted = await ctx.iii.trigger<unknown, {
        mainTopic: string;
        articleTitle: string;
        keyThemes: string;
        searchQuerySuggestion: string;
      }>({
        function_id: "content.topic-extract",
        payload: { content: articleText, title: articleTitle ?? undefined },
        timeoutMs: 300_000,
      });
      searchQuery = extracted.searchQuerySuggestion;
      if (!articleTitle) articleTitle = extracted.articleTitle;
      await recordStep("topic-extracted", { searchQuery, articleTitle });
    } else {
      searchQuery = input.topic ?? articleTitle ?? "content optimization";
    }
    ctx.log.info("search query selected", { searchQuery });

    // ── Step 3: SERP research + analysis ────────────────────────────────
    ctx.log.info("running SERP analysis");
    const insights = await ctx.iii.trigger<unknown, {
      primaryKeywords: string;
      relatedKeywords: string;
      relatedQuestions: string;
      searchIntent: string;
      competitorAnalysis: string;
      aiOverviewSummary: string;
    }>({
      function_id: "content.serp-analyze",
      payload: { query: searchQuery },
      timeoutMs: 300_000,
    });
    await recordStep("serp-analyzed", { searchQuery, insightsKeys: Object.keys(insights) });

    const reportsWritten: string[] = [];

    // search_insights.md
    const insightsMd = renderInsights(searchQuery, articleTitle, insights);
    const insightsPath = join(REPORTS_DIR, "search_insights.md");
    await writeFile(insightsPath, insightsMd);
    reportsWritten.push(insightsPath);

    // ── Step 4: mode branch ─────────────────────────────────────────────
    if (isExisting) {
      ctx.log.info("auditing existing article");
      const audit = await ctx.iii.trigger<unknown, {
        contentStrengths: string;
        contentGaps: string;
        keywordOpportunities: string;
        structureImprovements: string;
        eeAtAssessment: string;
        missingSections: string;
        prioritizedRecommendations: string;
      }>({
        function_id: "content.article-audit",
        payload: {
          articleTitle: articleTitle ?? "Untitled",
          articleText: articleText!,
          insights,
        },
        timeoutMs: 300_000,
      });

      const auditPath = join(REPORTS_DIR, "article_audit.md");
      await writeFile(auditPath, renderAudit(articleTitle, audit));
      reportsWritten.push(auditPath);
      await recordStep("audit-complete", { auditPath });

      ctx.log.info("generating section rewrites");
      const edits = await ctx.iii.trigger<unknown, {
        improvedSections: string;
        keywordIntegrationSummary: string;
        changesExplanation: string;
      }>({
        function_id: "content.section-edits",
        payload: {
          articleTitle: articleTitle ?? "Untitled",
          articleText: articleText!,
          audit: {
            contentGaps: audit.contentGaps,
            keywordOpportunities: audit.keywordOpportunities,
            structureImprovements: audit.structureImprovements,
            prioritizedRecommendations: audit.prioritizedRecommendations,
          },
          insights: {
            primaryKeywords: insights.primaryKeywords,
            relatedKeywords: insights.relatedKeywords,
            relatedQuestions: insights.relatedQuestions,
          },
        },
        timeoutMs: 300_000,
      });

      const editsPath = join(REPORTS_DIR, "section_edits.md");
      await writeFile(editsPath, renderEdits(articleTitle, edits));
      reportsWritten.push(editsPath);
      await recordStep("section-edits-complete", { editsPath });

      const summary = `CONTENT SEO OPTIMIZATION COMPLETED

Article: ${articleTitle ?? "Untitled"}
Mode: Existing Article Optimization
Run ID: ${ctx.runId}

Reports Generated:
${reportsWritten.map((p) => `• ${p}`).join("\n")}

Key Improvements:
${audit.prioritizedRecommendations.slice(0, 300)}…

Query this run later:
  iii trigger state::get --json '{"scope":"${STATE_SCOPE}","key":"${ctx.runId}:audit-complete"}'`;

      // Final record so `state::list` returns this run as completed
      await recordStep("done", {
        mode: "audit",
        reportsWritten,
        articleTitle,
      });

      return {
        mode: "audit" as const,
        searchQuery,
        articleTitle,
        reportsWritten,
        runId: ctx.runId,
        summary,
      };
    }

    // Brief mode
    ctx.log.info("generating pre-writing content brief");
    const brief = await ctx.iii.trigger<unknown, {
      targetIntent: string;
      contentOutline: string;
      recommendedHeadings: string;
      keyEntitiesToMention: string;
      faqSuggestions: string;
      keywordPlacementGuidance: string;
      contentStructureRecommendations: string;
      writingGuidelines: string;
    }>({
      function_id: "content.brief",
      payload: { query: searchQuery, insights },
      timeoutMs: 300_000,
    });

    const briefPath = join(REPORTS_DIR, "content_brief.md");
    await writeFile(briefPath, renderBrief(searchQuery, brief));
    reportsWritten.push(briefPath);
    await recordStep("brief-complete", { briefPath });

    const summary = `CONTENT SEO BRIEF GENERATION COMPLETED

Topic: ${searchQuery}
Mode: Pre-Writing Content Brief
Run ID: ${ctx.runId}

Reports Generated:
${reportsWritten.map((p) => `• ${p}`).join("\n")}

Key Recommendations:
${brief.contentStructureRecommendations.slice(0, 300)}…

Query this run later:
  iii trigger state::get --json '{"scope":"${STATE_SCOPE}","key":"${ctx.runId}:brief-complete"}'

List all past runs:
  iii trigger state::list --json '{"scope":"${STATE_SCOPE}"}'`;

    await recordStep("done", { mode: "brief", reportsWritten });

    return {
      mode: "brief" as const,
      searchQuery,
      articleTitle: null,
      reportsWritten,
      runId: ctx.runId,
      summary,
    };
  },
});

// ─── markdown renderers ─────────────────────────────────────────────────────

function renderInsights(query: string, title: string | null, i: any): string {
  return `# Search Insights & Keyword Research

${title ? `**Article Title:** ${title}\n\n` : ""}**Search Query:** ${query}

## Primary Keywords
${i.primaryKeywords}

## Related Keywords
${i.relatedKeywords}

## Related Questions
${i.relatedQuestions}

## Search Intent
${i.searchIntent}

## Competitor Analysis
${i.competitorAnalysis}

## AI Overview Summary
${i.aiOverviewSummary}
`;
}

function renderAudit(title: string | null, a: any): string {
  return `# Article SEO Audit & Improvement Plan

**Article Title:** ${title ?? "Untitled"}

## Content Strengths
${a.contentStrengths}

## Content Gaps
${a.contentGaps}

## Keyword Opportunities
${a.keywordOpportunities}

## Structure Improvements
${a.structureImprovements}

## E-E-A-T Assessment
${a.eeAtAssessment}

## Missing Sections
${a.missingSections}

## Prioritized Recommendations
${a.prioritizedRecommendations}
`;
}

function renderEdits(title: string | null, e: any): string {
  return `# Optimized Section Rewrites

**Article Title:** ${title ?? "Untitled"}

## Improved Sections
${e.improvedSections}

## Keyword Integration Summary
${e.keywordIntegrationSummary}

## Changes Explanation
${e.changesExplanation}
`;
}

function renderBrief(query: string, b: any): string {
  return `# Content Brief & SEO Writing Guidelines

**Topic:** ${query}

## Target Intent
${b.targetIntent}

## Content Outline
${b.contentOutline}

## Recommended Headings
${b.recommendedHeadings}

## Key Entities to Mention
${b.keyEntitiesToMention}

## FAQ Suggestions
${b.faqSuggestions}

## Keyword Placement Guidance
${b.keywordPlacementGuidance}

## Content Structure Recommendations
${b.contentStructureRecommendations}

## Writing Guidelines
${b.writingGuidelines}
`;
}
