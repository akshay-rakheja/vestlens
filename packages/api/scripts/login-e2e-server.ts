// Synthetic server for the browser login test (packages/web/e2e). The real login router and the real /api/session
// route, an in-memory session store, a throwaway password, no database, no SnapTrade, no network beyond loopback.
import { hashOwnerPassword } from "../src/auth/owner-password.js";
import { loginRouter } from "../src/auth/login-routes.js";
import { createPortfolioApi } from "../src/http/app.js";
import { SlidingWindowLimiter } from "../src/security/sliding-window.js";
import { memoryOwnerSessions } from "../src/testing/owner-session-prisma.js";

const port = Number(process.env.E2E_PORT ?? 47831);
const origin = `http://127.0.0.1:${port}`;
const password = process.env.E2E_PASSWORD ?? "synthetic-e2e-password";

const sessions = memoryOwnerSessions();
const app = createPortfolioApi({
  sessions,
  portfolio: { getPortfolio: async () => ({ connectionRequired: false, generatedAt: new Date().toISOString(), accounts: [], errors: [] }) },
  history: { getAccountHistory: async () => ({}) },
  connections: { getConnections: async () => [], createConnectionPortal: async () => "http://127.0.0.1/unused" },
  appBaseUrl: origin,
  ownerRouters: [
    loginRouter({
      sessions,
      passwordHash: await hashOwnerPassword(password),
      limiter: new SlidingWindowLimiter([{ ms: 15 * 60_000, max: 100 }]),
      secureCookies: false,
      expectedOrigin: origin,
    }),
  ],
} as never);

app.listen(port, "127.0.0.1", () => console.log(`login e2e server on ${origin}`));
