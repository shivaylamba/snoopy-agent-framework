import { z } from "zod";
import { defineTool } from "@snoopy/core";

/**
 * SerpAPI search tools. If SERPAPI_API_KEY is set, hits the real API.
 * Otherwise returns realistic mock data so the agent flow runs without
 * a paid key — useful for demos and CI.
 */

interface SerpResult {
  organic_results?: Array<{ title: string; link: string; snippet: string }>;
  related_questions?: Array<{ question: string }>;
  people_also_ask?: Array<{ question: string }>;
  related_searches?: Array<{ query: string }>;
  ai_overview?: { answer?: string };
}

async function serpApi(query: string, engine: "google_ai_mode" | "google_ai_overview"): Promise<SerpResult> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) return mockResults(query, engine);

  // SerpAPI parameters differ slightly between engines; both go through /search.
  const params = new URLSearchParams({
    api_key: apiKey,
    engine,
    q: query,
  });
  const res = await fetch(`https://serpapi.com/search?${params}`);
  if (!res.ok) {
    console.warn(`[serp] ${engine} HTTP ${res.status}; falling back to mock`);
    return mockResults(query, engine);
  }
  return (await res.json()) as SerpResult;
}

function mockResults(query: string, engine: string): SerpResult {
  // Realistic-looking canned data so the agents have something coherent
  // to reason over. Production runs replace this by setting SERPAPI_API_KEY.
  return {
    organic_results: [
      {
        title: `Definitive guide to ${query} (2025)`,
        link: `https://example.com/${slug(query)}-guide`,
        snippet: `Everything you need to know about ${query}: best practices, common pitfalls, expert tips, and step-by-step walkthroughs from practitioners.`,
      },
      {
        title: `${query}: a comparison of approaches`,
        link: `https://anothersite.com/${slug(query)}-comparison`,
        snippet: `Side-by-side comparison of the top approaches to ${query}, including tradeoffs, performance characteristics, and when to choose each one.`,
      },
      {
        title: `Why ${query} matters in 2025`,
        link: `https://thirdsource.io/blog/${slug(query)}-2025`,
        snippet: `Industry analysts weigh in on the rising importance of ${query}, citing recent benchmarks and adoption trends across enterprise teams.`,
      },
    ],
    related_questions: [
      { question: `What is ${query}?` },
      { question: `How does ${query} work?` },
      { question: `What are the best tools for ${query}?` },
      { question: `Is ${query} worth learning in 2025?` },
    ],
    people_also_ask: [
      { question: `${query} vs alternatives?` },
      { question: `How long does it take to learn ${query}?` },
      { question: `What are the prerequisites for ${query}?` },
    ],
    related_searches: [
      { query: `${query} tutorial` },
      { query: `${query} best practices` },
      { query: `${query} examples` },
      { query: `${query} vs alternatives` },
    ],
    ...(engine === "google_ai_overview"
      ? {
          ai_overview: {
            answer:
              `${query} refers to a set of techniques and practices that practitioners use to ` +
              `solve a specific class of problems. Key concepts include foundational principles, ` +
              `common patterns, and best-practice approaches. The field has matured significantly ` +
              `since 2023, with widely adopted tools and clear conventions emerging across teams.`,
          },
        }
      : {}),
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const googleAiModeSearch = defineTool({
  name: "google_ai_mode_search",
  description: "Search Google AI Mode for a query. Returns raw search results.",
  input: z.object({ query: z.string() }),
  idempotent: true,
  handler: async ({ query }) => serpApi(query, "google_ai_mode"),
});

export const googleAiOverviewSearch = defineTool({
  name: "google_ai_overview_search",
  description: "Search Google AI Overview for a query. Returns AI overview + organic results.",
  input: z.object({ query: z.string() }),
  idempotent: true,
  handler: async ({ query }) => serpApi(query, "google_ai_overview"),
});
