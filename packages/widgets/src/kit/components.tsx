import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState, useLayoutEffect } from "preact/hooks";
import type { KeyboardEvent } from "preact/compat";
import { formatMoney, formatSignedMoney } from "./format";
import { CurrencySwitch } from "./currency-switch";

export function Tile(props: { label: string; value: ComponentChildren; tone?: "up" | "down" | "neutral" }) {
  return (
    <div class="w-tile">
      {props.label}
      <b class={props.tone && props.tone !== "neutral" ? props.tone : undefined}>{props.value}</b>
    </div>
  );
}

export function Segmented<T extends string>(props: {
  options: readonly T[];
  value: T;
  onChange(value: T): void;
  label: string;
  disabled?: boolean;
  /** Individual options that cannot be chosen. */
  disabledOptions?: readonly T[];
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    if (props.disabled) return;
    const count = props.options.length;
    const next = ((index % count) + count) % count;
    if (props.disabledOptions?.includes(props.options[next])) return;
    props.onChange(props.options[next]);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select(index - 1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select(index + 1);
        break;
      case "Home":
        event.preventDefault();
        select(0);
        break;
      case "End":
        event.preventDefault();
        select(props.options.length - 1);
        break;
    }
  };

  return (
    <div class="w-seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((option, index) => {
        const checked = option === props.value;
        return (
          <button
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={props.disabled || props.disabledOptions?.includes(option)}
            tabIndex={checked ? 0 : -1}
            onClick={() => { if (!props.disabled && !props.disabledOptions?.includes(option)) props.onChange(option); }}
            onKeyDown={onKeyDown(index)}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>(props: {
  options: readonly T[];
  value: T;
  onChange(value: T): void;
  label: string;
  /** When set, tabs get ids `${idPrefix}-tab-${i}` and aria-controls `${idPrefix}-panel-${i}` for tabpanel wiring. */
  idPrefix?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const count = props.options.length;
    const next = ((index % count) + count) % count;
    props.onChange(props.options[next]);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select(index - 1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select(index + 1);
        break;
      case "Home":
        event.preventDefault();
        select(0);
        break;
      case "End":
        event.preventDefault();
        select(props.options.length - 1);
        break;
    }
  };

  return (
    <div class="w-tabs" role="tablist" aria-label={props.label}>
      {props.options.map((option, index) => {
        const selected = option === props.value;
        return (
          <button
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            id={props.idPrefix ? `${props.idPrefix}-tab-${index}` : undefined}
            aria-controls={props.idPrefix ? `${props.idPrefix}-panel-${index}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(option)}
            onKeyDown={onKeyDown(index)}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function Pill(props: { tone: "up" | "down" | "neutral"; children: ComponentChildren }) {
  return <span class={`w-pill ${props.tone}`}>{props.children}</span>;
}

export function Chip(props: { children: ComponentChildren }) {
  return <span class="w-chip">{props.children}</span>;
}

/** An active filter the person can remove: styled like the widgets' other filter chips, named "Remove filter {text}". */
export function FilterChip(props: { text: string; disabled?: boolean; onRemove(): void }) {
  return (
    <button type="button" class="w-chip w-toggle" aria-pressed="true" aria-label={`Remove filter ${props.text}`} disabled={props.disabled}
      onClick={props.onRemove}>{`${props.text} ×`}</button>
  );
}

/**
 * A small "i" that opens how a figure is worked out. The glyph is drawn (not a text "i", whose side bearing pushes it
 * off-centre) and centred by layout in an 18px ring inside a 24px hit area. `body` may hold short paragraphs separated
 * by a blank line. Escape and a click outside close it; the panel stays inside the widget.
 */
export function InfoPopover(props: { title: string; body: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLSpanElement>(null);
  const dialogId = `${useId()}-dialog`;

  // Keep the popover fully inside the widget: shift it horizontally if it would overflow either edge.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!open || !el) return;
    el.style.transform = "";
    const rect = el.getBoundingClientRect();
    const view = el.ownerDocument.documentElement.clientWidth || el.ownerDocument.defaultView?.innerWidth || 0;
    const margin = 8;
    let shift = 0;
    if (rect.left < margin) shift = margin - rect.left;
    else if (view && rect.right > view - margin) shift = view - margin - rect.right;
    if (shift) el.style.transform = `translateX(${Math.round(shift)}px)`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const doc = root.current?.ownerDocument;
    const away = (event: Event) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    // Escape anywhere: Safari doesn't focus a clicked button, so the key may never reach the popover itself.
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    doc?.addEventListener("pointerdown", away);
    doc?.addEventListener("keydown", escape);
    return () => { doc?.removeEventListener("pointerdown", away); doc?.removeEventListener("keydown", escape); };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  };

  return (
    <span class="w-info" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={props.label ?? `About ${props.title}`}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span class="w-info-ring" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="2" r="1.05" fill="currentColor" /><rect x="4.1" y="3.9" width="1.8" height="5.1" rx=".9" fill="currentColor" /></svg>
        </span>
      </button>
      {open && (
        <span ref={dialog} id={dialogId} role="dialog" aria-label={props.title}>
          <b>{props.title}</b>
          {props.body.split(/\n\n+/).map((para, i) => <span key={i} class="w-info-p">{para}</span>)}
        </span>
      )}
    </span>
  );
}

export function Banner(props: { tone: "warning" | "info"; children: ComponentChildren }) {
  return (
    <div class={`w-banner ${props.tone}`} role="status">
      {props.children}
    </div>
  );
}

/**
 * The last line of every widget: says where the data comes from and what VestLens is. Widgets that already carry
 * their own, more specific advice disclaimer pass `advice={false}` so it isn't said twice.
 */
export function BrandFooter(props: { advice?: boolean }) {
  return (
    <div class="w-brand">
      <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="4" />
        <circle cx="24" cy="24" r="12" fill="none" stroke="var(--accent)" stroke-width="4" />
      </svg>
      <b>VestLens</b>{" "}
      <span>{props.advice === false ? "Read-only." : "Read-only. Not investment advice."}</span>
    </div>
  );
}

/**
 * The quiet row at the top of a widget: a lock with "Read-only" on the left, the amount and currency toggles on the
 * right as text toggles (teal when on). Accessible names match the old chips: "Hide amounts"/"Show amounts" and
 * "Show original currencies". A widget without a currency view (the report card) leaves out onCadChange.
 */
export function ViewControls(props: { privacy: boolean; onPrivacy(next: boolean): void; cadOn?: boolean; onCadChange?(next: boolean): void }) {
  return (
    <div class="w-controls">
      <span class="w-ro">
        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
          <path d="M2.6 5.2V3.6a2.4 2.4 0 0 1 4.8 0v1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
          <rect x="0.8" y="5.2" width="8.4" height="6.2" rx="1.6" fill="currentColor" />
        </svg>
        Read-only
      </span>
      <span class="w-ctl">
        <button type="button" class="w-tgl" aria-pressed={props.privacy} onClick={() => props.onPrivacy(!props.privacy)}>{props.privacy ? "Show amounts" : "Hide amounts"}</button>
        {props.onCadChange && <CurrencySwitch on={props.cadOn ?? true} onChange={props.onCadChange} />}
      </span>
    </div>
  );
}

/** Market symbol without its Canadian exchange suffix (XEQT.TO shows as XEQT). Display only: requests keep the full symbol. */
export function shortSymbol(symbol: string): string {
  return symbol.replace(/\.(TO|V|NE|CN)$/i, "");
}

/** A symbol as shown: the short form on screen, the full symbol for screen readers and on hover. */
export function SymbolText(props: { symbol: string }) {
  const short = shortSymbol(props.symbol);
  if (short === props.symbol || short === "") return <>{props.symbol}</>;
  return <span title={props.symbol}><span aria-hidden="true">{short}</span><span class="w-sr">{props.symbol}</span></span>;
}

export function Money(props:{ amount: number; currency: string; signed?: boolean; privacy: boolean }) {
  if (props.privacy) {
    return (
      <span class="w-blur" role="img" aria-label="Hidden amount">
        ••••••
      </span>
    );
  }
  return (
    <span>
      {props.signed ? formatSignedMoney(props.amount, props.currency) : formatMoney(props.amount, props.currency)}
    </span>
  );
}
