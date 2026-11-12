import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge, ToolResult } from "../../kit/bridge";
import { WidgetGuard, useHydrateWatchdog } from "../../kit/resilience";
import { Banner, BrandFooter, Money, Segmented, ViewControls } from "../../kit/components";
import { useCadView } from "../../kit/currency-switch";
import { formatRateDate } from "../../kit/format";
import { HomeMoney, NativeAmounts, cadValue, notConverted } from "../../kit/home-money";
import type { CalendarEventView, CalendarPayload, CalendarRange, MoodLevel } from "./types";

const LOAD_FAILED = "Couldn't load that view. Showing the previous one.";
const SEND_FAILED = "Couldn't send that to the chat.";
const ESTIMATE_NOTE = "Dates marked est. are projected from past filings and payments and may be wrong.";
const NOT_ADVICE = "News and ratings are for information only, not investment advice.";
const RATING_CAVEAT = "News tone is AI-rated from the headline and summary. It describes the news, not the stock, and may be wrong.";
const RANGES: readonly CalendarRange[] = ["2w", "1m", "3m"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY = 86_400_000;
const torontoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });

interface View { range: CalendarRange; accountId: string }

const isPayload = (c: unknown): c is CalendarPayload =>
  !!c && Array.isArray((c as CalendarPayload).weeks) && !!(c as CalendarPayload).filters && typeof (c as CalendarPayload).range === "string";
const payloadOf = (r: ToolResult): CalendarPayload => {
  if (r.isError || !isPayload(r.structuredContent)) throw new Error("failed");
  return r.structuredContent;
};
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const longDate = (iso: string) => `${WEEKDAYS[new Date(dayMs(iso)).getUTCDay()]}, ${shortDate(iso)}`;
const moodWord = (m: MoodLevel) => m.replace(/_/g, " ");
const viewOf = (p: CalendarPayload): View => ({ range: p.range, accountId: p.filters.accountId ?? "" });

function weekLabel(weekStart: string, thisMonday: number): string {
  const t = dayMs(weekStart);
  if (t === thisMonday) return "This week";
  if (t === thisMonday + 7 * DAY) return "Next week";
  return `Week of ${shortDate(weekStart)}`;
}

/** A per-unit dividend keeps up to four decimals (0.2375), at least two. */
const NO_AMOUNT = "Amount left out: units changed around the last payment";

function perUnitText(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount).replace(/[\u00a0\u202f]/g, " ");
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Projected payments convert at the latest rate; paid ones keep the plain rate-date caption. */
function rateCaption(estimated: boolean, rateDate: string | null, projected: boolean, notConverted = 0): string | null {
  const parts: string[] = [];
  if (estimated) parts.push(rateDate ? (projected ? `est. · at the latest BoC rate (${formatRateDate(rateDate)})` : `est. · BoC ${formatRateDate(rateDate)}`) : "est.");
  if (notConverted > 0) parts.push(`${notConverted} not converted`);
  return parts.length ? parts.join(" · ") : null;
}

function EventCard(p: { e: CalendarEventView; privacy: boolean; today: number; cad: boolean; onNews(symbol: string): void }) {
  const { e } = p;
  const home = p.cad ? e.amount?.home : undefined;
  const earnings = e.kind === "earnings";
  const passed = dayMs(e.date) < p.today;
  const head = (
    <>
      <span class="w-act-ic" aria-hidden="true">{earnings ? "E" : "$"}</span>
      <span><b>{e.symbol}</b> <span class="w-muted">{earnings ? "Earnings" : "Dividend"}</span></span>
      <span class="w-act-amt">
        {e.amount ? (home ? <HomeMoney value={home} privacy={p.privacy} /> : <Money amount={e.amount.total} currency={e.amount.currency} privacy={p.privacy} />) : null}
      </span>
      <small>
        {longDate(e.date)}
        {e.estimated && <> <span class="w-chip" style={{ padding: "0 6px" }}>est.</span></>}
        {earnings && passed && !e.outcome && " · no rated news yet"}
      </small>
      {home && rateCaption(home.estimated, home.rateDate, !passed) && <small class="w-act-cur">{rateCaption(home.estimated, home.rateDate, !passed)}</small>}
      <small class="w-act-cur">{e.amount ? (home ? `${perUnitText(e.amount.perUnit, e.amount.currency)} per unit · est.` : `${e.amount.currency} · est.`) : earnings ? "" : NO_AMOUNT}</small>
    </>
  );
  return (
    <li style={{ listStyle: "none" }}>
      {earnings
        ? <button type="button" class="w-act-row" style={{ cursor: "pointer" }} aria-label={`${e.symbol} earnings ${longDate(e.date)}: show news`} onClick={() => p.onNews(e.symbol)}>{head}</button>
        : <div class="w-act-row">{head}</div>}
      {e.outcome && (
        <div class="w-muted" style={{ padding: "0 0 8px 38px" }}>
          <div>{`Reported · news tone ${moodWord(e.outcome.mood)} · ${e.outcome.source}`}</div>
          <div style={{ fontSize: "11px" }}>{e.outcome.headline}</div>
        </div>
      )}
    </li>
  );
}

function CalendarView({ bridge, seed }: { bridge: Bridge; seed: ToolResult | null }) {
  const [page, setPage] = useState<CalendarPayload | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(false);
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
    const next = viewOf(content);
    viewRef.current = next; appliedRef.current = next;
    setView(next); setPage(content); setLoadFailed(false);
    if (first) setPrivacy(content.settings?.privacyDefault ?? false);
    return true;
  }
  useEffect(() => bridge.onToolResult((result) => { hydrate(result); }), [bridge]);
  useEffect(() => { if (seed) hydrate(seed); }, []);
  const stalled = useHydrateWatchdog(bridge, () => hasData.current);
  async function retryLoad() {
    setRetrying(true);
    try { hydrate(await bridge.callTool("show_calendar", bridge.toolArguments())); } catch { if (!hasData.current) setLoadFailed(true); } finally { setRetrying(false); }
  }

  const count = page ? page.weeks.reduce((n, w) => n + w.events.length, 0) : 0;
  useEffect(() => {
    if (!page) return;
    // Only the range and the event count are shared: no symbols, amounts, ids or account labels.
    void bridge.updateModelContext(`Viewing calendar: ${page.range}, ${count} events`).catch(() => {});
  }, [bridge, page]);

  if (!page || !view) {
    if (loadFailed) {
      return (
        <div class="w-shell">
          <Banner tone="warning">Calendar unavailable right now</Banner>
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
    return <div class="w-shell w-muted">Loading your calendar…</div>;
  }

  async function load(change: Partial<View>) {
    const next = { ...viewRef.current!, ...change };
    viewRef.current = next; setView(next);
    const id = ++req.current;
    setLoading(true);
    const args: Record<string, unknown> = { range: next.range };
    if (next.accountId) args.accountId = next.accountId;
    try {
      const content = payloadOf(await bridge.callTool("get_calendar", args));
      if (id !== req.current) return;
      userLoaded.current = true;
      const settled = viewOf(content);
      viewRef.current = settled; appliedRef.current = settled;
      setView(settled); setPage(content); setNotice(null); setLoading(false);
    } catch {
      if (id !== req.current) return;
      const back = appliedRef.current!;
      viewRef.current = back; setView(back);
      setLoading(false); setNotice(LOAD_FAILED);
    }
  }

  // Turning CAD on over a payload built with it off needs the CAD fields from the server, after the setting is saved.
  function onCadChange(next: boolean) {
    const saved = setCadOn(next);
    if (next && !page!.home) void saved.then((ok) => { if (ok) void load({}); });
  }
  const sendNews = (symbol: string) => { bridge.sendMessage(`Show news for ${symbol}`).catch(() => setNotice(SEND_FAILED)); };
  const today = dayMs(torontoDate.format(new Date()));
  const thisMonday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  const noAmount = page.weeks.flatMap((w) => w.events).filter((e) => e.kind === "dividend_pay" && !e.amount).length;
  const rated = page.weeks.some((w) => w.events.some((e) => e.outcome !== null));

  return (
    <main class="w-shell">
      <h2 class="w-sr">Calendar</h2>
      <ViewControls privacy={privacy} onPrivacy={setPrivacy} cadOn={cadOn} onCadChange={onCadChange} />
      <div class="w-row" style={{ justifyContent: "space-between" }}>
        <span class="w-row">
          <Segmented label="Range" options={RANGES} value={view.range} disabled={loading} onChange={(range) => void load({ range })} />
          <select aria-label="Account" value={view.accountId} disabled={loading} onChange={(e) => void load({ accountId: (e.target as HTMLSelectElement).value })}>
            <option value="">All accounts</option>
            {page.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </span>
      </div>
      {cadOn && page.home && (
        <div>
          <span class="w-muted">Projected dividends</span>{" "}
          <b>{notConverted(page.home.dividends) ? <NativeAmounts total={page.home.dividends} privacy={privacy} /> : <HomeMoney value={cadValue(page.home.dividends)} privacy={privacy} />}</b>
          {!notConverted(page.home.dividends) && rateCaption(page.home.dividends.estimated, page.home.dividends.rateDates.length === 1 ? page.home.dividends.rateDates[0] : null, true, page.home.dividends.excludedCount ?? page.home.dividends.excluded.length) !== null
            && <p class="w-caption">{rateCaption(page.home.dividends.estimated, page.home.dividends.rateDates.length === 1 ? page.home.dividends.rateDates[0] : null, true, page.home.dividends.excludedCount ?? page.home.dividends.excluded.length)}</p>}
          {noAmount > 0 && <p class="w-caption">{`${noAmount} ${noAmount === 1 ? "payment" : "payments"} without an amount not included`}</p>}
        </div>
      )}
      <div class="w-muted">{`This week: ${page.thisWeek.earnings} earnings · ${page.thisWeek.dividends} ${page.thisWeek.dividends === 1 ? "dividend" : "dividends"} ahead`}</div>
      <div aria-busy={loading ? "true" : "false"}>
        {page.weeks.length === 0 && <div class="w-muted">No earnings or dividend dates in this range.</div>}
        {page.weeks.map((w) => {
          const label = weekLabel(w.weekStart, thisMonday);
          return (
            <section key={w.weekStart} aria-label={label}>
              <h3 class="w-day">{label}</h3>
              <ul style={{ margin: 0, padding: 0 }}>
                {w.events.map((e) => <EventCard key={e.id} e={e} privacy={privacy} today={today} cad={cadOn} onNews={sendNews} />)}
              </ul>
            </section>
          );
        })}
      </div>
      <footer class="w-notes w-muted">
        <div>{ESTIMATE_NOTE}</div>
        {rated && <div>{RATING_CAVEAT}</div>}
        <div>{NOT_ADVICE}</div>
      </footer>
      {notice && <Banner tone="info">{notice}</Banner>}
      <BrandFooter advice={false} />
    </main>
  );
}

export function Calendar({ bridge }: { bridge: Bridge }) {
  return <WidgetGuard bridge={bridge} showTool="show_calendar">{(seed) => <CalendarView bridge={bridge} seed={seed} />}</WidgetGuard>;
}
