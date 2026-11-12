import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { Banner, BrandFooter, FilterChip, Money, Segmented, SymbolText, Tile, ViewControls } from "../../kit/components";
import { ACCOUNT_TYPE_OPTION, accountTypeChip, knownAccountType, scopeValueLabel, type AccountType } from "../../kit/account-types";
import { DonutChart, type DonutSlice } from "../../kit/charts/DonutChart";
import { OTHER_COLOR, UNCLASSIFIED_COLOR, assignColors, type Preference } from "../../kit/charts/palette";
import { formatMoney, formatPercent } from "../../kit/format";
import { useCadView } from "../../kit/currency-switch";
import { HomeCaption, HomeMoney, NativeAmounts, cadValue, notConverted } from "../../kit/home-money";
import type { AllocationPayload, Dimension, Slice } from "./types";

const LOAD_FAILED = "Couldn't load that view. Showing the previous one.";
const DIMENSIONS: ReadonlyArray<{ id: Dimension; label: string }> = [
  { id: "assetClass", label: "Asset class" }, { id: "currency", label: "Currency" }, { id: "accountType", label: "Account" },
  { id: "sector", label: "Sector" }, { id: "region", label: "Region" },
];
const LABELS = DIMENSIONS.map((d) => d.label);
const idOf = (label: string) => DIMENSIONS.find((d) => d.label === label)?.id ?? "assetClass";
const labelOf = (id: Dimension) => DIMENSIONS.find((d) => d.id === id)?.label ?? "Asset class";
/** Classified slices with their own colour (one per palette slot); the rest fold into Other on the donut. */
const DONUT_SLICES = 8;
const OTHER = "__other";
const UNCLASSIFIED = "unclassified";

// Fixed slots so a sector, region or asset class keeps its colour across accounts and views. Keys are labels
// with everything but letters removed. Sectors without a slot (there are 11) take the first free one.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const FIXED: Partial<Record<Dimension, Record<string, Preference>>> = {
  sector: { technology: 0, financialservices: 1, healthcare: 2, consumercyclical: 3, communicationservices: 4, industrials: 5, energy: 6, realestate: 7 },
  region: { unitedstates: 0, canada: 7, developedexnorthamerica: 2, emergingmarkets: 3, other: "other" },
  assetClass: { etfsfunds: 0, stocks: 1, cash: 2, crypto: 4, other: "other" },
};

/** Colour per slice key: fixed maps for sector, region and asset class; sorted keys for currency and account. */
function sliceColors(dimension: Dimension, shown: Slice[], folded: Slice[]): Map<string, string> {
  const fixed = FIXED[dimension];
  const ordered = fixed ? shown : [...shown].sort((a, b) => a.key.localeCompare(b.key));
  const colors = assignColors(ordered.map((s) => s.key), (key) => fixed?.[norm(ordered.find((s) => s.key === key)!.label)]);
  for (const s of folded) colors.set(s.key, OTHER_COLOR);
  colors.set(UNCLASSIFIED, UNCLASSIFIED_COLOR);
  colors.set(OTHER, OTHER_COLOR);
  return colors;
}

/** `accountType` (a chip) and `accountId` (the picker) are never both set. */
interface View { dimension: Dimension; accountId: string; accountType: AccountType | null }

const isPayload = (c: unknown): c is AllocationPayload =>
  !!c && Array.isArray((c as AllocationPayload).slices) && !!(c as AllocationPayload).concentration && !!(c as AllocationPayload).filters && typeof (c as AllocationPayload).dimension === "string";
const payloadOf = (r: ToolResult): AllocationPayload => {
  if (r.isError || !isPayload(r.structuredContent)) throw new Error("failed");
  return r.structuredContent;
};

const pct = (f: number) => formatPercent(f, f > 0 && f < 0.1 ? 1 : 0);
const pctNote = (f: number) => (f > 0 && f < 0.001 ? "<0.1%" : pct(f));
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const lookThrough = (d: Dimension) => d === "sector" || d === "region";

function AllocationView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<AllocationPayload | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [applied, setApplied] = useState<View | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [cadOn, setCadOn] = useCadView(bridge, page?.settings);

  const req = useRef(0);
  const hasData = useRef(false);
  const userLoaded = useRef(false);
  const viewRef = useRef<View | null>(null);
  const appliedRef = useRef<View | null>(null);

  function hydrate(result: ToolResult): boolean {
    const content = result.structuredContent;
    if (result.isError || !isPayload(content)) {
      if (!hasData.current) setLoadFailed(true);
      return false;
    }
    if (userLoaded.current) return true;
    const first = !hasData.current;
    hasData.current = true;
    // An account-type scope is kept as the type, even when the server also echoes the one account it matched.
    const accountType = knownAccountType(content.filters.accountType);
    const next: View = { dimension: content.dimension, accountId: accountType ? "" : content.filters.accountId ?? "", accountType };
    viewRef.current = next; appliedRef.current = next;
    setView(next); setApplied(next); setPage(content); setLoadFailed(false); setSelected(null);
    if (first) setPrivacy(content.settings?.privacyDefault ?? false);
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retryLoad() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("show_allocation", bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  useEffect(() => {
    if (!applied || !page) return;
    // Account labels can carry ordinals ("TFSA 2"), so only the scope kind is shared.
    const scope = applied.accountType ? accountTypeChip(applied.accountType) : applied.accountId ? "one account" : "all accounts";
    void bridge.updateModelContext(`Viewing allocation by ${labelOf(applied.dimension).toLowerCase()}: ${scope}`).catch(() => {});
  }, [bridge, page !== null, applied]);

  if (!page || !view || !applied) {
    if (loadFailed) {
      return (
        <div class="w-shell">
          <Banner tone="warning">Allocation unavailable right now</Banner>
          <button type="button" class="w-chip w-toggle" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
        </div>
      );
    }
    if (stalled) return (
      <div class="w-shell">
        <Banner tone="info">Still loading…</Banner>
        <button type="button" class="w-chip w-toggle" disabled={retrying} onClick={() => void retryLoad()}>Try again</button>
      </div>
    );
    return <div class="w-shell w-muted">Loading your allocation…</div>;
  }

  async function load(change: Partial<View>) {
    const next = { ...viewRef.current!, ...change };
    viewRef.current = next; setView(next);
    const id = ++req.current;
    setLoading(true);
    const args: Record<string, unknown> = { dimension: next.dimension };
    if (next.accountType) args.accountType = next.accountType;
    else if (next.accountId) args.accountId = next.accountId;
    try {
      const content = payloadOf(await bridge.callTool("get_allocation", args));
      if (id !== req.current) return;
      userLoaded.current = true;
      viewRef.current = next; appliedRef.current = next;
      setView(next); setApplied(next); setPage(content); setNotice(null); setLoading(false); setSelected(null);
    } catch {
      if (id !== req.current) return;
      const back = appliedRef.current!;
      viewRef.current = back; setView(back);
      setLoading(false); setNotice(LOAD_FAILED);
    }
  }

  const slices = page.slices;
  // Unclassified is always its own slice: the top classified slices, then Other, then Unclassified.
  const unclassified = slices.find((s) => s.key === UNCLASSIFIED);
  const classified = slices.filter((s) => s !== unclassified);
  const head = classified.slice(0, DONUT_SLICES);
  const rest = classified.slice(DONUT_SLICES);
  const colors = sliceColors(page.dimension, head, rest);
  const colorOf = (key: string) => colors.get(key) ?? OTHER_COLOR;
  const donutOf = (s: Slice): DonutSlice => ({ key: s.key, label: s.label, fraction: s.fraction, value: s.valueCad, currency: "CAD", estimated: s.estimated, color: colorOf(s.key) });
  const donut: DonutSlice[] = head.map(donutOf);
  if (rest.length > 0) donut.push({ key: OTHER, label: "Other", fraction: rest.reduce((a, s) => a + s.fraction, 0), value: rest.reduce((a, s) => a + s.valueCad, 0), currency: "CAD", estimated: rest.some((s) => s.estimated), color: OTHER_COLOR });
  if (unclassified) donut.push(donutOf(unclassified));
  const swatch = (key: string) => {
    const color = colorOf(key);
    return <i aria-hidden="true" class={`w-swatch${color === UNCLASSIFIED_COLOR ? " w-hatch" : ""}`} style={{ backgroundColor: color }} />;
  };
  const shareBar = (key: string, fraction: number) => {
    const color = colorOf(key);
    return <span class="w-share" aria-hidden="true"><span class={color === UNCLASSIFIED_COLOR ? "w-hatch" : undefined} style={{ width: `${Math.min(100, Math.max(0, fraction * 100)).toFixed(2)}%`, backgroundColor: color }} /></span>;
  };
  const chosen: Slice | null = slices.find((s) => s.key === selected) ?? null;
  const c = page.concentration;
  const look = lookThrough(page.dimension);

  function sendHistory(symbol: string) {
    bridge.sendMessage(`Show my history with ${symbol}`).catch(() => setNotice("Couldn't send that to the chat."));
  }
  const debit = page.home?.marginDebit;
  // The donut draws shares of what it can draw; on a net basis they add up to over 100%, so its labels are scaled back.
  const donutScale = debit?.netBasis && !look ? slices.reduce((a, s) => a + s.fraction, 0) : 1;
  const debitText = debit ? `a margin debit of ${privacy ? "••••" : formatMoney(debit.amountCad, "CAD")}${debit.estimated ? " est." : ""}` : "";
  const basisNote = look ? "Shares of holdings, cash excluded"
    : !debit ? "Shares of total value, cash included"
    : debit.netBasis ? `Shares of net value after ${debitText} (the brokerage total), so they can add up to over 100%`
    : `Shares of holdings and positive cash; ${debitText} is not in them`;
  const notes = [
    !look && slices.length > 0 ? "Switch to Sector or Region to see ETF look-through" : null,
    page.unclassifiedFraction > 0 ? `${pctNote(page.unclassifiedFraction)} unclassified (no data)` : null,
    page.unvalued > 0 ? `${page.unvalued} ${page.unvalued === 1 ? "holding" : "holdings"} without a reported value ${page.unvalued === 1 ? "is" : "are"} not included` : null,
    page.estimated && page.fx.date ? `Converted to CAD at Bank of Canada rate of ${page.fx.date} · est.` : null,
    look ? "Sector and region data: Yahoo Finance" : null,
  ].filter((n): n is string => n !== null);
  const choose = (key: string) => { if (key !== OTHER) setSelected(selected === key ? null : key); };

  return (
    <main class="w-shell">
      <h2 class="w-sr">Allocation</h2>
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={(next) => { void setCadOn(next); }} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <select aria-label="Account" value={view.accountType ? ACCOUNT_TYPE_OPTION : view.accountId} onChange={(e) => {
          const accountId = (e.target as HTMLSelectElement).value;
          if (accountId !== ACCOUNT_TYPE_OPTION) void load({ accountId, accountType: null });
        }}>
          <option value="">All accounts</option>
          {view.accountType && <option value={ACCOUNT_TYPE_OPTION}>{accountTypeChip(view.accountType)}</option>}
          {page.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
      {view.accountType && (
        <div class="w-row">
          <FilterChip text={accountTypeChip(view.accountType)} disabled={loading} onRemove={() => void load({ accountType: null })} />
        </div>
      )}
      {cadOn && page.home && (
        <section aria-label={scopeValueLabel(page.filters)}>
          <div class="w-tiles">
            <Tile label={`${scopeValueLabel(page.filters)} in CAD`}
              value={<span style={{ fontSize: "1.6em" }}>{notConverted(page.home.total) ? <NativeAmounts total={page.home.total} privacy={privacy} /> : <HomeMoney value={cadValue(page.home.total)} privacy={privacy} />}</span>} />
          </div>
          {!notConverted(page.home.total) && <HomeCaption total={page.home.total} />}
          {page.home.includesUnreported && <p class="w-caption">Includes accounts without a brokerage total (valued from holdings)</p>}
          {page.home.rowsDiffer && <p class="w-caption">Rows converted at the BoC rate; the brokerage total uses its own rate.</p>}
        </section>
      )}
      <Segmented label="Group by" options={LABELS} value={labelOf(view.dimension)} disabled={loading} onChange={(label) => void load({ dimension: idOf(label) })} />
      <div aria-busy={loading ? "true" : "false"}>
        {slices.length === 0 ? <div class="w-muted">Nothing to allocate in this view</div> : (
          <div class="w-alloc">
            <DonutChart slices={donut} privacy={privacy} label={`Allocation by ${labelOf(page.dimension).toLowerCase()}`} onSlice={choose}
              selected={selected} legend={false} percent={(f) => pct(f * donutScale)} fractionScale={donutScale} />
            <div style={{ display: "grid", gap: "14px", minWidth: 0 }}>
              <ul class="w-items" aria-label="Allocation breakdown">
                {slices.map((s) => (
                  <li key={s.key}>
                    <button type="button" class="w-item" aria-pressed={selected === s.key} aria-label={`${s.label} ${pct(s.fraction)}`} onClick={() => choose(s.key)}>
                      <span class="lbl">{swatch(s.key)}<span>{s.label}</span></span>
                      <span class="num"><b>{pct(s.fraction)}</b>{" · "}<Money amount={s.valueCad} currency="CAD" privacy={privacy} />{s.estimated && <small>{" est."}</small>}</span>
                      {shareBar(s.key, s.fraction)}
                    </button>
                  </li>
                ))}
              </ul>
              {chosen && (
                <section aria-label={`${chosen.label} holdings`}>
                  <h3 class="w-sub">{chosen.label}<small class="w-sub-line">{count(chosen.holdings.length + chosen.moreHoldings, "holding")}</small></h3>
                  <ul class="w-items">
                    {chosen.holdings.map((h) => (
                      <li key={h.holdingKey} class="w-item">
                        <span class="lbl">
                          {h.holdingKey.startsWith("cash:")
                            ? <span>{h.symbol}</span>
                            : <button type="button" class="w-link" onClick={() => sendHistory(h.symbol)}><SymbolText symbol={h.symbol} /></button>}
                        </span>
                        <span class="num"><b><Money amount={h.valueCad} currency="CAD" privacy={privacy} /></b>
                          {chosen.valueCad > 0 && ` · ${pct(h.valueCad / chosen.valueCad)}`}{chosen.estimated && <small>{" est."}</small>}</span>
                      </li>
                    ))}
                  </ul>
                  {chosen.moreHoldings > 0 && <small class="w-muted" style={{ paddingLeft: "10px" }}>{`+${chosen.moreHoldings} more`}</small>}
                </section>
              )}
            </div>
          </div>
        )}
      </div>
      {slices.length > 0 && <p class="w-caption">{basisNote}</p>}
      {slices.length > 0 && (
        <section aria-label="Concentration">
          <h3 class="w-h" style={{ marginBottom: "8px" }}>Concentration</h3>
          <div class="w-tiles four-up">
            <Tile label="Top 10" value={`${pct(c.top10)}${c.estimated ? " est." : ""}`} />
            <Tile label="Effective holdings" value={`${c.effectiveN.toFixed(1)}${c.estimated ? " est." : ""}`} />
            <Tile label="Largest" value={c.largest ? <><SymbolText symbol={c.largest.symbol} />{` ${pct(c.largest.fraction)}${c.estimated ? " est." : ""}`}</> : "—"} />
            <Tile label="Largest incl. ETFs (est.)" value={c.largestWithLookThrough ? <><SymbolText symbol={c.largestWithLookThrough.symbol} />{` ${pct(c.largestWithLookThrough.fraction)}`}</> : "—"} />
          </div>
          <p class="w-caption">Of holdings, cash excluded</p>
        </section>
      )}
      {page.overlap.length > 0 && (
        <section aria-label="Overlap">
          <h3 class="w-h" style={{ marginBottom: "4px" }}>Held directly and through ETFs (est.)</h3>
          <ul class="w-items">
            {page.overlap.map((o) => (
              <li key={o.symbol} class="w-item">
                <span class="lbl"><button type="button" class="w-link" onClick={() => sendHistory(o.symbol)}><SymbolText symbol={o.symbol} /></button></span>
                <span class="num"><b>{`${pct(o.combined)} combined`}</b><small>{` · ${pct(o.direct)} direct · ${pct(o.indirect)} via ETFs`}</small></span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.excludedCurrencies.length > 0 && <Banner tone="warning">{`${page.excludedCurrencies.join(", ")} holdings excluded: exchange rate unavailable`}</Banner>}
      {page.usdExcluded && <Banner tone="warning">USD holdings excluded: exchange rate unavailable</Banner>}
      {notes.length > 0 && <footer class="w-notes">{notes.map((n) => <div key={n}>{n}</div>)}</footer>}
      {notice && <Banner tone="info">{notice}</Banner>}
      <BrandFooter />
    </main>
  );
}

export function Allocation({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_allocation">{(seed) => <AllocationView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
