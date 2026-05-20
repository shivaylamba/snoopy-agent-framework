import { z } from "zod";
import { defineAgent } from "@snoopy/core";

const SectionEdits = z.object({
  improvedSections: z.string(),
  keywordIntegrationSummary: z.string(),
  changesExplanation: z.string(),
});

export const seoEditor = defineAgent({
  id: "content.section-edits",
  role: "seo-editor",
  // Same as Agno original — Llama Nemotron Ultra via Nebius for writing.
  model: "nebius/nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
  tools: [],
  result: SectionEdits,
  prompt: (input: {
    articleTitle: string;
    articleText: string;
    audit: { contentGaps: string; keywordOpportunities: string; structureImprovements: string; prioritizedRecommendations: string };
    insights: { primaryKeywords: string; relatedKeywords: string; relatedQuestions: string };
  }) => `
Rewrite the most impactful sections of this article for SEO without changing its voice or core message.

TITLE: ${input.articleTitle}

FULL CONTENT:
${input.articleText}

AUDIT FINDINGS:
- Content Gaps: ${input.audit.contentGaps}
- Keyword Opportunities: ${input.audit.keywordOpportunities}
- Structure Improvements: ${input.audit.structureImprovements}
- Prioritized Recommendations: ${input.audit.prioritizedRecommendations}

SEARCH INSIGHTS:
- Primary Keywords: ${input.insights.primaryKeywords}
- Related Keywords: ${input.insights.relatedKeywords}
- Related Questions: ${input.insights.relatedQuestions}

Produce:
1. IMPROVED SECTIONS: rewrite the highest-impact sections with markdown headings; preserve the author's voice
2. KEYWORD INTEGRATION SUMMARY: where each new keyword landed
3. CHANGES EXPLANATION: why each change improves SEO potential
`,
});
