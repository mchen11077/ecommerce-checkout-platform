# @xumeiqi/coupon-client

TypeScript client for the coupon service.

The API answers every request with an HTTP status and a `result` string in the body. This client turns
that pair into a typed value on success and a `CouponApiError` on rejection, so call sites switch on
`SOLD_OUT` or `EXPIRED` instead of on status codes.

```ts
import { CouponApiError, CouponClient } from '@xumeiqi/coupon-client';

const coupons = new CouponClient({ baseUrl: 'http://localhost:8080' });

try {
  await coupons.claim(7, userId);
} catch (error) {
  if (error instanceof CouponApiError) {
    switch (error.code) {
      case 'SOLD_OUT':
        return 'This coupon is gone';
      case 'ALREADY_CLAIMED':
        return 'You already have this one';
      case 'LOCK_TIMEOUT':
        return 'Busy right now, try again';
    }
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

- `orderAmount` accepts a string on purpose. Passing `49.99` as a number goes through `toString()` and
  loses the scale that the server's `BigDecimal` parameter cares about.
- No runtime dependencies. `fetch` can be injected for tests or for custom headers.
- One `AbortController` covers both the internal timeout and a caller-supplied `signal`.

## Development

```bash
pnpm install
pnpm test
pnpm build     # tsc -> dist (ESM + declarations)
pnpm pack      # @xumeiqi/coupon-client-0.1.0.tgz
```
