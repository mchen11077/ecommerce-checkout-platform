// Step 2.5: fixed request rate (open model). Every request is a different user; stock is effectively unlimited.
import http from 'k6/http';
import exec from 'k6/execution';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE),
      timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: Number(__ENV.VUS || 300),
      maxVUs: Number(__ENV.MAXVUS || 3000),
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const uid = Number(__ENV.USER_OFFSET || 0) + exec.scenario.iterationInTest + 1;
  http.post(`${__ENV.BASE}/api/coupons/${__ENV.COUPON_ID}/claim?userId=${uid}&mode=${__ENV.MODE}`, null,
    { responseCallback: http.expectedStatuses(200), tags: { name: 'claim' } });
}

export function handleSummary(data) {
  return { [`/results/${__ENV.NAME}.json`]: JSON.stringify(data) };
}
