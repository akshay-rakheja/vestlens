// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountPage } from "./AccountPage";
import { FixedMessageError, createPortfolioApiClient } from "./App";

const connection = { id: "conn-1", brokerageName: "Wealthsimple", name: null, readOnly: true, disabled: false };
const aiApp = { clientKey: "client-key-1", name: "<img src=x onerror=alert(1)>Claude", host: "claude.ai", grantedAt: "2026-10-20T12:00:00.000Z" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function api(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    getConnections: vi.fn(async () => [connection]),
    disconnectConnection: vi.fn(async () => undefined),
    getAiApps: vi.fn(async () => [aiApp]),
    revokeAiApp: vi.fn(async () => undefined),
    exportMyData: vi.fn(async () => ({ blob: new Blob(["{}"]), filename: "vestlens-export-2026-10-23.json" })),
    ...over,
  };
}

function setup(client = api(), extra: Record<string, unknown> = {}) {
  const props = { onBack: vi.fn(), onSignOut: vi.fn(), saveFile: vi.fn(), ...extra };
  render(<AccountPage {...({ api: client, ...props } as never as Parameters<typeof AccountPage>[0])} />);
  return { client, props };
}

afterEach(cleanup);

describe("Account page", () => {
  it("lists brokerages and disconnects only after a confirm dialog that says what is removed", async () => {
    const { client } = setup();
    const section = await screen.findByRole("region", { name: /connected brokerages/i });
    fireEvent.click(await within(section).findByRole("button", { name: /^disconnect$/i }));
    expect(client.disconnectConnection).not.toHaveBeenCalled();
    const dialog = within(section).getByRole("alertdialog", { name: /confirm disconnecting wealthsimple/i });
    expect(dialog).toHaveTextContent(/deletes its accounts, snapshots and history/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /disconnect wealthsimple/i }));
    await waitFor(() => expect(client.disconnectConnection).toHaveBeenCalledWith("conn-1"));
    await waitFor(() => expect(client.getConnections).toHaveBeenCalledTimes(2));
  });

  it("can cancel a disconnect", async () => {
    const { client } = setup();
    const section = await screen.findByRole("region", { name: /connected brokerages/i });
    fireEvent.click(await within(section).findByRole("button", { name: /^disconnect$/i }));
    fireEvent.click(within(section).getByRole("button", { name: /cancel/i }));
    expect(within(section).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(client.disconnectConnection).not.toHaveBeenCalled();
  });

  it("lists AI apps as text only and revokes after confirmation", async () => {
    const { client } = setup();
    const section = await screen.findByRole("region", { name: /connected ai apps/i });
    expect(await within(section).findByText(/<img src=x onerror=alert\(1\)>Claude/)).toBeInTheDocument();
    expect(section.querySelector("img")).toBeNull();
    expect(within(section).getByText(/claude\.ai/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: /^revoke$/i }));
    expect(client.revokeAiApp).not.toHaveBeenCalled();
    const dialog = within(section).getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/no longer be able to read your portfolio/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke access$/i }));
    await waitFor(() => expect(client.revokeAiApp).toHaveBeenCalledWith("client-key-1"));
    await waitFor(() => expect(client.getAiApps).toHaveBeenCalledTimes(2));
  });

  it("downloads the export through the saver with the server's filename", async () => {
    const { client, props } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /download my data/i }));
    await waitFor(() => expect(props.saveFile).toHaveBeenCalledOnce());
    expect(client.exportMyData).toHaveBeenCalledOnce();
    expect(props.saveFile.mock.calls[0]![1]).toBe("vestlens-export-2026-10-23.json");
  });

  it("shows a fixed message when the export fails", async () => {
    setup(api({ exportMyData: vi.fn(async () => { throw new Error("SERVER-DETAIL"); }) }));
    fireEvent.click(await screen.findByRole("button", { name: /download my data/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/did not finish/i);
    expect(document.body.textContent).not.toContain("SERVER-DETAIL");
  });

  it("states the retention periods and the backup window", async () => {
    setup();
    expect(await screen.findByText(/Deleted data leaves our backups within 14 days\./)).toBeInTheDocument();
    expect(screen.getByText(/90 days/)).toBeInTheDocument();
  });

  it("goes back to the dashboard", async () => {
    const { props } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /back/i }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });
});

describe("account API client", () => {
  const record = () => {
    const requests: Array<{ url: string; method?: string; authorization: string | null }> = [];
    let respond: () => Response = () => new Response("[]");
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get("Authorization") });
        return respond();
      },
    });
    return { client, requests, set: (fn: () => Response) => { respond = fn; } };
  };

  it("calls the AI app and export routes on the session cookie", async () => {
    const { client, requests, set } = record();
    await client.getAiApps!();
    set(() => new Response(null, { status: 204 }));
    await client.revokeAiApp!("key/with space");
    set(() => new Response("{}", { headers: { "Content-Disposition": 'attachment; filename="vestlens-export-2026-10-23.json"' } }));
    const exported = await client.exportMyData!();
    expect(exported.filename).toBe("vestlens-export-2026-10-23.json");
    expect(requests).toEqual([
      { url: "/api/ai-apps", method: undefined, authorization: null },
      { url: "/api/ai-apps/key%2Fwith%20space/revoke", method: "POST", authorization: null },
      { url: "/api/account/export", method: undefined, authorization: null },
    ]);
  });

  it("falls back to a safe filename and throws fixed messages", async () => {
    const { client, set } = record();
    set(() => new Response("{}", { headers: { "Content-Disposition": 'attachment; filename="../../etc/passwd"' } }));
    expect((await client.exportMyData!()).filename).toBe("vestlens-export.json");
    set(() => new Response("SERVER-DETAIL", { status: 500 }));
    const failure = client.exportMyData!();
    await expect(failure).rejects.toBeInstanceOf(FixedMessageError);
    await expect(failure).rejects.not.toThrow(/SERVER-DETAIL/);
    set(() => new Response("x", { status: 404 }));
    await expect(client.revokeAiApp!("gone")).rejects.toThrow(/not found/i);
  });
});

describe("What VestLens remembers", () => {
  const HOSTILE = "<b>x</b> [a](b) <img src=x onerror=alert(1)>";
  const fact = (over: Record<string, unknown> = {}) => ({
    id: "f1", nodeType: "security", nodeKey: "SYN", property: "security.reason", value: null, text: "Bought for the dividend.", kind: "reason",
    provenance: "stated", source: "claude", validFrom: null, validTo: null, recordedAt: "2026-10-20T15:00:00.000Z", ...over,
  });
  const groups = (...gs: Array<[string, Array<Record<string, unknown>>]>) => ({ groups: gs.map(([nodeType, facts]) => ({ nodeType, facts })) });
  const memoryApi = (over: Record<string, unknown> = {}) => api({
    getMemory: vi.fn(async () => groups(
      ["account", [fact({ id: "a1", nodeType: "account", nodeKey: "outside:Bank", property: "account.note", text: "Outside TFSA at my bank." })]],
      ["security", [fact()]],
      ["goal", [fact({ id: "g1", nodeType: "goal", nodeKey: "house", property: "goal.note", text: "Save for a house.", provenance: "inferred", source: "chatgpt", kind: "plan" })]],
      ["rule", [fact({ id: "r1", nodeType: "rule", nodeKey: "cap", property: "rule.note", text: "Never more than 10% in one stock." })]],
      ["tax_year", [fact({ id: "t1", nodeType: "tax_year", nodeKey: "2026:tfsa", property: "tax_year.cra_room_jan1", value: { amountCad: 7000 }, text: "TFSA room on 1 January 2026." })]],
      ["user", [fact({ id: "u1", nodeType: "user", nodeKey: "me", property: "user.note", text: "Comfortable with some risk." })]],
    )),
    editMemory: vi.fn(async () => undefined),
    promoteMemory: vi.fn(async () => undefined),
    deleteMemory: vi.fn(async () => undefined),
    ...over,
  });
  const section = async () => screen.findByRole("region", { name: /what vestlens remembers/i });

  it("groups facts by thing and shows each fact's text, date, source and provenance", async () => {
    setup(memoryApi());
    const s = await section();
    await within(s).findByText("Bought for the dividend.");
    const headings = within(s).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Accounts", "Holdings", "Goals", "Rules", "Tax years", "You"]);
    const holdings = within(s).getByRole("region", { name: "Holdings" });
    expect(holdings).toHaveTextContent("Bought for the dividend.");
    expect(holdings).toHaveTextContent("2026-10-20");
    expect(holdings).toHaveTextContent("claude");
    expect(holdings).toHaveTextContent("Stated");
    expect(within(holdings).queryByText("Inferred")).not.toBeInTheDocument();
  });

  it("labels inferred facts and promotes them with That's right", async () => {
    const client = memoryApi();
    setup(client);
    const goals = within(await section()).getByRole("region", { name: "Goals" });
    expect(await within(goals).findByText("Inferred")).toBeInTheDocument();
    expect(within(await section()).getAllByRole("button", { name: /that.s right/i })).toHaveLength(1);
    fireEvent.click(within(goals).getByRole("button", { name: /that.s right/i }));
    await waitFor(() => expect(client.promoteMemory).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(client.getMemory).toHaveBeenCalledTimes(2));
  });

  it("renders every string as text: no HTML, no links", async () => {
    setup(memoryApi({
      getMemory: vi.fn(async () => groups(["security", [fact({ text: HOSTILE, nodeKey: "<i>k</i>", source: "[a](b)" })]])),
    }));
    const s = await section();
    expect(await within(s).findByText(HOSTILE)).toBeInTheDocument();
    expect(s.querySelector("b, i, img, a")).toBeNull();
    expect(s).toHaveTextContent("[a](b)");
  });

  it("edits inline as a superseding save, with the text prefilled; cancel saves nothing", async () => {
    const client = memoryApi();
    setup(client);
    const holdings = within(await section()).getByRole("region", { name: "Holdings" });
    fireEvent.click(await within(holdings).findByRole("button", { name: /^edit$/i }));
    const box = within(holdings).getByLabelText(/^entry text$/i) as HTMLTextAreaElement;
    expect(box.value).toBe("Bought for the dividend.");
    fireEvent.click(within(holdings).getByRole("button", { name: /^cancel$/i }));
    expect(client.editMemory).not.toHaveBeenCalled();
    fireEvent.click(within(holdings).getByRole("button", { name: /^edit$/i }));
    fireEvent.change(within(holdings).getByLabelText(/^entry text$/i), { target: { value: HOSTILE } });
    fireEvent.click(within(holdings).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(client.editMemory).toHaveBeenCalledWith("f1", { text: HOSTILE }));
    await waitFor(() => expect(client.getMemory).toHaveBeenCalledTimes(2));
  });

  it("offers an amount field for the TFSA room fact and sends a typed value", async () => {
    const client = memoryApi();
    setup(client);
    const years = within(await section()).getByRole("region", { name: "Tax years" });
    fireEvent.click(await within(years).findByRole("button", { name: /^edit$/i }));
    const amount = within(years).getByLabelText(/amount in cad/i) as HTMLInputElement;
    expect(amount.value).toBe("7000");
    fireEvent.change(amount, { target: { value: "6500" } });
    fireEvent.click(within(years).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(client.editMemory).toHaveBeenCalledWith("t1", { text: "TFSA room on 1 January 2026.", value: { amountCad: 6500 } }));
  });

  it("shows a fixed message when a save fails", async () => {
    setup(memoryApi({ editMemory: vi.fn(async () => { throw new FixedMessageError("That change could not be saved."); }) }));
    const holdings = within(await section()).getByRole("region", { name: "Holdings" });
    fireEvent.click(await within(holdings).findByRole("button", { name: /^edit$/i }));
    fireEvent.click(within(holdings).getByRole("button", { name: /^save$/i }));
    expect(await within(holdings).findByRole("alert")).toHaveTextContent("That change could not be saved.");
  });

  it("deletes only after a confirm that says it is removed from memory", async () => {
    const client = memoryApi();
    setup(client);
    const holdings = within(await section()).getByRole("region", { name: "Holdings" });
    fireEvent.click(await within(holdings).findByRole("button", { name: /^delete$/i }));
    expect(client.deleteMemory).not.toHaveBeenCalled();
    const dialog = within(holdings).getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/removes this from what vestlens remembers/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete entry$/i }));
    await waitFor(() => expect(client.deleteMemory).toHaveBeenCalledWith("f1"));
    await waitFor(() => expect(client.getMemory).toHaveBeenCalledTimes(2));
  });

  it("can cancel a delete", async () => {
    const client = memoryApi();
    setup(client);
    const holdings = within(await section()).getByRole("region", { name: "Holdings" });
    fireEvent.click(await within(holdings).findByRole("button", { name: /^delete$/i }));
    fireEvent.click(within(holdings).getByRole("button", { name: /^cancel$/i }));
    expect(within(holdings).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(client.deleteMemory).not.toHaveBeenCalled();
  });

  it("shows an empty state, and a fixed message when loading fails", async () => {
    setup(memoryApi({ getMemory: vi.fn(async () => ({ groups: [] })) }));
    expect(await within(await section()).findByText(/hasn.t remembered anything yet/i)).toBeInTheDocument();
    cleanup();
    setup(memoryApi({ getMemory: vi.fn(async () => { throw new Error("SERVER-DETAIL"); }) }));
    expect(await within(await section()).findByRole("alert")).toHaveTextContent(/did not finish/i);
    expect(document.body.textContent).not.toContain("SERVER-DETAIL");
  });

  it("is absent when the client has no memory methods", async () => {
    setup();
    await screen.findByRole("region", { name: /connected brokerages/i });
    expect(screen.queryByRole("region", { name: /what vestlens remembers/i })).not.toBeInTheDocument();
  });
});

describe("memory API client", () => {
  const record = () => {
    const requests: Array<{ url: string; method?: string; body?: string; authorization: string | null }> = [];
    let respond: () => Response = () => new Response(JSON.stringify({ groups: [] }));
    const client = createPortfolioApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method, body: init?.body as string | undefined, authorization: new Headers(init?.headers).get("Authorization") });
        return respond();
      },
    });
    return { client, requests, set: (fn: () => Response) => { respond = fn; } };
  };

  it("calls the memory and room routes on the session cookie", async () => {
    const { client, requests, set } = record();
    await client.getMemory!();
    set(() => new Response("{}"));
    await client.editMemory!("id/1", { text: "x" });
    await client.promoteMemory!("id/1");
    set(() => new Response(null, { status: 204 }));
    await client.deleteMemory!("id/1");
    set(() => new Response(JSON.stringify({ status: "missing", missing: [], alert: null })));
    await client.getTfsaRoom!();
    expect(requests.map((r) => [r.method, r.url, r.authorization])).toEqual([
      [undefined, "/api/memory", null],
      ["PATCH", "/api/memory/id%2F1", null],
      ["POST", "/api/memory/id%2F1/promote", null],
      ["DELETE", "/api/memory/id%2F1", null],
      [undefined, "/api/room/tfsa", null],
    ]);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ text: "x" });
  });

  it("throws fixed messages, never server text", async () => {
    const { client, set } = record();
    set(() => new Response(JSON.stringify({ error: "invalid_memory_edit", message: "SERVER-DETAIL" }), { status: 400 }));
    const failure = client.editMemory!("a", { text: "x" });
    await expect(failure).rejects.toBeInstanceOf(FixedMessageError);
    await expect(failure).rejects.toThrow("That change could not be saved.");
    set(() => new Response("x", { status: 404 }));
    await expect(client.deleteMemory!("a")).rejects.toThrow(/no longer there/i);
    set(() => new Response("SERVER-DETAIL", { status: 500 }));
    await expect(client.promoteMemory!("a")).rejects.not.toThrow(/SERVER-DETAIL/);
  });
});
