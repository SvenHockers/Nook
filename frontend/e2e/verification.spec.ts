import { test, expect } from "@playwright/test";
test("checks require review of exact commands and demo never executes them", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: /Explore a simpler navigation/ })
    .click();
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  const panel = page.getByRole("region", { name: "Evidence and verification" });
  await panel.getByText("Verification checks", { exact: true }).click();
  await panel.getByText("Configure project checks", { exact: true }).click();
  const command = [
    {
      name: "Unit checks",
      argv: ["npm", "test", "--", "--run"],
      timeoutSeconds: 30,
      outputCap: 4096,
    },
  ];
  await panel.getByLabel(/Commands \(JSON/).fill(JSON.stringify(command));
  await panel.getByRole("button", { name: "Save checks", exact: true }).click();
  await panel
    .getByRole("button", { name: "Run Unit checks", exact: true })
    .click();
  const confirmation = panel.getByRole("group", {
    name: "Confirm project commands",
  });
  await expect(confirmation).toContainText('"--run"');
  await expect(panel).toContainText("not sandboxed");
  await confirmation
    .getByRole("button", { name: "Go back", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  await panel
    .getByRole("button", { name: "Run Unit checks", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Allow commands and run", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "demo never executes commands",
  );
  await panel
    .getByRole("button", { name: "Record evidence", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "does not measure a real workspace",
  );
});
