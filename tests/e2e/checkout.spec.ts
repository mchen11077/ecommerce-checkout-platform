import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { origin as base, signIn, test } from './fixtures';

const productId = 'nonstick-skillet';
const body = { items: [{ productId, quantity: 1 }] };
const csrf = async (page: Page) => {
  const session = await (await page.request.get(base + '/api/session')).json();
  return { [session.csrfHeader]: session.csrfToken };
};
const stock = async (page: Page) =>
  (await (await page.request.get(base + '/api/checkout/stock')).json())
    .find((item: { productId: string }) => item.productId === productId).available as number;

test('catalog, keyboard detail, filters and narrow layout', async ({page}) => {
  await page.setViewportSize({width:320,height:820});
  await page.goto(base);
  const detail = page.getByRole('button',{name:'View Nonstick skillet details'});
  await detail.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog',{name:'Nonstick skillet'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeFocused();
  await page.getByRole('button',{name:'Cookware',exact:true}).click();
  await expect(page.locator('.retail-photo')).toHaveCount(2);
  await page.locator('.retail-photo').evaluateAll(async imgs => {
    await Promise.all((imgs as HTMLImageElement[]).map(img => { img.loading='eager'; return img.decode(); }));
  });
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('guest checkout, server validation, CSRF, idempotency and stock', async ({page}) => {
  await page.goto(base);
  const headers = await csrf(page);
  const guest = base+'/api/checkout/guest/orders/';
  const start = await stock(page);
  await page.getByRole('button',{name:'Add Nonstick skillet to cart'}).click();
  const response = page.waitForResponse(r => r.url().startsWith(guest) && r.request().method()==='POST');
  await page.getByRole('button',{name:'Continue as guest'}).click();
  const placed = await response;
  expect(placed.status()).toBe(200);
  const receipt = await placed.json();
  expect(receipt.pricing).toMatchObject({subtotalCents:5000,discountCents:0,totalCents:5000});
  await expect(page.getByText(/Simulated payment complete/)).toBeVisible();
  const retry = await page.request.post(placed.url(),{headers,data:body});
  expect(await retry.json()).toEqual(receipt);
  expect(await stock(page)).toBe(start-1);
  const invalid = await page.request.post(guest+randomUUID(),{headers,data:{items:[{productId,quantity:0}]}});
  expect(invalid.status()).toBe(400);
  expect((await page.request.post(guest+randomUUID(),{data:body})).status()).toBe(403);
  const coupon = await page.request.post(guest+randomUUID(),{headers,data:{...body,couponId:1}});
  expect(coupon.status()).toBe(403);
  expect(await coupon.json()).toEqual({result:'SIGN_IN_FOR_COUPONS'});
  const insufficient = await page.request.post(guest+randomUUID(),{headers,data:{items:[{productId,quantity:99}]}});
  expect(insufficient.status()).toBe(409);
  expect(await insufficient.json()).toEqual({result:'INSUFFICIENT_STOCK'});
  expect(await stock(page)).toBe(start-1);
});

test('payment, refund, shipment, order history and ownership', async ({page}) => {
  await signIn(page);
  const headers = await csrf(page);
  const session = await (await page.request.get(base+'/api/session')).json();
  const orders = base+'/api/checkout/users/'+session.userId+'/orders/';
  const start = await stock(page);
  const place = async () => {
    const response = await page.request.post(orders+randomUUID(),{headers,data:body});
    expect(response.status()).toBe(200);
    return (await response.json()).orderId as string;
  };
  const refundId = await place();
  const shipId = await place();
  expect(await stock(page)).toBe(start-2);
  await page.reload();
  const row = (id:string) => page.locator('#orders details').filter({hasText:id.slice(0,8)});
  await row(refundId).locator('summary').click();
  await expect(row(refundId).getByText('Paid · simulated')).toBeVisible();
  await row(refundId).getByRole('button',{name:'Simulate refund'}).click();
  await expect(row(refundId).getByText('Refunded · simulated')).toBeVisible();
  expect((await page.request.post(orders+refundId+'/refund',{headers})).status()).toBe(200);
  expect(await stock(page)).toBe(start-1);
  await row(shipId).locator('summary').click();
  await row(shipId).getByRole('button',{name:'Simulate shipment'}).click();
  await expect(row(shipId).getByText('Shipped · simulated')).toBeVisible();
  expect((await page.request.post(orders+shipId+'/refund',{headers})).status()).toBe(409);
  expect((await page.request.get(base+'/api/checkout/users/201/orders')).status()).toBe(403);
  expect((await page.request.post(base+'/api/checkout/users/201/orders/'+shipId+'/ship',{headers})).status()).toBe(403);
  expect((await page.request.get(orders.slice(0,-1)+'?offset=-1')).status()).toBe(400);
  await page.reload();
  await row(shipId).locator('summary').click();
  await expect(row(shipId).getByText('Shipped · simulated')).toBeVisible();
});

test('lost response followed by refresh must not duplicate a guest order', async ({page}) => {
  await page.goto(base);
  const start = await stock(page);
  await page.getByRole('button',{name:'Add Nonstick skillet to cart'}).click();
  const submitted: string[] = [];
  await page.route('**/api/checkout/guest/orders/*',async route => {
    submitted.push(route.request().url());
    if (submitted.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await page.getByRole('button',{name:'Continue as guest'}).click();
  await expect(page.locator('#checkout').getByRole('alert')).toBeVisible();
  expect(await stock(page)).toBe(start-1);
  await page.reload();
  await page.getByRole('button',{name:'Retry order'}).click();
  await expect(page.getByText(/Simulated payment complete/)).toBeVisible();
  const end = await stock(page);
  console.log('Lost response: reused order ID = %s, units deducted = %d', submitted[0]===submitted[1], start-end);
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toBe(submitted[0]);
  expect(end).toBe(start-1);
});

test('signed-in checkout with a redeemed coupon recovers after refresh', async ({page}) => {
  await signIn(page);
  const name = 'Release duplicate offer';
  await page.locator('#offers article').filter({hasText:name}).getByRole('button',{name:'Claim offer'}).click();
  await page.getByRole('button',{name:'Add Nonstick skillet to cart'}).click();
  await page.getByRole('button',{name:'Increase Nonstick skillet quantity'}).click();
  await page.getByRole('button',{name:`Use ${name} at checkout`}).click();
  const confirm = page.getByRole('button',{name:'Confirm demo order'});
  await expect(confirm).toBeEnabled();
  const start = await stock(page);
  const attempts: {url:string; body:unknown}[] = [];
  await page.route('**/api/checkout/users/*/orders/*', async route => {
    attempts.push({url:route.request().url(), body:route.request().postDataJSON()});
    if (attempts.length === 1) {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await confirm.click();
  await expect(page.locator('#checkout').getByRole('alert')).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Retry order'}).click();
  await expect(page.getByText(/Simulated payment complete. Coupon used/)).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await stock(page)).toBe(start-2);
  const orderId = attempts[0].url.split('/').pop()!;
  await expect(page.locator('#orders details').filter({hasText:orderId.slice(0,8)})).toHaveCount(1);
});

test('guest can retry after a request fails before reaching the server', async ({page}) => {
  await page.goto(base);
  const start = await stock(page);
  await page.getByRole('button',{name:'Add Nonstick skillet to cart'}).click();
  await page.route('**/api/checkout/guest/orders/*', route => route.abort(), {times:1});
  const submit = page.getByRole('button',{name:'Continue as guest'});
  await submit.click();
  await expect(page.locator('#checkout').getByRole('alert')).toBeVisible();
  expect(await stock(page)).toBe(start);
  await page.reload();
  await page.getByRole('button',{name:'Retry order'}).click();
  await expect(page.getByText(/Simulated payment complete/)).toBeVisible();
  expect(await stock(page)).toBe(start-1);
});

test('two concurrent carts cannot oversell the same inventory', async ({page}) => {
  await page.goto(base);
  const headers = await csrf(page);
  const productId = 'glass-storage';
  const remainingStock = async () =>
    (await (await page.request.get(base + '/api/checkout/stock')).json())
      .find((item: { productId: string }) => item.productId === productId).available as number;
  const start = await remainingStock();
  expect(start).toBeGreaterThan(0);
  const guest = base+'/api/checkout/guest/orders/';
  const data = { items: [{productId,quantity:start}] };
  const responses = await Promise.all([
    page.request.post(guest+randomUUID(),{headers,data}),
    page.request.post(guest+randomUUID(),{headers,data}),
  ]);
  expect(responses.map(r=>r.status()).sort()).toEqual([200,409]);
  expect(await responses.find(r=>r.status()===409)?.json()).toEqual({result:'INSUFFICIENT_STOCK'});
  expect(await remainingStock()).toBe(0);
  await page.reload();
  await expect(page.getByRole('button',{name:'Add Glass storage set to cart'})).toBeDisabled();
});
