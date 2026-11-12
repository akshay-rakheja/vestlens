import { Component, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "./bridge";

/**
 * How long a widget waits after ui/initialize for a tool result before offering a retry. A cold
 * start plus a slow brokerage read plus the host's relay can exceed 8 s without anything being
 * wrong, so the calm loading line stays up until this long; late results still hydrate.
 */
export const HYDRATE_WATCHDOG_MS = 30_000;

/** True once HYDRATE_WATCHDOG_MS has passed since initialize with no usable payload. */
export function useHydrateWatchdog(bridge: Bridge, hasData: () => boolean): boolean {
  const [stalled, setStalled] = useState(false);
  const has = useRef(hasData);
  has.current = hasData;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      timer = setTimeout(() => { if (!has.current()) setStalled(true); }, HYDRATE_WATCHDOG_MS);
    };
    bridge.ready.then(start, start);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [bridge]);
  return stalled;
}

class Boundary extends Component<{ onRetry(): void; busy: boolean; children?: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div class="w-shell">
        <div class="w-banner warning" role="status">Couldn't display this view.</div>
        <button type="button" class="w-chip" disabled={this.props.busy} onClick={() => this.props.onRetry()}>Try again</button>
      </div>
    );
  }
}

/**
 * Error boundary for a widget root. The fallback names no values; "Try again" re-calls the show
 * tool with {} and remounts the widget, handing it that result to hydrate from.
 */
export function WidgetGuard({ bridge, showTool, children }: { bridge: Bridge; showTool: string; children: (seed: ToolResult | null) => ComponentChildren }) {
  const [attempt, setAttempt] = useState<{ key: number; seed: ToolResult | null }>({ key: 0, seed: null });
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    let seed: ToolResult | null = null;
    try { seed = await bridge.callTool(showTool, bridge.toolArguments()); } catch { /* remount without a seed */ }
    setBusy(false);
    setAttempt((a) => ({ key: a.key + 1, seed }));
  }
  return <Boundary key={attempt.key} busy={busy} onRetry={() => void retry()}>{children(attempt.seed)}</Boundary>;
}
