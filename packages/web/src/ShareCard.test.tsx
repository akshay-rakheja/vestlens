// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReportCardView } from "./ReportCard";
import { CARD_FOOTER, CARD_HEIGHT, CARD_TITLE, CARD_WIDTH, cardPng, periodLabel, ShareCardPanel, shareCardBlocks } from "./ShareCard";

// Synthetic symbols, dates, prices and amounts only.
const call = (symbol: string, vs: number, over: Record<string, unknown> = {}) => ({
  symbol, returnPct: vs + 5, vsSp500Pct: vs, vsTsxPct: vs + 1, startDate: "2025-01-02", endDate: "2026-10-22", estimated: false, rateDate: null as string | null, ...over,
});
const sale = (symbol: string, date: string, changePct: number) => ({
  symbol, date, units: 5, salePrice: 20, currency: "CAD", estimated: false, priceRateDate: null, recordedPrice: null, latestClose: 20 * (1 + changePct / 100),
  latestCloseDate: "2026-10-22", changePct, keptVsSold: { native: { amount: changePct, currency: "CAD" }, cad: changePct, estimated: false, rateDate: null },
});
const none = { count: 0, reasons: [] };
const SYMBOLS = ["AAA", "BBB", "CCC", "SLA", "SLB", "SLC", "SLD"];
const valueFill = (text: string) => [...document.querySelectorAll("svg.share-card-svg text")].find((t) => t.textContent === text)!.getAttribute("fill");

const report = (over: Partial<ReportCardView> = {}): ReportCardView => ({
  asOf: "2026-10-23",
  activityFrom: "2025-01-02",
  calls: {
    checked: 4,
    items: [call("AAA", 18.24), call("CCC", 2), call("BBB", -15)],
    summary: { compared: 4, ahead: 3, behind: 1, even: 0, best: call("AAA", 18.24), worst: call("BBB", -15), aheadUnmeasured: [] },
    cantTell: none,
  },
  afterSold: {
    items: [sale("SLA", "2026-06-01", -4), sale("SLA", "2026-02-02", 12), sale("SLB", "2026-05-01", 8), sale("SLC", "2026-04-01", 3), sale("SLD", "2026-03-02", -1)],
    summary: { sells: 5, rose: 3, fell: 2, unchanged: 0, keptVsSoldCad: 18, estimated: false, rateDate: null, notConverted: 0, native: [] },
    cantTell: none,
  },
  tradingCost: {
    conversion: {
      rows: 25, convertedCad: 27000, estimated: false, rateDate: null, native: [], cantTell: none,
      estimate: { rows: 22, minRows: 20, costCad: 300, sharePct: 1.11, estimated: true, rateDates: { first: "2025-01-02", last: "2026-01-05" }, cantTell: none },
    },
    fees: { rows: 3, totalCad: 8.7, estimated: true, rateDate: "2026-03-02", native: [{ currency: "USD", amount: 2 }], cantTell: none },
  },
  overall: { period: "YTD", from: "2026-01-01", to: "2026-10-22", returnPct: 8.4, sp500Pct: 12.1, returnEstimated: false, sp500Estimated: false },
  ...over,
});

const OFF = { showAmounts: false, showTickers: false };
const texts = (r: ReportCardView, o = OFF) => shareCardBlocks(r, o).map((b) => b.text);
const svgText = () => document.querySelector("svg.share-card-svg")!.textContent ?? "";
const svgMarkup = () => document.querySelector("svg.share-card-svg")!.outerHTML;
const panel = (r: ReportCardView, toPng = vi.fn(async () => new Blob(["png"], { type: "image/png" }))) => {
  render(<ShareCardPanel card={r} onClose={vi.fn()} toPng={toPng} />);
  return toPng;
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shareCardBlocks", () => {
  it("states each line from the report's own numbers", () => {
    expect(texts(report())).toEqual([
      "Beat the S&P 500 total return on 3 of 4 picks",
      "My best pick: +18.2 pts vs the S&P 500 total return",
      "This year: my portfolio +8.4%, S&P 500 total return +12.1%",
      "The price rose after 3 of 5 of my sales",
    ]);
  });

  it("leaves lines out below their thresholds; the best line only shows with the calls line", () => {
    const r = report();
    // Two picks compared, both with a figure: neither the calls line nor the best line.
    const fewCalls = { ...r.calls, summary: { ...r.calls.summary, compared: 2, ahead: 1, behind: 1 } };
    const fewSales = { ...r.afterSold, summary: { ...r.afterSold.summary, sells: 2, rose: 1, fell: 1 } };
    expect(texts({ ...r, calls: fewCalls, afterSold: fewSales, overall: null })).toEqual([]);
    // Exactly at the threshold: three picks compared, three sales.
    const three = { ...r.calls.summary, compared: 3, ahead: 2, behind: 1 };
    const atThreshold = texts({ ...r, calls: { ...r.calls, summary: three }, afterSold: { ...r.afterSold, summary: { ...r.afterSold.summary, sells: 3, rose: 2, fell: 1 } }, overall: null });
    expect(atThreshold).toEqual(["Beat the S&P 500 total return on 2 of 3 picks", "My best pick: +18.2 pts vs the S&P 500 total return", "The price rose after 2 of 3 of my sales"]);
  });

  it("uses the page's sale counts, not its own", () => {
    const r = report();
    // The card never recounts the items: the summary is what the page shows.
    const out = texts({ ...r, afterSold: { ...r.afterSold, items: [], summary: { ...r.afterSold.summary, sells: 11, rose: 7 } } });
    expect(out).toContain("The price rose after 7 of 11 of my sales");
  });

  it("labels Overall by its period: this year from 1 January, else since the month it starts", () => {
    expect(periodLabel("2026-01-01")).toBe("This year");
    expect(periodLabel("2026-03-14")).toBe("Since March 2026");
    const r = report();
    expect(texts({ ...r, overall: { ...r.overall!, from: "2026-03-14" } })).toContain("Since March 2026: my portfolio +8.4%, S&P 500 total return +12.1%");
  });

  it("the best line says it is the best with a figure when some picks are ahead without one, and labels an estimate", () => {
    const r = report();
    const unmeasured = [{ symbol: "WIN", returnPct: 50, startDate: "2025-02-03", endDate: "2026-03-02", estimated: false, rateDate: null }];
    const best = call("AAA", 18.24, { estimated: true, rateDate: "2026-10-22" });
    const out = texts({ ...r, calls: { ...r.calls, summary: { ...r.calls.summary, best, aheadUnmeasured: unmeasured } } });
    expect(out).toContain("My best pick with a figure: +18.2 pts vs the S&P 500 total return (est.)");
    expect(texts({ ...r, calls: { ...r.calls, summary: { ...r.calls.summary, best, aheadUnmeasured: unmeasured } } }, { showAmounts: false, showTickers: true }))
      .toContain("AAA, my best pick with a figure: +18.2 pts vs the S&P 500 total return (est.)");
  });

  it("adds tickers and amounts only when turned on, with the estimate labelled est.", () => {
    const out = texts(report(), { showAmounts: true, showTickers: true });
    expect(out).toContain("AAA, my best pick: +18.2 pts vs the S&P 500 total return");
    // Fees only, est. when converted; the conversion estimate stays on the page.
    expect(out).toContain("Trading costs: fees $8.70 (est.)");
    expect(out.join(" ")).not.toMatch(/conversion|\$300/);
    const r = report();
    expect(texts({ ...r, tradingCost: { ...r.tradingCost, fees: { ...r.tradingCost.fees, estimated: false, native: [] } } }, { showAmounts: true, showTickers: false }))
      .toContain("Trading costs: fees $8.70");
    expect(texts(report(), { showAmounts: false, showTickers: true }).join(" ")).not.toContain("$");
  });
});

describe("ShareCardPanel", () => {
  it("renders the title, the lines and the footer in the card", () => {
    panel(report());
    const text = svgText();
    expect(text).toContain(CARD_TITLE);
    expect(text).toContain("3 of 4");
    expect(text).toContain("+18.2 pts");
    expect(text).toContain(CARD_FOOTER);
    const svg = document.querySelector("svg.share-card-svg")!;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`);
    expect(svg.getAttribute("aria-label")).toContain("Beat the S&P 500 total return on 3 of 4 picks");
  });

  it("a best pick at or below the index is in ink, not the accent colour", () => {
    const r = report();
    panel(r);
    expect(valueFill("+18.2 pts")).toBe("#0e6b6b");
    cleanup();
    const behind = call("AAA", -2);
    panel({ ...r, calls: { ...r.calls, items: [behind, call("BBB", -15)], summary: { ...r.calls.summary, ahead: 0, behind: 4, best: behind } } });
    expect(valueFill("-2.0 pts")).toBe("#14212b");
  });

  it("by default the card has no dollar amounts and no tickers; the toggles add them", () => {
    panel(report());
    for (const s of SYMBOLS) expect(svgMarkup()).not.toContain(s);
    expect(svgMarkup()).not.toContain("$");
    fireEvent.click(screen.getByLabelText("Show tickers"));
    expect(svgText()).toContain("AAA");
    expect(svgMarkup()).not.toContain("$");
    fireEvent.click(screen.getByLabelText("Show amounts"));
    expect(svgText()).toContain("$8.70");
    expect(svgText()).toContain("fees (est.)");
    expect(svgText()).not.toContain("$300");
  });

  it("never shows account names, balances or a name or email, and uses no advice or judgement words", () => {
    panel(report());
    fireEvent.click(screen.getByLabelText("Show tickers"));
    fireEvent.click(screen.getByLabelText("Show amounts"));
    const text = `${svgText()} ${document.body.textContent}`;
    expect(text).not.toMatch(/TFSA|RRSP|FHSA|balance|@|27,000/i);
    expect(text).not.toMatch(/\b(should|consider|mistakes?|bad calls?|better off|recommend\w*|regret\w*|wrong|crush\w*|lost|losers?|winners?|beat you|smart|dumb)\b/i);
  });

  it("exports the card at 1080×1350 and downloads vestlens-card.png", async () => {
    const createObjectURL = vi.fn(() => "blob:synthetic");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const attached: boolean[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { attached.push(this.isConnected); });
    const toPng = panel(report());
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(toPng).toHaveBeenCalledWith(expect.any(SVGSVGElement), { width: 1080, height: 1350 });
    const anchor = click.mock.contexts[click.mock.contexts.length - 1] as HTMLAnchorElement;
    expect(attached).toEqual([true]);
    expect(anchor.isConnected).toBe(false);
    expect(anchor.download).toBe("vestlens-card.png");
    expect(anchor.href).toBe("blob:synthetic");
  });

  it("offers Share only when the device can share files", async () => {
    panel(report());
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    cleanup();
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, share, canShare: () => true });
    panel(report());
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    const data = (share.mock.calls[0] as unknown as [{ files: File[] }])[0];
    expect(data.files[0]!.name).toBe("vestlens-card.png");
    expect(data.files[0]!.type).toBe("image/png");
  });
});

describe("cardPng", () => {
  it("draws the SVG onto a 1080×1350 canvas and returns a PNG, on the device", async () => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage, fillRect: vi.fn(), fillStyle: "" })), toBlob: vi.fn((cb: (b: Blob) => void, type: string) => cb(new Blob(["png"], { type }))) };
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "canvas" ? canvas : realCreate(tag))) as typeof document.createElement);
    class FakeImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; decoding = ""; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:synthetic"), revokeObjectURL: vi.fn() }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const blob = await act(() => cardPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"></svg>`, { width: CARD_WIDTH, height: CARD_HEIGHT }));
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1350);
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 1080, 1350);
    expect(blob.type).toBe("image/png");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
