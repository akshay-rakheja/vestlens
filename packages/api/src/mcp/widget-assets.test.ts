import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileWidgetAssets, withWidgetUris, widgetUri, LEGACY_WIDGET_URIS } from "./widget-assets.js";

describe("widget asset URIs", () => {
  it("embeds a 10-hex content hash that changes with the HTML", () => {
    const a = widgetUri("overview", "<p>a</p>");
    expect(a).toMatch(/^ui:\/\/portfolio\/overview-[0-9a-f]{10}$/);
    expect(widgetUri("overview", "<p>a</p>")).toBe(a);
    expect(widgetUri("overview", "<p>b</p>")).not.toBe(a);
    expect(widgetUri("activity", "<p>a</p>")).toMatch(/^ui:\/\/portfolio\/activity-[0-9a-f]{10}$/);
  });
  it("file assets expose uri(name) and null when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "widgets-"));
    writeFileSync(join(dir, "overview.html"), "<p>x</p>");
    const assets = fileWidgetAssets(dir);
    expect(assets.uri("overview")).toBe(widgetUri("overview", "<p>x</p>"));
    expect(assets.uri("performance")).toBeNull();
  });
  it("withWidgetUris adds uri() to html-only assets", () => {
    const assets = withWidgetUris({ html: (n) => (n === "overview" ? "<p>o</p>" : null) });
    expect(assets.uri("overview")).toBe(widgetUri("overview", "<p>o</p>"));
    expect(assets.uri("activity")).toBeNull();
  });
  it("keeps the old fixed URIs as aliases", () => {
    expect(LEGACY_WIDGET_URIS).toEqual({ overview: "ui://portfolio/overview-v5", performance: "ui://portfolio/performance-v1", activity: "ui://portfolio/activity-v1", holdings: "ui://portfolio/holdings-v1", allocation: "ui://portfolio/allocation-v1", income: "ui://portfolio/income-v1", news: "ui://portfolio/news-v1", calendar: "ui://portfolio/calendar-v1", "tfsa-room": "ui://portfolio/tfsa-room-v1", thesis: "ui://portfolio/thesis-v1", limits: "ui://portfolio/limits-v1", goal: "ui://portfolio/goal-v1", "report-card": "ui://portfolio/report-card-v1" });
  });
});
