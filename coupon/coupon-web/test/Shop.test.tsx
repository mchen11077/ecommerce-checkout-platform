import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

const { claim } = vi.hoisted(() => ({ claim: vi.fn() }));

vi.mock('@xumeiqi/coupon-client', () => ({
  CouponClient: class { claim = claim; },
  CouponApiError: class extends Error {
    constructor(public code: string) { super(code); }
  },
}));

import Shop from '../src/Shop';

it('claims a coupon, checks the order minimum, and marks it used after checkout', async () => {
  const coupon = { id: 8, name: 'Weekend savings', discountAmount: 20, minOrderAmount: 100, validUntil: '2026-12-12T00:00:00Z' };
  let claimed = false;
  let redeemed = false;
  claim.mockImplementation(async () => { claimed = true; return { result: 'OK' }; });
  const totals = { result: 'ELIGIBLE', subtotalCents: 12000, discountCents: 2000, totalCents: 10000, shortfallCents: 0 };
  const submissions: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (options?.method !== 'POST' && url.pathname.endsWith('/orders')) return json([]);
    if (url.pathname.endsWith('/products')) return json([
      { id: 'canvas-tote', name: 'Canvas tote', cents: 5000 },
      { id: 'weekender-bag', name: 'Weekender bag', cents: 12000 },
    ]);
    if (url.pathname.endsWith('/quote')) return json(url.searchParams.get('cart') === 'canvas-tote:1'
      ? { result: 'BELOW_MIN_ORDER', subtotalCents: 5000, discountCents: 0, totalCents: 5000, shortfallCents: 5000 } : totals);
    if (options?.method === 'POST') {
      submissions.push(url.pathname);
      expect(JSON.parse(String(options.body))).toEqual({ couponId: 8, items: [{ productId: 'weekender-bag', quantity: 1 }] });
      if (submissions.length === 1) throw new TypeError('connection interrupted');
      redeemed = true;
      return json({ orderId: url.pathname.split('/').pop(), pricing: { ...totals, result: 'REDEEMED' } });
    }
    return json(url.pathname.includes('/users/')
      ? (claimed ? [{ coupon, status: redeemed ? 'REDEEMED' : 'AVAILABLE', remainingUses: redeemed ? 0 : 1 }] : [])
      : [coupon]);
  }));

  try {
    const user = userEvent.setup();
    render(<Shop />);
    await user.click(await screen.findByRole('button', { name: 'Add Canvas tote to cart' }));
    await user.click(await screen.findByRole('button', { name: 'Claim offer' }));
    await screen.findByText('Coupon added to My coupons.');
    await user.click(screen.getByRole('button', { name: 'Use Weekend savings at checkout' }));
    const picker = screen.getByText('Weekend savings', { selector: '#coupon-value' }).closest('summary');
    expect(picker).toHaveFocus();
    expect(await screen.findByText('Your order is below the minimum for this coupon.')).toBeInTheDocument();
    expect(screen.getByText('$50.00 away from the minimum.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm demo order' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /canvas tote/i }));
    await user.click(screen.getByRole('button', { name: 'Add Weekender bag to cart' }));
    expect(await screen.findByText('This coupon applies to your order.')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Order totals')).getByText('$100.00')).toBeInTheDocument();
    expect(confirm).toHaveTextContent('$100.00');
    expect(screen.getByText('−$20.00')).toBeInTheDocument();
    await user.click(confirm);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry order' }));
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toBe(submissions[0]);
    const wallet = screen.getByRole('heading', { name: 'My coupons' }).closest('section')!;
    const history = await within(wallet).findByText('Used and expired coupons (1)');
    expect(history.closest('details')).not.toHaveAttribute('open');
    await user.click(history);
    expect(within(wallet).getByText('Used')).toBeVisible();
    expect(screen.getByText(/order confirmed for \$100\.00/i)).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});

it('sorts available coupons by expiry and keeps inactive coupons out of checkout', async () => {
  const coupon = { discountAmount: 5, minOrderAmount: 50 };
  const wallet = [
    { coupon: { ...coupon, id: 1, name: 'Later offer', validUntil: '2099-12-10T00:00:00Z' }, status: 'AVAILABLE' },
    { coupon: { ...coupon, id: 2, name: 'Earlier offer', validUntil: '2099-12-01T00:00:00Z', maxUsesPerUser: 3 },
      status: 'AVAILABLE', remainingUses: 2 },
    { coupon: { ...coupon, id: 3, name: 'Past offer', validUntil: '2000-01-01T00:00:00Z' }, status: 'EXPIRED' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(
    new URL(input).pathname.endsWith('/coupons') && new URL(input).pathname.includes('/users/') ? wallet : [],
  ))));
  try {
    render(<Shop />);
    const section = within(screen.getByRole('heading', { name: 'My coupons' }).closest('section')!);
    await section.findByText('2 of 3 uses left');
    expect(section.getAllByRole('button', { name: /at checkout/i }).map(button => button.getAttribute('aria-label')))
      .toEqual(['Use Earlier offer at checkout', 'Use Later offer at checkout']);
    expect(screen.queryByRole('option', { name: 'Past offer' })).not.toBeInTheDocument();
    const history = section.getByText('Used and expired coupons (1)');
    expect(history.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(history);
    expect(section.getByText('Past offer')).toBeVisible();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('confirms removal and checks out only the selected quantities', async () => {
  const order = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/products')) return Response.json([
      { id: 'canvas-tote', name: 'Canvas tote', cents: 5000 },
      { id: 'weekender-bag', name: 'Weekender bag', cents: 12000 },
    ]);
    if (options?.method === 'POST') {
      order(JSON.parse(String(options.body)));
      return Response.json({ orderId: 'test-order', pricing: { result: 'CONFIRMED', totalCents: 10000 } });
    }
    return Response.json([]);
  }));
  try {
    const user = userEvent.setup();
    render(<Shop />);
    await user.click(await screen.findByRole('button', { name: 'Add Canvas tote to cart' }));
    await user.click(screen.getByRole('button', { name: 'Add Weekender bag to cart' }));
    const selectAll = await screen.findByRole('checkbox', { name: 'Select all items' });
    expect(selectAll).toBeChecked();
    await user.click(selectAll);
    await user.click(selectAll);
    expect(screen.getByRole('checkbox', { name: /weekender bag/i })).toBeChecked();
    await user.click(selectAll);
    expect(screen.getByRole('button', { name: 'Confirm demo order' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove Canvas tote' }));
    await user.click(screen.getByRole('button', { name: 'Keep item' }));
    expect(screen.getByRole('checkbox', { name: /canvas tote/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Canvas tote' }));
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));
    expect(screen.queryByRole('checkbox', { name: /canvas tote/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add Canvas tote/ }));
    await user.click(screen.getByRole('button', { name: 'Increase Canvas tote quantity' }));
    await user.click(screen.getByRole('button', { name: 'Increase Canvas tote quantity' }));
    await user.click(screen.getByRole('button', { name: 'Decrease Canvas tote quantity' }));
    await user.click(screen.getByRole('button', { name: 'Confirm demo order' }));
    expect(order).toHaveBeenCalledWith({ couponId: null, items: [{ productId: 'canvas-tote', quantity: 2 }] });
    expect(await screen.findByText(/order confirmed for \$100\.00/i)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /weekender bag/i })).not.toBeChecked();
  } finally {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});
