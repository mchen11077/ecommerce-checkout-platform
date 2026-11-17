# coupon-web

React front end for the coupon service. It talks to the API only through `@xumeiqi/coupon-client`, so a
rejection arrives as a `CouponApiError` carrying the service's own result code.

```bash
pnpm install --no-frozen-lockfile
pnpm dev     # http://localhost:5173
pnpm test
pnpm build
```

Vite forwards same-origin `/api` requests to `http://127.0.0.1:8080` during development.
Set `VITE_API_BASE` to point at another API that permits requests from the page's origin.

## How it works

The home page is a shopping demo for customer 101. Claim an offer, find it under My coupons,
then select it in simulated checkout. The service checks eligibility and records redemption.
The two sample items and the displayed order total are calculated by the demo UI.
Open `/?debug=1` to access the coupon operations console.

The page loads up to 50 currently active coupons from `GET /api/coupons`. Select a coupon or type its
ID, then enter a user ID to claim, check eligibility, or redeem through the TypeScript client.
The list shows the minimum order and validity window. Claim responses determine stock availability.

`src/messages.ts` holds the copy for every result code. Sold out, already claimed, expired, below
minimum and lock timeout each get their own sentence and colour, because they mean different things to
the shopper. Network failures and a 2xx without a `result` are shown separately, not folded into
"something went wrong".

The attempt list shows each action and its result during the current page session.

## Layout

```
src/App.tsx                  form state, the three actions, outcome handling
src/messages.ts              result code -> message and tone
src/components/ResultBanner.tsx
src/components/AttemptList.tsx
test/messages.test.ts        copy coverage for every code
test/App.test.tsx            success, business rejection, transport failure, attempt log
```
