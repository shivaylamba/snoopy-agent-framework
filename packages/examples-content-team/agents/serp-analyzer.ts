import { z } from "zod";
import { defineAgent } from "@snoopy/core";
import { googleAiModeSearch, googleAiOverviewSearch } from "../tools/serp.js";

const SearchInsights = z.object({
  primaryKeywords: z.string(),
  relatedKeywords: z.string(),
  relatedQuestions: z.string(),
  searchIntent: z.string(),
  competitorAnalysis: z.string(),
  aiOverviewSummary: z.string(),
});

/**
 * Merges the original Agno "Search Insights Agent" + "SERP Analysis Agent"
 * into one. With snoopy we can do both jobs in a single loop: the model
 * calls the search tools (via iii), then synthesizes the structured output.
 */
export const serpAnalyzer = defineAgent({
  id: "content.serp-analyze",
  role: "serp-analyzer",
  // OpenAI for tool calling — Nebius Qwen3 Instruct refused to call tools
  // reliably; OpenAI's function-calling is more deterministic. The Agno
  // original used Moonshot K2-Instruct (now retired) for this role.
  model: "openai/gpt-5-mini",
  tools: [googleAiModeSearch, googleAiOverviewSearch],
  result: SearchInsights,
  maxTurns: 6,
  prompt: (input: { query: string }) => `
You are an expert SEO researcher. Run SERP research and produce structured keyword insights for:

QUERY: ${input.query}

Step 1: Call google_ai_mode_search with the query.
Step 2: Call google_ai_overview_search with the query.
Step 3: From the combined results, synthesize:
  - PRIMARY KEYWORDS: terms appearing in titles, snippets, and the AI Overview
  - RELATED KEYWORDS: semantic variations and clusters
  - RELATED QUESTIONS: from "Related Questions" and "People Also Ask"
  - SEARCH INTENT: informational / commercial / navigational / transactional
  - COMPETITOR ANALYSIS: what top-ranking results cover and angles they take
  - AI OVERVIEW SUMMARY: what Google's AI Overview emphasizes

Be comprehensive and actionable.
`,
});
