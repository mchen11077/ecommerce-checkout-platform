import { devices, expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const origin = 'http://localhost:5186';
const offerName = 'Release checkout offer';

test.beforeAll(async ({ request }) => {
  await expect.poll(async () => {
    const session = await request.get(`${origin}/api/session`);
    const identity = await request.get('http://localhost:8186/realms/coupons/.well-known/openid-configuration');
    return session.ok() && identity.ok();
  }, { timeout: 30_000 }).toBe(true);
});

async function signIn(page: Page, account: 'a' | 'b') {
  await page.goto(origin);
  await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
  await page.getByLabel('Username or email').fill(`shopper-${account}`);
  await page.getByLabel('Password', { exact: true }).fill(
    account === 'a' ? 'LocalShopperA-201!' : 'LocalShopperB-202!',
  );
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('accounts own their coupons and checkout survives a retry', async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage(devices['iPhone 13']);
  await b.goto(origin);
  await expect(b.getByText('Your cart is empty.')).toBeVisible();
  await b.getByRole('button', { name: 'Cookware', exact: true }).click();
  await expect(b.getByRole('button', { name: 'Add Silicone utensil set to cart' })).toHaveCount(0);
  await b.getByRole('button', { name: 'Add Nonstick skillet to cart' }).click();
  await signIn(a, 'a');
  const crossAccount = await a.request.get(`${origin}/api/users/202/coupons`);
  expect(crossAccount.status()).toBe(403);
  expect(await crossAccount.json()).toEqual({ result: 'FORBIDDEN' });
  const otherOrders = await a.request.get(`${origin}/api/checkout/users/202/orders`);
  expect(otherOrders.status()).toBe(403);

  await signIn(b, 'b');
  await expect(b.getByRole('checkbox', { name: /Nonstick skillet/ })).toBeChecked();
  const offer = b.getByRole('article').filter({ hasText: offerName });
  const wallet = b.locator('#wallet');
  await expect(wallet.getByText(offerName)).toHaveCount(0);
  await offer.getByRole('button', { name: 'Claim offer' }).click();
  await expect(b.getByText('Coupon added to My coupons.')).toBeVisible();
  await expect(offer.getByRole('button', { name: 'Claimed' })).toBeDisabled();
  await b.reload();
  const useCoupon = wallet.getByRole('button', { name: `Use ${offerName} at checkout` });
  await expect(useCoupon).toBeVisible();
  await b.route('**/api/checkout/quote?*', route => route.abort(), { times: 1 });
  await useCoupon.click();
  await b.getByRole('button', { name: 'Retry coupon check' }).click();
  const confirm = b.getByRole('button', { name: 'Confirm demo order' });
  await expect(b.getByText('$50.00 away from the minimum.')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await b.getByRole('button', { name: 'Add Stainless steel stockpot to cart' }).click();
  await expect(b.getByText('You save')).toBeVisible();
  await expect(confirm).toBeEnabled();
  const confirmation = b.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/orders/'));
  await confirm.click();
  const response = await confirmation;
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.pricing).toMatchObject({ subtotalCents: 12500, discountCents: 2000, totalCents: 10500 });
  await expect(b.getByText('Order confirmed for $105.00. Simulated payment complete. Coupon used.')).toBeVisible();
  const history = wallet.locator('details').filter({ hasText: offerName });
  await expect(history).not.toHaveAttribute('open');
  await history.locator('summary').click();
  await expect(history.getByText('Used', { exact: true }).first()).toBeVisible();
  const session = await (await b.request.get(`${origin}/api/session`)).json();
  expect(session.userId).toBe('202');
  const data = { items: receipt.items, couponId: receipt.couponId };
  const noCsrf = await b.request.post(response.url(), { data });
  expect(noCsrf.status()).toBe(403);
  const replay = await b.request.post(response.url(), {
    data,
    headers: { [session.csrfHeader]: session.csrfToken },
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const otherOrder = response.url().replace(receipt.orderId, randomUUID());
  const reused = await b.request.post(otherOrder, {
    data,
    headers: { [session.csrfHeader]: session.csrfToken },
  });
  expect(reused.status()).toBe(409);
  expect(await reused.json()).toEqual({ result: 'ALREADY_REDEEMED' });
  await b.reload();
  const order = b.locator('#orders details').filter({ hasText: receipt.orderId.slice(0, 8) });
  await order.locator('summary').click();
  await expect(order.getByText('1 × Nonstick skillet')).toBeVisible();
  await expect(order.getByText('1 × Stainless steel stockpot')).toBeVisible();
  await b.getByRole('button', { name: 'Sign out' }).click();
  await expect(b.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible();
});

test('prices a multi-item cart and preserves unselected items after checkout', async ({ page }) => {
  await signIn(page, 'a');
  await page.getByRole('button', { name: 'Add Nonstick skillet to cart' }).click();
  await page.getByRole('button', { name: 'Add Stainless steel stockpot to cart' }).click();
  const all = page.getByRole('checkbox', { name: 'Select all items' });
  const pot = page.getByRole('checkbox', { name: /Stainless steel stockpot/ });
  await all.check();
  await page.getByRole('button', { name: 'Increase Nonstick skillet quantity' }).click();
  await expect(page.locator('#checkout').getByText('$175.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Remove Stainless steel stockpot' }).click();
  await page.getByRole('button', { name: 'Keep item' }).click();
  await pot.uncheck();
  const confirmation = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/orders/'));
  await page.getByRole('button', { name: 'Confirm demo order' }).click();
  const response = await confirmation;
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.items).toEqual([{ productId: 'nonstick-skillet', quantity: 2 }]);
  expect(receipt.pricing.totalCents).toBe(10000);
  await expect(pot).not.toBeChecked();
  const session = await (await page.request.get(`${origin}/api/session`)).json();
  const headers = { [session.csrfHeader]: session.csrfToken };
  const replay = await page.request.post(response.url(), { headers, data: { items: receipt.items } });
  expect(await replay.json()).toEqual(receipt);
  const changed = await page.request.post(response.url(), {
    headers, data: { items: [{ productId: 'nonstick-skillet', quantity: 1 }] },
  });
  expect(changed.status()).toBe(409);
  const invalid = await page.request.post(response.url().replace(receipt.orderId, randomUUID()), {
    headers, data: { items: [{ productId: 'nonstick-skillet', quantity: 100 }] },
  });
  expect(invalid.status()).toBe(400);
  await page.getByRole('button', { name: 'Add Nonstick skillet to cart' }).click();
  await all.check();
  const fullOrder = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/orders/'));
  await page.getByRole('button', { name: 'Confirm demo order' }).click();
  const fullResponse = await fullOrder;
  expect(fullResponse.status()).toBe(200);
  expect(await fullResponse.json()).toMatchObject({
    items: [{ productId: 'nonstick-skillet', quantity: 1 }, { productId: 'stainless-stockpot', quantity: 1 }],
    pricing: { subtotalCents: 12500, totalCents: 12500 },
  });
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
});

test('concurrent claims respect inventory and reject duplicates', async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await Promise.all([signIn(a, 'a'), signIn(b, 'b')]);
  const catalog = await (await a.request.get(`${origin}/api/coupons`)).json();
  const race = catalog.find((coupon: { name: string }) => coupon.name === 'Release race offer');
  const duplicate = catalog.find((coupon: { name: string }) => coupon.name === 'Release duplicate offer');
  expect(race).toBeDefined();
  expect(duplicate).toBeDefined();

  async function claimAs(page: Page, userId: string) {
    const session = await (await page.request.get(`${origin}/api/session`)).json();
    expect(session.userId).toBe(userId);
    return async (couponId: number) => {
      const start = performance.now();
      const response = await page.request.post(`${origin}/api/coupons/${couponId}/claim?userId=${userId}`, {
        headers: { [session.csrfHeader]: session.csrfToken },
      });
      return { status: response.status(), result: (await response.json()).result, ms: performance.now() - start };
    };
  }

  const [claimA, claimB] = await Promise.all([claimAs(a, '201'), claimAs(b, '202')]);
  const raceResults = await Promise.all([claimA(race.id), claimB(race.id)]);
  expect(raceResults.map(item => item.result).sort()).toEqual(['OK', 'SOLD_OUT']);
  const duplicateResults = await Promise.all([claimA(duplicate.id), claimA(duplicate.id)]);
  expect(duplicateResults.map(item => item.result).sort()).toEqual(['ALREADY_CLAIMED', 'OK']);
  const start = performance.now();
  const burst = await Promise.all(Array.from({ length: 80 }, () => claimA(duplicate.id)));
  const elapsed = performance.now() - start;
  expect(burst.some(item => item.status === 429 && item.result === 'RATE_LIMITED')).toBe(true);
  expect(burst.every(item => item.status === 429 || item.result === 'ALREADY_CLAIMED')).toBe(true);
  const latency = burst.map(item => item.ms).sort((left, right) => left - right);
  console.log(JSON.stringify({
    requests: burst.length,
    limited: burst.filter(item => item.status === 429).length,
    unexpectedErrors: 0,
    p95Ms: Math.round(latency[Math.ceil(latency.length * 0.95) - 1]),
    requestsPerSecond: Math.round(burst.length * 1000 / elapsed),
  }));
});
