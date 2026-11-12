import { Download, Share2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";

import type { ReportCardView } from "./ReportCard";
import { cad } from "./roomFormat";

/**
 * The shareable card ("share"): a portrait image of a few report card figures, made on the device. The SVG
 * below is drawn onto a canvas and saved or shared as a PNG; nothing is sent to the server. Privacy first: no dollar
 * amounts and no tickers unless the user turns them on, and never account names, balances, a name or an email.
 * Every figure is the report card's own; this file only picks and formats them. Facts only.
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
export const CARD_FILE = "vestlens-card.png";
export const CARD_TITLE = "My investing, by VestLens";
export const CARD_FOOTER = "Read-only. Not investment advice. vestlens.com";
/** The calls and after-sold lines need at least this many picks or stocks. */
export const CARD_MIN_COUNT = 3;

export interface CardOptions { showAmounts: boolean; showTickers: boolean }
/** "positive": a count or a figure above zero, in the accent colour; "neutral": in ink. */
export type CardTone = "positive" | "neutral";
export type CardBlock =
  | { kind: "single"; id: string; label: string; value: string; caption: string; text: string; tone: CardTone }
  | { kind: "pair"; id: string; label: string; cells: Array<{ label: string; value: string }>; text: string };

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");
const pct = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)}%`;
const pts = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)} pts`;
const est = (estimated: boolean) => (estimated ? " (est.)" : "");
const MONTH_YEAR = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", month: "long", year: "numeric" });
/** "This year" when the period starts on 1 January, else "Since <Month YYYY>". */
export function periodLabel(from: string): string {
  return from.slice(5) === "01-01" ? "This year" : `Since ${MONTH_YEAR.format(new Date(`${from}T00:00:00Z`))}`;
}

/** The card's lines, in order, from the report card's own figures (the page's numbers); a line below its threshold is left out. */
export function shareCardBlocks(card: ReportCardView, opts: CardOptions): CardBlock[] {
  const blocks: CardBlock[] = [];
  const { summary } = card.calls;
  const callsShown = summary.compared >= CARD_MIN_COUNT;
  if (callsShown) {
    const value = `${summary.ahead} of ${summary.compared}`;
    blocks.push({ kind: "single", id: "calls", label: "Beat the S&P 500 total return on", value, caption: "picks", text: `Beat the S&P 500 total return on ${value} picks`, tone: "positive" });
  }
  const best = summary.best;
  if (callsShown && best && card.calls.items.length >= 2) {
    // Picks ahead without a figure may be further ahead: then it is the best with a figure.
    const pick = summary.aheadUnmeasured.length > 0 ? "my best pick with a figure" : "my best pick";
    const label = opts.showTickers ? `${best.symbol}, ${pick}` : `${pick.charAt(0).toUpperCase()}${pick.slice(1)}`;
    const value = pts(best.vsSp500Pct);
    const caption = `vs the S&P 500 total return${est(best.estimated)}`;
    blocks.push({ kind: "single", id: "best", label, value, caption, text: `${label}: ${value} ${caption}`, tone: best.vsSp500Pct > 0 ? "positive" : "neutral" });
  }
  if (card.overall) {
    const o = card.overall;
    const period = periodLabel(o.from);
    blocks.push({
      kind: "pair", id: "year", label: `${period}, time-weighted`,
      cells: [{ label: `My portfolio${est(o.returnEstimated)}`, value: pct(o.returnPct) }, { label: `S&P 500 total return${est(o.sp500Estimated)}`, value: pct(o.sp500Pct) }],
      text: `${period}: my portfolio ${pct(o.returnPct)}${est(o.returnEstimated)}, S&P 500 total return ${pct(o.sp500Pct)}${est(o.sp500Estimated)}`,
    });
  }
  const sold = card.afterSold.summary;
  if (sold.sells >= CARD_MIN_COUNT) {
    const value = `${sold.rose} of ${sold.sells}`;
    blocks.push({ kind: "single", id: "sold", label: "The price rose after", value, caption: "of my sales", text: `The price rose after ${value} of my sales`, tone: "positive" });
  }
  const { fees } = card.tradingCost;
  // Fees only: the page carries the conversion estimate, its method and the Bank of Canada dates.
  if (opts.showAmounts && fees.rows > 0) {
    const caption = `fees${est(fees.estimated)}`;
    blocks.push({ kind: "single", id: "costs", label: "Trading costs", value: cad(fees.totalCad), caption, text: `Trading costs: fees ${cad(fees.totalCad)}${est(fees.estimated)}`, tone: "neutral" });
  }
  return blocks;
}

/* ---------------------------------------------------------------------------------------------------------------
 * The card image. Literal colours and system fonts only: an SVG drawn as an image can't read the page's CSS
 * variables or web fonts. The VestLens light palette (index.css); figures in a grotesque like Bricolage.
 * ------------------------------------------------------------------------------------------------------------- */

const C = { ground: "#f4f7f6", paper: "#ffffff", ink: "#14212b", muted: "#4d5c66", line: "#d5dfdd", accent: "#0e6b6b" };
const DISPLAY = "'Bricolage Grotesque Variable', 'Avenir Next', 'Segoe UI', Helvetica, Arial, sans-serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', Helvetica, Arial, sans-serif";
const PAD = 96;
const TOP = 290;
const BOTTOM = 1200;
const INNER = CARD_WIDTH - PAD * 2;

/** Vertical offsets and sizes within a block: the first block is the hero; five blocks use the compact set. */
interface Dims { height: number; labelSize: number; labelY: number; valueSize: number; valueY: number; captionSize: number; captionY: number; cellLabelY: number; cellValueSize: number; cellValueY: number }
const DIMS: Record<"hero" | "heroCompact" | "normal" | "normalCompact", Dims> = {
  hero: { height: 290, labelSize: 34, labelY: 34, valueSize: 168, valueY: 196, captionSize: 42, captionY: 252, cellLabelY: 84, cellValueSize: 120, cellValueY: 196 },
  heroCompact: { height: 240, labelSize: 32, labelY: 32, valueSize: 140, valueY: 164, captionSize: 38, captionY: 214, cellLabelY: 80, cellValueSize: 104, cellValueY: 170 },
  normal: { height: 170, labelSize: 32, labelY: 32, valueSize: 84, valueY: 114, captionSize: 34, captionY: 158, cellLabelY: 76, cellValueSize: 72, cellValueY: 152 },
  normalCompact: { height: 146, labelSize: 30, labelY: 30, valueSize: 72, valueY: 100, captionSize: 30, captionY: 138, cellLabelY: 70, cellValueSize: 62, cellValueY: 134 },
};
const dimsFor = (index: number, count: number): Dims =>
  index === 0 ? (count >= 5 ? DIMS.heroCompact : DIMS.hero) : count >= 5 ? DIMS.normalCompact : DIMS.normal;
/** A font size at most `size` at which `text` fits `width` (a generous per-character estimate; SVG doesn't wrap). */
const fit = (text: string, size: number, width: number, perChar = 0.6) => Math.min(size, Math.floor(width / Math.max(1, text.length * perChar)));

function Block({ block, y, d, hero }: { block: CardBlock; y: number; d: Dims; hero: boolean }) {
  const label = <text x={PAD} y={y + d.labelY} fontFamily={SANS} fontSize={fit(block.label, d.labelSize, INNER, 0.55)} fontWeight={600} fill={C.muted}>{block.label}</text>;
  if (block.kind === "single") {
    return (
      <g>
        {label}
        <text x={PAD - 4} y={y + d.valueY} fontFamily={DISPLAY} fontSize={fit(block.value, d.valueSize, INNER)} fontWeight={700} letterSpacing={hero ? -5 : -2} fill={block.tone === "positive" ? C.accent : C.ink}>{block.value}</text>
        <text x={PAD} y={y + d.captionY} fontFamily={SANS} fontSize={fit(block.caption, d.captionSize, INNER, 0.55)} fill={C.ink}>{block.caption}</text>
      </g>
    );
  }
  const colWidth = INNER / Math.max(1, block.cells.length);
  return (
    <g>
      {label}
      {block.cells.map((cell, i) => (
        <g key={cell.label}>
          <text x={PAD + i * colWidth} y={y + d.cellLabelY} fontFamily={SANS} fontSize={fit(cell.label, d.labelSize - 2, colWidth - 24, 0.55)} fill={C.ink}>{cell.label}</text>
          <text x={PAD + i * colWidth - 3} y={y + d.cellValueY} fontFamily={DISPLAY} fontSize={fit(cell.value, d.cellValueSize, colWidth - 24)} fontWeight={700} letterSpacing={-2} fill={i === 0 ? C.accent : C.ink}>{cell.value}</text>
        </g>
      ))}
    </g>
  );
}

/** The card as an inline SVG, CARD_WIDTH × CARD_HEIGHT; the preview scales it down. */
export function ShareCardSvg({ blocks, svgRef }: { blocks: CardBlock[]; svgRef?: Ref<SVGSVGElement> }) {
  const dims = blocks.map((_b, i) => dimsFor(i, blocks.length));
  const used = dims.reduce((sum, d) => sum + d.height, 0);
  // Generous spacing: the room left over is shared between the gaps.
  const gap = blocks.length > 1 ? Math.min(90, Math.max(20, (BOTTOM - TOP - used) / (blocks.length - 1))) : 0;
  let y = TOP;
  const placed = blocks.map((b, i) => { const at = y; y += dims[i]!.height + gap; return { b, at, i, d: dims[i]! }; });
  return (
    <svg
      ref={svgRef} className="share-card-svg" xmlns="http://www.w3.org/2000/svg" width={CARD_WIDTH} height={CARD_HEIGHT}
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`} role="img" aria-label={[CARD_TITLE, ...blocks.map((b) => b.text), CARD_FOOTER].join(". ")}
    >
      <rect width={CARD_WIDTH} height={CARD_HEIGHT} fill={C.ground} />
      {/* The lens mark, large and faint, and small beside the title. */}
      <g transform={`translate(${CARD_WIDTH - 360} -80) scale(9)`} opacity="0.07" fill="none" stroke={C.accent} strokeWidth="3">
        <circle cx="24" cy="24" r="21" />
        <circle cx="24" cy="24" r="12" />
      </g>
      <g transform={`translate(${PAD} 92) scale(1.25)`} fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="21" stroke={C.ink} />
        <circle cx="24" cy="24" r="12" stroke={C.accent} />
        <polyline points="9,31 18,25 25,28 39,15" stroke={C.accent} />
      </g>
      <text x={PAD} y={232} fontFamily={DISPLAY} fontSize={66} fontWeight={700} letterSpacing={-2} fill={C.ink}>{CARD_TITLE}</text>
      {placed.map(({ b, at, i, d }) => (
        <g key={b.id}>
          {i > 0 && <line x1={PAD} x2={CARD_WIDTH - PAD} y1={at - gap / 2} y2={at - gap / 2} stroke={C.line} strokeWidth="2" />}
          <Block block={b} y={at} d={d} hero={i === 0} />
        </g>
      ))}
      <rect x={0} y={CARD_HEIGHT - 120} width={CARD_WIDTH} height={120} fill={C.paper} />
      <line x1={0} x2={CARD_WIDTH} y1={CARD_HEIGHT - 120} y2={CARD_HEIGHT - 120} stroke={C.line} strokeWidth="2" />
      <text x={PAD} y={CARD_HEIGHT - 50} fontFamily={SANS} fontSize={30} fill={C.muted}>{CARD_FOOTER}</text>
      <rect x={0} y={CARD_HEIGHT - 12} width={CARD_WIDTH} height={12} fill={C.accent} />
    </svg>
  );
}

/* ---------------------------------------------------------------------------------------------------------------
 * Export: SVG → image → canvas → PNG, all in the browser.
 * ------------------------------------------------------------------------------------------------------------- */

export interface CardSize { width: number; height: number }

/** Draws the card's SVG onto a canvas of `size` and returns it as a PNG blob. Nothing leaves the device. */
export async function cardPng(svg: SVGSVGElement | string, size: CardSize): Promise<Blob> {
  const markup = typeof svg === "string" ? svg : new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("card_image"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("card_canvas");
    context.drawImage(image, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("card_png"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const SIZE: CardSize = { width: CARD_WIDTH, height: CARD_HEIGHT };

function canShareFiles(): boolean {
  try {
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    return typeof nav.share === "function" && typeof nav.canShare === "function"
      && nav.canShare({ files: [new File([""], CARD_FILE, { type: "image/png" })] });
  } catch {
    return false;
  }
}

function download(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = CARD_FILE;
  link.rel = "noopener";
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

type Status = "idle" | "working" | "failed";

/** The preview, the privacy toggles, and Download (and Share where the device can share files). */
export function ShareCardPanel({ card, onClose, toPng = cardPng }: { card: ReportCardView; onClose(): void; toPng?: (svg: SVGSVGElement, size: CardSize) => Promise<Blob> }) {
  const [options, setOptions] = useState<CardOptions>({ showAmounts: false, showTickers: false });
  const [status, setStatus] = useState<Status>("idle");
  const blocks = useMemo(() => shareCardBlocks(card, options), [card, options]);
  const svgRef = useRef<SVGSVGElement>(null);
  const shareable = useMemo(canShareFiles, []);

  // A share must start from the tap itself on some phones, so the PNG is made ahead for Share.
  const ready = useRef<{ key: string; blob: Promise<Blob> } | null>(null);
  const key = JSON.stringify(options);
  const png = () => {
    if (!ready.current || ready.current.key !== key) ready.current = { key, blob: toPng(svgRef.current!, SIZE) };
    return ready.current.blob;
  };
  useEffect(() => {
    if (!shareable || !svgRef.current) return;
    png().catch(() => { ready.current = null; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, shareable]);

  const run = async (act: (blob: Blob) => Promise<void> | void) => {
    setStatus("working");
    try {
      await act(await png());
      setStatus("idle");
    } catch (error) {
      ready.current = null;
      // Closing the share sheet is not a failure.
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "idle" : "failed");
    }
  };
  const toggle = (k: keyof CardOptions) => setOptions((o) => ({ ...o, [k]: !o[k] }));

  return (
    <section className="share-card-panel" aria-label="Shareable card">
      <div className="share-card-head">
        <h2>Your shareable card</h2>
        <button type="button" className="secondary-button" onClick={onClose} aria-label="Close the shareable card"><X size={15} /> Close</button>
      </div>
      <p className="data-controls-copy">Made on this device; nothing is uploaded. No dollar amounts or tickers unless you turn them on.</p>
      <div className="share-card-toggles">
        <label><input type="checkbox" checked={options.showAmounts} onChange={() => toggle("showAmounts")} /> Show amounts</label>
        <label><input type="checkbox" checked={options.showTickers} onChange={() => toggle("showTickers")} /> Show tickers</label>
      </div>
      <div className="share-card-preview"><ShareCardSvg blocks={blocks} svgRef={svgRef} /></div>
      <div className="share-card-actions">
        <button type="button" className="primary-button" disabled={status === "working"} onClick={() => void run(download)}><Download size={15} /> Download</button>
        {shareable && (
          <button
            type="button" className="secondary-button" disabled={status === "working"}
            onClick={() => void run((blob) => navigator.share({ files: [new File([blob], CARD_FILE, { type: "image/png" })], title: CARD_TITLE }))}
          ><Share2 size={15} /> Share</button>
        )}
      </div>
      {status === "failed" && <p className="data-controls-copy" role="alert">The card couldn't be made on this device.</p>}
    </section>
  );
}
