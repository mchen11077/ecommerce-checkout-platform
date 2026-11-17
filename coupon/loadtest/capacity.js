// Capacity probe: closed model with a fixed number of virtual users. Each VU sends the next request
// as soon as the previous one returns, so throughput converges to what the system can actually serve
// instead of being capped by k6's maxVUs when latency grows.
import http from 'k6/http';
import exec from 'k6/execution';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 800),
      duration: __ENV.DURATION || '45s',
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const uid = Number(__ENV.USER_OFFSET || 0) + exec.scenario.iterationInTest + 1;
  http.post(`${__ENV.BASE}/api/coupons/${__ENV.COUPON_ID}/claim?userId=${uid}&mode=${__ENV.MODE}`,
    null, { responseCallback: http.expectedStatuses(200), tags: { name: 'claim' } });
}

export function handleSummary(data) {
  return { [`/results/${__ENV.NAME}.json`]: JSON.stringify(data) };
}
