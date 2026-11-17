# @xumeiqi/coupon-client

TypeScript client for the coupon service.

Coupon operations return a typed `result` on success. On rejection, `CouponApiError` exposes the
service's result code and HTTP status.

```ts
import { CouponApiError, CouponClient } from '@xumeiqi/coupon-client';

const coupons = new CouponClient({ baseUrl: 'http://localhost:8080' });

try {
  await coupons.claim(7, 101);
} catch (error) {
  if (error instanceof CouponApiError) {
    console.error(error.code, error.status);
  }
  throw error;
}
```

## Methods

| Method | Endpoint | Resolves to |
|---|---|---|
| `claim(couponId, userId, { mode? })` | `POST /api/coupons/{id}/claim` | `{ result: 'OK' }` |
| `checkEligibility(couponId, { userId, orderAmount })` | `GET /api/coupons/{id}/eligibility` | `{ result: 'ELIGIBLE' }` |
| `redeem(couponId, userId, { orderAmount, orderId })` | `POST /api/coupons/{id}/redeem` | `{ result: 'REDEEMED' }` |

Rejections throw one of:

- `CouponApiError` — the service said no. `code` is its result code, `status` the HTTP status.
- `CouponNetworkError` — no response: connection failure, abort, timeout (10s default).
- `CouponProtocolError` — a 2xx without a `result` field, or an argument the client refuses to send.

## Notes

- Pass `orderAmount` as a decimal string to preserve its exact text, for example `"49.99"`.
- No runtime dependencies. `fetch` can be injected for tests or for custom headers.
- One `AbortController` covers both the internal timeout and a caller-supplied `signal`.

## Development

```bash
pnpm install
pnpm test
pnpm build     # tsc -> dist (ESM + declarations)
pnpm pack      # @xumeiqi/coupon-client-0.1.0.tgz
```
