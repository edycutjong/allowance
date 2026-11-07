import { expect, test } from "@playwright/test";

// /judge must work for a judge with no account, no cookies and no session.
test.use({ storageState: { cookies: [], origins: [] } });

test("/judge is reachable without credentials and carries the claim", async ({ page }) => {
  const res = await page.goto("/judge/");
  expect(res?.status()).toBe(200);
  await expect(page.locator("#claim")).toContainText("the verdict is what the run did, not what the model believes");
});

test("/judge links the proof issues and the otari branch", async ({ page }) => {
  await page.goto("/judge/");
  for (const n of [1, 4, 5, 6, 7]) {
    await expect(page.locator(`a[href*="allowance-demo/issues/${n}"]`).first()).toBeVisible();
  }
  await expect(page.locator('a[href$="/allowance/tree/otari"]')).toBeVisible();
  await expect(page.locator('a[href$="/commit/948f1b4"]')).toBeVisible();
});

test("/judge says what is NOT claimed", async ({ page }) => {
  await page.goto("/judge/");
  await expect(page.getByText("Not claimed").first()).toBeVisible();
});
