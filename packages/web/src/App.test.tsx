// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App, {
  PortfolioExperience,
  createPortfolioApiClient,
  type PortfolioResponse,
} from "./App";

function presentedAccount(input: {
  id: string;
  group:
    | "registered"
    | "non_registered"
    | "digital_assets"
    | "credit_products"
    | "closed";
  groupLabel: string;
  bucket:
    | "tfsa"
    | "fhsa"
    | "rrsp"
    | "margin"
    | "automated_portfolio"
    | "money_market"
    | "crypto"
    | "credit_card";
  bucketLabel: string;
  label: string;
  value: { amount: number; currency: string } | null;
  balances?: Array<{
    currency: string;
    cash: number | null;
    buyingPower: number | null;
  }>;
  positions?: PortfolioResponse["accounts"][number]["positions"];
}): PortfolioResponse["accounts"][number] {
  return {
    id: input.id,
    name: input.label,
    institution: "Wealthsimple",
    rawType: null,
    metaType: null,
    unifiedType: null,
    status: input.group === "closed" ? "closed" : "open",
    isPaper: false,
    classification: {
      group: input.group,
      groupLabel: input.groupLabel,
      bucket: input.bucket,
      bucketLabel: input.bucketLabel,
      label: input.label,
      includedInPortfolioTotal:
        input.group !== "closed" && input.group !== "credit_products",
      isClosed: input.group === "closed",
    },
    value: input.value
      ? { ...input.value, source: "brokerage_reported" }
      : null,
    balances: input.balances ?? [],
    positions: input.positions ?? [],
    positionCount: input.positions?.length ?? 0,
    reconciliation: { calculatedByCurrency: [] },
    freshness: {
      positionsAsOf: "2026-08-19T19:55:00.000Z",
      holdingsLastSyncedAt: "2026-08-19T19:55:00.000Z",
      initialSyncCompleted: true,
      holdingsUnavailable: false,
    },
    warnings: [],
  };
}

const connectedPortfolio: PortfolioResponse = {
  connectionRequired: false,
  generatedAt: "2026-08-19T20:00:00.000Z",
  totals: [
    { currency: "CAD", amount: 5_000, source: "brokerage_reported" },
    { currency: "USD", amount: 600, source: "brokerage_reported" },
  ],
  accounts: [
    presentedAccount({
      id: "tfsa",
      group: "registered",
      groupLabel: "Registered",
      bucket: "tfsa",
      bucketLabel: "TFSA",
      label: "Self-directed TFSA",
      value: { amount: 1_250, currency: "CAD" },
      balances: [{ currency: "CAD", cash: 250, buyingPower: 250 }],
      positions: [
        {
          instrumentId: "instrument-vfv",
          kind: "etf",
          symbol: "VFV.TO",
          description: "Vanguard S&P 500 Index ETF",
          units: 10,
          price: 100,
          costBasis: 90,
          marketValue: 1_000,
          unrealizedGain: 100,
          currency: "CAD",
          cashEquivalent: false,
        },
      ],
    }),
    presentedAccount({
      id: "fhsa",
      group: "registered",
      groupLabel: "Registered",
      bucket: "fhsa",
      bucketLabel: "FHSA",
      label: "Self-directed FHSA",
      value: { amount: 700, currency: "CAD" },
    }),
    presentedAccount({
      id: "rrsp",
      group: "registered",
      groupLabel: "Registered",
      bucket: "rrsp",
      bucketLabel: "RRSP",
      label: "Managed RRSP",
      value: { amount: 900, currency: "CAD" },
    }),
    presentedAccount({
      id: "margin",
      group: "non_registered",
      groupLabel: "Non-registered",
      bucket: "margin",
      bucketLabel: "Margin",
      label: "Margin account",
      value: { amount: 1_000, currency: "CAD" },
      balances: [
        { currency: "CAD", cash: 100, buyingPower: 120 },
        { currency: "USD", cash: 20, buyingPower: null },
      ],
    }),
    presentedAccount({
      id: "automated",
      group: "non_registered",
      groupLabel: "Non-registered",
      bucket: "automated_portfolio",
      bucketLabel: "Automated portfolio",
      label: "Automated portfolio",
      value: { amount: 850, currency: "CAD" },
    }),
    presentedAccount({
      id: "cash-usd",
      group: "non_registered",
      groupLabel: "Non-registered",
      bucket: "money_market",
      bucketLabel: "Cash / money market",
      label: "Cash / money market (USD)",
      value: { amount: 600, currency: "USD" },
    }),
    presentedAccount({
      id: "crypto",
      group: "digital_assets",
      groupLabel: "Digital assets",
      bucket: "crypto",
      bucketLabel: "Crypto",
      label: "Crypto",
      value: { amount: 300, currency: "CAD" },
    }),
    presentedAccount({
      id: "credit-card",
      group: "credit_products",
      groupLabel: "Credit products",
      bucket: "credit_card",
      bucketLabel: "Credit card",
      label: "Credit card",
      value: { amount: -100, currency: "CAD" },
    }),
    presentedAccount({
      id: "closed-tfsa",
      group: "closed",
      groupLabel: "Closed accounts",
      bucket: "tfsa",
      bucketLabel: "TFSA",
      label: "Managed TFSA",
      value: { amount: 10_000, currency: "CAD" },
    }),
  ],
  errors: [],
};

const signedOut = {
  isLoading: false,
  isAuthenticated: false,
  userName: null,
  login: async () => undefined,
  logout: () => undefined,
};

afterEach(cleanup);

describe("PortfolioExperience", () => {
  it("presents a read-only sign-in state before requesting portfolio data", () => {
    render(
      <PortfolioExperience
        auth={signedOut}
        api={{
          getPortfolio: async () => {
            throw new Error("signed-out users must not load a portfolio");
          },
          getConnections: async () => {
            throw new Error("signed-out users must not load connections");
          },
          createConnectionSession: async () => {
            throw new Error("signed-out users must not create connections");
          },
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /your portfolio, read-only/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("offers a Wealthsimple connection when the authenticated user has none", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => ({
            connectionRequired: true,
            generatedAt: "2026-08-19T20:00:00.000Z",
            totals: [],
            accounts: [],
            errors: [],
          }),
          getConnections: async () => [],
          createConnectionSession: async () => ({
            portalUrl: "https://connect.snaptrade.com/portal",
          }),
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: /connect your brokerage/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/snaptrade.*read-only access/i)).toBeInTheDocument();
  });

  it("keeps the live heading", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{ getPortfolio: async () => connectedPortfolio, getConnections: async () => [], createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }) }}
      />,
    );
    expect(await screen.findByText(/live, read-only portfolio/i)).toBeInTheDocument();
  });

  it("asks for a reconnect, in brokerage-neutral words, when the connection must be redone", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => ({
            connectionRequired: true,
            relinkRequired: true,
            generatedAt: "2026-11-02T12:00:00.000Z",
            totals: [],
            accounts: [],
            errors: [],
          }),
          getConnections: async () => [],
          createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }),
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: /reconnect your brokerage/i })).toBeInTheDocument();
    expect(screen.getByText(/settings, goals and\s+contribution room are still here/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to snaptrade/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/moved to a new|wealthsimple again/i);
  });

  it("renders brokerage totals and clustered accounts without trading controls", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => connectedPortfolio,
          getConnections: async () => [],
          createConnectionSession: async () => ({
            portalUrl: "https://connect.snaptrade.com/portal",
          }),
        }}
      />,
    );

    const totals = await screen.findByLabelText("Portfolio totals");
    expect(within(totals).getByText(/brokerage-reported portfolio value/i)).toBeInTheDocument();
    expect(within(totals).getByText("$5,000.00")).toBeInTheDocument();
    expect(within(totals).getByText("US$600.00")).toBeInTheDocument();
    const registered = screen.getByTestId("portfolio-group-registered");
    expect(within(registered).getByRole("heading", { name: "Registered" })).toBeInTheDocument();
    expect(within(registered).getByRole("heading", { name: "TFSA" })).toBeInTheDocument();
    expect(within(registered).getByRole("heading", { name: "FHSA" })).toBeInTheDocument();
    expect(within(registered).getByRole("heading", { name: "RRSP" })).toBeInTheDocument();
    const nonRegistered = screen.getByTestId("portfolio-group-non_registered");
    expect(within(nonRegistered).getByRole("heading", { name: "Non-registered" })).toBeInTheDocument();
    expect(within(nonRegistered).getByRole("heading", { name: "Margin" })).toBeInTheDocument();
    expect(
      within(within(nonRegistered).getByTestId("portfolio-bucket-automated_portfolio"))
        .getAllByRole("heading", { name: "Automated portfolio" }),
    ).toHaveLength(2);
    expect(
      within(within(nonRegistered).getByTestId("portfolio-bucket-money_market"))
        .getByRole("heading", { name: "Cash / money market" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Digital assets" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Credit products" })).toBeInTheDocument();
    expect(screen.getByText("Closed accounts")).toBeInTheDocument();
    expect(screen.getByText("VFV.TO")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy|sell/i })).not.toBeInTheDocument();
    expect(screen.getByText("Reload data shows what VestLens has stored; Refresh now asks your brokerage for a fresh sync.")).toBeInTheDocument();
  });

  it("leads with the combined CAD total (est., with the Bank of Canada date) and keeps each currency below", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => ({ ...connectedPortfolio, homeTotal: { currency: "CAD", amount: 5840, estimated: true, rateDate: "2026-10-27", notConverted: [] } }),
          getConnections: async () => [],
          createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }),
        }}
      />,
    );
    const totals = await screen.findByLabelText("Portfolio totals");
    expect(within(totals).getByText("Total in Canadian dollars")).toBeInTheDocument();
    expect(within(totals).getByText("$5,840.00")).toBeInTheDocument();
    expect(within(totals).getByText("est.")).toBeInTheDocument();
    expect(within(totals).getByText("US dollars converted at the Bank of Canada rate of 2026-10-27.")).toBeInTheDocument();
    expect(within(totals).getByText("As your brokerage reports it")).toBeInTheDocument();
    expect(within(totals).getByText("US$600.00")).toBeInTheDocument();
    expect(screen.getByText("Your total in Canadian dollars, with each currency as your brokerage reports it.")).toBeInTheDocument();
  });

  it("dates the total by the brokerage's last sync, not by when VestLens read SnapTrade", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => connectedPortfolio,
          getConnections: async () => [],
          createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }),
        }}
      />,
    );
    const totals = await screen.findByLabelText("Portfolio totals");
    const stamp = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
    const line = within(totals).getByText(/^Prices as of /);
    expect(line.textContent).toContain(stamp("2026-08-19T19:55:00.000Z"));
    expect(line.textContent).toMatch(/SnapTrade's last sync.*live prices/);
    expect(totals.textContent).not.toContain(stamp("2026-08-19T20:00:00.000Z"));
  });

  it("says when the total leaves out an account with no brokerage total (B9)", async () => {
    const [first, ...rest] = connectedPortfolio.accounts;
    const unreported = { ...first!, id: "U", name: "Second USD account", value: null };
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => ({ ...connectedPortfolio, accounts: [first!, ...rest, unreported] }),
          getConnections: async () => [],
          createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }),
        }}
      />,
    );
    const totals = await screen.findByLabelText("Portfolio totals");
    expect(within(totals).getByText(/^Not included: Second USD account\. The brokerage reports no total for it/)).toBeInTheDocument();
  });

  it("names no account when every counted account has a brokerage total (B9)", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => ({ ...connectedPortfolio, accounts: connectedPortfolio.accounts.map((a: any) => ({ ...a, value: a.value ?? { currency: "CAD", amount: 1, source: "brokerage_reported" } })) }),
          getConnections: async () => [],
          createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }),
        }}
      />,
    );
    const totals = await screen.findByLabelText("Portfolio totals");
    expect(within(totals).queryByText(/The brokerage reports no total/)).toBeNull();
  });

  it("still renders the portfolio when connection health is unavailable", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => connectedPortfolio,
          getConnections: async () => { throw new Error("The portfolio service is temporarily unavailable."); },
          createConnectionSession: async () => ({
            portalUrl: "https://connect.snaptrade.com/portal",
          }),
        }}
      />,
    );

    const totals = await screen.findByLabelText("Portfolio totals");
    expect(within(totals).getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText(/connection status is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your portfolio/i)).not.toBeInTheDocument();
  });

  it("renders mixed-currency cash as separate rows", async () => {
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => connectedPortfolio,
          getConnections: async () => [],
          createConnectionSession: async () => ({
            portalUrl: "https://connect.snaptrade.com/portal",
          }),
        }}
      />,
    );

    const margin = await screen.findByTestId("portfolio-account-margin");
    expect(within(margin).getByText("Cash CAD")).toBeInTheDocument();
    expect(within(margin).getByText("Cash USD")).toBeInTheDocument();
    expect(within(margin).getByText("$100.00")).toBeInTheDocument();
    expect(within(margin).getByText("US$20.00")).toBeInTheDocument();
  });

  it("shows degraded connection health and starts a read-only reconnect", async () => {
    const createConnectionSession = vi.fn(async () => ({
      portalUrl: "https://connect.snaptrade.com/reconnect",
    }));
    const openPortal = vi.fn();
    render(
      <PortfolioExperience
        auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }}
        api={{
          getPortfolio: async () => connectedPortfolio,
          getConnections: async () => [
            {
              id: "00000000-0000-4000-8000-0000000000c2",
              name: "Primary Wealthsimple",
              brokerageSlug: "WEALTHSIMPLETRADE",
              brokerageName: "Wealthsimple",
              readOnly: true,
              disabled: true,
              disabledAt: "2026-08-20T14:00:00.000Z",
              degraded: true,
              maintenance: false,
              dataFreshnessMode: "delayed",
            },
          ],
          createConnectionSession,
        }}
        openPortal={openPortal}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: /connection needs attention/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/brokerage is reporting degraded service/i)).toBeInTheDocument();
    expect(screen.getByText(/daily or delayed data/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^reconnect brokerage$/i }));

    await waitFor(() =>
      expect(createConnectionSession).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-0000000000c2",
      ),
    );
    expect(openPortal).toHaveBeenCalledWith(
      "https://connect.snaptrade.com/reconnect",
    );
  });
});

describe("createPortfolioApiClient", () => {
  it("reads the portfolio on the session cookie, never a bearer token", async () => {
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        if (input !== "/api/portfolio" || authorization !== null || init?.credentials !== "same-origin") {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify(connectedPortfolio), { status: 200 });
      },
    });

    await expect(client.getPortfolio()).resolves.toEqual(connectedPortfolio);
  });

  it("sends a validated reconnect identifier in the connection request body", async () => {
    const reconnect = "00000000-0000-4000-8000-0000000000c2";
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => {
        expect(input).toBe("/api/connections/session");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ reconnect }));
        return new Response(
          JSON.stringify({ portalUrl: "https://connect.snaptrade.com/reconnect" }),
          { status: 200 },
        );
      },
    });

    await expect(client.createConnectionSession(reconnect)).resolves.toEqual({
      portalUrl: "https://connect.snaptrade.com/reconnect",
    });
  });
});

describe("Refresh now", () => {
  const baseApi = () => ({
    getPortfolio: vi.fn(async () => connectedPortfolio),
    getConnections: async () => [],
    createConnectionSession: async () => ({ portalUrl: "https://connect.snaptrade.com/portal" }),
  });
  const mount = (api: ReturnType<typeof baseApi> & { refreshNow?: () => Promise<{ failures: number } | void> }) =>
    render(<PortfolioExperience auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }} api={api} />);

  it("shows Refreshing… while pending, then re-fetches the portfolio", async () => {
    let finish!: () => void;
    const refreshNow = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const api = { ...baseApi(), refreshNow };
    mount(api);
    const button = await screen.findByRole("button", { name: /refresh now/i });
    expect(api.getPortfolio).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    const pending = await screen.findByRole("button", { name: /refreshing/i });
    expect(pending).toBeDisabled();
    finish();
    await waitFor(() => expect(api.getPortfolio).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /refresh now/i })).toBeEnabled();
  });

  /** A fake server: POST /api/refresh answers 202, then GET /api/refresh/status answers each state in turn. */
  function pollingClient(states: unknown[], post: { status: number; body: unknown } = { status: 202, body: { status: "started" } }) {
    const calls: string[] = [];
    const queue = [...states];
    const client = createPortfolioApiClient({
      pollIntervalMs: 0,
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (input === "/api/refresh") return new Response(JSON.stringify(post.body), { status: post.status });
        if (input === "/api/refresh/status") return new Response(JSON.stringify(queue.length > 1 ? queue.shift() : queue[0]), { status: 200 });
        return new Response(JSON.stringify(connectedPortfolio), { status: 200 });
      },
    });
    return { client, calls };
  }

  it("polls the refresh status until the run finishes, then reloads the portfolio", async () => {
    const { client, calls } = pollingClient([{ state: "running" }, { state: "running" }, { state: "succeeded", failures: 0, failureCodes: {} }]);
    const api = { ...baseApi(), refreshNow: client.refreshNow };
    mount(api);
    fireEvent.click(await screen.findByRole("button", { name: /refresh now/i }));
    await waitFor(() => expect(api.getPortfolio).toHaveBeenCalledTimes(2));
    expect(calls.filter((c) => c === "GET /api/refresh/status")).toHaveLength(3);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells the owner when the refresh finished with failures", async () => {
    const { client } = pollingClient([{ state: "succeeded", failures: 2, failureCodes: { sync_account: 2 } }]);
    mount({ ...baseApi(), refreshNow: client.refreshNow });
    fireEvent.click(await screen.findByRole("button", { name: /refresh now/i }));
    expect(await screen.findByText(/finished, but some data could not be updated/i)).toBeInTheDocument();
  });

  it("shows the SnapTrade key message when the refresh failed on a rejected key", async () => {
    const { client } = pollingClient([{ state: "running" }, { state: "failed", error: "snaptrade_key_rejected" }]);
    mount({ ...baseApi(), refreshNow: client.refreshNow });
    fireEvent.click(await screen.findByRole("button", { name: /refresh now/i }));
    expect(await screen.findAllByText(/SnapTrade rejected your API key.*SNAPTRADE_CLIENT_ID.*SNAPTRADE_CONSUMER_KEY.*restart the app.*docker compose up -d/i)).not.toHaveLength(0);
    expect(screen.queryByText(/refresh did not finish/i)).toBeNull();
  });

  it.each([
    [{ state: "failed", error: "busy" }, "A refresh is already running."],
    [{ state: "failed", error: "rate_limited" }, "Try again in a minute."],
    [{ state: "failed", error: "refresh_failed" }, "The refresh did not finish. Please try again."],
  ])("maps a failed run %j to a fixed message", async (state, message) => {
    const { client } = pollingClient([state]);
    mount({ ...baseApi(), refreshNow: client.refreshNow });
    fireEvent.click(await screen.findByRole("button", { name: /refresh now/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("shows the key message as the dashboard error when /api/portfolio answers 502 snaptrade_key_rejected", async () => {
    const client = createPortfolioApiClient({
      fetchImpl: async () => new Response(JSON.stringify({ error: "snaptrade_key_rejected" }), { status: 502 }),
    });
    render(<PortfolioExperience auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }} api={{ ...baseApi(), getPortfolio: client.getPortfolio }} />);
    expect(await screen.findByText(/SnapTrade rejected your API key\. Check SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY in your \.env, then restart the app \(for Docker: docker compose up -d\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });

  it("keeps the generic message for any other 502", async () => {
    const client = createPortfolioApiClient({
      fetchImpl: async () => new Response(JSON.stringify({ error: "internal_error" }), { status: 502 }),
    });
    render(<PortfolioExperience auth={{ ...signedOut, isAuthenticated: true, userName: "Sam" }} api={{ ...baseApi(), getPortfolio: client.getPortfolio }} />);
    expect(await screen.findByText("The portfolio service is temporarily unavailable.")).toBeInTheDocument();
  });

  it.each([
    [409, "A refresh is already running."],
    [429, "Try again in a minute."],
  ])("shows a short neutral message on %i", async (status, message) => {
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => {
        if (input === "/api/refresh") {
          expect(init?.method).toBe("POST");
          return new Response(JSON.stringify({ error: "x" }), { status });
        }
        return new Response(JSON.stringify(connectedPortfolio), { status: 200 });
      },
    });
    mount({ ...baseApi(), refreshNow: client.refreshNow });
    fireEvent.click(await screen.findByRole("button", { name: /refresh now/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh now/i })).toBeEnabled();
  });
});

describe("user data controls", () => {
  const connection = {
    id: "invented-connection-1",
    name: "Invented connection",
    brokerageSlug: "WEALTHSIMPLETRADE",
    brokerageName: "Wealthsimple",
    readOnly: true,
    disabled: false,
    disabledAt: null,
    degraded: false,
    maintenance: false,
    dataFreshnessMode: null,
  };

  function dataApi() {
    return {
      getPortfolio: vi.fn(async () => connectedPortfolio),
      getConnections: vi.fn(async () => [connection]),
      createConnectionSession: vi.fn(async () => ({ portalUrl: "https://connect.snaptrade.com/invented" })),
      disconnectConnection: vi.fn(async () => undefined),
    };
  }

  it("opens the Account page from the topbar, where disconnect moved", async () => {
    const api = dataApi();
    const logout = vi.fn();
    render(<PortfolioExperience auth={{ ...signedOut, isAuthenticated: true, userName: "Invented", logout }} api={api} />);

    expect(screen.queryByRole("region", { name: /your data/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^account$/i }));
    const section = await screen.findByRole("region", { name: /connected brokerages/i });
    fireEvent.click(await within(section).findByRole("button", { name: /^disconnect$/i }));
    fireEvent.click(within(section).getByRole("button", { name: /disconnect wealthsimple/i }));
    await waitFor(() => expect(api.disconnectConnection).toHaveBeenCalledWith("invented-connection-1"));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByRole("button", { name: /^account$/i })).toBeInTheDocument();
  });

  it("sends DELETE requests on the session cookie and explains provider failures", async () => {
    const requests: Array<{ url: string; method?: string; authorization: string | null; body?: unknown }> = [];
    let status = 202;
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get("Authorization"),
          body: init?.body,
        });
        return new Response(JSON.stringify({}), { status });
      },
    });

    await client.disconnectConnection!("invented/connection 1");
    expect(requests).toEqual([
      { url: "/api/connections/invented%2Fconnection%201", method: "DELETE", authorization: null, body: undefined },
    ]);

    status = 502;
    await expect(client.disconnectConnection!("invented-down")).rejects.toThrow(/nothing was removed/i);
    status = 404;
    await expect(client.disconnectConnection!("invented-gone")).rejects.toThrow(/not found/i);
    // Too many disconnects still pending: nothing was attempted, so say so plainly.
    status = 429;
    const capped = client.disconnectConnection!("invented-capped");
    await expect(capped).rejects.toThrow("Too many disconnects are still being processed. Try again later.");
  });
});

describe("App on the owner session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes to the sign-in page, returning here, when the server says signed out", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname: "/", search: "?view=room", hash: "", assign });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ signedIn: false }), { status: 200 })));
    render(<App />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/login?continue=${encodeURIComponent("/?view=room")}`));
    // No sign-in screen flashes while the browser leaves.
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it("loads the portfolio on the cookie when signed in, and signs out through /logout", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname: "/", search: "", hash: "", assign });
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/session") return new Response(JSON.stringify({ signedIn: true }));
      if (input === "/api/portfolio") return new Response(JSON.stringify({ connectionRequired: true, generatedAt: "2026-10-23T12:00:00.000Z", totals: [], accounts: [], errors: [] }));
      if (input === "/logout") return new Response(null, { status: 303 });
      return new Response("[]");
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    const portfolio = calls.find(([path]) => path === "/api/portfolio");
    expect(portfolio?.[1]?.credentials).toBe("same-origin");
    expect(new Headers(portfolio?.[1]?.headers).has("authorization")).toBe(false);
    expect(calls.find(([path]) => path === "/logout")?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
  });
});
