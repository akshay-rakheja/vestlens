import { expect, test } from "@playwright/test";

// The owner signs in through the real form in a real browser. Hand-set Origin headers in API tests cannot catch a
// page whose referrer policy makes the browser send `Origin: null`.
const PASSWORD = "synthetic-e2e-password";

test("the right password signs in and sets the session cookie", async ({ page, context }) => {
  await page.goto("/login?continue=/health");
  await page.getByLabel("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/health");
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === "vl_session" && c.httpOnly)).toBe(true);
  const session = await page.request.get("/api/session");
  expect(await session.json()).toEqual({ signedIn: true });
});

test("a wrong password shows the error and stays signed out", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Owner password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("That password didn't work.");
  expect((await context.cookies()).some((c) => c.name === "vl_session")).toBe(false);
  const session = await page.request.get("/api/session");
  expect(await session.json()).toEqual({ signedIn: false });
});
