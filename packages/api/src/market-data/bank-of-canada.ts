import { z } from "zod";
import { fetchJson, MarketDataUnavailableError, positiveNumber, type FetchLike, type FxProvider, type PricePoint } from "./types.js";

const schema = z.object({ observations: z.array(z.object({ d: z.string(), FXUSDCAD: z.object({ v: z.string() }).optional() })) });
export class BankOfCanadaFx implements FxProvider {
  readonly name = "bank_of_canada";
  constructor(private readonly fetch: FetchLike, private readonly timeoutMs = 8_000) {}
  async usdCad(from: string, to: string): Promise<PricePoint[]> {
    const url = `https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=${from}&end_date=${to}`;
    const parsed = schema.safeParse(await fetchJson(this.fetch, url, this.timeoutMs, this.name));
    if (!parsed.success) throw new MarketDataUnavailableError(this.name, "malformed");
    return parsed.data.observations.flatMap((o) => {
      const rate = positiveNumber(o.FXUSDCAD?.v);
      return rate === null ? [] : [{ date: o.d, close: rate }];
    });
  }
}
