/**
 * k6 load test — POST /api/chat
 *
 * The chat endpoint is the dashboard's conversational agent. Each request:
 *   - Resolves (or creates) an in-memory ChatSession keyed by sessionId.
 *   - Runs a ReAct-style loop (max 6 iterations) hitting the Z.ai LLM
 *     per turn + executing the LLM-chosen tool.
 *   - Streams the final reply back as SSE (event: token, event: done).
 *
 * This script measures the stack's vertical ceiling for the chat path
 * (which is lighter per-request than /api/investigate but expects to be
 * called more frequently — every operator question hits this route).
 *
 * Usage:
 *   k6 run tests/load/k6-chat.js
 *   k6 run --env K6_BASE_URL=https://staging.chismoso.example.com \
 *          --env K6_AUTH_TOKEN=chsm_<agent-token> \
 *          tests/load/k6-chat.js
 *
 * Tuning:
 *   --env SMOKE=1       — switch to a 1-user / 10s profile for CI smoke runs.
 *   --env DURATION=1m   — override the steady-state hold duration (default 1m).
 *   --env PEAK=10       — override the peak vus (default 10).
 *
 * Thresholds:
 *   - http_req_duration p(99) < 10s  — chat replies should complete well
 *     under the route's 60s maxDuration. The LLM call + tool execution
 *     typically takes 2-8s; a 10s ceiling catches regressions.
 *   - http_req_failed < 5%            — only 429 (rate limiter) is an
 *     accepted "failure"; 500s are real regressions.
 *
 * Notes:
 *   - The endpoint returns an SSE stream. k6's http.post blocks until the
 *     stream closes (which happens when the server sends `event: done` and
 *     terminates the controller). So each iteration is roughly the
 *     end-to-end chat-turn latency, plus the 1s sleep.
 *   - Each iteration creates a NEW sessionId (no `sessionId` field in the
 *     body), so the server-side session map grows linearly with the number
 *     of iterations. That's fine for a 2-minute run (~600 sessions at 5
 *     req/s peak); for longer runs, pass a fixed sessionId via K6_SESSION_ID
 *     so all VUs share a single conversation thread.
 *
 * See docs/OPERATIONS.md §Load testing for the runbook.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.K6_AUTH_TOKEN || '';
const SMOKE = __ENV.SMOKE === '1' || __ENV.SMOKE === 'true';
const DURATION = __ENV.DURATION || '1m';
const PEAK = parseInt(__ENV.PEAK || '10', 10);
const SESSION_ID = __ENV.K6_SESSION_ID || '';

const stages = SMOKE
  ? [
      { duration: '5s', target: 1 },
      { duration: '10s', target: 1 },
      { duration: '5s', target: 0 },
    ]
  : [
      { duration: '30s', target: Math.max(1, Math.floor(PEAK / 2)) },
      { duration: DURATION, target: PEAK },
      { duration: '30s', target: 0 },
    ];

export const options = {
  stages,
  thresholds: {
    http_req_duration: ['p<10000'],
    http_req_failed: ['rate<0.05'],
  },
  httpDebug: 'OFF',
};

const headers = {
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
};
if (AUTH_TOKEN) {
  headers['X-Chismoso-Agent'] = AUTH_TOKEN;
}

// Pool of varied prompts so the LLM doesn't trivially cache every iteration.
// Each prompt is short enough (<2000 chars, the server's cap) to exercise
// the full ReAct loop including tool selection (semantic-search / list-topics).
const PROMPTS = [
  '¿Qué señales emergentes hay en el sector fintech en Colombia esta semana?',
  'List the top 3 trends from Reddit r/SaaS in the last 7 days.',
  'Resume las oportunidades detectadas en el último reporte de chismoso.',
  'What problems are people reporting about Stripe on Twitter right now?',
  'Detecta señales tempranas en el sector edtech en LATAM.',
  'Show me anomalies in the recent signal volume.',
];

export default function chatLoadTest() {
  const prompt = PROMPTS[__ITER % PROMPTS.length] || PROMPTS[0];

  const body = { message: prompt };
  if (SESSION_ID) {
    body.sessionId = SESSION_ID;
  }
  const payload = JSON.stringify(body);

  const res = http.post(`${BASE_URL}/api/chat`, payload, {
    headers,
    timeout: '90s', // route maxDuration is 60s — give k6 headroom
  });

  // 200 = stream completed (SSE closed cleanly with event: done).
  // 429 = rate limiter rejected the request.
  // 401 = auth required (operator forgot K6_AUTH_TOKEN in a prod-protected env).
  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  sleep(1);
}
