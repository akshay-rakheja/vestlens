import { createBridge, UI_PROTOCOL_VERSION } from "./bridge";

function fakeHost() {
  const sent: any[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const parent = { postMessage: (message: any) => sent.push(structuredClone(message)) };
  const win = {
    parent,
    addEventListener: (_: string, fn: any) => listeners.add(fn),
    removeEventListener: (_: string, fn: any) => listeners.delete(fn),
    document: { documentElement: { scrollHeight: 2000, style: {} as Record<string, string> }, body: { height: 480, getBoundingClientRect() { return { height: this.height }; } } },
  } as unknown as Window;
  const deliver = (data: unknown) => listeners.forEach((fn) => fn({ data, source: parent } as unknown as MessageEvent));
  const reply = (request: any, result: unknown) => deliver({ jsonrpc: "2.0", id: request.id, result });
  return { win, sent, deliver, reply, listeners };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("initializes with the negotiated version and reports theme, size and tool access", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  const init = host.sent.find((m) => m.method === "ui/initialize");
  expect(init.params.protocolVersion).toBe(UI_PROTOCOL_VERSION);
  host.reply(init, { protocolVersion: "2025-11-21", hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } });
  const ready = await bridge.ready;
  expect(ready).toEqual({ hostTools: true, context: { theme: "dark" } });
  expect(host.sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
  await tick();
  expect(host.sent.find((m) => m.method === "ui/notifications/size-changed")?.params).toEqual({ height: 480 });
  expect((host.win as any).document.documentElement.style.colorScheme).toBe("dark");
});

test("delivers tool results and context changes; ignores other windows", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  const results: unknown[] = [];
  const contexts: unknown[] = [];
  bridge.onToolResult((r) => results.push(r));
  bridge.onContext((c) => contexts.push(c));
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { a: 1 } } });
  host.listeners.forEach((fn) => fn({ data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} }, source: {} } as unknown as MessageEvent));
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  expect(results).toEqual([{ structuredContent: { a: 1 } }]);
  expect(contexts).toEqual([{ theme: "light" }]);
});

test("callTool, sendMessage and updateModelContext use the host methods and time out", async () => {
  vi.useFakeTimers();
  const host = fakeHost();
  const bridge = createBridge(host.win, { timeoutMs: 1000 });
  const call = bridge.callTool("get_overview_series", { period: "1M" });
  const request = host.sent.find((m) => m.method === "tools/call");
  expect(request.params).toEqual({ name: "get_overview_series", arguments: { period: "1M" } });
  host.reply(request, { structuredContent: { ok: true } });
  await expect(call).resolves.toEqual({ structuredContent: { ok: true } });
  const message = bridge.sendMessage("Explain my largest holding");
  expect(host.sent.at(-1)).toMatchObject({ method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Explain my largest holding" }] } });
  vi.advanceTimersByTime(1001);
  await expect(message).rejects.toThrow(/timed out/);
  void bridge.updateModelContext("Viewing overview, period YTD");
  expect(host.sent.at(-1)).toMatchObject({ method: "ui/update-model-context", params: { content: [{ type: "text", text: "Viewing overview, period YTD" }] } });
  vi.useRealTimers();
});

test("answers ping and teardown, then stops listening", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  host.deliver({ jsonrpc: "2.0", id: 7, method: "ping" });
  expect(host.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  host.deliver({ jsonrpc: "2.0", id: 8, method: "ui/resource-teardown", params: {} });
  expect(host.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
  expect(host.listeners.size).toBe(0);
  await expect(bridge.callTool("x", {})).rejects.toThrow();
});

test("ui/message resolves on success and rejects when the host reports isError", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win, { timeoutMs: 1000 });
  const ok = bridge.sendMessage("Show my TFSA accounts");
  host.reply(host.sent.at(-1), {});
  await expect(ok).resolves.toBeUndefined();
  const declined = bridge.sendMessage("Show my RRSP accounts");
  host.reply(host.sent.at(-1), { isError: true });
  await expect(declined).rejects.toThrow(/declined/);
});

test("reports the content height, so the frame shrinks again when content gets shorter", async () => {
  // The document element's scrollHeight never drops below the frame height the host set,
  // so measuring it would only ever grow. The body follows the content.
  const host = fakeHost();
  const observed: unknown[] = [];
  let fire = () => {};
  (globalThis as any).ResizeObserver = class { constructor(cb: () => void) { fire = cb; } observe(el: unknown) { observed.push(el); } disconnect() {} };
  const bridge = createBridge(host.win);
  host.reply(host.sent.find((m) => m.method === "ui/initialize"), { protocolVersion: "2026-01-26", hostContext: {} });
  await bridge.ready; await tick();
  const sizes = () => host.sent.filter((m) => m.method === "ui/notifications/size-changed").map((m) => m.params.height);
  expect(sizes()).toEqual([480]);
  expect(observed).toEqual([(host.win as any).document.body]);
  (host.win as any).document.body.height = 1200.2; fire();
  (host.win as any).document.body.height = 300; fire();
  expect(sizes()).toEqual([480, 1201, 300]);
  delete (globalThis as any).ResizeObserver;
  bridge.destroy();
});

// 2026-10-22: in Claude a tool result could arrive before the widget's effect subscribed
// (effects run after paint, later still in a frame the host has not shown yet), and the
// bridge dropped it, leaving "Still loading…". The latest result must reach late listeners.
test("replays the latest tool result to a listener that subscribes after it arrived", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { early: 1 } } });
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { early: 2 } } });
  const late: unknown[] = [];
  bridge.onToolResult((r) => late.push(r));
  await tick();
  expect(late).toEqual([{ structuredContent: { early: 2 } }]);
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { live: 3 } } });
  expect(late).toEqual([{ structuredContent: { early: 2 } }, { structuredContent: { live: 3 } }]);
});

test("a listener that unsubscribes before the replay runs gets nothing", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { a: 1 } } });
  const got: unknown[] = [];
  const off = bridge.onToolResult((r) => got.push(r));
  off();
  await tick();
  expect(got).toEqual([]);
});

// "Try again" must re-run the call the model made (e.g. show_activity for HOOD), not an
// unfiltered one, so the bridge keeps the arguments from ui/notifications/tool-input.
test("remembers the tool arguments from ui/notifications/tool-input, defaulting to none", () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  expect(bridge.toolArguments()).toEqual({});
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { symbol: "HOOD" } } });
  expect(bridge.toolArguments()).toEqual({ symbol: "HOOD" });
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: "not-an-object" } });
  expect(bridge.toolArguments()).toEqual({ symbol: "HOOD" });
  const copy = bridge.toolArguments(); (copy as any).symbol = "X";
  expect(bridge.toolArguments()).toEqual({ symbol: "HOOD" });
});

test("a result some listener already received is not replayed to later listeners (remounts keep their seed)", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  const first: unknown[] = [];
  bridge.onToolResult((r) => first.push(r));
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { a: 1 } } });
  const later: unknown[] = [];
  bridge.onToolResult((r) => later.push(r));
  await tick();
  expect(first).toEqual([{ structuredContent: { a: 1 } }]);
  expect(later).toEqual([]);
});

// 2026-10-23: news links did nothing — a sandboxed frame cannot open windows. The host opens them.
test("openLink asks the host with ui/open-link and reports whether it opened", async () => {
  const host = fakeHost();
  const bridge = createBridge(host.win);
  const opened = bridge.openLink("https://news.example.test/a1");
  const req = host.sent.find((m) => m.method === "ui/open-link");
  expect(req.params).toEqual({ url: "https://news.example.test/a1" });
  host.reply(req, {});
  expect(await opened).toBe(true);
  const refused = bridge.openLink("https://news.example.test/a2");
  host.reply(host.sent.filter((m) => m.method === "ui/open-link").at(-1), { isError: true });
  expect(await refused).toBe(false);
});

