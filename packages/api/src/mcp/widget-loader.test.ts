import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { loopbackRequest } from "../testing/loopback-request.js";
import { isWidgetAlias } from "./widget-assets.js";
import { createWidgetLoader, extractWidgetParts, LOADER_WIDGETS, widgetLoaderHtml, widgetLoaderRouter, widgetLoaderUri, type LoaderWidgetName } from "./widget-loader.js";

const ALL_WIDGETS = ["overview", "performance", "activity", "holdings", "allocation", "income", "news", "calendar", "tfsa-room", "thesis", "limits", "goal", "report-card"] as const;
/** Each widget's <title> in packages/widgets/src/widgets/<name>/index.html. */
const TITLES: Record<LoaderWidgetName, string> = {
  overview: "Portfolio overview", performance: "Portfolio performance", activity: "Portfolio activity", holdings: "Portfolio holdings",
  allocation: "Portfolio allocation", income: "Portfolio income", news: "Portfolio news", calendar: "Portfolio calendar", "tfsa-room": "TFSA room",
  thesis: "Thesis check", limits: "Portfolio limits", goal: "Savings goal", "report-card": "Investing report card",
};

const ORIGIN = "https://vestlens.example";
/** The shape packages/widgets/scripts/build.mjs produces (vite-plugin-singlefile). */
const built = (js: string, css: string) =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><title>Portfolio holdings</title>  <script type="module" crossorigin>${js}</script>\n<style rel="stylesheet" crossorigin>${css}</style>\n</head>\n<body><div id="app"></div></body></html>`;
const BUILD_A = built("console.log('a');", ".w-a{color:red}");
const BUILD_B = built("console.log('b'); const x = 1 < 2;", ".w-b{color:blue}");

describe("extractWidgetParts", () => {
  it("returns the single inline module script and style bodies", () => {
    expect(extractWidgetParts(BUILD_A)).toEqual({ js: "console.log('a');", css: ".w-a{color:red}" });
  });
  it.each([
    ["no script", "<style>a{}</style>"],
    ["no style", '<script type="module" crossorigin>x</script>'],
    ["two scripts", '<script type="module" crossorigin>x</script><script type="module" crossorigin>y</script><style>a{}</style>'],
    ["two styles", '<script type="module" crossorigin>x</script><style>a{}</style><style>b{}</style>'],
    ["an external script", '<script type="module" crossorigin src="/x.js"></script><style>a{}</style>'],
    ["a classic script", "<script>x</script><style>a{}</style>"],
    ["an extra classic script", '<script type="module" crossorigin>x</script><script>y</script><style>a{}</style>'],
    ["an unterminated script", '<script type="module" crossorigin>x<style>a{}</style>'],
  ])("fails closed on %s", (_label, html) => {
    expect(extractWidgetParts(html)).toBeNull();
  });
});

const BUILT_DIR = fileURLToPath(new URL("../../../widgets/dist/", import.meta.url));
describe.skipIf(!existsSync(`${BUILT_DIR}holdings.html`))("extractWidgetParts on the real widget build", () => {
  it.each(["holdings", "overview", "activity", "performance", "allocation", "income", "news", "calendar", "tfsa-room", "thesis", "limits", "goal", "report-card"])("splits dist/%s.html into one script and one style", (name) => {
    const html = readFileSync(`${BUILT_DIR}${name}.html`, "utf8");
    const parts = extractWidgetParts(html);
    expect(parts).not.toBeNull();
    expect(parts!.js.length).toBeGreaterThan(1000);
    expect(parts!.css.length).toBeGreaterThan(100);
    expect(parts!.js).not.toContain("</script>");
    expect(parts!.css).not.toContain("</style>");
  });
  it("serves each widget's own bundle through the loader (never another widget's)", () => {
    const html = (name: string) => readFileSync(`${BUILT_DIR}${name}.html`, "utf8");
    const loader = createWidgetLoader({ names: ALL_WIDGETS, origin: ORIGIN, assets: { html } as never });
    const bodies = new Map<string, string>();
    for (const name of ALL_WIDGETS) {
      expect(loader.enabled(name), name).toBe(true);
      const js = loader.part(name, "js")!.body.toString();
      expect(js, name).toBe(extractWidgetParts(html(name))!.js);
      expect(loader.part(name, "css")!.body.toString(), name).toBe(extractWidgetParts(html(name))!.css);
      bodies.set(name, js);
    }
    expect(new Set(bodies.values()).size).toBe(ALL_WIDGETS.length);
  });
});

describe("loader widget set", () => {
  it("covers all thirteen Vite widgets", () => {
    expect([...LOADER_WIDGETS].sort()).toEqual([...ALL_WIDGETS].sort());
  });
  it.each(ALL_WIDGETS)("%s: loader page names its own title, script and stylesheet, and its URI is its own alias", (name) => {
    const html = widgetLoaderHtml(name, ORIGIN);
    expect(html).toContain(`<title>${TITLES[name]}</title>`);
    expect(html).toContain(`<link rel="stylesheet" href="${ORIGIN}/widgets/${name}.css">`);
    expect(html).toContain(`"${ORIGIN}/widgets/${name}.js"`);
    for (const other of ALL_WIDGETS.filter((o) => o !== name)) expect(html, other).not.toContain(`/widgets/${other}.`);
    const uri = widgetLoaderUri(name, html);
    expect(uri).toMatch(new RegExp(`^ui://portfolio/${name}-loader1-[0-9a-f]{10}$`));
    expect(isWidgetAlias(name, uri)).toBe(true);
    for (const other of ALL_WIDGETS.filter((o) => o !== name)) expect(isWidgetAlias(other, uri), other).toBe(false);
  });
});

describe("widgetLoaderHtml", () => {
  const html = widgetLoaderHtml("holdings", ORIGIN);
  it("is fixed per origin and names only the origin's script and stylesheet", () => {
    expect(widgetLoaderHtml("holdings", ORIGIN)).toBe(html);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8"');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<title>Portfolio holdings</title>");
    expect(html).toContain(`<link rel="stylesheet" href="${ORIGIN}/widgets/holdings.css">`);
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('<div id="w-loader" class="w-muted">Loading…</div>');
    expect(html).toContain(`"${ORIGIN}/widgets/holdings.js"`);
    expect(html).toContain("Couldn't load this view");
    expect(html).toContain("Try again");
    expect(html).toContain("?r=");
    const urls = html.match(/https?:\/\/[^"'\s<>)]+/g) ?? [];
    expect(new Set(urls.map((u) => new URL(u).origin))).toEqual(new Set([ORIGIN]));
  });
  it("has no inline event-handler attributes and only one inline module script", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script type="module">']);
  });
  it("holds no data, tokens or identities", () => {
    for (const pattern of [/token/i, /bearer/i, /auth0/i, /secret/i, /password/i, /cookie/i, /localStorage/i, /\d{3,}\.\d{2}/, /@/]) {
      expect(html, String(pattern)).not.toMatch(pattern);
    }
  });
  it("refuses an origin that is not a bare http(s) origin", () => {
    for (const bad of ["https://a.example/path", "javascript:alert(1)", 'https://a.example"><script>', "https://a.example/"]) {
      expect(() => widgetLoaderHtml("holdings", bad), bad).toThrow();
    }
  });
  it("its URI is versioned and content-hashed, and an alias of holdings", () => {
    const uri = widgetLoaderUri("holdings", html);
    expect(uri).toBe(`ui://portfolio/holdings-loader1-${createHash("sha256").update(html).digest("hex").slice(0, 10)}`);
    expect(isWidgetAlias("holdings", uri)).toBe(true);
    expect(isWidgetAlias("activity", uri.replace("holdings", "activity"))).toBe(true);
    expect(isWidgetAlias("holdings", uri.replace("loader1", "loader2"))).toBe(false);
    expect(isWidgetAlias("activity", uri)).toBe(false);
  });
});

describe("createWidgetLoader", () => {
  const assets = (html: string | null) => ({ html: (name: string) => (name === "holdings" ? html : null), uri: () => null });
  it("is byte-identical across two builds with different widget code", () => {
    const a = createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: assets(BUILD_A) as never });
    const b = createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: assets(BUILD_B) as never });
    expect(a.enabled("holdings")).toBe(true);
    expect(a.html("holdings")).toBe(b.html("holdings"));
    expect(a.uri("holdings")).toBe(b.uri("holdings"));
    expect(a.part("holdings", "js")!.body.toString()).not.toBe(b.part("holdings", "js")!.body.toString());
    expect(a.html("holdings")).not.toContain("console.log");
  });
  it("disables a widget whose build is malformed or missing, logging counts only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const secretish = built("x", "a{}").replace("</style>", "</style><style>SECRET-STYLE</style>");
      const loader = createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: assets(secretish) as never });
      expect(loader.enabled("holdings")).toBe(false);
      expect(loader.html("holdings")).toBeNull();
      expect(loader.part("holdings", "js")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0][0]);
      expect(JSON.parse(logged)).toEqual({ event: "widget_loader_disabled", widget: "holdings", scripts: 1, styles: 2 });
      expect(logged).not.toContain("SECRET");
      expect(createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: assets(null) as never }).enabled("holdings")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
  it("keeps unlisted widgets' addresses inline but still serves their build (rollback keeps cached loaders working)", () => {
    const loader = createWidgetLoader({ names: [], origin: ORIGIN, assets: assets(BUILD_A) as never });
    expect(loader.enabled("holdings")).toBe(false);
    expect(loader.uri("holdings")).toBeNull();
    expect(loader.html("holdings")).toBeNull();
    expect(loader.part("holdings", "js")!.body.toString()).toBe("console.log('a');");
    expect(loader.part("holdings", "css")!.body.toString()).toBe(".w-a{color:red}");
    expect(loader.part("activity", "js")).toBeNull();
    expect(loader.part("dashboard", "js")).toBeNull();
  });
  it("does not log for an unlisted widget whose build is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      createWidgetLoader({ names: [], origin: ORIGIN, assets: assets(null) as never });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("widgetLoaderRouter", () => {
  const app = () => {
    const server = express();
    server.use(widgetLoaderRouter(createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: { html: (n: string) => (n === "holdings" ? BUILD_A : null), uri: () => null } as never })));
    server.use((_req, res) => { res.status(418).send("fallthrough"); });
    return server;
  };
  const etag = (body: string) => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

  it.each([
    ["js", "text/javascript; charset=utf-8", "console.log('a');"],
    ["css", "text/css; charset=utf-8", ".w-a{color:red}"],
  ])("serves holdings.%s with revalidation, CORS and nosniff headers", async (ext, type, body) => {
    const response = await (await loopbackRequest(app())).get(`/widgets/holdings.${ext}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(type);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers.etag).toBe(etag(body));
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.headers.vary).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.text).toBe(body);
  });

  it("serves only the allow-listed brand font, as font/woff2 with CORS, and 404s any other font path", async () => {
    const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]);
    const server = express();
    const font = (file: string) => (file === "bricolage-grotesque-latin-wght-normal.woff2" ? bytes : null);
    server.use(widgetLoaderRouter(createWidgetLoader({ names: ["holdings"], origin: ORIGIN, assets: { html: () => BUILD_A, uri: () => null, font } as never })));
    server.use((_req, res) => { res.status(418).send("fallthrough"); });
    const client = await loopbackRequest(server);
    const ok = await client.get("/widgets/fonts/bricolage-grotesque-latin-wght-normal.woff2").buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("font/woff2");
    expect(ok.headers["access-control-allow-origin"]).toBe("*");
    expect(ok.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(Buffer.compare(ok.body as Buffer, bytes)).toBe(0);
    for (const path of ["/widgets/fonts/other.woff2", "/widgets/fonts/%2e%2e%2fholdings.js", "/widgets/fonts/x.ttf"]) {
      expect((await client.get(path)).status, path).toBe(404);
    }
    // Without a font in the build, the path is a 404 too.
    expect((await (await loopbackRequest(app())).get("/widgets/fonts/bricolage-grotesque-latin-wght-normal.woff2")).status).toBe(404);
  });

  it("answers 304 to a matching If-None-Match and 200 to a stale one", async () => {
    const client = await loopbackRequest(app());
    const tag = etag("console.log('a');");
    const fresh = await client.get("/widgets/holdings.js").set("If-None-Match", tag);
    expect(fresh.status).toBe(304);
    expect(fresh.headers.etag).toBe(tag);
    expect(fresh.text).toBe("");
    expect((await client.get("/widgets/holdings.js").set("If-None-Match", `"other", ${tag}`)).status).toBe(304);
    expect((await client.get("/widgets/holdings.js").set("If-None-Match", '"stale"')).status).toBe(200);
  });

  it("is identical with and without cookies or auth headers", async () => {
    const client = await loopbackRequest(app());
    const plain = await client.get("/widgets/holdings.js");
    const withCreds = await client.get("/widgets/holdings.js").set("Cookie", "session=abc").set("Authorization", "Bearer abc");
    expect(withCreds.status).toBe(200);
    expect(withCreds.text).toBe(plain.text);
    for (const h of ["content-type", "cache-control", "etag", "access-control-allow-origin", "content-length"]) {
      expect(withCreds.headers[h], h).toBe(plain.headers[h]);
    }
  });

  it.each(ALL_WIDGETS)("serves the js and css of %s for every listed widget, with 304 on a matching ETag", async (name) => {
    const builds = (n: string) => built(`console.log(${JSON.stringify(n)});`, `.w-${n}{color:red}`);
    const server = express();
    server.use(widgetLoaderRouter(createWidgetLoader({ names: ALL_WIDGETS, origin: ORIGIN, assets: { html: builds } as never })));
    const client = await loopbackRequest(server);
    for (const [ext, type, body] of [["js", "text/javascript; charset=utf-8", `console.log(${JSON.stringify(name)});`], ["css", "text/css; charset=utf-8", `.w-${name}{color:red}`]] as const) {
      const response = await client.get(`/widgets/${name}.${ext}`);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(type);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers.etag).toBe(etag(body));
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(response.text).toBe(body);
      const fresh = await client.get(`/widgets/${name}.${ext}`).set("If-None-Match", etag(body));
      expect(fresh.status).toBe(304);
    }
  });

  it("with no widget listed (none listed) still serves every built widget with the same headers, and 404s unknown names", async () => {
    const builds = (n: string) => built(`console.log(${JSON.stringify(n)});`, `.w-${n}{color:red}`);
    const server = express();
    server.use(widgetLoaderRouter(createWidgetLoader({ names: [], origin: ORIGIN, assets: { html: builds } as never })));
    server.use((_req, res) => { res.status(418).send("fallthrough"); });
    const client = await loopbackRequest(server);
    for (const name of ALL_WIDGETS) {
      const body = `console.log(${JSON.stringify(name)});`;
      const response = await client.get(`/widgets/${name}.js`);
      expect(response.status, name).toBe(200);
      expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers.etag).toBe(etag(body));
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(response.text).toBe(body);
      expect((await client.get(`/widgets/${name}.js`).set("If-None-Match", etag(body))).status).toBe(304);
      expect((await client.get(`/widgets/${name}.css`)).status, name).toBe(200);
    }
    for (const path of ["/widgets/dashboard.js", "/widgets/secret.css", "/widgets/holdings.html", "/widgets/-.js", "/widgets/tfsa-.js", "/widgets/-tfsa.js", "/widgets/tfsa--room.js", "/widgets/tfsa-room-.css", "/widgets/tfsa-roomx.js"]) {
      expect((await client.get(path)).status, path).toBe(404);
    }
  });

  it("404s a widget whose build fails extraction (fails closed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = express();
      const malformed = built("x", "a{}") + "<style>b{}</style>";
      server.use(widgetLoaderRouter(createWidgetLoader({ names: [], origin: ORIGIN, assets: { html: (n: string) => (n === "news" ? malformed : BUILD_A) } as never })));
      const client = await loopbackRequest(server);
      expect((await client.get("/widgets/news.js")).status).toBe(404);
      expect((await client.get("/widgets/holdings.js")).status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("404s unlisted names, unknown extensions and malformed paths without falling through", async () => {
    const client = await loopbackRequest(app());
    for (const path of ["/widgets/activity.js", "/widgets/overview.css", "/widgets/holdings.html", "/widgets/holdings", "/widgets/..%2Fholdings.js", "/widgets/HOLDINGS.js"]) {
      const response = await client.get(path);
      expect(response.status, path).toBe(404);
      expect(response.text, path).not.toContain("console.log");
    }
  });
});

describe("loader script behaviour (fake DOM)", () => {
  type Listener = () => void;
  class FakeElement {
    textContent = "";
    type = "";
    src = "";
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    listeners = new Map<string, Listener[]>();
    constructor(public tag: string, public id = "") {}
    addEventListener(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    fire(event: string) { for (const l of this.listeners.get(event) ?? []) l(); }
    append(child: FakeElement) { child.parent = this; this.children.push(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  }
  function run() {
    const body = new FakeElement("body");
    const note = new FakeElement("div", "w-loader");
    note.textContent = "Loading…";
    body.append(note);
    const document = { body, getElementById: (id: string) => (id === "w-loader" ? note : null), createElement: (tag: string) => new FakeElement(tag) };
    // Setting textContent clears children, as in the DOM.
    const html = widgetLoaderHtml("holdings", ORIGIN);
    const code = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length, html.lastIndexOf("</script>"));
    const patched = code.replace(/note\.textContent = ([^;]+);/g, "note.textContent = $1; note.children = [];");
    new Function("document", patched)(document);
    const scripts = () => body.children.filter((c) => c.tag === "script");
    return { body, note, scripts };
  }

  it("appends the origin's module script and removes the note on load", () => {
    const { body, note, scripts } = run();
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]).toMatchObject({ type: "module", src: `${ORIGIN}/widgets/holdings.js` });
    scripts()[0].fire("load");
    expect(body.children).not.toContain(note);
  });

  it("on error shows the message and a Try again button that replaces the script with ?r=<count>", () => {
    const { body, note, scripts } = run();
    scripts()[0].fire("error");
    expect(note.textContent).toBe("Couldn't load this view");
    const button = note.children.find((c) => c.tag === "button")!;
    expect(button.textContent).toBe("Try again");
    button.fire("click");
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].src).toBe(`${ORIGIN}/widgets/holdings.js?r=1`);
    expect(note.textContent).toBe("Loading…");
    scripts()[0].fire("error");
    note.children.find((c) => c.tag === "button")!.fire("click");
    expect(scripts().map((s) => s.src)).toEqual([`${ORIGIN}/widgets/holdings.js?r=2`]);
    scripts()[0].fire("load");
    expect(body.children).not.toContain(note);
  });
});
