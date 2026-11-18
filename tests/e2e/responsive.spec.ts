import { expect } from '@playwright/test';
import { origin as base, signIn, test } from './fixtures';

for (const width of [320, 390, 480, 600, 768, 820, 1024, 1440]) {
  test(`catalog, filters and cart at ${width}px`, async ({ page }) => {

    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    await expect(page.locator('.retail-product')).toHaveCount(4);
    const original = await page.locator('.retail-product').first().boundingBox();
    expect(original).not.toBeNull();

    for (const [category, count] of [
      ['Kitchen tools', 1], ['Cookware', 2], ['Food storage', 1], ['All products', 4],
    ] as const) {
      await page.getByRole('button', { name: category, exact: true }).click();
      await expect(page.locator('.retail-product')).toHaveCount(count);
      const cards = await page.locator('.retail-product').evaluateAll(elements =>
        elements.map(element => element.getBoundingClientRect().width));
      expect(Math.max(...cards)).toBeLessThanOrEqual(original!.width + 1);
      const imageHeights = await page.locator('.retail-photo').evaluateAll(images =>
        images.map(image => image.getBoundingClientRect().height));
      expect(Math.max(...imageHeights)).toBeLessThanOrEqual(220);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }

    await page.getByRole('button', { name: 'Kitchen tools', exact: true }).click();
    await page.getByRole('button', { name: 'View Silicone utensil set details' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Add Silicone utensil set to cart' }).click();
    await page.getByRole('button', { name: 'Increase Silicone utensil set quantity' }).click();
    await expect(page.getByLabel('Silicone utensil set quantity', { exact: true })).toHaveText('2');
    await page.getByRole('button', { name: 'Remove Silicone utensil set', exact: true }).click();
    await page.getByRole('button', { name: 'Keep item', exact: true }).click();
    await page.locator('#products').screenshot({ path: test.info().outputPath(`catalog-${width}.png`), animations: 'disabled' });
    await page.locator('#checkout').screenshot({ path: test.info().outputPath(`cart-${width}.png`), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    console.log(JSON.stringify({ width, cardWidth: original!.width, maxImageHeight: 220, overflow: false }));
  });
}

test('existing order at phone, tablet and desktop widths', async ({ page }) => {
  await signIn(page);
  const session = await (await page.request.get(base + '/api/session')).json();
  const placed = await page.request.post(`${base}/api/checkout/users/${session.userId}/orders/${crypto.randomUUID()}`, {
    headers: { [session.csrfHeader]: session.csrfToken },
    data: { items: [{ productId: 'nonstick-skillet', quantity: 1 }, { productId: 'silicone-utensils', quantity: 1 }] },
  });
  expect(placed.status()).toBe(200);
  const receipt = await placed.json();
  await page.reload();
  const order = page.locator('#orders details').filter({ hasText: receipt.orderId.slice(0, 8) });
  await order.locator('summary').click();
  for (const width of [320, 390, 600, 768, 820, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(order.locator('.retail-order-items img')).toHaveCount(2);
    await order.screenshot({ path: test.info().outputPath(`order-${width}.png`), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const imageWidths = await order.locator('img').evaluateAll(images =>
      images.map(image => image.getBoundingClientRect().width));
    expect(Math.max(...imageWidths)).toBeLessThanOrEqual(56);
  }
});
