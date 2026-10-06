/**
 * CHISMOSO V1.3 — MCP Prompt Templates (Task MCP-1)
 *
 * MCP prompts are reusable templates that a client (Claude Desktop, Cursor,
 * Continue.dev) can surface in its UI as "slash commands". Each template
 * takes named arguments, gets rendered server-side, and returns one or more
 * MCP `messages` (typically a single `user` role message).
 *
 * Three prompts are exposed:
 *
 *   investigate_topic(topic, geography?)
 *     → renders a prompt asking the LLM to call `chismoso_investigate` and
 *       summarise the result for the user.
 *
 *   compare_topics(topicA, topicB)
 *     → renders a prompt asking the LLM to call `chismoso_get_topic_history`
 *       for both topics and produce a side-by-side comparison.
 *
 *   deep_dive_opportunity(investigationId, opportunityIndex)
 *     → renders a prompt asking the LLM to fetch a specific opportunity and
 *       produce a deep-dive analysis (validation steps, competitors, ICP,
 *       monetisation, GTM).
 *
 * Why prompt templates live server-side:
 *   - Single source of truth — every MCP client gets the same prompt content
 *     regardless of vendor.
 *   - Server-side composition — the prompt can reference tool names that the
 *     server also exposes, keeping the conversation coherent.
 *   - Discoverability — `prompts/list` enumerates them so the client UI can
 *     present them as click-to-run commands.
 */

import type { ChismosoMCPServerDeps } from './tools.js';
import { getLatestInvestigationId } from './tools.js';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
  /**
   * Render the prompt given the arguments provided by the client. Returns
   * an array of MCP messages (typically just one user-role message).
   *
   * Missing required arguments cause a thrown Error — `server.ts` will
   * convert it to an MCP error response.
   */
  render(
    args: Record<string, string>,
    deps: ChismosoMCPServerDeps,
  ): Promise<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[]>;
}

// ---------------------------------------------------------------------------
// PROMPT 1: investigate_topic
// ---------------------------------------------------------------------------

const investigateTopicPrompt: McpPrompt = {
  name: 'investigate_topic',
  description:
    'Launch a CHISMOSO investigation on the given topic. The rendered prompt asks ' +
    'the LLM to call the `chismoso_investigate` tool and summarise the resulting ' +
    'trends, problems, and opportunities in plain language for the user.',
  arguments: [
    {
      name: 'topic',
      description: 'Research question or topic, e.g. "restaurant automation in Colombia".',
      required: true,
    },
    {
      name: 'geography',
      description: 'Geographic scope (default: "global").',
      required: false,
    },
  ],
  async render(args, _deps) {
    const topic = (args?.topic ?? '').trim();
    if (!topic) throw new Error('Argument "topic" is required for prompt investigate_topic');
    const geography = (args?.geography ?? '').trim() || 'global';

    const text = [
      `Please research the following topic using CHISMOSO:`,
      ``,
      `Topic: ${topic}`,
      `Geography: ${geography}`,
      ``,
      `Steps:`,
      `1. Call the \`chismoso_investigate\` tool with objective="${topic}" and geography="${geography}".`,
      `   This may take 1–5 minutes — wait for it to complete.`,
      `2. Once it returns, summarise the results for me as a human-readable brief:`,
      `   - The top 3 trends (with state + score).`,
      `   - The most severe problem detected (with severity score).`,
      `   - The top opportunity by score (with the scoring breakdown).`,
      `   - The recommended next action.`,
      `3. End with 3 bullet-point "next steps" an operator could take based on the findings.`,
      ``,
      `Do NOT invent data — only report what the tool returned. If the tool fails or returns ` +
      `INSUFFICIENT_EVIDENCE, explain what that means and suggest alternative angles to try.`,
    ].join('\n');

    return [{ role: 'user', content: { type: 'text', text } }];
  },
};

// ---------------------------------------------------------------------------
// PROMPT 2: compare_topics
// ---------------------------------------------------------------------------

const compareTopicsPrompt: McpPrompt = {
  name: 'compare_topics',
  description:
    'Compare two topics side-by-side using their CHISMOSO observation history. ' +
    'The LLM is asked to fetch `chismoso_get_topic_history` for both topics and ' +
    'produce a comparative analysis: which is growing faster, which has more ' +
    'confidence, which has anomalies, etc.',
  arguments: [
    {
      name: 'topicA',
      description: 'First topic to compare (must be an exact canonical topic string).',
      required: true,
    },
    {
      name: 'topicB',
      description: 'Second topic to compare.',
      required: true,
    },
  ],
  async render(args, _deps) {
    const topicA = (args?.topicA ?? '').trim();
    const topicB = (args?.topicB ?? '').trim();
    if (!topicA) throw new Error('Argument "topicA" is required');
    if (!topicB) throw new Error('Argument "topicB" is required');

    const text = [
      `Please compare two topics using their CHISMOSO observation history:`,
      ``,
      `Topic A: ${topicA}`,
      `Topic B: ${topicB}`,
      ``,
      `Steps:`,
      `1. Call \`chismoso_get_topic_history\` with topic="${topicA}" and limit=20.`,
      `2. Call \`chismoso_get_topic_history\` with topic="${topicB}" and limit=20.`,
      `3. Call \`chismoso_list_anomalies\` with topic="${topicA}".`,
      `4. Call \`chismoso_list_anomalies\` with topic="${topicB}".`,
      `5. Produce a comparison table with these rows:`,
      `   - Total observations`,
      `   - Latest signals_count`,
      `   - Latest confidence`,
      `   - Active anomalies (count + types)`,
      `   - Velocity trend (increasing / flat / declining)`,
      `6. Conclude with a paragraph stating which topic shows stronger momentum and why.`,
      ``,
      `Only use data returned by the tools. If a topic has no history, say so explicitly.`,
    ].join('\n');

    return [{ role: 'user', content: { type: 'text', text } }];
  },
};

// ---------------------------------------------------------------------------
// PROMPT 3: deep_dive_opportunity
// ---------------------------------------------------------------------------

const deepDiveOpportunityPrompt: McpPrompt = {
  name: 'deep_dive_opportunity',
  description:
    'Deep-dive on a specific opportunity identified in an investigation. ' +
    'The LLM is asked to fetch the investigation, pick the Nth opportunity, and ' +
    'produce a structured deep-dive: validation steps, competitors, ICP, ' +
    'monetisation options, and GTM plan. If opportunityIndex is omitted, defaults ' +
    'to the highest-scoring opportunity (index 0 since findByInvestigation sorts DESC).',
  arguments: [
    {
      name: 'investigationId',
      description: 'Investigation ID (e.g. "inv_abc123"). Use "latest" to target the newest.',
      required: true,
    },
    {
      name: 'opportunityIndex',
      description: 'Zero-based index into the opportunity list (sorted by score DESC). Default: 0.',
      required: false,
    },
  ],
  async render(args, deps) {
    const raw = (args?.investigationId ?? '').trim();
    if (!raw) throw new Error('Argument "investigationId" is required');
    const investigationId = raw === 'latest' ? (getLatestInvestigationId(deps.db) ?? 'latest') : raw;
    const opportunityIndex = Number.isFinite(Number(args?.opportunityIndex))
      ? Number(args.opportunityIndex)
      : 0;

    const text = [
      `Please produce a deep-dive analysis of a specific CHISMOSO opportunity.`,
      ``,
      `Investigation ID: ${investigationId}`,
      `Opportunity index: ${opportunityIndex} (0 = highest-scoring)`,
      ``,
      `Steps:`,
      `1. Call \`chismoso_get_investigation\` with id="${investigationId}".`,
      `2. From the returned \`opportunities\` array, pick the one at index ${opportunityIndex}.`,
      `   If that index doesn't exist, fall back to index 0 and tell the user.`,
      `3. Produce a structured deep-dive in this format:`,
      ``,
      `   ## Opportunity: <title>`,
      `   **Score**: X/100  |  **Confidence**: Y%`,
      `   **Target Segment**: ...`,
      `   **Geography**: ...`,
      ``,
      `   ### Validation steps`,
      `   1. ...`,
      `   2. ...`,
      `   3. ...`,
      ``,
      `   ### Likely competitors`,
      `   - ...`,
      ``,
      `   ### Ideal Customer Profile (ICP)`,
      `   - ...`,
      ``,
      `   ### Monetisation options`,
      `   - ...`,
      ``,
      `   ### GTM plan (next 90 days)`,
      `   - ...`,
      ``,
      `4. Ground every claim in the evidence returned by the tool. Where evidence is missing,`,
      `   explicitly say "no evidence — hypothesis".`,
    ].join('\n');

    return [{ role: 'user', content: { type: 'text', text } }];
  },
};

// ---------------------------------------------------------------------------
// REGISTRY EXPORT
// ---------------------------------------------------------------------------

export const CHISMOSO_MCP_PROMPTS: McpPrompt[] = [
  investigateTopicPrompt,
  compareTopicsPrompt,
  deepDiveOpportunityPrompt,
];

export function getPromptByName(name: string): McpPrompt | undefined {
  return CHISMOSO_MCP_PROMPTS.find((p) => p.name === name);
}
