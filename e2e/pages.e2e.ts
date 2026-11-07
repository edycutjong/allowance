import { expect, test } from "@playwright/test";

const pages = [
  { path: "/", title: /Allowance/ },
  { path: "/deck/", title: /Allowance/ },
  { path: "/judge/", title: /for judges/ },
];

for (const p of pages) {
  test(`${p.path} loads with no console errors and no failed requests`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("requestfailed", (r) => errors.push(`failed: ${r.url()}`));
    page.on("response", (r) => r.url().startsWith(page.url().split("/").slice(0, 3).join("/")) && r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
    const res = await page.goto(p.path, { waitUntil: "networkidle" });
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(p.title);
    expect(errors).toEqual([]);
  });

  test(`${p.path} has no horizontal scroll`, async ({ page }) => {
    await page.goto(p.path, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test("landing has social card metadata", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/media\/og\.png/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
});
