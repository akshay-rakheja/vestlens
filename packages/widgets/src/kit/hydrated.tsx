import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "./bridge";
import { Banner } from "./components";
import { WidgetGuard, useHydrateWatchdog } from "./resilience";

interface Props<T> {
  bridge: Bridge;
  showTool: string;
  isPayload(content: unknown): content is T;
  loadingText: string;
  unavailableText: string;
  children(payload: T): ComponentChildren;
}

function View<T>(props: Props<T> & { seed: ToolResult | null }) {
  const { bridge, showTool, seed } = props;
  {
    const [page, setPage] = useState<T | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const hasData = useRef(false);

    function hydrate(result: ToolResult): boolean {
      const content = result.structuredContent;
      if (result.isError || !props.isPayload(content)) {
        if (!hasData.current) setLoadFailed(true);
        return false;
      }
      hasData.current = true;
      setPage(content); setLoadFailed(false);
      return true;
    }
    useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
    useEffect(() => { if (seed) hydrate(seed); }, []);
    const stalled = useHydrateWatchdog(bridge, () => hasData.current);
    async function retry() {
      setRetrying(true);
      try { hydrate(await bridge.callTool(showTool, bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
    }

    if (!page) {
      if (loadFailed || stalled) {
        return (
          <div class="w-shell">
            <Banner tone={loadFailed ? "warning" : "info"}>{loadFailed ? props.unavailableText : "Still loading…"}</Banner>
            <button type="button" class="w-chip w-toggle" disabled={retrying} onClick={() => void retry()}>Try again</button>
          </div>
        );
      }
      return <div class="w-shell w-muted">{props.loadingText}</div>;
    }
    return <>{props.children(page)}</>;
  }
}

/**
 * A card that renders one show tool's structuredContent: loading line, calm failure with "Try again", and the
 * error guard, as the TFSA room card does. `isPayload` decides what is usable; anything else is a failed load.
 */
export function HydratedCard<T>(props: Props<T>) {
  return <WidgetGuard bridge={props.bridge} showTool={props.showTool}>{(seed) => <View {...props} seed={seed} />}</WidgetGuard>;
}
