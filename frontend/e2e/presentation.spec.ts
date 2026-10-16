import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".agent-card")).toHaveCount(15);
});
// Demo sessions alternate providers: "Explore a simpler navigation" and "Organize project
// references" are Claude Code sessions, "Give onboarding a warmer welcome" is Codex.
async function openCanvas(page: Page, title: RegExp) {
  await page.getByRole("button", { name: title }).click();
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  return page.getByRole("region", { name: "Nook Canvas" });
}
test("arranging is labelled a sample, honors a focus and can be refocused", async ({
  page,
}) => {
  const canvas = await openCanvas(page, /Explore a simpler navigation/);
  await expect(canvas.locator(".evidence-card")).toHaveCount(2);
  await expect(
    canvas.getByText(
      "Demo: arranging uses a built-in sample and sends nothing.",
    ),
  ).toBeVisible();
  await canvas
    .getByRole("button", { name: "Arrange with Claude Code" })
    .click();
  await expect(canvas.getByRole("button", { name: "Cancel" })).toBeVisible();
  const note = canvas.locator(".arrange-note");
  await expect(note).toContainText("Sample arrangement · no model ran");
  await expect(note).toContainText("2 of 2 records");
  await canvas.getByLabel("Focus").fill("navigation");
  await canvas
    .getByRole("button", { name: "Arrange with Claude Code" })
    .click();
  await expect(note).toContainText("focus “navigation”");
  await expect(note).toContainText("1 of 2 records");
  await expect(canvas.locator(".evidence-card")).toHaveCount(1);
  await canvas.getByLabel("Focus").fill("zzz");
  await canvas
    .getByRole("button", { name: "Arrange with Claude Code" })
    .click();
  await expect(
    canvas.getByText("Nothing in this session matched that focus."),
  ).toBeVisible();
  // Visual, Chat and Raw keep describing the same revision.
  const revision = await canvas.locator("p.help").innerText();
  await canvas.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(canvas.locator("p.help")).toHaveText(revision);
});
test("cancelling leaves the standard layout and nothing is retained", async ({
  page,
}) => {
  const canvas = await openCanvas(page, /Explore a simpler navigation/);
  await canvas
    .getByRole("button", { name: "Arrange with Claude Code" })
    .click();
  await canvas.getByRole("button", { name: "Cancel" }).click();
  await expect(canvas.locator(".arrange-note")).toHaveText(
    "Standard layout · Arranging cancelled.",
  );
  await expect(
    canvas.getByRole("button", { name: "Arrange with Claude Code" }),
  ).toBeEnabled();
  await expect(canvas.locator(".evidence-card")).toHaveCount(2);
  // The cancelled run must not apply itself after the demo's delay.
  await page.waitForTimeout(1000);
  await expect(canvas.locator(".arrange-note")).not.toContainText("Sample");
});
test("Codex sessions explain that arranging is unavailable", async ({
  page,
}) => {
  const canvas = await openCanvas(page, /Give onboarding a warmer welcome/);
  await expect(
    canvas.getByRole("button", { name: "Arrange with Codex" }),
  ).toBeDisabled();
  await expect(
    canvas.getByText("Arranging is available for Claude Code sessions."),
  ).toBeVisible();
});
test("new evidence returns to the standard layout until arranged again", async ({
  page,
}) => {
  const canvas = await openCanvas(page, /Organize project references/);
  await canvas
    .getByRole("button", { name: "Arrange with Claude Code" })
    .click();
  await expect(canvas.locator(".arrange-note")).toContainText(
    "Sample arrangement",
  );
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    canvas.getByRole("button", { name: "Refresh view" }),
  ).toBeVisible();
  // Until refreshed, everything still describes the arranged revision.
  await expect(canvas.locator(".arrange-note")).toContainText(
    "Sample arrangement",
  );
  await canvas.getByRole("button", { name: "Refresh view" }).click();
  await expect(canvas.locator(".arrange-note")).not.toContainText("Sample");
  await expect(canvas.locator(".evidence-card").first()).toBeVisible();
});
test("the Canvas arrange controls have no accessibility violations in light or dark", async ({
  page,
}) => {
  // Contrast audits measure settled themes, not intermediate transition colors.
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  const canvas = await openCanvas(page, /Explore a simpler navigation/);
  await canvas
    .getByRole("button", { name: "Arrange with Claude Code" })
    .click();
  await expect(canvas.locator(".arrange-note")).toContainText("Sample");
  const scan = () =>
    new AxeBuilder({ page }).include('[aria-label="Nook Canvas"]').analyze();
  expect((await scan()).violations).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect((await scan()).violations).toEqual([]);
});
