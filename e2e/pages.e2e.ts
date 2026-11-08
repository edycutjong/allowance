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

test("landing, deck and judge footers show a semantic version", async ({ page, request }) => {
  const health = process.env.BASE_URL ? await (await request.get("/api/health")).json() : null;
  for (const path of ["/", "/deck/", "/judge/"]) {
    await page.goto(path);
    const versions = await page.locator("[data-version]").allTextContents();
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(v).toMatch(/^v\d+\.\d+\.\d+$/);
      // in production the stamped footer must equal the deployed version
      if (health) expect(v).toBe(`v${health.version}`);
    }
  }
});

test("landing links judges to /judge from the header and the footer", async ({ page }) => {
  await page.goto("/");
  const header = page.locator('header.top a[href="/judge"]');
  await expect(header).toBeVisible();          // the one header CTA left on phones
  await expect(page.locator('footer a[href="/judge"]')).toHaveCount(1);
  await header.click();
  await expect(page).toHaveURL(/\/judge\/?$/);
  await expect(page).toHaveTitle(/for judges/);
});
