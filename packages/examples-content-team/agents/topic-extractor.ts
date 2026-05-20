import { z } from "zod";
import { defineAgent } from "@snoopy/core";

const ArticleTopic = z.object({
  mainTopic: z.string().describe("Core subject in 3-8 words"),
  articleTitle: z.string().describe("The actual or inferred article title"),
  keyThemes: z.string().describe("Main themes and subtopics covered (2-4)"),
  searchQuerySuggestion: z.string().describe("Best search query for SEO research"),
});

export const topicExtractor = defineAgent({
  id: "content.topic-extract",
  role: "topic-extractor",
  // OpenAI for extraction — fast, reliable JSON output.
  // Override per-agent: this is exactly how Agno's original distinguishes
  // tool-calling models from writing models.
  model: "openai/gpt-5-mini",
  tools: [],
  result: ArticleTopic,
  prompt: (input: { content: string; title?: string }) => `
Analyze this article content and extract the main topic, title, key themes, and a search query suggestion.

${input.title ? `EXISTING TITLE: ${input.title}\n` : ""}
CONTENT (first 6000 chars):
${input.content.slice(0, 6000)}

Be specific. The search query you suggest will be used to drive SEO research, so it must match what users would actually search for.
`,
});
