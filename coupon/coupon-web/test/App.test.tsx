import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const claim = vi.fn();
const checkEligibility = vi.fn();
const redeem = vi.fn();

vi.mock('@xumeiqi/coupon-client', () => {
  class CouponApiError extends Error {
    code: string;
    status: number;
    body: unknown;

    constructor(code: string, status: number, body: unknown) {
      super(`${code} (${status})`);
      this.name = 'CouponApiError';
      this.code = code;
      this.status = status;
      this.body = body;
    }
  }

  class CouponNetworkError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CouponNetworkError';
    }
  }

  class CouponProtocolError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CouponProtocolError';
    }
  }

  class CouponClient {
    claim = claim;
    checkEligibility = checkEligibility;
    redeem = redeem;
  }

  return { CouponClient, CouponApiError, CouponNetworkError, CouponProtocolError };
});

import { CouponApiError, CouponNetworkError } from '@xumeiqi/coupon-client';

import App from '../src/App';

function setup() {
  render(<App />);
  return userEvent.setup();
}

const banner = () => within(screen.getByRole('status'));
const attempts = () => within(screen.getByRole('list'));

describe('App', () => {
  beforeEach(() => {
    claim.mockReset();
    checkEligibility.mockReset();
    redeem.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses a selected catalog coupon when claiming', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([{
      id: 17, name: 'Demo coupon', minOrderAmount: 100,
      validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z',
    }])));
    claim.mockResolvedValue({ result: 'OK' });
    const user = setup();

    const coupon = await screen.findByRole('button', { name: /demo coupon/i });
    expect(coupon).toHaveTextContent('Minimum order 100.00');
    await user.click(coupon);
    expect(coupon).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /^claim$/i }));

    expect(claim).toHaveBeenCalledWith(17, 1);
    expect(await screen.findByText('Coupon claimed.')).toBeInTheDocument();
  });

  it('shows the eligibility message the service returned', async () => {
    checkEligibility.mockResolvedValue({ result: 'ELIGIBLE' });
    const user = setup();

    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    expect(await screen.findByText('This coupon applies to your order.')).toBeInTheDocument();
    expect(banner().getByText('ELIGIBLE')).toBeInTheDocument();
  });

  it('renders a business rejection with its status instead of a generic failure', async () => {
    claim.mockRejectedValue(new CouponApiError('ALREADY_CLAIMED', 409, { result: 'ALREADY_CLAIMED' }));
    const user = setup();

    await user.click(screen.getByRole('button', { name: /^claim$/i }));

    expect(await screen.findByText('You have already claimed this coupon.')).toBeInTheDocument();
    expect(banner().getByText('HTTP 409')).toBeInTheDocument();
    expect(banner().getByText('ALREADY_CLAIMED')).toBeInTheDocument();
  });

  it('separates a transport failure from a business one', async () => {
    redeem.mockRejectedValue(new CouponNetworkError('coupon request timed out after 10000ms'));
    const user = setup();

    await user.click(screen.getByRole('button', { name: /redeem/i }));

    expect(await screen.findByText(/timed out/i)).toBeInTheDocument();
    expect(banner().getByText('NETWORK')).toBeInTheDocument();
  });

  it('keeps a log of what was tried', async () => {
    checkEligibility.mockResolvedValue({ result: 'EXPIRED' });
    const user = setup();

    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    expect(await screen.findByText('This coupon has expired.')).toBeInTheDocument();
    expect(attempts().getByText('eligibility')).toBeInTheDocument();
    expect(attempts().getByText('EXPIRED')).toBeInTheDocument();
    expect(screen.queryByText('Nothing tried yet.')).not.toBeInTheDocument();
  });
});
