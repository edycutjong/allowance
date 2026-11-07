import { expect, test } from "@playwright/test";

test("deck advances with the arrow key and updates the hash", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard navigation is a desktop interaction");
  await page.goto("/deck/");
  const before = page.url();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.url()).not.toBe(before);
});
