import { expect } from '@playwright/test';
import { origin as base, signIn, test } from './fixtures';

test('an offers outage should not hide an otherwise healthy catalog', async ({page}) => {
  await page.route('**/api/coupons', route => route.fulfill({status:503,json:{result:'TEMPORARY'}}));
  const catalog = page.waitForResponse(r => r.url() === base+'/api/checkout/products');
  await page.goto(base);
  expect((await catalog).status()).toBe(200);
  await expect(page.locator('#offers').getByRole('alert')).toHaveText('Could not load offers.');
  await expect(page.getByRole('button',{name:'View Nonstick skillet details'})).toBeVisible();
  await page.getByRole('button',{name:'Add Nonstick skillet to cart'}).click();
  await expect(page.getByRole('link',{name:'Cart (1)'})).toBeVisible();
  await page.unroute('**/api/coupons');
  await page.getByRole('button',{name:'Retry offers'}).click();
  await expect(page.locator('#offers').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#offers article').first()).toBeVisible();
  await expect(page.getByRole('link',{name:'Cart (1)'})).toBeVisible();
});

test('keyboard can open, operate and dismiss the coupon picker', async ({page}) => {
  await signIn(page);
  const picker = page.locator('.shop-coupon-picker');
  const summary = picker.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  const option = picker.getByRole('button',{name:'No coupon selected',exact:true});
  await expect(option).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(option).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(summary).toBeFocused();
  await expect(option).toBeHidden();
});
