// Side-effect imports — each agent registers on iii at module load time.
import { topicExtractor } from "./agents/topic-extractor.js";
import { serpAnalyzer } from "./agents/serp-analyzer.js";
import { contentBriefAgent, articleAuditAgent } from "./agents/content-strategist.js";
import { seoEditor } from "./agents/seo-editor.js";
import { contentSeoWorkflow } from "./agents/workflow.js";

export default {
  agents: [
    topicExtractor,
    serpAnalyzer,
    contentBriefAgent,
    articleAuditAgent,
    seoEditor,
    contentSeoWorkflow,
  ],
};
