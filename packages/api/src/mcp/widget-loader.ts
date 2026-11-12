import { createHash } from "node:crypto";
import express from "express";
import { WIDGET_FONTS, type WidgetAssets, type WidgetFont, type WidgetName } from "./widget-assets.js";

/**
 * Live widget loader.
 *
 * Hosts keep widget HTML by ui:// address and do not re-ask after a deploy. A loader widget's
 * resource is therefore a fixed page that loads the current build's JS and CSS from the app's own
 * origin on every open (`/widgets/<name>.js|css`, revalidated by ETag). The page and the scripts are
 * static build output: no portfolio data, tokens or identities; tool results hydrate them as before.
 */
export const LOADER_WIDGETS = [
  "overview", "performance", "activity", "holdings", "allocation", "income", "news", "calendar", "tfsa-room",
  "thesis", "limits", "goal", "report-card",
] as const satisfies readonly WidgetName[];
export type LoaderWidgetName = (typeof LOADER_WIDGETS)[number];

/** Each widget's `<title>` (packages/widgets/src/widgets/<name>/index.html). */
const TITLES: Record<LoaderWidgetName, string> = {
  overview: "Portfolio overview",
  performance: "Portfolio performance",
  activity: "Portfolio activity",
  holdings: "Portfolio holdings",
  allocation: "Portfolio allocation",
  income: "Portfolio income",
  news: "Portfolio news",
  calendar: "Portfolio calendar",
  "tfsa-room": "TFSA room",
  thesis: "Thesis check",
  limits: "Portfolio limits",
  goal: "Savings goal",
  "report-card": "Investing report card",
};

export function isLoaderWidget(name: string): name is LoaderWidgetName {
  return (LOADER_WIDGETS as readonly string[]).includes(name);
}

const MODULE_OPEN = '<script type="module" crossorigin>';

/**
 * Splits a built single-file widget into its inline module script and its stylesheet. Fails closed
 * (null) unless there is exactly one `<script type="module" crossorigin>` (and no other script) and
 * exactly one `<style>`.
 */
export function extractWidgetParts(html: string): { js: string; css: string } | null {
  const counts = partCounts(html);
  if (counts.scripts !== 1 || counts.styles !== 1) return null;
  const scriptStart = html.indexOf(MODULE_OPEN);
  if (scriptStart < 0) return null;
  const jsStart = scriptStart + MODULE_OPEN.length;
  const jsEnd = html.indexOf("</script>", jsStart);
  if (jsEnd < 0 || html.indexOf("</script>", jsEnd + 1) >= 0) return null;
  const style = /<style\b[^>]*>/.exec(html)!;
  const cssStart = style.index + style[0].length;
  const cssEnd = html.indexOf("</style>", cssStart);
  if (cssEnd < 0 || html.indexOf("</style>", cssEnd + 1) >= 0) return null;
  // The style must sit outside the script and vice versa.
  if (style.index > jsStart && style.index < jsEnd) return null;
  if (scriptStart > cssStart && scriptStart < cssEnd) return null;
  return { js: html.slice(jsStart, jsEnd), css: html.slice(cssStart, cssEnd) };
}

function partCounts(html: string) {
  return { scripts: (html.match(/<script\b/gi) ?? []).length, styles: (html.match(/<style\b/gi) ?? []).length };
}

function assertOrigin(origin: string): void {
  let ok = false;
  try {
    const url = new URL(origin);
    ok = (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin &&
      /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(origin);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("Invalid widget loader origin");
}

/** The fixed loader page: depends only on the widget name and the app origin, never on the build. */
export function widgetLoaderHtml(name: LoaderWidgetName, origin: string): string {
  assertOrigin(origin);
  const base = `${origin}/widgets/${name}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${TITLES[name]}</title>`,
    `<link rel="stylesheet" href="${base}.css">`,
    "<style>#w-loader{padding:12px 4px}#w-loader button{margin-left:8px;font:inherit}</style>",
    "</head>",
    '<body><div id="app"></div><div id="w-loader" class="w-muted">Loading…</div>',
    '<script type="module">',
    `const src = ${JSON.stringify(`${base}.js`)};`,
    'const note = document.getElementById("w-loader");',
    "let tries = 0;",
    "let current = null;",
    "function load() {",
    '  const script = document.createElement("script");',
    '  script.type = "module";',
    '  script.src = tries === 0 ? src : src + "?r=" + tries;',
    '  script.addEventListener("load", () => { note.remove(); });',
    '  script.addEventListener("error", () => {',
    '    note.textContent = "Couldn\'t load this view";',
    '    const retry = document.createElement("button");',
    '    retry.type = "button";',
    '    retry.textContent = "Try again";',
    '    retry.addEventListener("click", () => {',
    "      tries += 1;",
    "      if (current) current.remove();",
    '      note.textContent = "Loading…";',
    "      load();",
    "    });",
    "    note.append(retry);",
    "  });",
    "  current = script;",
    "  document.body.append(script);",
    "}",
    "load();",
    "</script>",
    "</body></html>",
  ].join("\n");
}

/** `loader1` versions the loader contract; it changes only if the loader page itself must change. */
export function widgetLoaderUri(name: LoaderWidgetName, loaderHtml: string): string {
  return `ui://portfolio/${name}-loader1-${createHash("sha256").update(loaderHtml).digest("hex").slice(0, 10)}`;
}

export interface WidgetPart { body: Buffer; etag: string; contentType: string }

export interface WidgetLoader {
  /** The app origin: the only script and style origin a loader page names. */
  readonly origin: string;
  enabled(name: WidgetName): boolean;
  html(name: WidgetName): string | null;
  uri(name: WidgetName): string | null;
  part(name: string, kind: "js" | "css"): WidgetPart | null;
  /** A brand font the widget stylesheets name (`fonts/<file>`, so `/widgets/fonts/<file>` on this origin). */
  font(file: string): WidgetPart | null;
}

function part(body: string | Buffer, contentType: string): WidgetPart {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return { body: bytes, contentType, etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"` };
}

/**
 * Builds the loader from the build in `assets`. Every known widget's JS and CSS is served whenever
 * its build splits cleanly, independent of `names`: a host may still hold a loader page after the
 * widget is dropped from `names`, and that page must keep loading. `names` only decides which
 * widgets' addresses point at loader pages (`enabled`/`html`/`uri`). A build that is not exactly one
 * module script and one style is never served and its widget stays inline (logged with counts only;
 * a missing build is logged only for a listed widget).
 */
export function createWidgetLoader(input: { names: readonly LoaderWidgetName[]; origin: string; assets: Pick<WidgetAssets, "html" | "font"> }): WidgetLoader {
  assertOrigin(input.origin);
  const listed = new Set<LoaderWidgetName>(input.names);
  const parts = new Map<LoaderWidgetName, { js: WidgetPart; css: WidgetPart }>();
  const pages = new Map<LoaderWidgetName, { html: string; uri: string }>();
  for (const name of LOADER_WIDGETS) {
    const built = input.assets.html(name);
    const split = built === null ? null : extractWidgetParts(built);
    if (!split) {
      if (built !== null || listed.has(name)) {
        const counts = built === null ? { scripts: 0, styles: 0 } : partCounts(built);
        console.warn(JSON.stringify({ event: "widget_loader_disabled", widget: name, ...counts }));
      }
      continue;
    }
    parts.set(name, { js: part(split.js, "text/javascript; charset=utf-8"), css: part(split.css, "text/css; charset=utf-8") });
    if (listed.has(name)) {
      const html = widgetLoaderHtml(name, input.origin);
      pages.set(name, { html, uri: widgetLoaderUri(name, html) });
    }
  }
  const fonts = new Map<string, WidgetPart>();
  for (const file of WIDGET_FONTS) {
    const bytes = input.assets.font?.(file as WidgetFont) ?? null;
    if (bytes) fonts.set(file, part(bytes, "font/woff2"));
  }
  const page = (name: string) => (isLoaderWidget(name) ? pages.get(name) : undefined);
  return {
    origin: input.origin,
    enabled: (name) => page(name) !== undefined,
    html: (name) => page(name)?.html ?? null,
    uri: (name) => page(name)?.uri ?? null,
    part: (name, kind) => (isLoaderWidget(name) ? parts.get(name)?.[kind] ?? null : null),
    font: (file) => fonts.get(file) ?? null,
  };
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag);
}

/**
 * `GET /widgets/<name>.js|css` for every known widget with a clean build, and `GET /widgets/fonts/<file>.woff2` for the
 * allow-listed brand fonts: public build output, no authentication. The
 * response reads only the path and If-None-Match, never cookies or auth headers; everything else
 * under /widgets is a 404 (it never falls through to the dashboard).
 */
export function widgetLoaderRouter(loader: WidgetLoader): express.Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use("/widgets", (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const match = /^\/([a-z]+(?:-[a-z]+)*)\.(js|css)$/.exec(request.path);
    const fontMatch = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(request.path);
    const found = match ? loader.part(match[1], match[2] as "js" | "css") : fontMatch ? loader.font(fontMatch[1]) : null;
    if (!found) {
      response.status(404).type("text/plain").send("Not found");
      return;
    }
    response.set({
      "Content-Type": found.contentType,
      "Cache-Control": "no-cache",
      ETag: found.etag,
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (matchesEtag(request.header("if-none-match"), found.etag)) {
      response.status(304).end();
      return;
    }
    response.set("Content-Length", String(found.body.length));
    response.status(200).end(request.method === "HEAD" ? undefined : found.body);
  });
  return router;
}
