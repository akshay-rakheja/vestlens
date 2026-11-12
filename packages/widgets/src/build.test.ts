// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");

test("every widget builds to one self-contained HTML file", () => {
  execFileSync(process.execPath, [resolve(root, "scripts/build.mjs")], { cwd: root, stdio: "pipe" });
  const html = readFileSync(resolve(root, "dist/overview.html"), "utf8");
  expect(html).toContain("Portfolio overview");
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/<link[^>]+href=/);
  expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
}, 120_000);
