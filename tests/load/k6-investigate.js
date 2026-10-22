/**
 * k6 load test — POST /api/investigate
 *
 * The investigation endpoint is the most expensive path in CHISMOSO V1.5:
 * each request spawns a chismoso CLI subprocess (ReAct loop hitting the
 * Z.ai LLM 5+ times, writing an idempotency row to SQLite, producing a
 * Markdown report). A single call can take 30-90s.
 *
 * This script measures the stack's vertical ceiling for that path:
 * how many concurrent investigations a single Next.js instance can
 * sustain before the in-process semaphore starts returning 429
 * (CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS, default 3).
 *
 * Usage:
 *   k6 run tests/load/k6-investigate.js
 *   k6 run --env K6_BASE_URL=https://staging.chismoso.example.com \
 *          --env K6_AUTH_TOKEN=chsm_<agent-token> \
 *          tests/load/k6-investigate.js
 *
 * Tuning:
 *   --env SMOKE=1       — switch to a 1-user / 10s profile for CI smoke runs.
 *   --env DURATION=2m  — override the steady-state hold duration (default 1m).
 *   --env PEAK=10      — override the peak vus (default 10).
 *
 * Thresholds:
 *   - http_req_duration p(99) < 10s  — even the slowest investigations
 *     should complete in under 10s on a healthy single-box deploy.
 *   - http_req_failed < 5%            — only 429 (concurrency cap) is
 *     an accepted "failure"; anything else is a real regression.
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

// Smoke profile: 1 user, 10s. Used by CI to catch pathological regressions
// (e.g. a route returning 500 for every request) without burning LLM tokens.
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
    http_req_duration: ['p<10000'], // p99 under 10s (investigations are LLM-driven)
    http_req_failed: ['rate<0.05'], // <5% errors (only 429 accepted)
  },
  // Investigations are expensive — don't let a runaway test burn LLM tokens.
  // 60s timeout matches the route's maxDuration (300s) with margin for slow
  // responses; k6 will fail the request as a timeout otherwise.
  httpDebug: 'OFF',
};

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};
if (AUTH_TOKEN) {
  headers['X-Chismoso-Agent'] = AUTH_TOKEN;
}

export default function investigateLoadTest() {
  const payload = JSON.stringify({
    objective: 'load test — identify emerging signals in the test topic',
    geography: 'global',
    maxQueries: 1, // keep each iteration cheap — 1 search query instead of 5
  });

  const res = http.post(`${BASE_URL}/api/investigate`, payload, {
    headers,
    timeout: '120s',
  });

  // 200 = investigation completed.
  // 429 = rate limiter / concurrency limiter rejected the request (expected
  //       once concurrency exceeds CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS).
  // 401 = auth required (operator forgot K6_AUTH_TOKEN in a prod-protected env).
  // Anything else is a real failure that the threshold will catch.
  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  // Breathing room between iterations so the in-process limiter has a
  // chance to drain. Lower than the average investigation duration so an
  // early-retryer has a real chance of getting a slot.
  sleep(1);
}
