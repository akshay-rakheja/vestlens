// @vitest-environment jsdom
import { renderHook, waitFor, act } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, signIn, signOut, useOwnerSession } from "./session";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { pathname: "/", search: "", hash: "", assign });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("useOwnerSession", () => {
  it("is loading, then signedIn when the server says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ signedIn: true })));
    const { result } = renderHook(() => useOwnerSession());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/session");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("is signedOut when the server says signedIn is false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ signedIn: false })));
    const { result } = renderHook(() => useOwnerSession());
    await waitFor(() => expect(result.current.status).toBe("signedOut"));
  });

  it("does not bounce to sign-in when the check itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "session_unavailable" }, 503)));
    const { result } = renderHook(() => useOwnerSession());
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
  });

  it("moves to signedOut when any apiFetch call is answered 401", async () => {
    const fetchMock = vi.fn(async (path: string) => (path === "/api/session" ? json({ signedIn: true }) : json({ error: "authentication_required" }, 401)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useOwnerSession());
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    await act(async () => { await apiFetch("/api/portfolio"); });
    expect(result.current.status).toBe("signedOut");
  });
});

describe("signIn and signOut", () => {
  it("redirects to /login with the current path and query as continue", () => {
    vi.stubGlobal("location", { pathname: "/room", search: "?view=room&x=1", hash: "", assign });
    signIn();
    expect(assign).toHaveBeenCalledWith(`/login?continue=${encodeURIComponent("/room?view=room&x=1")}`);
  });

  it("redirects to /login when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ signedIn: false })));
    const { result } = renderHook(() => { const s = useOwnerSession(); useSignInWhenSignedOut(s.status); return s; });
    await waitFor(() => expect(result.current.status).toBe("signedOut"));
    expect(assign).toHaveBeenCalledWith("/login?continue=%2F");
  });

  it("signOut POSTs /logout on the session cookie, then goes to /login", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 303 }));
    vi.stubGlobal("fetch", fetchMock);
    await signOut();
    expect(fetchMock).toHaveBeenCalledWith("/logout", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("signOut still leaves when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await signOut();
    expect(assign).toHaveBeenCalledWith("/login");
  });
});

describe("apiFetch", () => {
  it("uses the session cookie and sends no Authorization header, even if one is passed", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => json({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/portfolio", { headers: { Authorization: "Bearer leaked", "X-Test": "1" } });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-test")).toBe("1");
  });
});

/** What App does: a signed-out session calls signIn(). */
function useSignInWhenSignedOut(status: string) {
  useEffect(() => { if (status === "signedOut") signIn(); }, [status]);
}
