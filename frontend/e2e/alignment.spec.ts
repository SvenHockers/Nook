import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".agent-card")).toHaveCount(15);
});
test("workflow dependencies and handoff retain inspectable source", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Explore workflow reference example" })
    .click();
  await expect(
    page.getByText("Workflows runtime is not connected"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explore example" }).click();
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  await expect(
    page.getByText("Depends on: API contract + Sign-in interface"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page.getByRole("button", { name: /api-contract@r3/ }).click();
  await expect(page.getByText("Summary · sample")).toBeVisible();
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(page.locator(".source-record")).toContainText("sample-r3");
});
test("loop attempts stay independent of idle agent and contain no percentage", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Loops", exact: true }).click();
  await page.getByRole("button", { name: "Explore example" }).click();
  await expect(
    page.getByText("Clio is idle while external verification runs."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Attempt 3 / 5 · running" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "#1 · failed · 08:10" }).click();
  await expect(
    page.getByRole("heading", { name: "Attempt 1 / 5 · failed" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.getByText("TestReport · sample")).toBeVisible();
  await expect(page.locator(".work-page")).not.toContainText("%");
});
test("playground supports density and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Avatar playground" }).click();
  await page.getByLabel("15-agent density").check();
  await expect(page.locator(".pose-card")).toHaveCount(15);
  await page.getByLabel("Runtime state").selectOption("waiting_for_input");
  await expect(page.locator(".avatar-hero svg")).toHaveAttribute(
    "aria-label",
    "Clio · waiting for input",
  );
  expect(
    await page
      .locator(".avatar-hero .avatar-eyes")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
test("session Canvas exposes the same revision in all modes", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: /Review the accessibility basics/ })
    .click();
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Nook Canvas" });
  const revision = await canvas.locator("p.help").innerText();
  await canvas.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(canvas.locator("p.help")).toHaveText(revision);
  await canvas.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(canvas.locator("p.help")).toHaveText(revision);
  await expect(canvas.locator(".source-record")).toContainText("sessionId");
});
test("captures foundation and checks workspace accessibility", async ({
  page,
}) => {
  await page.screenshot({ path: "test-results/nook-home.png", fullPage: true });
  await page.getByRole("button", { name: "Avatar playground" }).click();
  await page.screenshot({
    path: "test-results/nook-avatar-playground.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Loops", exact: true }).click();
  await page.getByRole("button", { name: "Explore example" }).click();
  await page.screenshot({ path: "test-results/nook-loop.png", fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("dark workspaces retain accessible controls and context opens real assignments", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Avatar playground" }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByLabel("15-agent density").check();
  await page.screenshot({
    path: "test-results/nook-dark-density.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page
    .getByRole("button", {
      name: /Give onboarding a warmer welcome.*Inspect context/,
    })
    .click();
  await expect(
    page.getByText("Attached context is not an access boundary."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close agent details" }).click();
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Explore workflow reference example" })
    .click();
  await page.getByRole("button", { name: "Explore example" }).click();
  await page.screenshot({
    path: "test-results/nook-workflow-dark.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("new session evidence marks Canvas stale until explicit refresh", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: /Review the accessibility basics/ })
    .click();
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Nook Canvas" });
  await expect(canvas.locator(".evidence-card")).not.toHaveCount(0);
  if (await canvas.getByRole("button", { name: "Refresh view" }).isVisible())
    await canvas.getByRole("button", { name: "Refresh view" }).click();
  const previous = await canvas.locator("p.help").innerText();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    canvas.getByRole("button", { name: "Refresh view" }),
  ).toBeVisible();
  await expect(canvas.locator("p.help")).toHaveText(previous);
  await canvas.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(canvas.locator(".source-record")).not.toContainText(
    "Continue from where we left off.",
  );
  await canvas.getByRole("button", { name: "Refresh view" }).click();
  await expect(canvas.locator(".source-record")).toContainText(
    "Continue from where we left off.",
  );
});
