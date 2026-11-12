// Dev-only MCP Apps host for the widget gallery. It plays the host role of the JSON-RPC 2.0 postMessage protocol
// (see src/kit/bridge.ts) for each widget iframe and feeds it a synthetic fixture. No network service is called.
"use strict";

const WIDGETS = [
  { name: "overview", states: [{ fixture: "overview", label: "Portfolio overview" }, { fixture: "overview-cad", label: "Portfolio overview, CAD view" }] },
  { name: "holdings", states: [{ fixture: "holdings", label: "Holdings" }] },
  { name: "allocation", states: [{ fixture: "allocation", label: "Allocation" }] },
  { name: "performance", states: [{ fixture: "performance", label: "Performance" }, { fixture: "performance-all", label: "Performance, All with a yearly rate" }] },
  { name: "activity", states: [{ fixture: "activity", label: "Activity" }] },
  { name: "income", states: [{ fixture: "income", label: "Income" }] },
  { name: "calendar", states: [{ fixture: "calendar", label: "Calendar" }] },
  { name: "news", states: [{ fixture: "news", label: "News" }] },
  { name: "tfsa-room", states: [{ fixture: "tfsa-room", label: "TFSA room, known" }, { fixture: "tfsa-room-missing", label: "TFSA room, missing inputs" }] },
  { name: "limits", states: [{ fixture: "limits", label: "Limits" }] },
  { name: "goal", states: [{ fixture: "goal", label: "Savings goals" }] },
  { name: "thesis", states: [{ fixture: "thesis", label: "Thesis check" }, { fixture: "thesis-list", label: "Thesis list" }, { fixture: "thesis-holding", label: "Holding, no thesis" }] },
  { name: "report-card", states: [{ fixture: "report-card", label: "Report card" }, { fixture: "report-card-empty", label: "Report card, no activity yet" }] },
];

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const only = params.get("only");
document.documentElement.dataset.theme = theme;

// Fixtures hold date tokens so relative views (calendar weeks, "Today" in activity, "as of" times) stay current:
// "@today-3" and "@monday+4" are Toronto calendar dates, "@now" and "@now-3h" are ISO timestamps.
const TORONTO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
const DAY = 86400000;
function dateTokens() {
  const today = Date.parse(`${TORONTO.format(new Date())}T00:00:00Z`);
  return { today, monday: today - ((new Date(today).getUTCDay() + 6) % 7) * DAY };
}
function resolveTokens(value, base = dateTokens(), nowMs = Date.now()) {
  if (typeof value === "string") {
    const m = /^@(today|monday|now)(?:([+-])(\d+)([dh])?)?$/.exec(value);
    if (!m) return value;
    const sign = m[2] === "-" ? -1 : 1;
    const amount = m[3] ? Number(m[3]) : 0;
    if (m[1] === "now") return new Date(nowMs + sign * amount * (m[4] === "h" ? 3600000 : DAY)).toISOString();
    return new Date(base[m[1]] + sign * amount * DAY).toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) return value.map((v) => resolveTokens(v, base, nowMs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTokens(v, base, nowMs)]));
  return value;
}

const fixtureCache = new Map();
function loadFixture(name) {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(name, fetch(`./fixtures/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`fixture ${name}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return fixtureCache.get(name).then((raw) => resolveTokens(raw));
}

// ---- page ----
const nav = document.getElementById("nav");
const grid = document.getElementById("grid");
const link = (text, query, current) => {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = `?${query}`;
  if (current) a.setAttribute("aria-current", "true");
  nav.appendChild(a);
};
link("light", new URLSearchParams({ ...(only ? { only } : {}), theme: "light" }).toString(), theme === "light");
link("dark", new URLSearchParams({ ...(only ? { only } : {}), theme: "dark" }).toString(), theme === "dark");
link("all widgets", `theme=${theme}`, !only);
for (const w of WIDGETS) link(w.name, `theme=${theme}&only=${w.name}`, only === w.name);

const frames = new Map(); // contentWindow -> { name, fixture, iframe }
const shown = WIDGETS.filter((w) => !only || w.name === only);
if (only && shown.length === 0) {
  grid.textContent = `Unknown widget "${only}". Choose one of: ${WIDGETS.map((w) => w.name).join(", ")}.`;
}
for (const w of shown) {
  for (const state of w.states) {
    const figure = document.createElement("figure");
    figure.dataset.widget = w.name;
    figure.dataset.fixture = state.fixture;
    const caption = document.createElement("figcaption");
    caption.textContent = state.label.toLowerCase().startsWith(w.name) ? state.label : `${state.label} · ${w.name}`;
    const iframe = document.createElement("iframe");
    iframe.title = `${w.name}: ${state.label}`;
    iframe.width = "420";
    iframe.dataset.status = "loading";
    iframe.src = `../dist/${w.name}.html`;
    figure.append(caption, iframe);
    grid.appendChild(figure);
    frames.set(iframe, { name: w.name, fixture: state.fixture, iframe });
  }
}

// ---- host side of the protocol ----
const byWindow = () => new Map([...frames.values()].map((f) => [f.iframe.contentWindow, f]));
const reply = (frame, id, result) => frame.iframe.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
const fail = (frame, id, message) => frame.iframe.contentWindow.postMessage({ jsonrpc: "2.0", id, error: { code: -32000, message } }, "*");
const notify = (frame, method, params) => frame.iframe.contentWindow.postMessage({ jsonrpc: "2.0", method, params }, "*");

const SKIPPED_GETTERS = new Set(["get_symbol_history", "get_intraday"]);
async function callTool(frame, name, args) {
  const payload = await loadFixture(frame.fixture);
  const toolResult = (structuredContent) => ({ structuredContent, content: [{ type: "text", text: "Synthetic gallery data." }] });
  if (name === "save_portfolio_settings") return toolResult({});
  if (name === "get_overview_series") return toolResult(payload.series);
  if (name === "get_activity_page") return toolResult(args && args.cursor ? { ...payload, rows: [], nextCursor: null } : payload);
  if ((name.startsWith("show_") || name.startsWith("get_")) && !SKIPPED_GETTERS.has(name)) return toolResult(payload);
  return { isError: true, content: [{ type: "text", text: `The gallery does not serve ${name}.` }] };
}

async function sendFixture(frame) {
  try {
    const structuredContent = await loadFixture(frame.fixture);
    notify(frame, "ui/notifications/tool-input", { arguments: {} });
    notify(frame, "ui/notifications/tool-result", { structuredContent, content: [{ type: "text", text: "Synthetic gallery data." }] });
    frame.iframe.dataset.status = "sent";
  } catch (error) {
    frame.iframe.dataset.status = "fixture-error";
    console.error(error);
  }
}

window.addEventListener("message", (event) => {
  const frame = byWindow().get(event.source);
  const message = event.data;
  if (!frame || !message || message.jsonrpc !== "2.0") return;
  const { id, method, params } = message;
  switch (method) {
    case "ui/initialize":
      reply(frame, id, {
        protocolVersion: params && params.protocolVersion,
        hostInfo: { name: "vestlens-widget-gallery", version: "0.0.0" },
        hostContext: { theme, locale: "en-CA", timeZone: "America/Toronto", displayMode: "inline" },
        hostCapabilities: { serverTools: {} },
      });
      frame.iframe.style.colorScheme = theme;
      break;
    case "ui/notifications/initialized":
      void sendFixture(frame);
      break;
    case "ui/notifications/size-changed":
      if (params && Number.isFinite(params.height)) frame.iframe.style.height = `${Math.ceil(params.height)}px`;
      break;
    case "tools/call":
      callTool(frame, String(params && params.name), (params && params.arguments) || {}).then((r) => reply(frame, id, r), (e) => fail(frame, id, String(e && e.message || e)));
      break;
    case "ui/message":
    case "ui/update-model-context":
      console.info(`[gallery] ${frame.name} -> chat:`, params && params.content && params.content[0] && params.content[0].text);
      if (id !== undefined) reply(frame, id, {});
      break;
    case "ui/open-link":
      console.info(`[gallery] ${frame.name} asked to open a link (not opened)`);
      if (id !== undefined) reply(frame, id, {});
      break;
    default:
      if (id !== undefined && method) fail(frame, id, `Unsupported method ${method}`);
  }
});
