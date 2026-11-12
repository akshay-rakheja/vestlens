import { Share2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { PortfolioApiClient } from "./App";
import { AppHeader } from "./AppHeader";
import { cad, calendarDate, convertedMoney, estLabel, nativeMoney } from "./roomFormat";
import { ShareCardPanel } from "./ShareCard";

/**
 * The report card (GET /api/report-card): the user's own calls, sales and trading costs, from stored data only. Facts
 * only; every converted or estimated figure says est. Formatting here; every figure comes from the API.
 */

export interface CantTellView { count: number; reasons: Array<{ reason: string; count: number; symbols: string[] }> }
export interface CallRowView { symbol: string; returnPct: number; vsSp500Pct: number; vsTsxPct: number | null; startDate: string; endDate: string; estimated: boolean; rateDate: string | null }
export interface ReportCardView {
  asOf: string;
  activityFrom: string | null;
  calls: {
    checked: number;
    items: CallRowView[];
    summary: {
      compared: number; ahead: number; behind: number; even: number; best: CallRowView | null; worst: CallRowView | null;
      aheadUnmeasured: Array<Omit<CallRowView, "vsSp500Pct" | "vsTsxPct">>;
    };
    cantTell: CantTellView;
  };
  afterSold: {
    items: Array<{
      symbol: string; date: string; units: number; salePrice: number; currency: string; estimated: boolean; priceRateDate: string | null;
      recordedPrice: { amount: number; currency: string } | null; latestClose: number; latestCloseDate: string; latestCloseSplitAdjusted?: number;
      changePct: number; keptVsSold: { native: { amount: number; currency: string }; cad: number | null; estimated: boolean; rateDate: string | null };
    }>;
    summary: {
      sells: number; rose: number; fell: number; unchanged: number; keptVsSoldCad: number | null; estimated: boolean; rateDate: string | null;
      notConverted: number; native: Array<{ currency: string; amount: number }>;
    };
    cantTell: CantTellView;
  };
  tradingCost: {
    conversion: {
      rows: number; convertedCad: number; estimated: boolean; rateDate: string | null; native: Array<{ currency: string; amount: number }>; cantTell: CantTellView;
      estimate: {
        rows: number; minRows: number; costCad: number | null; sharePct: number | null; estimated: true;
        rateDates: { first: string; last: string } | null; cantTell: CantTellView;
      };
    };
    fees: { rows: number; totalCad: number; estimated: boolean; rateDate: string | null; native: Array<{ currency: string; amount: number }>; cantTell: CantTellView };
  };
  overall: { period: "YTD"; from: string; to: string; returnPct: number; sp500Pct: number; returnEstimated: boolean; sp500Estimated: boolean } | null;
}

export const METHOD_NOTE = "How this is worked out: from your stored activity and cached market closes only. Each holding is money-weighted from your first recorded purchase against the same money in the S&P 500 (total return, dividends reinvested) and the TSX (a price index, dividends not included); holdings count their dividends, before withholding, so the TSX comparison favours holdings slightly. US-dollar figures use the Bank of Canada rate (est.). Facts only, not advice.";

const LIST_LIMIT = 10;
const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");
const pct = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)}%`;
const points = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)} points`;
const signedCad = (n: number) => `${n > 0 ? "+" : ""}${cad(n)}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const est = (estimated: boolean, rateDate: string | null = null) => estLabel(estimated, rateDate);
const price = (amount: number, currency: string) => (currency === "CAD" ? cad(amount) : nativeMoney(amount, currency));
const span = (from: string, to: string) => `from ${calendarDate(from)} to ${calendarDate(to)}`;
const nativeList = (native: Array<{ currency: string; amount: number }>) => native.map((n) => nativeMoney(n.amount, n.currency)).join(" and ");
/** " (est., Bank of Canada rate D; includes US$X)" for a converted total; the estLabel alone without native parts. */
const convertedNote = (estimated: boolean, rateDate: string | null, native: Array<{ currency: string; amount: number }>) => {
  const label = estLabel(estimated, rateDate);
  return label && native.length > 0 ? `${label.slice(0, -1)}; includes ${nativeList(native)})` : label;
};

export const LOADING_COPY = "Crunching your trades. The first time takes about 20 seconds.";
export const SLOW_COPY = "Taking longer than usual";
/** After this long, the loading line offers a retry. */
export const SLOW_MS = 60_000;

type Load = { status: "loading"; slow: boolean } | { status: "error" } | { status: "ready"; card: ReportCardView };

export function ReportCardPage({ api, onBack }: { api: PortfolioApiClient; onBack(): void }) {
  const [state, setState] = useState<Load>({ status: "loading", slow: false });
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  const { getReportCard } = api;
  useEffect(() => {
    if (!getReportCard) { setState({ status: "error" }); return; }
    let active = true;
    setState({ status: "loading", slow: false });
    const slow = setTimeout(() => { if (active) setState((s) => (s.status === "loading" ? { status: "loading", slow: true } : s)); }, SLOW_MS);
    getReportCard().then(
      (card) => { if (active) setState({ status: "ready", card }); },
      () => { if (active) setState({ status: "error" }); },
    ).finally(() => clearTimeout(slow));
    return () => { active = false; clearTimeout(slow); };
  }, [getReportCard, attempt]);

  return (
    <div className="app-shell">
      <AppHeader>
        <button type="button" className="topbar-link" onClick={onBack}>Back</button>
      </AppHeader>
      <main className="dashboard account-page report-page">
        <section className="dashboard-heading">
          <div><h1>Your report card</h1></div>
          {state.status === "ready" && !sharing && (
            <button type="button" className="secondary-button" onClick={() => setSharing(true)}><Share2 size={15} /> Make a shareable card</button>
          )}
        </section>
        {state.status === "loading" && (
          <div className="report-loading" role="status">
            <p className="data-controls-copy">{LOADING_COPY}</p>
            <div className="report-progress" role="progressbar" aria-label="Working out your report card"><span /></div>
            {state.slow && (
              <p className="data-controls-copy">
                {SLOW_COPY}{" "}
                <button type="button" className="link-button" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
              </p>
            )}
          </div>
        )}
        {state.status === "error" && <p className="data-controls-copy">The report card is unavailable right now.</p>}
        {state.status === "ready" && sharing && <ShareCardPanel card={state.card} onClose={() => setSharing(false)} />}
        {state.status === "ready" && <ReportBody card={state.card} />}
      </main>
    </div>
  );
}

function CantTellLine({ cantTell, label = "Couldn't tell for" }: { cantTell: CantTellView; label?: string }) {
  if (cantTell.count === 0) return null;
  return (
    <ul className="tfsa-list" aria-label={label}>
      {cantTell.reasons.map((r) => (
        <li key={r.reason}>{`${label} ${r.count}: ${r.reason}${r.symbols.length > 0 ? ` (${r.symbols.join(", ")})` : ""}`}</li>
      ))}
    </ul>
  );
}

function Section({ id, title, headline, children }: { id: string; title: string; headline: string; children?: ReactNode }) {
  return (
    <section className="section-block" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{title}</h2>
      <p className="tfsa-headline">{headline}</p>
      {children}
    </section>
  );
}

function ShortList({ lines }: { lines: string[] }) {
  const [all, setAll] = useState(false);
  if (lines.length === 0) return null;
  const shown = all ? lines : lines.slice(0, LIST_LIMIT);
  return (
    <>
      <ul className="tfsa-list">{shown.map((line, i) => <li key={i}>{line}</li>)}</ul>
      {!all && lines.length > LIST_LIMIT && <button type="button" className="link-button" onClick={() => setAll(true)}>{`Show all ${lines.length}`}</button>}
    </>
  );
}

function ReportBody({ card }: { card: ReportCardView }) {
  return (
    <>
      <Calls calls={card.calls} />
      <AfterSold afterSold={card.afterSold} />
      <TradingCost cost={card.tradingCost} activityFrom={card.activityFrom} />
      {card.overall && <Overall overall={card.overall} />}
      <p className="tfsa-note">{METHOD_NOTE}</p>
    </>
  );
}

function Calls({ calls }: { calls: ReportCardView["calls"] }) {
  const { summary } = calls;
  const headline = summary.compared === 0
    ? "None of your holdings could be compared with the S&P 500 yet"
    : `${summary.ahead} of ${summary.compared} ${plural(summary.compared, "holding", "holdings")} came out ahead of the S&P 500 since your first purchase`;
  const counts = `${summary.ahead} ahead, ${summary.behind} behind${summary.even > 0 ? `, ${summary.even} level` : ""}, ${calls.cantTell.count} couldn't tell`;
  const ends = (r: Pick<CallRowView, "returnPct" | "startDate" | "endDate" | "estimated">) => `${pct(r.returnPct)} ${span(r.startDate, r.endDate)}`;
  const lines = [
    ...calls.items.map((i) => `${i.symbol}: ${ends(i)}; ${points(i.vsSp500Pct)} against the S&P 500${i.vsTsxPct === null ? "" : `, ${points(i.vsTsxPct)} against the TSX`}${est(i.estimated, i.rateDate)}`),
    ...summary.aheadUnmeasured.map((i) => `${i.symbol}: ${ends(i)}; ahead of the S&P 500 by more than this comparison can put a number on (the sales brought in more than the same money in the index was worth)${est(i.estimated, i.rateDate)}`),
  ];
  const { best, worst } = summary;
  // Holdings ahead without a figure may be further ahead than any with one: the best line says it is the best with a figure.
  const bestLabel = summary.aheadUnmeasured.length > 0 ? "Highest with a figure against the S&P 500" : "Highest against the S&P 500";
  return (
    <Section id="report-calls" title="Your calls against the market" headline={headline}>
      {summary.compared > 0 && <p className="data-controls-copy">{counts}</p>}
      {best && worst && calls.items.length >= 2 && (
        <ul className="tfsa-list" aria-label="Highest and lowest">
          <li>{`${bestLabel}: ${best.symbol}, ${points(best.vsSp500Pct)} (${ends(best)})${est(best.estimated, best.rateDate)}`}</li>
          <li>{`Lowest against the S&P 500: ${worst.symbol}, ${points(worst.vsSp500Pct)} (${ends(worst)})${est(worst.estimated, worst.rateDate)}`}</li>
        </ul>
      )}
      <ShortList lines={lines} />
      <CantTellLine cantTell={calls.cantTell} />
    </Section>
  );
}

function AfterSold({ afterSold }: { afterSold: ReportCardView["afterSold"] }) {
  const { summary } = afterSold;
  const headline = summary.sells === 0
    ? "No sales could be compared with the latest price yet"
    : `Since you sold, the price rose after ${summary.rose} of ${summary.sells} ${plural(summary.sells, "sale", "sales")}`;
  const lines = afterSold.items.map((i) => {
    const kept = i.keptVsSold.cad === null
      ? `${i.keptVsSold.native.amount > 0 ? "+" : ""}${nativeMoney(i.keptVsSold.native.amount, i.keptVsSold.native.currency)} (not converted: no Bank of Canada rate)`
      : convertedMoney(signedCad(i.keptVsSold.cad), { estimated: i.keptVsSold.estimated, rateDate: i.keptVsSold.rateDate, native: i.keptVsSold.native });
    const recorded = i.recordedPrice ? `; ${price(i.recordedPrice.amount, i.recordedPrice.currency)} as recorded` : "";
    const salePrice = `${price(i.salePrice, i.currency)}${i.estimated ? ` (est., Bank of Canada rate ${i.priceRateDate ?? "date unknown"}${recorded})` : ""}`;
    return `${i.symbol}, sold ${calendarDate(i.date)} at ${salePrice} (${i.units} ${plural(i.units, "share", "shares")}): `
      + `latest close ${price(i.latestClose, i.currency)} on ${calendarDate(i.latestCloseDate)}${i.latestCloseSplitAdjusted === undefined ? "" : ` (${price(i.latestCloseSplitAdjusted, i.currency)} with the splits since the sale)`}, ${pct(i.changePct)}; kept vs sold ${kept}`;
  });
  return (
    <Section id="report-sold" title="After you sold" headline={headline}>
      {summary.keptVsSoldCad !== null && (
        <p className="data-controls-copy">
          {`Kept vs sold, all sales together: ${signedCad(summary.keptVsSoldCad)}${convertedNote(summary.estimated, summary.rateDate, summary.native)}. `
            + "That is the shares' value at the latest close, splits included, minus what the sales brought in (before fees)."
            + (summary.notConverted > 0 ? ` ${summary.notConverted} ${plural(summary.notConverted, "sale isn't", "sales aren't")} in this total: no Bank of Canada rate to convert.` : "")}
        </p>
      )}
      <ShortList lines={lines} />
      <CantTellLine cantTell={afterSold.cantTell} />
    </Section>
  );
}

function TradingCost({ cost, activityFrom }: { cost: ReportCardView["tradingCost"]; activityFrom: string | null }) {
  const { conversion, fees } = cost;
  const { estimate } = conversion;
  const unread = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"} couldn't be read`;
  const headline = conversion.rows > 0
    ? `You converted about ${cad(conversion.convertedCad)} between CAD and USD on trades${convertedNote(conversion.estimated, conversion.rateDate, conversion.native)}`
    : conversion.cantTell.count > 0
      ? `${conversion.cantTell.count} ${plural(conversion.cantTell.count, "trade", "trades")} between CAD and USD couldn't be read`
      : "No trades between CAD and USD found";
  const dates = estimate.rateDates ? `, Bank of Canada rates from ${calendarDate(estimate.rateDates.first)} to ${calendarDate(estimate.rateDates.last)}` : "";
  const noisy = "(est.; compares each trade with that day's closing price, so single trades are noisy)";
  const estimateLine = estimate.costCad === null
    ? conversion.rows > 0 ? `Too few trades with a closing price that day to estimate what the conversion cost (${estimate.rows} of the ${estimate.minRows} needed).` : null
    : `${estimate.costCad >= 0 ? `Estimated cost against the Bank of Canada rate: about ${cad(estimate.costCad)}` : `Against the Bank of Canada rate, the conversions came out about ${cad(-estimate.costCad)} ahead`} ${noisy}`
      + `${estimate.sharePct === null ? "" : `, ${estimate.sharePct.toFixed(2)}% of the value compared`}, over ${estimate.rows} trades${dates}.`;
  const feesLine = fees.rows > 0
    ? `Fees: ${cad(fees.totalCad)}${convertedNote(fees.estimated, fees.rateDate, fees.native)}`
    : fees.cantTell.count > 0 ? `No fee amounts could be counted: ${unread(fees.cantTell.count, "fee row")}` : "No fees recorded";
  return (
    <Section id="report-cost" title="What trading cost you" headline={headline}>
      {activityFrom && <p className="data-controls-copy">{`In your stored activity since ${calendarDate(activityFrom)}.`}</p>}
      {conversion.rows > 0 && (
        <p className="data-controls-copy">{`Across ${conversion.rows} ${plural(conversion.rows, "trade", "trades")} in a security whose currency differs from the account's, from the amounts recorded.`}</p>
      )}
      <CantTellLine cantTell={conversion.cantTell} />
      {estimateLine && <p className="data-controls-copy">{estimateLine}</p>}
      <CantTellLine cantTell={estimate.cantTell} label="Left out of the cost estimate" />
      <p className="data-controls-copy">{feesLine}</p>
      <CantTellLine cantTell={fees.cantTell} />
    </Section>
  );
}

function Overall({ overall }: { overall: NonNullable<ReportCardView["overall"]> }) {
  const headline = `From ${calendarDate(overall.from)} to ${calendarDate(overall.to)}: your portfolio ${pct(overall.returnPct)}${est(overall.returnEstimated)} `
    + `against the S&P 500's ${pct(overall.sp500Pct)}${est(overall.sp500Estimated)}`;
  return (
    <Section id="report-overall" title="Overall" headline={headline}>
      <p className="data-controls-copy">Time-weighted, as on the performance view; the S&P 500 is its total-return index, dividends reinvested, converted to CAD at the Bank of Canada rate.</p>
    </Section>
  );
}
