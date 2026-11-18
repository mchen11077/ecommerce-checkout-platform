import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { origin, signIn, test } from './fixtures';

test('search, price sorting and product specifications work across window sizes', async ({ page }) => {
  await page.goto(origin);
  await expect(page.locator('.retail-product')).toHaveCount(4);
  await page.locator('.retail-choice summary').filter({ hasText: 'Featured' }).click();
  await page.getByRole('button', { name: 'Price: high to low' }).click();
  await expect(page.locator('.retail-product').first()).toContainText('Stainless steel stockpot');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('searchbox', { name: 'Search products' }).fill('SKILLET');
    await expect(page.locator('.retail-product')).toHaveCount(1);
    await page.getByRole('button', { name: 'View Nonstick skillet details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nonstick skillet' });
    await expect(dialog.getByText('10-inch diameter')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Care instructions' })).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: test.info().outputPath(`detail-${width}.png`) });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByRole('searchbox').fill('missing product');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.retail-product')).toHaveCount(4);
});

test('guest checkout renews stale CSRF and retries the same order', async ({ page }) => {
  let firstSession = true;
  await page.route('**/api/session', async route => {
    if (!firstSession) return route.continue();
    firstSession = false;
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), csrfToken: 'stale-token' } });
  });
  const submissions: { url: string; body: string | null }[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/checkout/guest/orders/')) {
      submissions.push({ url: request.url(), body: request.postData() });
    }
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Add Silicone utensil set to cart' }).click();
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(page.locator('#checkout').getByText(/Order confirmed for \$25.00/)).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
});

test('expired authentication preserves the cart and pending request', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add Silicone utensil set to cart' }).click();
  const session = await (await page.request.get(origin + '/api/session')).json();
  const logout = await page.request.post(origin + '/logout', {
    form: { [session.csrfParameter]: session.csrfToken }, maxRedirects: 0,
  });
  expect(logout.status()).toBe(302);
  await page.getByRole('button', { name: 'Confirm demo order' }).click();
  if (await page.getByRole('button', { name: 'Continue without a coupon' }).isVisible()) {
    await page.getByRole('button', { name: 'Continue without a coupon' }).click();
  }
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry order' })).toBeDisabled();
  const pending = await page.evaluate(owner => sessionStorage.getItem(`kitchenware-checkout-v1:${owner}`), session.userId);
  expect(pending).toContain('silicone-utensils');
  await expect(page.getByRole('checkbox', { name: /Silicone utensil set/ })).toBeChecked();
});

test('order status filtering queries the server and keeps receipts discoverable', async ({ page }) => {
  await signIn(page);
  const session = await (await page.request.get(origin + '/api/session')).json();
  const base = `${origin}/api/checkout/users/${session.userId}/orders`;
  const headers = { [session.csrfHeader]: session.csrfToken };
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    expect((await page.request.post(`${base}/${id}`, { headers,
      data: { items: [{ productId: 'silicone-utensils', quantity: 1 }] },
    })).status()).toBe(200);
  }
  expect((await page.request.post(`${base}/${ids[0]}/refund`, { headers })).status()).toBe(200);
  expect((await page.request.post(`${base}/${ids[1]}/ship`, { headers })).status()).toBe(200);
  await page.reload();
  await page.locator('#orders .retail-choice summary').click();
  await page.getByRole('button', { name: 'Refunded', exact: true }).click();
  await expect(page.locator('.retail-order').filter({ hasText: ids[0].slice(0, 8) })).toBeVisible();
  await expect(page.locator('.retail-order').filter({ hasText: ids[1].slice(0, 8) })).toHaveCount(0);
  await page.locator('#orders .retail-choice summary').click();
  await page.getByRole('button', { name: 'Shipped', exact: true }).click();
  await expect(page.locator('.retail-order').filter({ hasText: ids[1].slice(0, 8) })).toBeVisible();
  const response = await page.request.get(base + '?status=SHIPPED&limit=21');
  expect((await response.json()).every((item: { shippingStatus: string }) => item.shippingStatus === 'SHIPPED')).toBe(true);
});

for (const action of ['refund', 'ship'] as const) {
  test(`retry ${action} after a committed response is lost`, async ({ page }) => {
    await signIn(page);
    const session = await (await page.request.get(origin + '/api/session')).json();
    const base = `${origin}/api/checkout/users/${session.userId}/orders`;
    const headers = { [session.csrfHeader]: session.csrfToken };
    const id = randomUUID();
    expect((await page.request.post(`${base}/${id}`, { headers,
      data: { items: [{ productId: 'silicone-utensils', quantity: 1 }] },
    })).status()).toBe(200);
    const inventory = async () => (await (await page.request.get(origin + '/api/checkout/stock')).json())
      .find((item: { productId: string }) => item.productId === 'silicone-utensils').available as number;
    const before = await inventory();
    let requests = 0;
    await page.route(`**/orders/${id}/${action}`, async route => {
      requests += 1;
      if (requests === 1) {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await page.reload();
    const row = page.locator('.retail-order').filter({ hasText: id.slice(0, 8) });
    await row.locator('summary').click();
    await row.getByRole('button', { name: action === 'refund' ? 'Simulate refund' : 'Simulate shipment' }).click();
    await page.getByRole('button', { name: action === 'refund' ? 'Retry refund' : 'Retry shipment' }).click();
    await expect(page.locator('.retail-action-error')).toHaveCount(0);
    expect(requests).toBe(2);
    expect(await inventory()).toBe(before + (action === 'refund' ? 1 : 0));
  });
}
