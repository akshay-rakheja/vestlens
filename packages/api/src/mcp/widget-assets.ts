import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "tfsa-room" is registered for get_contribution_room; "thesis", "limits" and "goal" for show_thesis, show_limits and
 * show_goal; "report-card" for show_report_card. Each is served only once its build exists.
 */
export type WidgetName = "overview" | "performance" | "activity" | "holdings" | "allocation" | "income" | "news" | "calendar" | "tfsa-room" | "thesis" | "limits" | "goal" | "report-card";
export interface WidgetAssets {
  html(name: WidgetName): string | null;
  uri(name: WidgetName): string | null;
  /** A brand font shipped with the widget build (dist/fonts/<file>), for the loader to serve; absent in tests. */
  font?(file: WidgetFont): Buffer | null;
}

/** The only font files a widget stylesheet names (packages/widgets/fonts); everything else under /widgets/fonts is a 404. */
export const WIDGET_FONTS = ["bricolage-grotesque-latin-wght-normal.woff2"] as const;
export type WidgetFont = (typeof WIDGET_FONTS)[number];

/**
 * Claude caches widget HTML by ui:// URI, so a fixed URI makes it render stale widget code
 * against new payloads after a deploy. The URI therefore carries a content hash.
 */
export function widgetUri(name: WidgetName, html: string): string {
  return `ui://portfolio/${name}-${createHash("sha256").update(html).digest("hex").slice(0, 10)}`;
}
/** Earlier fixed URIs, still readable (not listed) so old conversations keep working. */
export const LEGACY_WIDGET_URIS: Record<WidgetName, string> = {
  overview: "ui://portfolio/overview-v5",
  performance: "ui://portfolio/performance-v1",
  activity: "ui://portfolio/activity-v1",
  holdings: "ui://portfolio/holdings-v1",
  allocation: "ui://portfolio/allocation-v1",
  income: "ui://portfolio/income-v1",
  news: "ui://portfolio/news-v1",
  calendar: "ui://portfolio/calendar-v1",
  "tfsa-room": "ui://portfolio/tfsa-room-v1",
  thesis: "ui://portfolio/thesis-v1",
  limits: "ui://portfolio/limits-v1",
  goal: "ui://portfolio/goal-v1",
  "report-card": "ui://portfolio/report-card-v1",
};

/**
 * True for an earlier address of a known widget: its fixed legacy URI, or any content hash
 * (`<name>-<10 hex>`). Hosts can keep a tool list from before a deploy, even across an app
 * restart (seen in Claude on 2026-10-22), and then ask for the old hash; serving the current
 * HTML there keeps the widget working instead of "Unable to reach". Other names never match.
 * Loader addresses (`<name>-loader1-<10 hex>`, widget-loader.ts) are aliases too, so turning the
 * loader off serves the inline HTML there.
 */
export function isWidgetAlias(name: WidgetName, uri: string): boolean {
  return uri === LEGACY_WIDGET_URIS[name] || new RegExp(`^ui://portfolio/${name}-(loader1-)?[0-9a-f]{10}$`).test(uri);
}

export function withWidgetUris(source: { html(name: WidgetName): string | null; uri?: (name: WidgetName) => string | null; font?: (file: WidgetFont) => Buffer | null }): WidgetAssets {
  return {
    html: (name) => source.html(name),
    ...(source.font ? { font: source.font } : {}),
    uri(name) {
      if (source.uri) return source.uri(name);
      const html = source.html(name);
      return html === null ? null : widgetUri(name, html);
    },
  };
}

export function fileWidgetAssets(directory: string): WidgetAssets {
  const cache = new Map<WidgetName, string | null>();
  const html = (name: WidgetName) => {
    if (!cache.has(name)) {
      try { cache.set(name, readFileSync(join(directory, `${name}.html`), "utf8")); } catch { cache.set(name, null); }
    }
    return cache.get(name)!;
  };
  const fonts = new Map<WidgetFont, Buffer | null>();
  const font = (file: WidgetFont) => {
    if (!fonts.has(file)) {
      try { fonts.set(file, readFileSync(join(directory, "fonts", file))); } catch { fonts.set(file, null); }
    }
    return fonts.get(file)!;
  };
  return withWidgetUris({ html, font });
}

/** Rebinds a show tool's widget metadata to the content-hashed URI; other tools pass through. */
export function withToolWidgetUri<T extends { _meta?: unknown }>(tool: T, from: string, uri: string): T {
  const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined;
  if (meta?.ui?.resourceUri !== from) return tool;
  return { ...tool, _meta: { ...meta, ui: { ...meta.ui, resourceUri: uri }, "openai/outputTemplate": uri } };
}
