export const UI_PROTOCOL_VERSION = "2026-01-26";

export interface HostContext { theme?: "light" | "dark"; locale?: string; timeZone?: string; displayMode?: string }
export interface ToolResult { structuredContent?: unknown; content?: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: Record<string, unknown> }
export interface Bridge {
  ready: Promise<{ hostTools: boolean; context: HostContext }>;
  /** Live tool results; a listener added late also receives the latest result once (replayed). */
  onToolResult(listener: (result: ToolResult) => void): () => void;
  /** The arguments of the tool call this widget renders (from `ui/notifications/tool-input`), or `{}`. */
  toolArguments(): Record<string, unknown>;
  onContext(listener: (context: HostContext) => void): () => void;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  sendMessage(text: string): Promise<void>;
  /** Ask the host to open a URL in the user's browser (`ui/open-link`); resolves whether it did. */
  openLink(url: string): Promise<boolean>;
  updateModelContext(text: string): Promise<void>;
  destroy(): void;
}

interface Pending { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export function createBridge(target: Window = window, options: { timeoutMs?: number; appName?: string } = {}): Bridge {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pending = new Map<number, Pending>();
  const toolListeners = new Set<(result: ToolResult) => void>();
  const contextListeners = new Set<(context: HostContext) => void>();
  // The host sends tool-input and tool-result right after `initialized`, which can be before
  // the widget's effect subscribes (effects run after paint, later in a hidden frame). Keep a
  // missed result for the first subscriber, and the arguments so "Try again" re-runs the call.
  // `undelivered` is a result that arrived while nobody was listening; it is handed to the first
  // listener once. A result some listener already saw is never replayed, so a remount after an
  // error-boundary retry keeps the fresh seed instead of getting the original payload again.
  let undelivered: ToolResult | null = null;
  let lastArguments: Record<string, unknown> = {};
  let nextId = 1;
  let destroyed = false;
  let initialized = false;
  let reportedHeight = 0;
  let observer: ResizeObserver | null = null;
  const root = target.document?.documentElement;
  // Measure the body, not the document element: the document element's scrollHeight never drops
  // below the frame height the host set, so it could only grow and left empty space after the
  // content got shorter (for example switching from all accounts to one).
  const content: (Element & { getBoundingClientRect(): { height: number } }) | undefined = target.document?.body ?? undefined;

  const post = (message: unknown) => target.parent.postMessage(message, "*");
  function request(method: string, params: unknown): Promise<any> {
    if (destroyed) return Promise.reject(new Error("Widget closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Request timed out")); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      post({ jsonrpc: "2.0", id, method, params });
    });
  }
  function applyContext(context: HostContext | undefined) {
    if (!context) return;
    if ((context.theme === "light" || context.theme === "dark") && root) root.style.colorScheme = context.theme;
    contextListeners.forEach((listener) => listener(context));
  }
  function reportSize() {
    if (destroyed || !initialized || !root) return;
    const measured = content ? content.getBoundingClientRect().height : root.scrollHeight;
    const height = Math.ceil(Number(measured) || 0);
    if (!height || height === reportedHeight) return;
    reportedHeight = height;
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
  }
  function onMessage(event: MessageEvent) {
    if (event.source !== target.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ping" || message.method === "ui/resource-teardown") {
      if (message.id !== undefined) post({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "ui/resource-teardown") destroy();
      return;
    }
    if (!message.method && message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error("Host request failed"));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-input") {
      const args = message.params?.arguments;
      if (args && typeof args === "object" && !Array.isArray(args)) lastArguments = { ...args };
    }
    if (message.method === "ui/notifications/tool-result") {
      const result: ToolResult = message.params ?? {};
      undelivered = toolListeners.size === 0 ? result : null;
      toolListeners.forEach((listener) => listener(result));
    }
    if (message.method === "ui/notifications/host-context-changed") applyContext(message.params);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    pending.forEach((entry) => { clearTimeout(entry.timer); entry.reject(new Error("Widget closed")); });
    pending.clear();
    target.removeEventListener("message", onMessage as EventListener);
  }
  target.addEventListener("message", onMessage as EventListener);

  const ready = request("ui/initialize", {
    protocolVersion: UI_PROTOCOL_VERSION,
    appInfo: { name: options.appName ?? "portfolio-widget", version: "5.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((result) => {
    if (!result || typeof result.protocolVersion !== "string") throw new Error("Unsupported host");
    initialized = true;
    const context: HostContext = result.hostContext ?? {};
    applyContext(context);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    if (typeof ResizeObserver === "function" && root) { observer = new ResizeObserver(reportSize); observer.observe(content ?? root); }
    queueMicrotask(reportSize);
    return { hostTools: !!result.hostCapabilities?.serverTools, context };
  });
  // Observe the rejection so an unawaited `ready` does not surface as an unhandled rejection.
  ready.catch(() => undefined);

  return {
    ready,
    onToolResult(listener) {
      toolListeners.add(listener);
      // Replay asynchronously, only if the listener is still subscribed and nobody took it first.
      if (undelivered) queueMicrotask(() => {
        if (!undelivered || !toolListeners.has(listener)) return;
        const missed = undelivered; undelivered = null; listener(missed);
      });
      return () => toolListeners.delete(listener);
    },
    toolArguments: () => ({ ...lastArguments }),
    onContext(listener) { contextListeners.add(listener); return () => contextListeners.delete(listener); },
    callTool: (name, args) => request("tools/call", { name, arguments: args }).then((result: ToolResult) => result),
    openLink: (url) => request("ui/open-link", { url }).then((r) => !(r && r.isError === true), () => false),
    // MCP Apps types `content` as ContentBlock[] (McpUiMessageRequest); hosts reject a bare object.
    sendMessage: (text) => request("ui/message", { role: "user", content: [{ type: "text", text }] }).then((result) => {
      if (result && result.isError) throw new Error("Host declined the message");
    }),
    updateModelContext: (text) => request("ui/update-model-context", { content: [{ type: "text", text }] }).then(() => undefined),
    destroy,
  };
}
