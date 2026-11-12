import { Money } from "./components";
import { formatMoney, formatRateDate } from "./format";

/** Mirrors `HomeAmount` in packages/api/src/fx/home-currency.ts. Widgets do no FX math. */
export interface HomeAmountView {
  amount: number | null;
  estimated: boolean;
  rate: number | null;
  rateDate: string | null;
  native: { amount: number; currency: string };
}

/** Mirrors `HomeTotal` in packages/api/src/fx/home-currency.ts. */
export interface HomeTotalView {
  amount: number;
  estimated: boolean;
  rateDates: string[];
  /** One entry per currency (amounts summed). */
  excluded: Array<{ amount: number; currency: string }>;
  /** Number of unconverted parts; absent in older payloads (then `excluded.length`). */
  excludedCount?: number;
}

const HOME_CURRENCY = "CAD";

/** CAD figure (exact, or "est." when converted) with the original amount as a muted second line. */
export function HomeMoney(props: { value: HomeAmountView; privacy: boolean; signed?: boolean; showNative?: boolean }) {
  const { value, privacy, signed } = props;
  const showNative = props.showNative ?? true;
  if (value.amount === null) {
    return <Money amount={value.native.amount} currency={value.native.currency} signed={signed} privacy={privacy} />;
  }
  const title =
    !privacy && value.estimated && value.rate !== null && value.rateDate
      ? `${formatMoney(value.native.amount, value.native.currency)} at ${value.rate} (BoC ${formatRateDate(value.rateDate)})`
      : undefined;
  const differs = value.native.currency !== HOME_CURRENCY;
  return (
    <span class="w-home-money" title={title}>
      <span class="w-home-cad">
        <Money amount={value.amount} currency={HOME_CURRENCY} signed={signed} privacy={privacy} />
        {value.estimated && <span class="w-muted"> est.</span>}
      </span>
      {showNative && differs && (
        <span class="w-muted w-home-native" style={{ display: "block" }}>
          <Money amount={value.native.amount} currency={value.native.currency} signed={signed} privacy={privacy} />
        </span>
      )}
    </span>
  );
}

/** "est. · BoC May 26" / "est. · rates by trade date", plus "N not converted"; nothing for an exact total. */
export function HomeCaption(props: { total: HomeTotalView }) {
  const { estimated, rateDates, excluded } = props.total;
  const excludedCount = props.total.excludedCount ?? excluded.length;
  const parts: string[] = [];
  if (estimated) {
    if (rateDates.length === 1) parts.push(`est. · BoC ${formatRateDate(rateDates[0])}`);
    else if (rateDates.length > 1) parts.push("est. · rates by trade date");
    else parts.push("est.");
  }
  if (excludedCount > 0) parts.push(`${excludedCount} not converted`);
  if (parts.length === 0) return null;
  return <p class="w-caption">{parts.join(" · ")}</p>;
}

/** A CAD total as a HomeMoney value (the original amounts are in the breakdown). */
export const cadValue = (t: HomeTotalView): HomeAmountView => ({ amount: t.amount, estimated: t.estimated, rate: null, rateDate: null, native: { amount: t.amount, currency: "CAD" } });

/** Every part was excluded: the CAD amount is 0 from nothing, so no CAD figure is shown. */
export const notConverted = (t: HomeTotalView) => t.excluded.length > 0 && t.amount === 0 && !t.estimated && t.rateDates.length === 0;
/** Excluded parts summed per currency, in the order they first appear. */
export function byCurrency(parts: HomeTotalView["excluded"]): Array<{ currency: string; amount: number }> {
  const map = new Map<string, number>();
  for (const p of parts) map.set(p.currency, (map.get(p.currency) ?? 0) + p.amount);
  return [...map].map(([currency, amount]) => ({ currency, amount }));
}
export const NOT_CONVERTED = "Not converted (no recent Bank of Canada rate)";
/** The original amounts of a total that could not be converted, with the muted note. */
export function NativeAmounts(props: { total: HomeTotalView; privacy: boolean; signed?: boolean }) {
  const parts = byCurrency(props.total.excluded);
  return <>
    {parts.map((p, i) => <span key={p.currency}>{i > 0 ? " · " : ""}<Money amount={p.amount} currency={p.currency} signed={props.signed} privacy={props.privacy} /></span>)}
    <small class="w-muted" style={{ display: "block" }}>{NOT_CONVERTED}</small>
  </>;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/**
 * Caption of a CAD daily series (values at each day's rate): "est. · 2 days not converted · 1 account not converted".
 * Days are dates left out of the chart; accounts are never converted in the span.
 */
export function SeriesCaption(props: { estimated: boolean; days: number; accounts: number }) {
  const parts: string[] = [];
  if (props.estimated) parts.push("est.");
  if (props.days > 0) parts.push(`${plural(props.days, "day")} not converted`);
  if (props.accounts > 0) parts.push(`${plural(props.accounts, "account")} not converted`);
  if (parts.length === 0) return null;
  return <p class="w-caption">{parts.join(" · ")}</p>;
}
/** "Return unavailable: a USD deposit or withdrawal on Sep 10 could not be converted" (no rate within 7 days). */
export const flowNotConvertedText = (date: string) =>
  `Return unavailable: a USD deposit or withdrawal on ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))} could not be converted`;
