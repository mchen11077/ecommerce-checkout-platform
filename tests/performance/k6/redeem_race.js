// Step 1.1 redemption: N requests try to redeem the SAME claim at the same moment. Exactly one may succeed.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const ok = new Counter('redeem_ok');
const rejected = new Counter('redeem_rejected');
const errors = new Counter('redeem_error');

export const options = {
  scenarios: {
    burst: { executor: 'per-vu-iterations', vus: Number(__ENV.ATTEMPTS || 50), iterations: 1, maxDuration: '60s' },
  },
};

export default function () {
  const url = `${__ENV.BASE}/api/coupons/${__ENV.COUPON_ID}/redeem?userId=${__ENV.USER_ID}`
    + `&orderAmount=200&orderId=race-order-${__VU}`;
  const r = http.post(url, null, { responseCallback: http.expectedStatuses(200, 409), tags: { name: 'redeem' } });
  if (r.status === 200) ok.add(1);
  else if (r.status === 409) rejected.add(1);
  else errors.add(1);
}

export function handleSummary(data) {
  return { [`/results/${__ENV.NAME}.json`]: JSON.stringify(data) };
}
