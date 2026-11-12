// Synthetic host only: no network, credentials, provider SDK, or database access.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { portfolioWidgetHtml, PORTFOLIO_WIDGET_URI } from "../packages/api/src/mcp/portfolio-widget.ts";

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.attributes = {};
    this.text = "";
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(n => n.textContent).join(" "); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ""; this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}

function host({ openai, synchronousInitialize = false, root, globals = {} } = {}) {
  const ids = new Map(["totals", "groups", "status", "generated", "refresh"].map(id => [id, new Element("div")]));
  ids.get("refresh").disabled = true; // Matches the initial button attribute in the HTML.
  const listeners = new Map();
  const sent = [];
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;
  const parent = {
    postMessage(message) {
      sent.push(structuredClone(message));
      if (synchronousInitialize && message.method === "ui/initialize") reply(message, initialized());
    },
  };
  const window = {
    parent, openai,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  function message(data, source = parent) {
    for (const fn of listeners.get("message") ?? []) fn({ data, source });
  }
  function reply(request, result) { message({ jsonrpc: "2.0", id: request.id, result }); }
  const context = vm.createContext({
    window,
    document: { getElementById: id => ids.get(id), createElement: tag => new Element(tag), documentElement: root, body: root },
    ...globals,
    Intl, Map, Set, Promise, Error, Number, Array, String,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const html = portfolioWidgetHtml();
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return {
    ids, sent, timers, listeners, reply, message, html,
    async ready(capabilities = { serverTools: {} }) {
      const request = sent.find(m => m.method === "ui/initialize");
      assert.ok(request, "widget must initiate the MCP Apps handshake");
      reply(request, initialized(capabilities));
      await flush();
    },
    output(result = portfolio()) { message({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: result } }); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    },
    setTime(milliseconds) { now = milliseconds; },
    descendants(id) {
      const all = [];
      function visit(node) { all.push(node); node.children.forEach(visit); }
      visit(ids.get(id));
      return all;
    },
  };
}

const initialized = (hostCapabilities = { serverTools: {} }, extra = {}) => ({ protocolVersion: "2026-01-26", hostCapabilities, hostInfo: { name: "synthetic", version: "1" }, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const account = (id, group, currency = "CAD") => ({
  id, name: "Synthetic account", institution: "Synthetic brokerage", positionCount: 1,
  classification: { group, groupLabel: group, bucket: group, bucketLabel: group, label: "Synthetic account" },
  value: { amount: 100, currency, asOf: "2026-01-01T00:00:00Z" },
  freshness: { positionsAsOf: "2026-01-01T00:00:00Z", holdingsLastSyncedAt: "2025-12-31T00:00:00Z", initialSyncCompleted: true, holdingsUnavailable: false },
  positions: [], warnings: [],
});
const portfolio = () => ({
  generatedAt: "2026-01-02T00:00:00Z", connectionRequired: false, errors: [],
  totals: [{ amount: 100, currency: "CAD" }, { amount: 100, currency: "USD" }],
  accounts: [account("synthetic-a", "registered"), account("synthetic-b", "non_registered", "USD"), account("synthetic-c", "credit_products"), account("synthetic-d", "closed")],
});
const toolCalls = h => h.sent.filter(m => m.method === "tools/call");
const accountButton = h => h.descendants("groups").find(n => n.className === "account-button");
const detailPanel = h => h.descendants("groups").find(n => n.className === "details");

test("initializes before enabling interaction and tolerates an immediate parent response", async () => {
  const h = host({ synchronousInitialize: true });
  await flush();
  assert.equal(h.sent[0]?.method, "ui/initialize");
  assert.equal(h.sent[0].params.protocolVersion, "2026-01-26");
  assert.equal(PORTFOLIO_WIDGET_URI, "ui://portfolio/dashboard-v4");
  assert.equal(h.sent[0].params.appInfo.version, "4.0.0");
  assert.ok(h.sent[0].params.appInfo.name);
  assert.ok(h.sent[0].params.appCapabilities);
  assert.ok(h.sent.some(m => m.method === "ui/notifications/initialized"));
  assert.equal(h.timers.size, 0, "initialization timeout must be cleared");
});

test("ignores other windows and malformed notifications; keeps native currencies and groups", async () => {
  const h = host();
  await h.ready();
  h.message({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: portfolio() } }, {});
  h.message({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: {} } });
  assert.equal(h.ids.get("groups").children.length, 0);
  h.output();
  assert.equal(h.ids.get("totals").children.length, 2);
  assert.match(h.ids.get("totals").textContent, /CAD/);
  assert.match(h.ids.get("totals").textContent, /USD/);
  assert.equal(h.ids.get("groups").children.length, 4);
  assert.match(h.ids.get("generated").textContent, /assembled|generated/i);
  assert.match(h.ids.get("generated").textContent, /brokerage|sync/i);
  assert.match(h.ids.get("groups").textContent, /synced|positions as of/i);
});

test("holdings call is read-only and timeout releases pending state; late replies cannot overwrite it", async () => {
  const h = host();
  await h.ready(); h.output();
  accountButton(h).onclick();
  await flush();
  const request = toolCalls(h).at(-1);
  assert.equal(request.params.name, "get_account_positions");
  assert.deepEqual(request.params.arguments, { accountId: "synthetic-a" });
  h.advance(15000); await flush();
  assert.equal(h.timers.size, 0);
  assert.match(detailPanel(h).textContent, /could not be loaded/i);
  h.reply(request, { structuredContent: { positions: [{ symbol: "Late synthetic position" }] } });
  await flush();
  assert.doesNotMatch(detailPanel(h).textContent, /Late synthetic/);
});

test("MCP isError does not masquerade as an empty holdings list or reveal provider text", async () => {
  const h = host();
  await h.ready(); h.output(); accountButton(h).onclick(); await flush();
  h.reply(toolCalls(h).at(-1), { isError: true, content: [{ type: "text", text: "synthetic private diagnostic" }] });
  await flush();
  assert.match(detailPanel(h).textContent, /could not be loaded/i);
  assert.doesNotMatch(detailPanel(h).textContent, /private diagnostic|No positions/);
});

test("reload uses the data tool once, rate-limits duplicate clicks, and keeps prior values on failure", async () => {
  const h = host();
  await h.ready(); h.output();
  const before = h.ids.get("totals").textContent;
  h.ids.get("refresh").onclick(); h.ids.get("refresh").onclick(); await flush();
  assert.equal(toolCalls(h).length, 1);
  const request = toolCalls(h)[0];
  assert.equal(request.params.name, "get_portfolio_snapshot");
  h.reply(request, { isError: true }); await flush();
  assert.equal(h.ids.get("totals").textContent, before);
  assert.match(h.ids.get("status").textContent, /previous|last.*data/i);
  h.ids.get("refresh").onclick(); await flush();
  assert.equal(toolCalls(h).length, 1);
  h.advance(10000); await flush();
  h.ids.get("refresh").onclick(); await flush();
  assert.equal(toolCalls(h).length, 2);
});

test("reload hydrates a fresh result without calling the render tool", async () => {
  const h = host();
  await h.ready(); h.output(); h.ids.get("refresh").onclick(); await flush();
  const next = portfolio(); next.totals[0].amount = 200;
  h.reply(toolCalls(h)[0], { structuredContent: next }); await flush();
  assert.match(h.ids.get("totals").textContent, /200/);
  assert.equal(toolCalls(h).length, 1);
  assert.equal(toolCalls(h)[0].params.name, "get_portfolio_snapshot");
});

test("capability negotiation disables unavailable tool access", async () => {
  const h = host();
  await h.ready({}); h.output();
  assert.equal(h.ids.get("refresh").disabled, true);
  assert.equal(accountButton(h).disabled, true);
  assert.equal(toolCalls(h).length, 0);
});

test("feature-detected legacy tool bridge also times out", async () => {
  let calls = 0;
  const h = host({ openai: { toolOutput: portfolio(), callTool() { calls++; return new Promise(() => {}); } } });
  h.ids.get("refresh").onclick(); await flush();
  assert.equal(calls, 1);
  h.advance(15000); await flush();
  assert.match(h.ids.get("status").textContent, /previous|last.*data/i);
  assert.equal(h.timers.size, 0);
});

test("teardown replies, releases timers/listeners and rejects pending work", async () => {
  const h = host();
  await h.ready(); h.output(); accountButton(h).onclick(); await flush();
  h.message({ jsonrpc: "2.0", id: "synthetic-teardown", method: "ui/resource-teardown", params: {} });
  await flush();
  assert.ok(h.sent.some(m => m.id === "synthetic-teardown" && m.result));
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.get("message").size, 0);
  assert.equal(h.ids.get("refresh").disabled, true);
});

test("missing sync timestamps and partial results do not imply fresh brokerage data", async () => {
  const h = host();
  await h.ready(); const data = portfolio();
  data.accounts[0].freshness = { holdingsUnavailable: true, initialSyncCompleted: false };
  data.errors = [{ accountId: "synthetic-missing", code: "account_data_unavailable" }];
  h.output(data);
  assert.match(h.ids.get("groups").textContent, /sync.*(unknown|pending)|holdings unavailable/i);
  assert.match(h.ids.get("status").textContent, /temporarily unavailable/i);
  assert.doesNotMatch(h.html, /Live · read only/);
});

// Claude and other spec hosts: negotiated version, host theme and iframe sizing.
const syntheticRoot = (scrollHeight = 640) => ({ style: {}, scrollHeight });
const sizeReports = h => h.sent.filter(m => m.method === "ui/notifications/size-changed");
async function initializeWith(h, result) {
  h.reply(h.sent.find(m => m.method === "ui/initialize"), result);
  await flush();
}

test("normal mode accepts a host-negotiated protocol version", async () => {
  const h = host();
  await initializeWith(h, initialized({ serverTools: {} }, { protocolVersion: "2025-11-21" }));
  h.output();
  assert.equal(accountButton(h).disabled, false);
  assert.equal(h.ids.get("refresh").disabled, false);
});

test("normal mode still rejects a missing protocol version", async () => {
  const h = host();
  await initializeWith(h, { hostCapabilities: { serverTools: {} } });
  h.output();
  assert.equal(accountButton(h).disabled, true);
  assert.equal(toolCalls(h).length, 0);
});

test("follows the host theme from initialize and later context changes", async () => {
  const root = syntheticRoot();
  const h = host({ root });
  await initializeWith(h, initialized({ serverTools: {} }, { hostContext: { theme: "dark" } }));
  assert.equal(root.style.colorScheme, "dark");
  h.message({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  assert.equal(root.style.colorScheme, "light");
  h.message({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "neon" } });
  assert.equal(root.style.colorScheme, "light", "unknown themes are ignored");
});

test("reports content height to the host only after initialization and only on change", async () => {
  const root = syntheticRoot(500);
  const h = host({ root });
  await flush();
  assert.equal(sizeReports(h).length, 0, "no notifications before the handshake completes");
  await h.ready();
  assert.deepEqual(sizeReports(h).at(-1)?.params, { height: 500 });
  const before = sizeReports(h).length;
  root.scrollHeight = 500; h.output(); await flush();
  assert.equal(sizeReports(h).length, before, "unchanged height is not re-reported");
  root.scrollHeight = 920; h.output(); await flush();
  assert.deepEqual(sizeReports(h).at(-1)?.params, { height: 920 });
});

test("observes layout changes when ResizeObserver is available and disconnects on teardown", async () => {
  const root = syntheticRoot(300);
  const observers = [];
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const h = host({ root, globals: { ResizeObserver } });
  await h.ready();
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, root);
  root.scrollHeight = 777; observers[0].callback([]);
  await flush();
  assert.deepEqual(sizeReports(h).at(-1)?.params, { height: 777 });
  h.message({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} });
  assert.equal(observers[0].disconnected, true);
  const after = sizeReports(h).length;
  root.scrollHeight = 10; observers[0].callback([]); await flush();
  assert.equal(sizeReports(h).length, after, "no size reports after teardown");
});

test("normal-mode reload asks the server for fresh brokerage data", async () => {
  const h = host();
  await h.ready(); h.output();
  h.ids.get("refresh").onclick(); await flush();
  assert.deepEqual(toolCalls(h)[0].params, { name: "get_portfolio_snapshot", arguments: { refresh: true } });
});

test("stale fallback data is labelled with its last read time", async () => {
  const h = host();
  await h.ready();
  h.output({ ...portfolio(), cache: { source: "last_good", loadedAt: "2026-01-01T09:00:00Z", stale: true, staleReason: "provider_unavailable" } });
  assert.match(h.ids.get("status").textContent, /could not be reached|out of date/i);
  assert.ok(h.ids.get("totals").children.length > 0, "stale values remain visible, clearly labelled");
  h.output(portfolio());
  assert.doesNotMatch(h.ids.get("status").textContent, /could not be reached|out of date/i);
});
