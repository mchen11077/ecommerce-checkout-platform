/** Result codes the coupon service returns in the `result` field of every response body. */

/** POST /api/coupons/{id}/claim — 200 means OK, everything else is a rejection. */
export type ClaimResult =
  | 'OK'
  | 'SOLD_OUT'
  | 'ALREADY_CLAIMED'
  | 'NOT_FOUND'
  | 'NOT_ISSUED'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'RATE_LIMITED'
  | 'LOCK_TIMEOUT';

/** GET /api/coupons/{id}/eligibility — 200 means ELIGIBLE. */
export type EligibilityResult =
  | 'ELIGIBLE'
  | 'COUPON_NOT_FOUND'
  | 'NOT_ISSUED'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'NOT_CLAIMED'
  | 'ALREADY_REDEEMED'
  | 'BELOW_MIN_ORDER'
  | 'REDEEMED';

/** POST /api/coupons/{id}/redeem — 200 means REDEEMED. */
export type RedeemResult = 'REDEEMED' | EligibilityResult;

/** Every response from the service has exactly this shape. */
export interface ApiBody<T extends string> {
  result: T;
}

/** A monetary amount is sent as a decimal string so 50.00 does not become 50. */
export type Money = string | number;

export interface ClaimOptions {
  /** Which claim implementation to exercise. Defaults to the Redis path. */
  mode?: 'redis' | 'lock' | 'naive';
  signal?: AbortSignal;
}

export interface RedeemOptions {
  orderAmount: Money;
  orderId: string;
  signal?: AbortSignal;
}

export interface EligibilityOptions {
  userId: number;
  orderAmount: Money;
  signal?: AbortSignal;
}

export interface CouponClientOptions {
  /** Origin of the coupon service, e.g. `http://localhost:8080`. No trailing slash required. */
  baseUrl: string;
  /** Injected for tests, or to use a fetch with custom headers/credentials. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds before the request is aborted. Defaults to 10_000. */
  timeoutMs?: number;
}
