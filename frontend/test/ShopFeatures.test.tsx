import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Shop from '../src/Shop';
import LoginShop from '../src/LoginShop';

const products = [
  { id: 'silicone-utensils', name: 'Silicone utensil set', cents: 2500, category: 'Kitchen tools', description: 'Soft utensils' },
  { id: 'nonstick-skillet', name: 'Nonstick skillet', cents: 5000, category: 'Cookware', description: 'Everyday skillet',
    details: { dimensions: '10-inch diameter', material: 'Aluminum and nonstick coating', care: ['Hand wash after cooling.'] } },
  { id: 'stainless-stockpot', name: 'Stainless steel stockpot', cents: 7500, category: 'Cookware', description: 'Soup pot' },
  { id: 'glass-storage', name: 'Glass storage set', cents: 3500, category: 'Food storage', description: 'Stackable containers' },
];
const session = { userId: '101', csrfHeader: 'X-CSRF-TOKEN', csrfParameter: '_csrf', csrfToken: 'original-token' };
const pricing = { result: 'CONFIRMED', subtotalCents: 5000, discountCents: 0, totalCents: 5000, shortfallCents: 0 };
function order(id: number) {
  return { orderId: `order-${id}`, createdAt: '2026-01-01T00:00:00Z', pricing,
    items: [{ name: 'Nonstick skillet', quantity: 1 }], paymentStatus: 'PAID', shippingStatus: 'UNSHIPPED' };
}
function mockFetch(handler?: (url: URL, options?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const custom = await handler?.(url, options);
    if (custom) return custom;
    if (url.pathname.endsWith('/products')) return Response.json(products);
    if (url.pathname.endsWith('/stock')) return Response.json(products.map(product => ({ productId: product.id, available: 20 })));
    return Response.json([]);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => {
  sessionStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

it('combines search, category and price ordering, and clears an empty result', async () => {
  mockFetch();
  const user = userEvent.setup();
  const { container } = render(<Shop />);
  await screen.findByRole('button', { name: 'Add Nonstick skillet to cart' });
  await user.click(screen.getByText('Featured', { selector: 'summary span' }));
  await user.click(screen.getByRole('button', { name: 'Price: low to high' }));
  expect([...container.querySelectorAll('.retail-product-preview')].map(element => element.textContent))
    .toEqual(['Silicone utensil set', 'Glass storage set', 'Nonstick skillet', 'Stainless steel stockpot']);
  await user.click(screen.getByRole('button', { name: 'Cookware', exact: true }));
  await user.type(screen.getByRole('searchbox', { name: 'Search products' }), 'SOUP');
  expect(container.querySelectorAll('.retail-product')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Add Stainless steel stockpot to cart' })).toBeVisible();
  await user.clear(screen.getByRole('searchbox'));
  await user.type(screen.getByRole('searchbox'), 'no match');
  expect(screen.getByText('No products match your search and category.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(container.querySelectorAll('.retail-product')).toHaveLength(4);
});

it('shows product specifications and adds the item from its detail dialog', async () => {
  mockFetch();
  const user = userEvent.setup();
  render(<Shop />);
  await user.click(await screen.findByRole('button', { name: 'View Nonstick skillet details' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('10-inch diameter')).toBeVisible();
  expect(dialog.getByText('Hand wash after cooling.')).toBeVisible();
  await user.click(dialog.getByRole('button', { name: 'Add to cart' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Nonstick skillet/ })).toBeChecked();
});

it('paginates 25 orders and resets the page when filtering by status', async () => {
  const allOrders = Array.from({ length: 25 }, (_, index) => ({ ...order(index + 1), paymentStatus: index < 3 ? 'REFUNDED' : 'PAID' }));
  mockFetch(url => {
    if (!url.pathname.endsWith('/orders')) return;
    const filtered = url.searchParams.get('status') === 'REFUNDED' ? allOrders.filter(item => item.paymentStatus === 'REFUNDED') : allOrders;
    const offset = Number(url.searchParams.get('offset'));
    return Response.json(filtered.slice(offset, offset + Number(url.searchParams.get('limit'))));
  });
  const user = userEvent.setup();
  const { container } = render(<Shop />);
  await screen.findByText('Order order-1');
  expect(container.querySelectorAll('.retail-order')).toHaveLength(20);
  await user.click(screen.getByRole('button', { name: 'Older orders' }));
  await screen.findByText('Page 2');
  await waitFor(() => expect(container.querySelectorAll('.retail-order')).toHaveLength(5));
  expect(screen.getByRole('button', { name: 'Older orders' })).toBeDisabled();
  await user.click(screen.getByText('All orders', { selector: 'summary span' }));
  await user.click(screen.getByRole('button', { name: 'Refunded', exact: true }));
  await screen.findByText('Order order-1');
  expect(container.querySelectorAll('.retail-order')).toHaveLength(3);
  expect(screen.queryByText('Page 2')).not.toBeInTheDocument();
});

it.each(['refund', 'ship'] as const)('safely retries a %s after its server response is lost', async action => {
  let current = order(1);
  let submissions = 0;
  mockFetch((url, options) => {
    if (url.pathname.endsWith('/orders')) return Response.json([current]);
    if (options?.method === 'POST' && url.pathname.endsWith('/' + action)) {
      submissions += 1;
      current = action === 'refund' ? { ...current, paymentStatus: 'REFUNDED' } : { ...current, shippingStatus: 'SHIPPED' };
      if (submissions === 1) throw new TypeError('Response lost');
      return Response.json({ result: action === 'refund' ? 'REFUNDED' : 'SHIPPED' });
    }
  });
  const user = userEvent.setup();
  render(<Shop />);
  await user.click(await screen.findByText('Order order-1'));
  await user.click(screen.getByRole('button', { name: action === 'refund' ? 'Simulate refund' : 'Simulate shipment' }));
  const retry = await screen.findByRole('button', { name: action === 'refund' ? 'Retry refund' : 'Retry shipment' });
  await user.click(retry);
  await waitFor(() => expect(submissions).toBe(2));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByText(action === 'refund' ? 'Refunded · simulated' : 'Shipped · simulated')).toBeVisible();
});

it('blocks an expired selected coupon without silently removing it or charging full price', async () => {
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const coupon = { id: 8, name: 'Expiring discount', minOrderAmount: 50, discountAmount: 5, validUntil };
  mockFetch(url => {
    if (url.pathname === '/api/users/101/coupons') return Response.json([{ coupon, status: 'AVAILABLE' }]);
    if (url.pathname.endsWith('/quote')) return Response.json({ ...pricing, result: 'ELIGIBLE', discountCents: 500, totalCents: 4500 });
  });
  const user = userEvent.setup();
  render(<Shop />);
  await user.click(await screen.findByRole('button', { name: 'Add Nonstick skillet to cart' }));
  await user.click(await screen.findByRole('button', { name: 'Use Expiring discount at checkout' }));
  await screen.findByText('−$5.00');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(validUntil) + 100);
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(screen.getByText('This coupon has expired.')).toBeVisible();
  expect(screen.queryByText('−$5.00')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm demo order' })).toBeDisabled();
});

it('keeps an expanded receipt visible while an action refreshes the order list', async () => {
  let current = order(1);
  let loads = 0;
  let release: ((response: Response) => void) | undefined;
  mockFetch((url, options) => {
    if (url.pathname.endsWith('/orders')) {
      loads += 1;
      if (loads > 1) return new Promise<Response>(resolve => { release = resolve; });
      return Response.json([current]);
    }
    if (options?.method === 'POST') {
      current = { ...current, paymentStatus: 'REFUNDED' };
      return Response.json({ result: 'REFUNDED' });
    }
  });
  const user = userEvent.setup();
  render(<Shop />);
  await user.click(await screen.findByText('Order order-1'));
  await user.click(screen.getByRole('button', { name: 'Simulate refund' }));
  await waitFor(() => expect(release).toBeDefined());
  expect(screen.getByText('Refunded · simulated')).toBeVisible();
  await act(async () => { release!(Response.json([current])); });
  expect(screen.getByText('Refunded · simulated')).toBeVisible();
});

it('preserves the pending order and asks for sign-in when the session expires during checkout', async () => {
  mockFetch((url, options) => {
    if (url.pathname === '/api/session') return Response.json({ ...session, userId: null, csrfToken: 'guest' });
    if (options?.method === 'POST') return Response.json({ result: 'FORBIDDEN' }, { status: 401 });
  });
  const user = userEvent.setup();
  render(<Shop session={session} />);
  await user.click(await screen.findByRole('button', { name: 'Add Nonstick skillet to cart' }));
  await user.click(screen.getByRole('button', { name: 'Confirm demo order' }));
  await screen.findByRole('link', { name: 'Sign in again' });
  expect(sessionStorage.getItem('kitchenware-checkout-v1:101')).toContain('nonstick-skillet');
  expect(screen.getByRole('button', { name: 'Retry order' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /Nonstick skillet/ })).toBeChecked();
});

it('refreshes a stale CSRF token and retries the identical checkout request once', async () => {
  const submissions: { path: string; body: string; token: string | null }[] = [];
  mockFetch((url, options) => {
    if (url.pathname === '/api/session') return Response.json({ ...session, csrfToken: 'renewed-token' });
    if (options?.method === 'POST') {
      submissions.push({ path: url.pathname, body: String(options.body), token: new Headers(options.headers).get('X-CSRF-TOKEN') });
      if (submissions.length === 1) return Response.json({ result: 'FORBIDDEN' }, { status: 403 });
      return Response.json({ orderId: url.pathname.split('/').at(-1), pricing });
    }
  });
  const user = userEvent.setup();
  render(<Shop session={session} />);
  await user.click(await screen.findByRole('button', { name: 'Add Nonstick skillet to cart' }));
  await user.click(screen.getByRole('button', { name: 'Confirm demo order' }));
  await screen.findByText(/Order confirmed for \$50.00/);
  expect(submissions).toHaveLength(2);
  expect(submissions[0].path).toBe(submissions[1].path);
  expect(submissions[0].body).toBe(submissions[1].body);
  expect(submissions.map(item => item.token)).toEqual(['original-token', 'renewed-token']);
});

it('retries initial session loading without requiring a page refresh', async () => {
  let attempts = 0;
  mockFetch(url => {
    if (url.pathname !== '/api/session') return;
    attempts += 1;
    if (attempts === 1) throw new TypeError('Offline');
    return Response.json({ ...session, userId: null });
  });
  const user = userEvent.setup();
  render(<LoginShop />);
  await user.click(await screen.findByRole('button', { name: 'Retry connection' }));
  await screen.findByRole('button', { name: 'Add Nonstick skillet to cart' });
  expect(attempts).toBe(2);
});
