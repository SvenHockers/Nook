import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("saved workflow gates downstream work on explicitly accepted source evidence", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  await page.getByLabel("Workflow goal").fill("Ship a thoughtful welcome");
  await page
    .getByLabel("Task 1 name", { exact: true })
    .fill("Draft the welcome");
  await page
    .getByLabel("Task 1 brief", { exact: true })
    .fill("Write welcoming copy. Acceptance: clear next step.");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Task 2 name", { exact: true })
    .fill("Review the welcome");
  await page
    .getByLabel("Task 2 brief", { exact: true })
    .fill("Review the accepted draft for clarity.");
  await page
    .getByRole("checkbox", { name: "Draft the welcome", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Ship a thoughtful welcome",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Review the welcome.*Task: blocked/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Start task", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: /Draft the welcome.*Task: ready/ })
    .click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Draft the welcome.*Agent: completed/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect latest output", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept reviewed output", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Accept reviewed output", exact: true })
    .click();
  await expect(
    page.getByText(
      /This immutable handoff will be available to 1 dependent tasks/,
    ),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Accept and unlock dependent tasks",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: /Review the welcome.*Task: ready/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(page.locator(".source-record")).toContainText(
    "Simulated workflow output",
  );
  await page
    .getByRole("button", { name: /Review the welcome.*Task: ready/ })
    .click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Review the welcome.*Agent: completed/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect latest output", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Accept reviewed output", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Accept and unlock dependent tasks",
      exact: true,
    })
    .click();
  await expect(page.getByText("2 accepted / 2 tasks")).toBeVisible();
  await expect(page.getByText(/Nook · completed · revision/)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/nook-saved-workflow.png",
    fullPage: true,
  });
});
