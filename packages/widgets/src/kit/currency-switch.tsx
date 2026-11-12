import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Bridge } from "./bridge";

/** Per-user home-currency switch. On (default) shows CAD; off shows original currencies. */
export function useCadView(bridge: Bridge, settings: { cadView?: boolean } | undefined): [boolean, (next: boolean) => Promise<boolean>] {
  const [on, setOn] = useState<boolean>(settings?.cadView ?? true);
  const confirmed = useRef(on); // last value the server is known to hold
  const latest = useRef(0); // id of the most recent click
  const seen = useRef(settings?.cadView); // last settings value adopted or seen

  // Settings arrive in tool results after mount: adopt a changed value unless a local toggle is in flight.
  const incoming = settings?.cadView;
  useEffect(() => {
    if (incoming === undefined || incoming === seen.current) return;
    seen.current = incoming;
    if (pending.current > 0) return;
    confirmed.current = incoming;
    setOn(incoming);
  }, [incoming]);
  const pending = useRef(0);

  const set = useCallback((next: boolean): Promise<boolean> => {
    const id = ++latest.current;
    setOn(next);
    pending.current++;
    const settle = (ok: boolean) => {
      pending.current--;
      if (ok) confirmed.current = next;
      else if (id === latest.current) setOn(confirmed.current);
      return ok;
    };
    return bridge.callTool("save_portfolio_settings", { cadView: next }).then(
      (result) => settle(!result?.isError),
      () => settle(false),
    );
  }, [bridge]);
  return [on, set];
}

export function CurrencySwitch(props: { on: boolean; onChange(next: boolean): void }) {
  return (
    <button type="button" class="currency-switch w-tgl" aria-pressed={!props.on} aria-label="Show original currencies" onClick={() => props.onChange(!props.on)}>
      Original currencies
    </button>
  );
}
