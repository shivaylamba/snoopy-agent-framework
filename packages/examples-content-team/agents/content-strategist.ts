import { z } from "zod";
import { defineAgent } from "@snoopy/core";

const ContentBrief = z.object({
  targetIntent: z.string(),
  contentOutline: z.string(),
  recommendedHeadings: z.string(),
  keyEntitiesToMention: z.string(),
  faqSuggestions: z.string(),
  keywordPlacementGuidance: z.string(),
  contentStructureRecommendations: z.string(),
  writingGuidelines: z.string(),
});

const ArticleAudit = z.object({
  contentStrengths: z.string(),
  contentGaps: z.string(),
  keywordOpportunities: z.string(),
  structureImprovements: z.string(),
  eeAtAssessment: z.string(),
  missingSections: z.string(),
  prioritizedRecommendations: z.string(),
});

/**
 * The original Agno code mutates `content_strategist_agent.instructions`
 * at runtime to switch between brief mode and audit mode. With snoopy
 * we use two markdown skills (`content-brief.md`, `article-audit.md`)
 * and pick one via session.skill() inside the orchestrator. This agent
 * is the brief side; the audit side lives in `seo-editor.ts` as
 * `content.article-audit` because the data shape differs.
 *
 * Two payload shapes:
 *  - { mode: "brief", query, insights }     → ContentBrief
 *  - { mode: "audit", query, insights,
 *      articleTitle, articleText }          → ArticleAudit
 */
export const contentBriefAgent = defineAgent({
  id: "content.brief",
  role: "content-strategist",
  // Same as Agno original — Llama Nemotron Ultra via Nebius for writing.
  model: "nebius/nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
  tools: [],
  result: ContentBrief,
  prompt: (input: { query: string; insights: Record<string, string> }) => `
Create a comprehensive content brief for writing an SEO-optimized article on:

TOPIC: ${input.query}

SEARCH INSIGHTS:
- Primary Keywords: ${input.insights.primaryKeywords}
- Related Keywords: ${input.insights.relatedKeywords}
- Related Questions: ${input.insights.relatedQuestions}
- Search Intent: ${input.insights.searchIntent}
- Competitor Analysis: ${input.insights.competitorAnalysis}
- AI Overview: ${input.insights.aiOverviewSummary}

Provide a detailed brief covering:
1. Target intent
2. Content outline (sections + scope)
3. Recommended heading hierarchy (H1, H2, H3)
4. Key entities to mention (people, places, products, concepts)
5. FAQ suggestions based on related questions
6. Keyword placement guidance (title, first paragraph, headings)
7. Content structure recommendations (length, format, schema)
8. Writing guidelines (tone, do's and don'ts)
`,
});

export const articleAuditAgent = defineAgent({
  id: "content.article-audit",
  role: "content-strategist",
  // Same as Agno original — Llama Nemotron Ultra via Nebius for writing.
  model: "nebius/nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
  tools: [],
  result: ArticleAudit,
  prompt: (input: {
    articleTitle: string;
    articleText: string;
    insights: Record<string, string>;
  }) => `
Audit this existing article against the SERP insights and produce a prioritized improvement plan.

ARTICLE TITLE: ${input.articleTitle}

ARTICLE CONTENT (up to 12k chars):
${input.articleText.slice(0, 12_000)}

SEARCH INSIGHTS:
- Primary Keywords: ${input.insights.primaryKeywords}
- Related Keywords: ${input.insights.relatedKeywords}
- Related Questions: ${input.insights.relatedQuestions}
- Search Intent: ${input.insights.searchIntent}
- Competitor Analysis: ${input.insights.competitorAnalysis}
- AI Overview: ${input.insights.aiOverviewSummary}

Audit areas:
1. Content strengths (what the article does well)
2. Content gaps (missing topics, sections, depth)
3. Keyword opportunities (terms underused or missing)
4. Structure improvements (headings, scannability, length)
5. E-E-A-T assessment (Experience, Expertise, Authoritativeness, Trustworthiness)
6. Missing sections that top-ranking competitors include
7. Prioritized recommendations (rank by impact × ease)
`,
});
