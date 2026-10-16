import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(
    page.getByRole("heading", { name: "A little space for big ideas." }),
  ).toBeVisible();
});
test("15 sessions stay navigable and approval controls resolve only their request", async ({
  page,
}) => {
  await expect(page.locator(".agent-card")).toHaveCount(15);
  await page
    .getByRole("button", { name: /Explore a simpler navigation/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Run the navigation tests?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".approval")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to overview" }).click();
  await page.getByRole("button", { name: /Review the latest changes/ }).click();
  await expect(
    page.getByRole("heading", { name: "Which approach feels right?" }),
  ).toBeVisible();
});
test("draft and theme survive navigation and reload", async ({ page }) => {
  await page
    .getByRole("button", { name: /Review the accessibility basics/ })
    .click();
  await page
    .getByRole("textbox", { name: "Message agent" })
    .fill("Keep this thought");
  await page.getByRole("button", { name: "Back to overview" }).click();
  await page
    .getByRole("button", { name: /Find the story in our interviews/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message agent" }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Back to overview" }).click();
  await page
    .getByRole("button", { name: /Review the accessibility basics/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message agent" }),
  ).toHaveValue("Keep this thought");
  await page.getByRole("button", { name: "Back to overview" }).click();
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page.getByRole("button", { name: "dark", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.waitForTimeout(450);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
test("launch, stop, and resume are available without a terminal", async ({
  page,
}) => {
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByLabel("What are we working on?").fill("A brand new task");
  await page.getByRole("button", { name: "Let’s get started" }).click();
  await expect(
    page.getByRole("heading", { name: "A brand new task" }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop agent", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByText("This is a demo response.", { exact: false }),
  ).toBeVisible();
});
test("overview has no serious accessibility violations", async ({ page }) => {
  const scan = await new AxeBuilder({ page }).analyze();
  expect(
    scan.violations
      .filter((v) => ["serious", "critical"].includes(v.impact || ""))
      .map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
  ).toEqual([]);
});
test("reduced motion and keyboard filtering", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("textbox", { name: "Search agents" }).fill("onboarding");
  await expect(page.locator(".agent-card")).toHaveCount(1);
  await page.screenshot({
    path: "test-results/nook-overview.png",
    fullPage: true,
  });
  expect(
    await page
      .locator(".agent-card")
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});
