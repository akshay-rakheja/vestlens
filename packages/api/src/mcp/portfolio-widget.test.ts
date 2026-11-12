import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { portfolioWidgetHtml } from "./portfolio-widget.js";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  hidden = false;
  open = false;
  type = "";
  onclick: (() => void) | null = null;
  private value = "";

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.value = String(value);
    this.children = [];
  }

  get textContent(): string {
    return this.value + this.children.map((child) => child.textContent).join("");
  }

  set innerHTML(_value: string) {
    throw new Error("Dynamic innerHTML is forbidden");
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.value = "";
    this.children = [...children];
  }

  addEventListener(_name: string, listener: () => void) {
    this.onclick = listener;
  }

  setAttribute(_name: string, _value: string) {}
}

function executeWidget(toolOutput: Record<string, unknown>) {
  const elements = new Map(
    ["status", "totals", "groups", "generated", "refresh"].map((id) => [
      id,
      new FakeElement("div"),
    ]),
  );
  const listeners = new Map<string, (event: unknown) => void>();
  const document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    getElementById: (id: string) => elements.get(id) ?? null,
  };
  const window = {
    openai: { toolOutput },
    parent: { postMessage: () => undefined },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      listeners.set(name, listener);
    },
    removeEventListener: (name: string) => { listeners.delete(name); },
  };
  const script = portfolioWidgetHtml().match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("Widget script is missing");

  vm.runInNewContext(script, {
    document,
    window,
    Intl,
    Map,
    Set,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console,
  });

  return { elements, listeners };
}

describe("portfolioWidgetHtml", () => {
  it("renders separate currency totals and safe account labels from tool output", () => {
    const { elements } = executeWidget({
      connectionRequired: false,
      generatedAt: "2026-08-26T20:05:00.000Z",
      totals: [
        { currency: "CAD", amount: 1500, source: "brokerage_reported" },
        { currency: "USD", amount: 600, source: "brokerage_reported" },
      ],
      accounts: [
        {
          id: "margin",
          name: "<img src=x onerror=alert(1)>",
          institution: "Wealthsimple",
          classification: {
            group: "non_registered",
            groupLabel: "Non-registered",
            bucket: "margin",
            bucketLabel: "Margin",
            label: "Margin account",
            includedInPortfolioTotal: true,
            isClosed: false,
          },
          value: {
            currency: "CAD",
            amount: 1500,
            source: "brokerage_reported",
          },
          positionCount: 2,
          balances: [],
          positions: [],
          freshness: { positionsAsOf: "2026-08-26T20:00:00.000Z" },
          warnings: [],
        },
      ],
      errors: [],
    });

    expect(elements.get("totals")?.textContent).toContain("$1,500.00");
    expect(elements.get("totals")?.textContent).toContain("US$600.00");
    expect(elements.get("groups")?.textContent).toContain("Non-registered");
    expect(elements.get("groups")?.textContent).toContain("Margin account");
    expect(elements.get("groups")?.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
  });
});
