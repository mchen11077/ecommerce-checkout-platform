// Step 1.2: N users hit the same coupon at the same moment. Each user claims exactly once.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const ok = new Counter('claim_ok');
const rejected = new Counter('claim_rejected');
const errors = new Counter('claim_error');

export const options = {
  scenarios: {
    burst: { executor: 'per-vu-iterations', vus: Number(__ENV.USERS || 100), iterations: 1, maxDuration: '60s' },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const url = `${__ENV.BASE}/api/coupons/${__ENV.COUPON_ID}/claim?userId=${__VU}&mode=${__ENV.MODE}`;
  const r = http.post(url, null, { responseCallback: http.expectedStatuses(200, 409), tags: { name: 'claim' } });
  if (r.status === 200) ok.add(1);
  else if (r.status === 409) rejected.add(1);
  else errors.add(1);
}

export function handleSummary(data) {
  return { [`/results/${__ENV.NAME}.json`]: JSON.stringify(data) };
}
