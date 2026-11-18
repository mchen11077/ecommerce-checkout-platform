/**
 * Copy for every result code the service can return.
 * Codes are the API's own (`{ result: "..." }`), so nothing is inferred from a status number.
 */
export type Tone = 'ok' | 'warn' | 'bad';

interface Copy {
  message: string;
  tone: Tone;
}

const COPY: Record<string, Copy> = {
  // success
  OK: { message: 'Coupon claimed.', tone: 'ok' },
  ELIGIBLE: { message: 'This coupon applies to your order.', tone: 'ok' },
  REDEEMED: { message: 'Coupon redeemed.', tone: 'ok' },

  // business rejections
  SOLD_OUT: { message: 'This coupon is sold out.', tone: 'warn' },
  ALREADY_CLAIMED: { message: 'You have already claimed this coupon.', tone: 'warn' },
  NOT_CLAIMED: { message: 'Claim the coupon before redeeming it.', tone: 'warn' },
  SIGN_IN_FOR_COUPONS: { message: 'Sign in to use coupons.', tone: 'warn' },
  INSUFFICIENT_STOCK: { message: 'Some items are out of stock at the selected quantity. Update your cart and try again.', tone: 'warn' },
  ORDER_ACTION_UNAVAILABLE: { message: 'This order can no longer be refunded or shipped.', tone: 'warn' },
  ALREADY_REDEEMED: { message: 'This coupon has already been redeemed.', tone: 'warn' },
  EXPIRED: { message: 'This coupon has expired.', tone: 'warn' },
  NOT_STARTED: { message: 'This coupon is not active yet.', tone: 'warn' },
  BELOW_MIN_ORDER: { message: 'Your order is below the minimum for this coupon.', tone: 'warn' },
  NOT_ISSUED: { message: 'This coupon has not been issued yet.', tone: 'warn' },
  COUPON_NOT_FOUND: { message: 'There is no coupon with that ID.', tone: 'bad' },
  NOT_FOUND: { message: 'There is no coupon with that ID.', tone: 'bad' },
  SESSION_EXPIRED: { message: 'Your session expired. Sign in again; your cart and pending order are saved.', tone: 'warn' },
  FORBIDDEN: { message: 'You do not have access to this coupon or order.', tone: 'bad' },
  ORDER_CONFLICT: { message: 'This order ID is already in use for a different checkout.', tone: 'warn' },

  // transport-level rejections
  RATE_LIMITED: { message: 'Too many attempts — try again in a moment.', tone: 'bad' },
  LOCK_TIMEOUT: { message: 'The service is busy — please try again.', tone: 'bad' },
  UNKNOWN: { message: 'The service rejected the request without a reason.', tone: 'bad' },
};

export function copyFor(code: string): Copy {
  return COPY[code] ?? { message: `Unrecognised result: ${code}`, tone: 'bad' };
}

export function isKnownCode(code: string): boolean {
  return code in COPY;
}
