import { SESSION_COOKIE, type OwnerSessionStore } from "../auth/owner-session.js";

/** A `Cookie` header value for a freshly created owner session: `vl_session=<token>`. Test-only. */
export async function sessionCookieFor(store: Pick<OwnerSessionStore, "create">): Promise<string> {
  const { token } = await store.create();
  return `${SESSION_COOKIE}=${token}`;
}
