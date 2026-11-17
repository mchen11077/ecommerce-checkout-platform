import { describe, expect, it } from 'vitest';

import { copyFor, isKnownCode } from '../src/messages';

describe('copyFor', () => {
  it('uses the success copy for the three happy outcomes', () => {
    expect(copyFor('ELIGIBLE')).toEqual({ message: 'This coupon applies to your order.', tone: 'ok' });
    expect(copyFor('OK')).toEqual({ message: 'Coupon claimed.', tone: 'ok' });
    expect(copyFor('REDEEMED')).toEqual({ message: 'Coupon redeemed.', tone: 'ok' });
  });

  it('explains a below-minimum order rather than saying "invalid"', () => {
    expect(copyFor('BELOW_MIN_ORDER').message).toMatch(/below the minimum/i);
  });

  it('treats busy and rate-limited as separate failures', () => {
    expect(copyFor('LOCK_TIMEOUT').message).toMatch(/busy/i);
    expect(copyFor('RATE_LIMITED').message).toMatch(/too many/i);
  });

  it('covers every code the service can return', () => {
    const codes = [
      'OK',
      'ELIGIBLE',
      'REDEEMED',
      'SOLD_OUT',
      'ALREADY_CLAIMED',
      'NOT_CLAIMED',
      'ALREADY_REDEEMED',
      'EXPIRED',
      'NOT_STARTED',
      'BELOW_MIN_ORDER',
      'NOT_ISSUED',
      'COUPON_NOT_FOUND',
      'RATE_LIMITED',
      'LOCK_TIMEOUT',
    ];
    for (const code of codes) {
      expect(isKnownCode(code), `missing copy for ${code}`).toBe(true);
    }
  });

  it('falls back for a code it has never seen, without pretending it is fine', () => {
    const copy = copyFor('SOMETHING_NEW');
    expect(copy.tone).toBe('bad');
    expect(copy.message).toContain('SOMETHING_NEW');
  });
});
