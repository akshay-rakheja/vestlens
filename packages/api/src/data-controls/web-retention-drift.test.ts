import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RETENTION } from "./retention.js";

// The Account page mirrors these periods in packages/web/src/retention.ts; update both together.
const webSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web", "src", "retention.ts"),
  "utf8",
);
const webDays = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(webSource)?.[1]);

describe("web retention copy", () => {
  it("matches the API retention periods", () => {
    expect(webDays("snapshots")).toBe(RETENTION.snapshotDays);
    expect(webDays("webhookEvents")).toBe(RETENTION.webhookEventDays);
  });
});
