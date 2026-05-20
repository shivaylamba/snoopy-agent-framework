import { z } from "zod";
import { defineTool } from "@snoopy/core";

/**
 * URL → plain text. Original Agno project uses Trafilatura (Python).
 * Here we do a simple fetch + tag strip — fine for the demo. Production
 * would swap in @mozilla/readability for proper article extraction.
 */
export const extractTextFromUrl = defineTool({
  name: "extract_text_from_url",
  description: "Fetch a URL and extract its readable text content.",
  input: z.object({ url: z.string().url() }),
  idempotent: true,
  handler: async ({ url }) => {
    const res = await fetch(url, {
      headers: {
        "user-agent": "snoopy-content-team/0.1 (+https://github.com/snoopy-diffie)",
        accept: "text/html",
      },
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    return { text: htmlToText(html).slice(0, 20_000) };
  },
});

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
