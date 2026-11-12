import { describe, expect, it } from "vitest";

import type { OwnerSessionStore } from "../auth/owner-session.js";
import { localOwnerUpstream } from "./local-upstream.js";
import { UpstreamRejectedError, UpstreamUnavailableError, type UpstreamIdp } from "./upstream.js";

const ISSUER = "https://vestlens.example.test";

// The contract the authorize callback relies on: a refusal from `exchange` is any error other than
// UpstreamUnavailableError (the host then gets access_denied), and `authorizeUrl` is a plain string to redirect to.
describe("UpstreamIdp seam with the local owner upstream", () => {
  const sessions = { resolve: async () => false } as unknown as OwnerSessionStore;
  const upstream: UpstreamIdp = localOwnerUpstream({ sessions, issuer: ISSUER }).upstream;

  it("builds a same-origin path for the browser to follow", () => {
    const url = upstream.authorizeUrl({ state: "s", nonce: "n", codeChallenge: "c".repeat(43), redirectUri: `${ISSUER}/oauth/upstream/callback` });
    expect(url.startsWith("/")).toBe(true);
    expect(url.startsWith("//")).toBe(false);
  });

  it("refuses with a plain error, never the service-unavailable class", async () => {
    const error = await upstream
      .exchange({ code: "unknown", verifier: "v".repeat(43), redirectUri: `${ISSUER}/oauth/upstream/callback`, nonce: "n" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpstreamUnavailableError);
    expect((error as Error).message).toBe("invalid_grant");
  });

  it("keeps the two error classes for implementations that need them", () => {
    expect(new UpstreamRejectedError("x").message).toBe("upstream rejected: x");
    expect(new UpstreamUnavailableError("x").name).toBe("UpstreamUnavailableError");
  });
});
