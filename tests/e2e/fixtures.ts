import { expect, test as base, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const origin = process.env.E2E_BASE_URL ?? 'http://localhost:5186';
const identity = process.env.E2E_IDENTITY_URL ?? 'http://localhost:8186';
const realm = JSON.parse(readFileSync('../../deploy/keycloak/coupons-realm.json', 'utf8'));

export const test = base.extend({
  page: async ({ page, request }, use) => {
    await expect.poll(async () => {
      try {
        const [session, provider] = await Promise.all([
          request.get(origin + '/api/session'),
          request.get(identity + '/realms/coupons/.well-known/openid-configuration'),
        ]);
        return session.ok() && provider.ok();
      } catch {
        return false;
      }
    }, { timeout: 60_000 }).toBe(true);
    await use(page);
  },
});

export async function signIn(page: Page, account: 'a' | 'b' = 'b') {
  const fixture = realm.users.find((user: { username: string }) => user.username === 'shopper-' + account);
  if (!fixture) throw new Error('Demo account is missing from the Keycloak fixture.');
  await page.goto(origin);
  await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
  await page.getByLabel('Username or email').fill(fixture.username);
  await page.getByLabel('Password', { exact: true }).fill(fixture.credentials[0].value);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
