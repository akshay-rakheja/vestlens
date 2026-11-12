import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import {
  InvalidAccessTokenError,
  MissingRequiredScopeError,
  type AuthenticatedIdentity,
} from "../auth/token-types.js";
import { DASHBOARD_PARTY, SESSION_COOKIE } from "../auth/owner-session.js";
import { setSessionCookie } from "../auth/login-routes.js";
import { OWNER_SUBJECT } from "../identity/owner-identity.js";
import { isLoopbackHttp } from "../loopback-url.js";
import { isSameOriginRequest } from "./same-origin.js";
import { handlePortfolioMcpRequest } from "../mcp/portfolio-mcp-server.js";
import type { OverviewDeps } from "../mcp/overview-tools.js";
import type { PerformanceDeps } from "../mcp/performance-tools.js";
import type { ActivityDeps } from "../mcp/activity-tools.js";
import type { AllocationDeps } from "../mcp/allocation-tools.js";
import type { IncomeDeps } from "../mcp/income-tools.js";
import type { HoldingsDeps } from "../mcp/holdings-tools.js";
import type { NewsDeps } from "../mcp/news-tools.js";
import type { CalendarDeps } from "../mcp/calendar-tools.js";
import { alertsClientKey, type AlertsDeps } from "../mcp/alerts-tools.js";
import type { MemoryToolDeps } from "../mcp/memory-tools.js";
import type { RoomDeps } from "../mcp/room-tools.js";
import type { PortfolioFactContext, PortfolioFactDeps } from "../mcp/portfolio-fact-tools.js";
import { buildShowGoal } from "../mcp/goal-tools.js";
import { limitsPayload } from "../mcp/limit-tools.js";
import { cleanUpAfterForget, TICKER } from "../mcp/memory-tools.js";
import { deleteGoal, deleteLimit, deleteThesis, editGoal, editLimit, editThesis, type PlanEditResult } from "../mcp/plan-edits.js";
import { buildShowThesis, resolveTicker, thesisListPayload } from "../mcp/thesis-tools.js";
import { readTheses } from "../memory/portfolio-facts.js";
import type { NudgeService } from "../nudges/nudge-service.js";
import { MemoryNotFoundError, type MemoryFact } from "../memory/memory-service.js";
import { INVALID_MEMORY_EDIT, memoryOutcome as sharedMemoryOutcome } from "./memory-outcome.js";
import { registerRoomRoutes } from "./room-routes.js";
import { createReportCardCache, type ReportCardCache } from "../report/report-cache.js";
import type { ReportCard } from "../report/report-loader.js";
import { createReportCardRunner, registerReportCardRoutes } from "../report/report-routes.js";
import { registerPerformanceRoute } from "./performance-route.js";
import type { WidgetAssets } from "../mcp/widget-assets.js";
import { widgetLoaderRouter, type WidgetLoader } from "../mcp/widget-loader.js";
import {
  PortfolioAccountNotFoundError,
  PortfolioConnectionRequiredError,
} from "../portfolio/portfolio-history-service.js";
import { torontoDay } from "../news/refresh-service.js";
import { SlidingWindowLimiter } from "../security/sliding-window.js";
import { buildPortfolioPresentation } from "../portfolio/portfolio-presentation.js";
import type { PortfolioQueryResult } from "../portfolio/portfolio-query-service.js";
import { InvalidSnapTradeWebhookError } from "../snaptrade/webhook-ingestion-service.js";
import { SnapTradeKeyRejectedError } from "../snaptrade/gateway.js";
import { DataControlError } from "../data-controls/data-control-service.js";
import { GATEWAY_PATH_PREFIXES, publicMetadataCors } from "../gateway/index.js";
import { dashboardHomeTotal } from "../portfolio/home-total.js";
import { withDeadline } from "../mcp/overview-tools.js";

/** The owner session store, as the REST side uses it. */
interface SessionResolver {
  resolve(token: string): Promise<boolean>;
}

/** Verifies gateway-issued MCP bearer tokens. */
interface TokenVerifier {
  verify(
    token: string,
    requiredScopes: readonly string[],
  ): Promise<AuthenticatedIdentity>;
}

interface PortfolioService {
  getPortfolio(authSubject: string): Promise<PortfolioQueryResult>;
  getAccountPortfolio?(authSubject: string, accountId: string): Promise<PortfolioQueryResult>;
}

interface PortfolioHistoryService {
  getAccountHistory(
    authSubject: string,
    accountId: string,
    options?: {
      orders?: { state?: "all" | "open" | "executed"; days?: number };
      activities?: { startDate?: string; endDate?: string; limit?: number };
    },
  ): Promise<unknown>;
}

interface ConnectionsService {
  getConnections(authSubject: string): Promise<unknown>;
  createConnectionPortal(
    authSubject: string,
    options?: { reconnect?: string },
  ): Promise<string>;
}

interface DataControls {
  disconnect(authSubject: string, connectionId: string): Promise<{ status: "disconnected"; providerDeletion: string }>;
}

interface AiAppsControls {
  list(authSubject: string): Promise<Array<{ clientKey: string; name: string | null; host: string | null; grantedAt: string }>>;
  /** False when the caller has no grant for that client (unknown or another subject's): answered 404 alike. */
  revoke(authSubject: string, clientKey: string): Promise<boolean>;
}

interface WebhookService {
  ingest(
    rawBody: string,
    signature: string | undefined,
  ): Promise<{ duplicate: boolean }>;
}

interface PortfolioApiOptions {
  /** The owner session store: authenticates `/api/*` from the `vl_session` cookie. */
  sessions: SessionResolver;
  portfolio: PortfolioService;
  history: PortfolioHistoryService;
  connections: ConnectionsService;
  /** SnapTrade webhook ingestion; the route is mounted only when given (WEBHOOKS_ENABLED). */
  webhooks?: WebhookService;
  appBaseUrl: string;
  /** TRUST_PROXY: how many reverse-proxy hops to trust for the client address (1 to 5). Absent trusts none. */
  trustProxy?: number;
  mcpResourceUrl?: string;
  staticAssetsDirectory?: string;
  onWidgetResourcePrepared?: () => void;
  overview?: OverviewDeps;
  performance?: PerformanceDeps;
  activity?: ActivityDeps;
  holdings?: HoldingsDeps;
  allocation?: AllocationDeps;
  income?: IncomeDeps;
  /** News tools (normal mode only). */
  news?: NewsDeps;
  /** Unauthenticated thumbnail proxy, `GET /api/news/image/:articleId` (normal mode with news only). */
  newsImages?: express.Router;
  /** Earnings and dividend calendar tools (normal mode with news only). */
  calendar?: CalendarDeps;
  /** get_portfolio_alerts (normal mode with news only). */
  alerts?: AlertsDeps;
  /** MCP remember/recall/forget (normal mode only). */
  memory?: MemoryToolDeps;
  /** MCP get_contribution_room (normal mode only). */
  room?: RoomDeps;
  /** MCP thesis, limit and goal tools (normal mode only, with memory). */
  portfolioFacts?: PortfolioFactDeps;
  /** Stored thesis-condition and limit nudges: get_portfolio_alerts and `GET /api/nudges` (normal mode only, with memory). */
  nudges?: Pick<NudgeService, "openNudges"> & Partial<Pick<NudgeService, "clearFor">>;
  assets?: WidgetAssets;
  /** Live widget loader: public `GET /widgets/<name>.js|css` for every built widget; its names pick which addresses are loader pages. */
  widgetLoader?: WidgetLoader;
  /** Disconnect (normal mode only). */
  dataControls?: DataControls;
  /** The report card's cache (runtime composes it, with the data-version marker, and clears it on webhook deletes). */
  reportCards?: ReportCardCache<ReportCard>;
  /** Data export (normal mode only): `GET /api/account/export`, dashboard tokens with connections:manage. */
  accountExport?: { stream(authSubject: string, write: (chunk: string) => Promise<void>): Promise<Record<string, number>> };
  /**
   * `POST /api/refresh` (normal mode only): one owner-triggered activity sync and snapshot run. `lock` is the same
   * advisory lock the scheduler takes for the nightly job (name "nightly"), so a manual and a scheduled run never overlap.
   */
  refresh?: {
    run(): Promise<{ users: number; synced: number; reconstructed: number; rows: number; failures: number; deferred: number; failureCodes?: Record<string, number> }>;
    lock(name: string, fn: () => Promise<void>): Promise<boolean>;
    /** Receives each background run so shutdown can wait for it (bounded) before the database closes. */
    track?(run: Promise<void>): void;
  };
  /** Wall clock for the refresh rate limit and export file name. */
  now?: () => Date;
  /**
   * MCP sign-in gateway (normal mode only): its routes, the verifier used on /mcp and, when present, the dashboard's
   * connected-AI-app controls. Without one, /mcp refuses every token.
   */
  gateway?: { router: express.Router; mcpVerifier: TokenVerifier; issuer: string; aiApps?: AiAppsControls };
  /** Owner sign-in routers (login page, local upstream), mounted before the gateway router so /authorize can send a signed-out browser to /login. Mounted with or without a gateway. */
  ownerRouters?: express.Router[];
}

const serverPathPrefixes = [
  "/api",
  "/mcp",
  "/webhooks",
  "/.well-known",
  "/health",
];

/** A dashboard memory edit: new text and/or a new value for the entry; nothing else can be changed from here. */
const memoryEditSchema = z.strictObject({ text: z.string().max(2000).optional(), value: z.unknown().optional() })
  .refine((body) => body.text !== undefined || body.value !== undefined);
const TYPED_PLAN_PROPERTIES = new Set(["security.thesis", "rule.concentration_limit", "goal.savings_target"]);
const USE_PLANS_PAGE = { error: "use_plans_page", message: "Edit theses, limits and goals on the Plans page." } as const;
const memoryIdSchema = z.string().min(1).max(100);

/** A fact as the dashboard sees it: plain data, no subject. */
function dashboardFact(fact: MemoryFact) {
  return {
    id: fact.id, nodeType: fact.node.type, nodeKey: fact.node.key, property: fact.property, value: fact.value, text: fact.text,
    kind: fact.kind, provenance: fact.provenance, source: fact.source,
    validFrom: fact.validFrom?.toISOString().slice(0, 10) ?? null, validTo: fact.validTo?.toISOString().slice(0, 10) ?? null,
    recordedAt: fact.recordedAt.toISOString(),
  };
}


const accountHistoryQuerySchema = z.object({
  orderState: z.enum(["all", "open", "executed"]).optional(),
  orderDays: z.coerce.number().int().min(1).max(90).optional(),
  activityStartDate: z.iso.datetime().optional(),
  activityEndDate: z.iso.datetime().optional(),
  activityLimit: z.coerce.number().int().min(1).max(1000).optional(),
});

function isServerPath(pathname: string, prefixes: readonly string[] = serverPathPrefixes): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function bearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

/** The one `vl_session` value in the Cookie header; null when there is none or more than one (ambiguous: unauthenticated). */
function singleSessionCookie(request: Request): string | null {
  const values: string[] = [];
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) values.push(part.slice(i + 1).trim());
  }
  return values.length === 1 && values[0] ? values[0] : null;
}

/** Applied to /mcp when no gateway is composed: no token is ever valid. */
const refuseEveryToken: TokenVerifier = {
  verify: async () => { throw new InvalidAccessTokenError(); },
};

const OWNER_SCOPES = ["portfolio:read", "connections:manage"] as const;

export function createPortfolioApi(options: PortfolioApiOptions) {
  const gateway = options.gateway;
  // The report card's 30-minute in-memory cache. Deleting data or a connection drops the subject's report before the
  // delete starts and again after it ends, so a delete that fails partway never leaves a report cached here.
  const reportCards = options.reportCards ?? createReportCardCache<ReportCard>();
  // One runner for GET /api/report-card and show_report_card: same inputs, same cache, same counts-only log line.
  const reportCardRunner = options.portfolioFacts && options.memory
    ? createReportCardRunner({
      facts: options.portfolioFacts, memory: options.memory.service, cache: reportCards, ...(options.performance ? { performance: options.performance } : {}),
      portfolio: (subject) => options.portfolio.getPortfolio(subject).then(buildPortfolioPresentation),
      log: (event) => (event.event === "report_card_failed" ? console.warn : console.info)(JSON.stringify(event)),
    })
    : undefined;
  const app = express();
  app.disable("x-powered-by");
  // The login, gateway and news image rate limits read req.ip. Unset (TRUST_PROXY not configured) trusts no proxy, so
  // X-Forwarded-For is ignored and cannot be spoofed to dodge a limit. A hop count N trusts exactly N proxies in front.
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);
  const mcpVerifier = gateway?.mcpVerifier ?? refuseEveryToken;
  const appOrigin = new URL(options.appBaseUrl).origin;
  const secureCookies = !isLoopbackHttp(options.appBaseUrl);
  const spaExcludedPrefixes = gateway ? [...serverPathPrefixes, ...GATEWAY_PATH_PREFIXES] : serverPathPrefixes;
  // Prevent browser caches from retaining financial responses or auth errors.
  app.use("/api", (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  app.use("/mcp", (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  const mcpMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", options.mcpResourceUrl ?? options.appBaseUrl).toString();

  // Alerts ledger fallback for a token without a client_id (gateway tokens always carry one), computed once.
  const ledgerFallback = new URL("/", options.appBaseUrl).toString();

  /**
   * /mcp only: a gateway-issued bearer token. The session cookie is never read here and no cookie authenticates
   * an MCP call.
   */
  function authenticateBearer(
    requiredScopes: readonly string[],
    discoveryUrl: string,
    verifier: TokenVerifier,
  ): RequestHandler {
    return async (request, response, next) => {
      const token = bearerToken(request);
      if (!token) {
        response
          .status(401)
          .set(
            "WWW-Authenticate",
            `Bearer resource_metadata="${discoveryUrl}", scope="${requiredScopes.join(" ")}"`,
          )
          .json({ error: "authentication_required" });
        return;
      }

      try {
        const identity = await verifier.verify(
          token,
          requiredScopes,
        );
        response.locals.authSubject = identity.subject;
        response.locals.authorizedParty = identity.authorizedParty;
        // The token's granted scopes as a list (gateway tokens may carry `memory`; see gateway/scope.ts hasScope).
        response.locals.scopes = [...identity.scopes];
        response.locals.clientKey = alertsClientKey(identity, ledgerFallback);
        next();
      } catch (error) {
        if (error instanceof MissingRequiredScopeError) {
          response
            .status(403)
            .set(
              "WWW-Authenticate",
              `Bearer resource_metadata="${discoveryUrl}", error="insufficient_scope", scope="${error.scope}"`,
            )
            .json({ error: "insufficient_scope" });
          return;
        }

        if (error instanceof InvalidAccessTokenError) {
          response
            .status(401)
            .set(
              "WWW-Authenticate",
              `Bearer resource_metadata="${discoveryUrl}", error="invalid_token"`,
            )
            .json({ error: "invalid_token" });
          return;
        }

        next(error);
      }
    };
  }

  /**
   * `/api/*` (and the dashboard's other API routes): the owner's session cookie. A bearer token is ignored here.
   * Owner scopes are fixed, so `requiredScopes` always pass; the parameter keeps call sites readable.
   * Non-GET/HEAD requests must carry this app's own Origin (CSRF); the check runs before the session is looked up.
   * More than one `vl_session` cookie is treated as unauthenticated; a session store failure answers 503, never a pass.
   */
  function authenticate(_requiredScopes: readonly string[]): RequestHandler {
    return async (request, response, next) => {
      const token = singleSessionCookie(request);
      if (!token) {
        response.status(401).json({ error: "authentication_required" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !isSameOriginRequest(request, appOrigin, { requireOrigin: true })) {
        response.status(403).json({ error: "bad_origin" });
        return;
      }
      let signedIn: boolean;
      try {
        signedIn = await options.sessions.resolve(token);
      } catch {
        console.warn(JSON.stringify({ event: "session_unavailable" }));
        response.status(503).json({ error: "session_unavailable" });
        return;
      }
      if (!signedIn) {
        response.status(401).json({ error: "authentication_required" });
        return;
      }
      // Slide the browser's cookie along with the server-side expiry.
      setSessionCookie(response, token, { secure: secureCookies });
      response.locals.authSubject = OWNER_SUBJECT;
      response.locals.authorizedParty = DASHBOARD_PARTY;
      response.locals.scopes = [...OWNER_SCOPES];
      next();
    };
  }

  /** connections:manage routes. The owner session carries the scope and is always the dashboard party. */
  function authenticateManage(): RequestHandler {
    return authenticate(["connections:manage"]);
  }

  // Before every other route and before the global JSON parser: these routes parse their own bodies.
  for (const router of options.ownerRouters ?? []) app.use(router);
  if (gateway) {
    app.use(["/.well-known/oauth-protected-resource"], publicMetadataCors);
    app.use(gateway.router);
  }

  // Widgets load thumbnails without a token; the router serves only stored article ids and sets its own
  // public cache headers over the /api no-store default. "/api" already keeps it out of the dashboard fallback.
  if (options.newsImages) app.use(options.newsImages);

  // Every widget's current build (public code, no data), whichever addresses are loader pages. Before auth, the JSON parser and the
  // dashboard fallback; output never depends on cookies or auth headers.
  if (options.widgetLoader) app.use(widgetLoaderRouter(options.widgetLoader));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  // Is this browser signed in? Public: the dashboard asks before it shows anything. Counts as use, so it slides the cookie.
  app.get("/api/session", async (request, response) => {
    const token = singleSessionCookie(request);
    if (!token) {
      response.json({ signedIn: false });
      return;
    }
    try {
      const signedIn = await options.sessions.resolve(token);
      if (signedIn) setSessionCookie(response, token, { secure: secureCookies });
      response.json({ signedIn });
    } catch {
      console.warn(JSON.stringify({ event: "session_unavailable" }));
      response.status(503).json({ error: "session_unavailable" });
    }
  });

  // Owner-triggered refresh: the nightly job's sync and snapshot, under the nightly lock. POST answers 202 at once and
  // the run continues in the background (a proxy such as Cloudflare would cut a request held for minutes); the
  // dashboard polls GET /api/refresh/status. One run at a time per process (409 already_running); across processes
  // the advisory lock decides (a held lock ends the run as failed "busy"). At most one run a minute per process
  // protects the provider read budget; a run is recorded when it actually starts, so a "busy" run costs nothing.
  const refreshLimiter = new SlidingWindowLimiter([{ ms: 60_000, max: 1 }]);
  type RefreshState =
    | { state: "idle" }
    | { state: "running" }
    | ({ state: "succeeded" } & Record<string, unknown>)
    | { state: "failed"; error: string };
  let refreshState: RefreshState = { state: "idle" };
  const refreshClock = () => (options.now ?? (() => new Date()))().getTime();
  const runRefreshInBackground = async (refresh: NonNullable<PortfolioApiOptions["refresh"]>): Promise<void> => {
    try {
      let counts: Awaited<ReturnType<typeof refresh.run>> | undefined;
      let limited = false;
      const ran = await refresh.lock("nightly", async () => {
        if (!refreshLimiter.take(OWNER_SUBJECT, refreshClock())) {
          limited = true;
          return;
        }
        counts = await refresh.run();
      });
      if (limited) {
        refreshState = { state: "failed", error: "rate_limited" };
      } else if (!ran || !counts) {
        refreshState = { state: "failed", error: "busy" };
      } else {
        const body = { users: counts.users, synced: counts.synced, reconstructed: counts.reconstructed, rows: counts.rows, failures: counts.failures, deferred: counts.deferred, failureCodes: counts.failureCodes ?? {} };
        console.warn(JSON.stringify({ event: "manual_refresh", ...body }));
        if (body.failureCodes.snaptrade_key_rejected) {
          // Counts and the code only; the key is never logged.
          console.warn(JSON.stringify({ event: "snaptrade_key_rejected" }));
          refreshState = { state: "failed", error: "snaptrade_key_rejected" };
        } else {
          refreshState = { state: "succeeded", ...body };
        }
      }
    } catch (error) {
      if (error instanceof SnapTradeKeyRejectedError) {
        console.warn(JSON.stringify({ event: "snaptrade_key_rejected" }));
        refreshState = { state: "failed", error: "snaptrade_key_rejected" };
      } else {
        console.warn(JSON.stringify({ event: "manual_refresh_failed" }));
        refreshState = { state: "failed", error: "refresh_failed" };
      }
    }
  };
  app.post("/api/refresh", authenticate(["portfolio:read"]), (_request, response) => {
    const refresh = options.refresh;
    response.set("Cache-Control", "no-store");
    if (!refresh) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    if (refreshState.state === "running") {
      response.status(409).json({ error: "already_running" });
      return;
    }
    if (!refreshLimiter.peek(OWNER_SUBJECT, refreshClock())) {
      response.status(429).json({ error: "rate_limited" });
      return;
    }
    refreshState = { state: "running" };
    const run = runRefreshInBackground(refresh);
    refresh.track?.(run);
    response.status(202).json({ status: "started" });
  });
  app.get("/api/refresh/status", authenticate(["portfolio:read"]), (_request, response) => {
    response.set("Cache-Control", "no-store");
    if (!options.refresh) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.json(refreshState);
  });

  // This instance has one protected resource, /mcp, so the root document mirrors the /mcp one.
  const protectedResourceMetadata = (_request: express.Request, response: express.Response) => {
    response.json({
      resource: options.mcpResourceUrl ?? new URL("/", options.appBaseUrl).toString(),
      authorization_servers: gateway ? [gateway.issuer] : [],
      // Gateway tokens may also carry `memory` (gateway/scope.ts).
      scopes_supported: gateway ? ["portfolio:read", "memory"] : ["portfolio:read"],
      bearer_methods_supported: ["header"],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  const webhooks = options.webhooks;
  if (webhooks) {
    app.post(
      "/webhooks/snaptrade",
      express.text({ type: ["application/json", "application/*+json"], limit: "128kb" }),
      async (request, response, next) => {
        if (typeof request.body !== "string") {
          response.status(400).json({ error: "invalid_webhook" });
          return;
        }
        try {
          await webhooks.ingest(
            request.body,
            request.header("signature"),
          );
          response.status(204).send();
        } catch (error) {
          if (error instanceof InvalidSnapTradeWebhookError) {
            response.status(401).json({ error: "invalid_webhook" });
            return;
          }
          next(error);
        }
      },
    );
  }

  app.use(express.json({ limit: "32kb" }));
  app.post(
    "/mcp",
    authenticateBearer(["portfolio:read"], mcpMetadataUrl, mcpVerifier),
    async (request, response, next) => {
      response.once("finish", () => {
        // Protocol metadata only; params, results and identities are never logged.
        const rpcMethod = typeof request.body?.method === "string" ? request.body.method.slice(0, 64) : null;
        if (response.statusCode < 400) {
          // Which tool / widget resource the host asked for: static names only (diagnoses widget rendering).
          const params = request.body?.params;
          const tool = rpcMethod === "tools/call" && typeof params?.name === "string" ? params.name.slice(0, 64) : undefined;
          const uri = rpcMethod === "resources/read" && typeof params?.uri === "string" && params.uri.startsWith("ui://") ? params.uri.slice(0, 80) : undefined;
          // Argument names only (schema keys such as "symbol"), never values: shows which filters a call used.
          const rawArgs = tool && params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : null;
          const argKeys = rawArgs ? Object.keys(rawArgs).filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)).sort().slice(0, 12) : undefined;
          console.log(JSON.stringify({ event: "mcp_request", status: response.statusCode, rpcMethod, ...(tool ? { tool } : {}), ...(argKeys ? { argKeys } : {}), ...(uri ? { uri } : {}) }));
          return;
        }
        console.warn(JSON.stringify({
          event: "mcp_request_rejected",
          status: response.statusCode,
          rpcMethod,
          protocolVersionHeader: request.header("mcp-protocol-version")?.slice(0, 32) ?? null,
        }));
      });
      try {
        await handlePortfolioMcpRequest(request, response, {
          authSubject: response.locals.authSubject,
          scopes: response.locals.scopes,
          portfolio: options.portfolio,
          history: options.history,
          onWidgetResourcePrepared: options.onWidgetResourcePrepared,
          overview: options.overview,
          performance: options.performance,
          activity: options.activity,
          holdings: options.holdings,
          allocation: options.allocation,
          income: options.income,
          news: options.news,
          calendar: options.calendar,
          alerts: options.alerts,
          ...(options.memory ? { memory: options.memory } : {}),
          ...(options.room ? { room: options.room } : {}),
          ...(options.portfolioFacts && options.memory ? { portfolioFacts: options.portfolioFacts } : {}),
          ...(options.nudges && options.memory ? { nudges: options.nudges } : {}),
          ...(reportCardRunner ? { reportCard: reportCardRunner } : {}),
          clientKey: response.locals.clientKey,
          surface: "focused",
          assets: options.assets,
          widgetLoader: options.widgetLoader,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/mcp",
    authenticateBearer(["portfolio:read"], mcpMetadataUrl, mcpVerifier),
    (_request, response) => {
      response.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    },
  );

  app.delete(
    "/mcp",
    authenticateBearer(["portfolio:read"], mcpMetadataUrl, mcpVerifier),
    (_request, response) => {
      response.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    },
  );

  app.get(
    "/api/portfolio",
    authenticate(["portfolio:read"]),
    async (_request, response) => {
      const presentation = buildPortfolioPresentation(
        await options.portfolio.getPortfolio(response.locals.authSubject),
      );
      // The combined CAD total (est.) for a portfolio in more than one currency; the per-currency totals stay.
      const market = options.performance?.market;
      const homeTotal = market
        ? await withDeadline(() => dashboardHomeTotal(presentation, market, new Date().toISOString().slice(0, 10)), 4_000, () => null).catch(() => null)
        : null;
      response.json(homeTotal ? { ...presentation, homeTotal } : presentation);
    },
  );

  app.get(
    "/api/accounts/:accountId/history",
    authenticate(["portfolio:read"]),
    async (request, response, next) => {
      try {
        const query = accountHistoryQuerySchema.parse(request.query);
        const accountId = z.string().parse(request.params.accountId);
        const result = await options.history.getAccountHistory(
          response.locals.authSubject,
          accountId,
          {
            orders: {
              ...(query.orderState ? { state: query.orderState } : {}),
              ...(query.orderDays ? { days: query.orderDays } : {}),
            },
            activities: {
              ...(query.activityStartDate
                ? { startDate: query.activityStartDate }
                : {}),
              ...(query.activityEndDate
                ? { endDate: query.activityEndDate }
                : {}),
              ...(query.activityLimit ? { limit: query.activityLimit } : {}),
            },
          },
        );
        response.json(result);
      } catch (error) {
        if (error instanceof PortfolioAccountNotFoundError) {
          response.status(404).json({ error: "account_not_found" });
          return;
        }
        if (error instanceof PortfolioConnectionRequiredError) {
          response.status(409).json({ error: "connection_required" });
          return;
        }
        next(error);
      }
    },
  );

  app.get(
    "/api/connections",
    authenticate(["portfolio:read"]),
    async (_request, response) => {
      response.json(
        await options.connections.getConnections(response.locals.authSubject),
      );
    },
  );

  app.post(
    "/api/connections/session",
    authenticateManage(),
    async (request, response) => {
      const portalUrl = await options.connections.createConnectionPortal(
        response.locals.authSubject,
        request.body?.reconnect
          ? { reconnect: request.body.reconnect as string }
          : {},
      );
      response.json({ portalUrl });
    },
  );

  if (options.dataControls) {
    const dataControls = options.dataControls;
    app.delete(
      "/api/connections/:connectionId",
      authenticateManage(),
      async (request, response) => {
        const connectionId = z.string().parse(request.params.connectionId);
        reportCards.forget(response.locals.authSubject);
        try {
          response.status(202).json(await dataControls.disconnect(response.locals.authSubject, connectionId));
        } finally {
          reportCards.forget(response.locals.authSubject);
        }
      },
    );
  }

  if (options.accountExport) {
    const accountExport = options.accountExport;
    // Right of access. Dashboard tokens only (gateway AI tokens never verify on /api).
    app.get("/api/account/export", authenticateManage(), async (_request, response, next) => {
      response.set({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="vestlens-export-${torontoDay((options.now ?? (() => new Date()))())}.json"`,
        "Cache-Control": "no-store",
      });
      const write = (chunk: string) => new Promise<void>((resolve, reject) => {
        // A client that went away must not leave the stream waiting on a drain that never comes.
        if (response.destroyed || response.writableEnded) { reject(new Error("client_closed")); return; }
        const cleanup = () => { response.off("error", onClose); response.off("close", onClose); response.off("drain", onDrain); };
        const onClose = () => { cleanup(); reject(new Error("client_closed")); };
        const onDrain = () => { cleanup(); resolve(); };
        response.once("error", onClose);
        response.once("close", onClose);
        if (response.write(chunk)) { cleanup(); resolve(); } else response.once("drain", onDrain);
      });
      try {
        const counts = await accountExport.stream(response.locals.authSubject, write);
        response.end();
        console.info(JSON.stringify({ event: "account_export", counts }));
      } catch {
        console.warn(JSON.stringify({ event: "account_export_failed" }));
        if (response.headersSent) {
          // Truncate: a clean end would present a partial export as a complete one.
          response.destroy();
          return;
        }
        response.removeHeader("Content-Disposition");
        response.removeHeader("Content-Type");
        next(new Error("account_export_failed"));
      }
    });
  }

  if (gateway?.aiApps) {
    // Dashboard data controls: the owner session only (gateway-issued AI tokens never authenticate on /api).
    const aiApps = gateway.aiApps;
    app.get("/api/ai-apps", authenticateManage(), async (_request, response) => {
      // name and host are client-supplied display strings: JSON data only, never HTML.
      const apps = await aiApps.list(response.locals.authSubject);
      console.info(JSON.stringify({ event: "ai_apps_list", count: apps.length }));
      response.json(apps);
    });
    app.post("/api/ai-apps/:clientKey/revoke", authenticateManage(), async (request, response) => {
      const clientKey = request.params.clientKey;
      const revoked = typeof clientKey === "string" && clientKey.length > 0 && clientKey.length <= 2048
        ? await aiApps.revoke(response.locals.authSubject, clientKey)
        : false;
      console.info(JSON.stringify({ event: "ai_app_revoke", result: revoked ? "revoked" : "not_found" }));
      if (!revoked) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      response.status(204).send();
    });
  }

  if (options.memory) {
    // "What VestLens remembers": dashboard tokens with connections:manage only (gateway AI tokens never verify on
    // /api). Every edit goes through the same MemoryService, so reserved TFSA changes re-evaluate the alert.
    const memoryService = options.memory.service;
    const logMemory = (action: string, count?: number) =>
      console.info(JSON.stringify({ event: "memory_dashboard", action, ...(count === undefined ? {} : { count }) }));
    app.get("/api/memory", authenticateManage(), async (_request, response) => {
      const facts = await memoryService.listCurrent(response.locals.authSubject);
      const groups: Array<{ nodeType: string; facts: ReturnType<typeof dashboardFact>[] }> = [];
      for (const fact of facts) {
        let group = groups.find((g) => g.nodeType === fact.node.type);
        if (!group) { group = { nodeType: fact.node.type, facts: [] }; groups.push(group); }
        group.facts.push(dashboardFact(fact));
      }
      logMemory("list", facts.length);
      response.json({ groups });
    });
    const memoryOutcome = (response: Response, run: () => Promise<unknown>, action: string, status = 200) =>
      sharedMemoryOutcome(response, run, () => logMemory(action), status);
    app.patch("/api/memory/:id", authenticateManage(), async (request, response) => {
      const id = memoryIdSchema.safeParse(request.params.id);
      const body = memoryEditSchema.safeParse(request.body ?? {});
      if (!id.success || !body.success) { response.status(400).json(INVALID_MEMORY_EDIT); return; }
      // Theses, limits and goals have typed edits (their text is derived from their value, and nudges follow).
      const target = (await memoryService.listCurrent(response.locals.authSubject)).find((f) => f.id === id.data);
      if (target && TYPED_PLAN_PROPERTIES.has(target.property) && (body.data.text !== undefined || body.data.value !== undefined)) {
        response.status(400).json(USE_PLANS_PAGE);
        return;
      }
      await memoryOutcome(response, async () => dashboardFact(await memoryService.edit(response.locals.authSubject, id.data, body.data)), "edit");
    });
    app.post("/api/memory/:id/promote", authenticateManage(), async (request, response) => {
      const id = memoryIdSchema.safeParse(request.params.id);
      if (!id.success) { response.status(404).json({ error: "not_found" }); return; }
      await memoryOutcome(response, async () => dashboardFact(await memoryService.promote(response.locals.authSubject, id.data)), "promote");
    });
    app.delete("/api/memory/:id", authenticateManage(), async (request, response) => {
      const id = memoryIdSchema.safeParse(request.params.id);
      if (!id.success) { response.status(404).json({ error: "not_found" }); return; }
      const subject = response.locals.authSubject;
      await memoryOutcome(response, async () => {
        // What hangs off a deleted thesis or limit goes with it (its derived baseline, its open nudges), with no portfolio read.
        const target = (await memoryService.listCurrent(subject)).find((f) => f.id === id.data);
        if ((await memoryService.forget(subject, { id: id.data })) === 0) throw new MemoryNotFoundError();
        const nudges = options.nudges?.clearFor ? { clearFor: options.nudges.clearFor.bind(options.nudges) } : undefined;
        if (target) await cleanUpAfterForget(memoryService, nudges, subject, target, () => console.warn(JSON.stringify({ event: "memory_delete_nudges_failed" })));
      }, "delete", 204);
    });
  }

  if (options.room) {
    // The TFSA room tile: the engine's result from stored inputs only (no brokerage read) and the stored open alert.
    registerRoomRoutes(app, {
      room: options.room,
      ...(options.memory ? { memory: options.memory.service } : {}),
      guards: [authenticateManage()],
      now: options.room.now ?? (() => new Date()),
      log: (event) => console.info(JSON.stringify(event)),
    });
  }

  if (options.portfolioFacts && options.memory) {
    // "Plans": the caller's theses, limits and goals checked against the latest stored positions (no brokerage read).
    // Dashboard tokens only; edits and deletes use /api/memory.
    const facts = options.portfolioFacts;
    const memoryService = options.memory.service;
    const factContext = (subject: string): PortfolioFactContext => {
      let loaded: Promise<ReturnType<typeof buildPortfolioPresentation>> | undefined;
      return {
        subject, scopes: undefined, memory: memoryService,
        portfolio: () => (loaded ??= options.portfolio.getPortfolio(subject).then(buildPortfolioPresentation)),
      };
    };
    const plansRoute = (name: string, run: (ctx: PortfolioFactContext, request: Request, response: Response) => Promise<unknown>): RequestHandler =>
      async (request, response) => {
        try {
          const body = await run(factContext(response.locals.authSubject), request, response);
          if (response.headersSent) return;
          console.info(JSON.stringify({ event: "plans_dashboard", route: name }));
          response.json(body);
        } catch {
          console.warn(JSON.stringify({ event: "plans_dashboard_failed", route: name }));
          response.status(503).json({ error: "plans_unavailable" });
        }
      };
    const guard = [authenticateManage()];
    app.get("/api/theses", ...guard, plansRoute("theses", (ctx) => thesisListPayload(facts, ctx)));
    app.get("/api/theses/:ticker", ...guard, plansRoute("thesis", async (ctx, request, response) => {
      const ticker = String(request.params.ticker ?? "").trim();
      if (!TICKER.test(ticker)) { response.status(400).json({ error: "invalid_ticker" }); return undefined; }
      // The full check is for a saved thesis: without one, 404 before the holding view's reads (M-2).
      const saved = (await readTheses(ctx.memory, ctx.subject)).map((t) => t.ticker.trim().toUpperCase());
      const asSaved = resolveTicker(ticker, saved);
      if (!saved.includes(asSaved)) { response.status(404).json({ error: "not_found" }); return undefined; }
      const shown = await buildShowThesis(facts, ctx, { ticker: asSaved });
      const payload = shown.structuredContent as { thesis?: unknown } | undefined;
      if (shown.isError || !payload) throw new Error("plans_unavailable");
      if (!payload.thesis) { response.status(404).json({ error: "not_found" }); return undefined; }
      return payload;
    }));
    // Typed edits and deletes: values only, text derived on the server, nudges re-evaluated (mcp/plan-edits.ts).
    const plansWrite = (name: string, run: (ctx: PortfolioFactContext, request: Request) => Promise<PlanEditResult>): RequestHandler =>
      async (request, response) => {
        try {
          const result = await run(factContext(response.locals.authSubject), request);
          console.info(JSON.stringify({ event: "plans_dashboard", route: name, status: result.status }));
          if (result.status === 204) response.status(204).send(); else response.status(result.status).json(result.body);
        } catch {
          console.warn(JSON.stringify({ event: "plans_dashboard_failed", route: name }));
          response.status(503).json({ error: "plans_unavailable" });
        }
      };
    const param = (request: Request, key: string) => String(request.params[key] ?? "").trim();
    app.patch("/api/limits/:slug", ...guard, plansWrite("limit_edit", (ctx, req) => editLimit(facts, ctx, param(req, "slug"), req.body ?? {})));
    app.delete("/api/limits/:slug", ...guard, plansWrite("limit_delete", (ctx, req) => deleteLimit(facts, ctx, param(req, "slug"))));
    app.patch("/api/goals/:slug", ...guard, plansWrite("goal_edit", (ctx, req) => editGoal(facts, ctx, param(req, "slug"), req.body ?? {})));
    app.delete("/api/goals/:slug", ...guard, plansWrite("goal_delete", (ctx, req) => deleteGoal(facts, ctx, param(req, "slug"))));
    app.patch("/api/theses/:ticker", ...guard, plansWrite("thesis_edit", (ctx, req) => editThesis(facts, ctx, param(req, "ticker"), req.body ?? {})));
    app.delete("/api/theses/:ticker", ...guard, plansWrite("thesis_delete", (ctx, req) => deleteThesis(facts, ctx, param(req, "ticker"))));
    app.get("/api/limits", ...guard, plansRoute("limits", (ctx) => limitsPayload(facts, ctx)));
    app.get("/api/goals", ...guard, plansRoute("goals", async (ctx) => {
      const shown = await buildShowGoal(facts, ctx, {});
      if (shown.isError) throw new Error("plans_unavailable");
      return { goals: (shown.structuredContent as { goals?: unknown[] } | undefined)?.goals ?? [] };
    }));
    // The report card: the caller's calls, sales and trading costs from stored data only.
    // The dashboard and show_report_card share one runner (reportCardRunner above): one cache, one computation.
    if (reportCardRunner) registerReportCardRoutes(app, { guards: guard, runner: reportCardRunner });
  }

  if (options.performance) {
    // The dashboard's return chart: show_performance's computation, trimmed (performance-route.ts).
    registerPerformanceRoute(app, {
      guards: [authenticateManage()],
      performance: options.performance,
      portfolio: (subject) => options.portfolio.getPortfolio(subject).then(buildPortfolioPresentation),
    });
  }

  if (options.nudges && options.memory) {
    // The dashboard banner: the caller's open nudges as stored (no evaluation, no brokerage read).
    const nudges = options.nudges;
    app.get("/api/nudges", authenticateManage(), async (_request, response) => {
      try {
        const open = await nudges.openNudges(response.locals.authSubject);
        console.info(JSON.stringify({ event: "nudges_dashboard", open: open.length }));
        response.json({ nudges: open.map((n) => ({ kind: n.kind, target: n.target, text: n.text, raisedAt: n.raisedAt })) });
      } catch {
        console.warn(JSON.stringify({ event: "nudges_dashboard_failed" }));
        response.status(503).json({ error: "nudges_unavailable" });
      }
    });
  }

  if (options.staticAssetsDirectory) {
    app.use(express.static(options.staticAssetsDirectory));
    app.use((request, response, next) => {
      if (
        request.method !== "GET" ||
        isServerPath(request.path, spaExcludedPrefixes) ||
        !request.accepts("html")
      ) {
        next();
        return;
      }

      response.sendFile(
        "index.html",
        { root: options.staticAssetsDirectory },
        (error) => (error ? next(error) : undefined),
      );
    });
  }

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof ZodError) {
        // Field paths and codes only: never values from requests or providers.
        console.warn(JSON.stringify({
          event: "request_validation_failed",
          method: request.method,
          route: request.route?.path ?? "unmatched",
          issues: error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.map(String).join("."),
            code: issue.code,
          })),
        }));
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      if (error instanceof SnapTradeKeyRejectedError) {
        response.status(error.status).json({ error: error.code });
        return;
      }
      if (error instanceof DataControlError) {
        response.status(error.status).json({ error: error.code });
        return;
      }
      response.status(500).json({ error: "internal_error" });
    },
  );

  return app;
}
