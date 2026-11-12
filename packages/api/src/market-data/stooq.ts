import { fetchText, MarketDataUnavailableError, positiveNumber, type FetchLike, type PricePoint, type PriceHistoryProvider } from "./types.js";

export class StooqProvider implements PriceHistoryProvider {
  readonly name = "stooq";
  constructor(private readonly fetch: FetchLike, private readonly timeoutMs = 8_000) {}
  async history(ticker: string, from: string, to: string): Promise<PricePoint[]> {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker)}&d1=${from.replaceAll("-", "")}&d2=${to.replaceAll("-", "")}&i=d`;
    const text = await fetchText(this.fetch, url, this.timeoutMs, this.name);
    const lines = text.trim().split(/\r?\n/);
    if (!/^Date,Open,High,Low,Close/.test(lines[0] ?? "")) throw new MarketDataUnavailableError(this.name, "malformed");
    return lines.slice(1).flatMap((line) => {
      const [date, , , , close] = line.split(",");
      const value = positiveNumber(close);
      return /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && value !== null ? [{ date: date!, close: value }] : [];
    });
  }
}
