import { randomBytes } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";

import type { SelfHostConfig } from "./config.js";
import { ConnectionService } from "./connections/connection-service.js";
import { ConnectionStatusService } from "./connections/connection-status-service.js";
import { createReportCardCache, type ReportCardCache } from "./report/report-cache.js";
import type { ReportCard } from "./report/report-loader.js";
import { reportDataVersion, type ReportVersionPrismaPort } from "./report/report-version.js";
import { createPortfolioApi } from "./http/app.js";
import { OWNER_SUBJECT, OwnerIdentity, type OwnerPrismaPort } from "./identity/owner-identity.js";
import { findPendingHistoryUsers, type PendingHistoryPort } from "./history/pending-history.js";
import { CachedPortfolioService } from "./portfolio/cached-portfolio-service.js";
import { PortfolioHistoryService } from "./portfolio/portfolio-history-service.js";
import {
  PrismaLastGoodPortfolioStore,
  type LastGoodPrismaPort,
} from "./portfolio/prisma-last-good-portfolio-store.js";
import {
  PrismaPortfolioStateRepository,
  type PortfolioStatePrismaPort,
} from "./portfolio/prisma-portfolio-state-repository.js";
import { PortfolioQueryService } from "./portfolio/portfolio-query-service.js";
import { SnapTradeGateway } from "./snaptrade/gateway.js";
import {
  PrismaWebhookEventRepository,
  type WebhookPrismaPort,
} from "./snaptrade/prisma-webhook-repository.js";
import { createPersonalSnapTradeClient, createSnapTradeGateway } from "./snaptrade/sdk-client.js";
import { WebhookIngestionService } from "./snaptrade/webhook-ingestion-service.js";
import { BankOfCanadaFx } from "./market-data/bank-of-canada.js";
import { MarketDataService } from "./market-data/market-data-service.js";
import { PrismaMarketDataCache } from "./market-data/prisma-market-data-cache.js";
import { StooqProvider } from "./market-data/stooq.js";
import type { FetchLike } from "./market-data/types.js";
import { YahooChartProvider } from "./market-data/yahoo.js";
import { ActivityStore, type ActivityStorePort } from "./history/activity-store.js";
import { ActivitySyncService, createSnapTradeActivityProvider } from "./history/activity-sync-service.js";
import { withAdvisoryLock, type AdvisoryLockPrisma } from "./jobs/advisory-lock.js";
import { historyCatchupJob, runNightly } from "./jobs/nightly.js";
import { startScheduler, type ScheduledJob } from "./jobs/scheduler.js";
import { NightlyPipeline } from "./history/nightly-pipeline.js";
import { ReconstructionService, type ReconstructedValuePort } from "./history/reconstruction-service.js";
import { isHistoryChangeEvent } from "./history/webhook-events.js";
import { fileWidgetAssets, type WidgetAssets } from "./mcp/widget-assets.js";
import { createWidgetLoader, LOADER_WIDGETS } from "./mcp/widget-loader.js";
import type { OverviewDeps } from "./mcp/overview-tools.js";
import type { PerformanceDeps } from "./mcp/performance-tools.js";
import type { ActivityDeps } from "./mcp/activity-tools.js";
import type { AllocationDeps } from "./mcp/allocation-tools.js";
import { dividendPayments, type IncomeDeps } from "./mcp/income-tools.js";
import type { CalendarDeps, UserDividends } from "./mcp/calendar-tools.js";
import type { AlertsDeps } from "./mcp/alerts-tools.js";
import type { HoldingsDeps } from "./mcp/holdings-tools.js";
import { SettingsService, type SettingsPrismaPort } from "./settings/settings-service.js";
import { DailySnapshotService, type DailyValuePrismaPort } from "./snapshots/daily-snapshot-service.js";
import { isLoopbackHttp } from "./loopback-url.js";
import { loginRouter } from "./auth/login-routes.js";
import { OwnerSessionStore } from "./auth/owner-session.js";
import { SlidingWindowLimiter } from "./security/sliding-window.js";
import { createGateway } from "./gateway/index.js";
import { localOwnerUpstream } from "./gateway/local-upstream.js";
import { DataControlService } from "./data-controls/data-control-service.js";
import { hideDisconnected } from "./data-controls/disconnect-filter.js";
import { AccountExportService, type ExportPrismaPort } from "./account/export-service.js";
import { PrismaDataControlRepository, type DataControlPrismaPort } from "./data-controls/prisma-data-control-repository.js";
import { RetentionService } from "./data-controls/retention.js";
import { PrismaGatewayStore, type GatewayStore } from "./gateway/store.js";
import { edgarFetcher } from "./news/edgar.js";
import { JevClient } from "./news/jev.js";
import { marketauxFetcher } from "./news/marketaux.js";
import { rateUnrated } from "./news/rater.js";
import { NewsRefreshService, torontoDay } from "./news/refresh-service.js";
import { PrismaNewsStore, type NewsStore } from "./news/store.js";
import { imageProxyRouter, type ImageFetch } from "./news/image-proxy.js";
import { createPinnedHttpsFetch, systemLookup, type CimdLookup } from "./gateway/cimd.js";
import type { NewsDeps } from "./mcp/news-tools.js";
import { PrismaBrokerageLinks, type BrokerageLinks } from "./memory/context-builder.js";
import { MemoryService, type MemoryRepository } from "./memory/memory-service.js";
import type { MemoryToolDeps } from "./mcp/memory-tools.js";
import type { RoomDeps } from "./mcp/room-tools.js";
import type { PortfolioFactDeps } from "./mcp/portfolio-fact-tools.js";
import { NudgeService, type NudgePrismaPort } from "./nudges/nudge-service.js";
import { buildPortfolioPresentation, type PortfolioPresentation } from "./portfolio/portfolio-presentation.js";
import { reevaluateRoomAlert, RoomAlertService, type RoomAlertDeps, type RoomAlertPrismaPort } from "./room/room-alerts.js";
import type { CounterpartQuery, RoomActivityQuery, RoomPrismaPort } from "./room/room-loader.js";
import { PrismaMemoryRepository } from "./memory/prisma-memory-repository.js";

/** News wiring exposed for the HTTP/MCP layer (normal mode with config.news only). */
export interface RuntimeNews {
  service: NewsRefreshService;
  store: NewsStore;
}

type RuntimePrisma = OwnerPrismaPort &
  WebhookPrismaPort & {
    $disconnect(): Promise<void>;
  };

type RuntimeGateway = Pick<
  SnapTradeGateway,
  | "deleteConnection"
  | "createConnectionUrl"
  | "listConnections"
  | "listAccounts"
  | "getAccountDetails"
  | "getBalances"
  | "getPositions"
  | "getOrders"
  | "getActivities"
  | "getBalanceHistory"
>;

interface RuntimeOptions {
  prisma?: RuntimePrisma;
  /** Cross-process job lock (scheduler and manual refresh); composed from the real client when `prisma` is not injected, absent otherwise (no scheduler, no refresh). */
  advisoryLock?: (name: string, fn: () => Promise<void>) => Promise<boolean>;
  portfolioStatePrisma?: PortfolioStatePrismaPort;
  snapTradeGateway?: RuntimeGateway;
  now?: () => Date;
  lastGoodPrisma?: LastGoodPrismaPort;
  /** Overview wiring (normal mode only); all of market, settingsPrisma, dailyValuePrisma and widgetAssets must be present when prisma is injected. */
  market?: OverviewDeps["market"] & Pick<MarketDataService, "securityHistory" | "purgeExpiredCache" | "profile">;
  settingsPrisma?: SettingsPrismaPort;
  dailyValuePrisma?: DailyValuePrismaPort;
  widgetAssets?: WidgetAssets;
  /** History wiring (normal mode only). */
  historyPrisma?: ActivityStorePort & ReconstructedValuePort;
  /** Disconnect and retention persistence (normal mode only). */
  dataControlPrisma?: DataControlPrismaPort;
  /** Data export persistence (normal mode only); composed from the real client when `prisma` is not injected. */
  exportPrisma?: ExportPrismaPort;
  /** MCP gateway persistence; required when `prisma` is injected. */
  gatewayStore?: GatewayStore;
  /** The owner's session store; required when `prisma` is injected, composed from the real client otherwise. */
  ownerSessions?: OwnerSessionStore;
  /** Portfolio memory persistence (normal mode only); with an injected `prisma`, memory is composed only when given. */
  memoryRepository?: MemoryRepository;
  /** Brokerage links for memory's hop-1 context; composed from the real client when `prisma` is not injected. */
  memoryLinks?: BrokerageLinks;
  /** Stored accounts, activity and sync state for get_contribution_room; composed from the real client when `prisma` is not injected. */
  roomPrisma?: RoomPrismaPort;
  /** Stored activity, sync state, accounts and snapshots for the thesis, limit and goal tools; composed like roomPrisma. */
  factPrisma?: PortfolioFactDeps["prisma"];
  /** The report card's data-version marker reads; composed like factPrisma. Without it, cached reports aren't version-checked. */
  reportVersionPrisma?: ReportVersionPrismaPort;
  /** The report card's cache; by default composed here with the data-version marker. */
  reportCards?: ReportCardCache<ReportCard>;
  /** TFSA over-limit alert rows (normal mode only); composed from the real client when `prisma` is not injected. */
  roomAlertPrisma?: RoomAlertPrismaPort;
  /** Thesis-condition and limit nudge rows (normal mode only); composed from the real client when `prisma` is not injected. */
  nudgePrisma?: NudgePrismaPort;
  /** News persistence; required with config.news when `prisma` is injected. */
  newsStore?: NewsStore;
  /** Outbound fetch for Marketaux, EDGAR and TypeSafe (defaults to globalThis.fetch). */
  newsFetch?: FetchLike;
  /** Thumbnail proxy IO (defaults: the pinned, SSRF-guarded https fetch and system DNS). */
  newsImageFetch?: ImageFetch;
  newsImageLookup?: CimdLookup;
}

// Provider read limits.
const NORMAL_MODE_READS = { maxConcurrentAccounts: 3, requestTimeoutMs: 15_000 } as const;

export function createPortfolioRuntime(
  config: SelfHostConfig,
  options: RuntimeOptions = {},
) {
  if (options.prisma && !options.gatewayStore) {
    throw new Error("An injected database port requires an injected gateway store");
  }
  if (options.prisma && !options.ownerSessions) {
    throw new Error("An injected database port requires an injected owner session store");
  }
  const newsWanted = Boolean(config.news);
  if (newsWanted && options.prisma && !options.newsStore) {
    throw new Error("An injected database port requires an injected news store");
  }
  let newsStore = options.newsStore;
  let gatewayStore = options.gatewayStore;
  let ownerSessions = options.ownerSessions;
  let prisma = options.prisma;
  let portfolioStatePrisma = options.portfolioStatePrisma;
  let lastGoodPrisma = options.lastGoodPrisma;
  let market = options.market;
  let settingsPrisma = options.settingsPrisma;
  let dailyValuePrisma = options.dailyValuePrisma;
  let widgetAssets = options.widgetAssets;
  let historyPrisma = options.historyPrisma;
  let dataControlPrisma = options.dataControlPrisma;
  let exportPrisma = options.exportPrisma;
  let memoryRepository = options.memoryRepository;
  let pendingHistoryPort: PendingHistoryPort | undefined;
  let memoryLinks = options.memoryLinks;
  let roomPrisma = options.roomPrisma;
  let factPrisma = options.factPrisma;
  let reportVersionPrisma = options.reportVersionPrisma;
  let roomAlertPrisma = options.roomAlertPrisma;
  let nudgePrisma = options.nudgePrisma;
  let advisoryLock = options.advisoryLock;
  if (!prisma) {
    const client = new PrismaClient({ datasourceUrl: config.databaseUrl });
    advisoryLock ??= (name, fn) => withAdvisoryLock(client as unknown as AdvisoryLockPrisma, name, fn);
    prisma = {
      appUser: {
        findUnique: (input) => client.appUser.findUnique(input),
        upsert: (input) => client.appUser.upsert(input),
      },
      webhookEvent: {
        create: (input) =>
          client.webhookEvent.create({
            data: {
              ...input.data,
              payload: input.data.payload as Prisma.InputJsonObject,
            },
          }),
      },
      brokerageConnection: {
        upsert: (input) => client.brokerageConnection.upsert(input),
      },
      // CONNECTION_DELETED records a confirmed pending-disconnect marker.
      pendingDisconnect: { upsert: (input: Parameters<NonNullable<WebhookPrismaPort["pendingDisconnect"]>["upsert"]>[0]) => client.pendingDisconnect.upsert(input) },
      $disconnect: () => client.$disconnect(),
    };
    portfolioStatePrisma = {
      appUser: {
        findIdByAuthSubject: (authSubject) =>
          client.appUser.findUnique({
            where: { authSubject },
            select: { id: true },
          }),
      },
      brokerageConnection: {
        upsert: (input) => client.brokerageConnection.upsert(input),
      },
      brokerageAccount: {
        upsert: (input) => client.brokerageAccount.upsert(input),
      },
      portfolioSnapshot: {
        create: (input) =>
          client.portfolioSnapshot.create({
            data: {
              ...input.data,
              payload: input.data.payload as Prisma.InputJsonObject,
            },
          }),
      },
      pendingDisconnect: { findMany: (input) => client.pendingDisconnect.findMany(input) },
    };
    gatewayStore ??= new PrismaGatewayStore(client);
    ownerSessions ??= new OwnerSessionStore({ prisma: client, secret: config.owner.sessionSecret, now: options.now });
    pendingHistoryPort = { appUser: { findMany: (input) => client.appUser.findMany(input) } };
    memoryRepository ??= new PrismaMemoryRepository({
      memoryFact: {
        findMany: (input) => client.memoryFact.findMany(input as never) as never,
        findFirst: (input) => client.memoryFact.findFirst(input) as never,
        deleteMany: (input) => client.memoryFact.deleteMany(input as never),
      },
      $transaction: (fn) => client.$transaction((tx) => fn({
        $executeRaw: (query, ...values) => tx.$executeRaw(query, ...values),
        memoryFact: {
          updateMany: (input) => tx.memoryFact.updateMany(input),
          create: (input) => tx.memoryFact.create(input as never) as never,
        },
      })),
    });
    memoryLinks ??= new PrismaBrokerageLinks({
      brokerageAccount: { findMany: (input) => client.brokerageAccount.findMany(input) as never },
      activity: { findMany: (input) => client.activity.findMany(input) },
    });
    roomPrisma ??= {
      brokerageAccount: { findMany: (input) => client.brokerageAccount.findMany(input) as never },
      // Each query shape is checked against Prisma on its own (the transfer query has a tradeDate window).
      activity: {
        findMany: (input) => ("tradeDate" in input.where
          ? client.activity.findMany(input as CounterpartQuery)
          : client.activity.findMany(input as RoomActivityQuery)) as never,
      },
      activitySyncState: { findMany: (input) => client.activitySyncState.findMany(input) },
    };
    factPrisma ??= {
      activity: { findMany: (input: unknown) => client.activity.findMany(input as never) as never },
      activitySyncState: { findMany: (input: unknown) => client.activitySyncState.findMany(input as never) as never },
      brokerageAccount: { findMany: (input: unknown) => client.brokerageAccount.findMany(input as never) as never },
      portfolioSnapshot: { findMany: (input: unknown) => client.portfolioSnapshot.findMany(input as never) as never },
    } as PortfolioFactDeps["prisma"];
    reportVersionPrisma ??= {
      brokerageConnection: { count: (input) => client.brokerageConnection.count(input) },
      activity: { aggregate: (input) => client.activity.aggregate(input) },
      portfolioSnapshot: { aggregate: (input) => client.portfolioSnapshot.aggregate(input) },
    };
    nudgePrisma ??= {
      portfolioNudge: {
        findMany: (input) => client.portfolioNudge.findMany(input) as never,
        create: (input) => client.portfolioNudge.create(input),
        update: (input) => client.portfolioNudge.update(input),
      },
    };
    roomAlertPrisma ??= {
      contributionRoomAlert: {
        findUnique: (input) => client.contributionRoomAlert.findUnique(input),
        create: (input) => client.contributionRoomAlert.create(input),
        update: (input) => client.contributionRoomAlert.update(input),
        findMany: (input) => client.contributionRoomAlert.findMany(input),
      },
    };

    lastGoodPrisma = { brokerageAccount: { findMany: (input) => client.brokerageAccount.findMany(input) } };
    const fetcher = globalThis.fetch as unknown as FetchLike;
    const yahoo = new YahooChartProvider(fetcher);
    market ??= new MarketDataService({
      history: [yahoo, new StooqProvider(fetcher)],
      quotes: yahoo,
      fx: new BankOfCanadaFx(fetcher),
      cache: new PrismaMarketDataCache({
        marketDataCache: {
          findUnique: (input) => client.marketDataCache.findUnique(input),
          upsert: (input) => client.marketDataCache.upsert(input as never),
          deleteMany: (input) => client.marketDataCache.deleteMany(input),
        },
      }),
    });
    settingsPrisma ??= {
      appUser: {
        findIdByAuthSubject: (authSubject) =>
          client.appUser.findUnique({ where: { authSubject }, select: { id: true } }),
      },
      portfolioSettings: {
        findUnique: (input) => client.portfolioSettings.findUnique(input),
        upsert: (input) => client.portfolioSettings.upsert(input),
      },
    };
    dailyValuePrisma ??= {
      appUser: { findMany: (input) => client.appUser.findMany(input) },
      dailyValue: {
        upsert: (input) => client.dailyValue.upsert(input),
        findMany: (input) => client.dailyValue.findMany(input),
        findFirst: (input) => client.dailyValue.findFirst(input),
      },
    };
    historyPrisma ??= {
      appUser: { findUnique: (input) => client.appUser.findUnique(input) },
      activity: {
        upsert: (input) => client.activity.upsert(input),
        findMany: (input) => client.activity.findMany(input),
        deleteMany: (input) => client.activity.deleteMany(input),
      },
      activitySyncState: {
        findUnique: (input) => client.activitySyncState.findUnique(input),
        upsert: (input) => client.activitySyncState.upsert(input),
        updateMany: (input) => client.activitySyncState.updateMany(input),
        findMany: (input) => client.activitySyncState.findMany(input),
      },
      accountHistoryQuality: {
        upsert: (input) => client.accountHistoryQuality.upsert(input),
        deleteMany: (input) => client.accountHistoryQuality.deleteMany(input),
        findMany: (input) => client.accountHistoryQuality.findMany(input),
      },
      dailyValue: {
        findMany: (input) => client.dailyValue.findMany(input),
        deleteMany: (input) => client.dailyValue.deleteMany(input),
        createMany: (input) => client.dailyValue.createMany(input),
      },
    };
    if (newsWanted) newsStore ??= new PrismaNewsStore(client);
    exportPrisma ??= {
      appUser: { findUnique: (input) => client.appUser.findUnique(input) },
      brokerageConnection: { findMany: (input) => client.brokerageConnection.findMany(input) },
      brokerageAccount: { findMany: (input) => client.brokerageAccount.findMany(input) },
      portfolioSnapshot: { findMany: (input) => client.portfolioSnapshot.findMany(input) },
      activity: { findMany: (input) => client.activity.findMany(input) },
      dailyValue: { findMany: (input) => client.dailyValue.findMany(input) },
      newsAlertDelivery: { findMany: (input) => client.newsAlertDelivery.findMany(input) },
      pendingDisconnect: { findMany: (input) => client.pendingDisconnect.findMany(input) },
      portfolioSettings: { findUnique: (input) => client.portfolioSettings.findUnique(input) },
      activitySyncState: { findMany: (input) => client.activitySyncState.findMany(input) },
      accountHistoryQuality: { findMany: (input) => client.accountHistoryQuality.findMany(input) },
    };
    dataControlPrisma ??= {
      appUser: {
        findUnique: (input) => client.appUser.findUnique(input),
      },
      webhookEvent: { deleteMany: (input) => client.webhookEvent.deleteMany(input) },
      mcpOAuthClientRevocation: { deleteMany: (input) => client.mcpOAuthClientRevocation.deleteMany(input) },
      brokerageConnection: { findFirst: (input) => client.brokerageConnection.findFirst(input) },
      pendingDisconnect: {
        findMany: (input) => client.pendingDisconnect.findMany(input as never) as never,
        findUnique: (input) => client.pendingDisconnect.findUnique(input),
        count: (input) => client.pendingDisconnect.count(input),
      },
      $executeRaw: (query, ...values) => client.$executeRaw(query, ...values),
      $transaction: (fn) => client.$transaction((tx) => fn({
        brokerageAccount: { findMany: (input) => tx.brokerageAccount.findMany(input) },
        brokerageConnection: { deleteMany: (input) => tx.brokerageConnection.deleteMany(input) },
        portfolioSnapshot: { deleteMany: (input) => tx.portfolioSnapshot.deleteMany(input) },
        activity: { deleteMany: (input) => tx.activity.deleteMany(input) },
        activitySyncState: { deleteMany: (input) => tx.activitySyncState.deleteMany(input) },
        accountHistoryQuality: { deleteMany: (input) => tx.accountHistoryQuality.deleteMany(input) },
        dailyValue: { deleteMany: (input) => tx.dailyValue.deleteMany(input) },
        webhookEvent: { deleteMany: (input) => tx.webhookEvent.deleteMany(input) },
        pendingDisconnect: {
          findUnique: (input) => tx.pendingDisconnect.findUnique(input),
          upsert: (input) => tx.pendingDisconnect.upsert(input),
          deleteMany: (input) => tx.pendingDisconnect.deleteMany(input),
        },
      })),
    };

    if (!widgetAssets && config.widgetsDistDirectory) {
      widgetAssets = fileWidgetAssets(config.widgetsDistDirectory);
    }

  }
  const snapTradeGateway =
    options.snapTradeGateway ?? createSnapTradeGateway({ clientId: config.snapTrade.clientId, consumerKey: config.snapTrade.consumerKey }, (credentials) =>
      createPersonalSnapTradeClient(credentials, config.snapTrade.basePath ? { basePath: config.snapTrade.basePath } : {}));
  // The owner signs in once (password, server-side session); the MCP gateway asks "is the owner signed in?" through
  // the local upstream. One session store, exposed on the runtime so the REST side can reuse it.
  if (!gatewayStore || !ownerSessions) throw new Error("Invalid server configuration: owner sign-in is not composed");
  const sessions = ownerSessions;
  const localUpstream = localOwnerUpstream({ sessions, issuer: config.gateway.issuer, now: options.now });
  const gateway = createGateway({
    config: config.gateway,
    resource: config.mcpResourceUrl,
    store: gatewayStore,
    upstream: localUpstream.upstream,
    now: options.now,
  });
  // Mounted ahead of the gateway router: /login first, then the local authorize step /authorize redirects to.
  const ownerRouters = [
    loginRouter({
      sessions,
      passwordHash: config.owner.passwordHash,
      // Per source address; loginRouter holds a further global budget of its own.
      limiter: new SlidingWindowLimiter([{ ms: 15 * 60_000, max: 10 }]),
      secureCookies: !isLoopbackHttp(config.appBaseUrl),
      expectedOrigin: new URL(config.appBaseUrl).origin,
    }),
    localUpstream.router,
  ];

  const identity = new OwnerIdentity({ prisma });
  // Startup creates the owner's row; server.ts waits for this before it listens. A failure is also surfaced there.
  const ready = identity.ensureOwner().then(() => undefined);
  ready.catch(() => undefined);
  const dataControlRepository = dataControlPrisma
    ? new PrismaDataControlRepository(dataControlPrisma, options.now)
    : undefined;
  // Normal-mode reads list through this, so a disconnected authorization that SnapTrade still
  // lists is never shown or persisted again.
  const readGateway = dataControlRepository ? hideDisconnected(snapTradeGateway, dataControlRepository) : snapTradeGateway;
  const cachedPortfolio = new CachedPortfolioService({
    source: new PortfolioQueryService({
      identity,
      gateway: readGateway,
      state: portfolioStatePrisma
        ? new PrismaPortfolioStateRepository(portfolioStatePrisma)
        : undefined,
      now: options.now,
      ...NORMAL_MODE_READS,
    }),
    lastGood: lastGoodPrisma ? new PrismaLastGoodPortfolioStore(lastGoodPrisma) : undefined,
    now: options.now,
  });
  const portfolio = cachedPortfolio;
  const snapshots = dailyValuePrisma
    ? new DailySnapshotService({ prisma: dailyValuePrisma, portfolio: cachedPortfolio, now: options.now })
    : undefined;
  const activityStore = historyPrisma ? new ActivityStore(historyPrisma, options.now) : undefined;
  // Partial wiring leaves the legacy dashboard path in place.
  const overview: OverviewDeps | undefined = snapshots && market && settingsPrisma && widgetAssets
    ? { market, settings: new SettingsService(settingsPrisma), dailyValues: snapshots, now: options.now, ...(activityStore ? { history: activityStore, activities: activityStore } : {}) }
    : undefined;
  const performance: PerformanceDeps | undefined = overview && activityStore && snapshots && market
    ? { market, settings: overview.settings, dailyValues: snapshots, activities: activityStore, now: options.now }
    : undefined;
  // Signs activity paging cursors only. A fresh secret per process: a cursor from before a restart is simply rejected.
  const activityCursorSecret = randomBytes(32);
  const activity: ActivityDeps | undefined = overview && activityStore && market
    ? { activities: activityStore, market, settings: overview.settings, cursorSecret: activityCursorSecret, now: options.now }
    : undefined;
  const holdings: HoldingsDeps | undefined = overview && market
    ? { market, settings: overview.settings, now: options.now }
    : undefined;
  // Live widget loader, always on: every widget's address is a fixed loader page, and /widgets/<name>.js|css serves
  // its current build, so a widget fix reaches a host that cached the page without a reconnect.
  const widgetLoader = widgetAssets
    ? createWidgetLoader({ names: [...LOADER_WIDGETS], origin: new URL(config.appBaseUrl).origin, assets: widgetAssets })
    : undefined;
  const allocation: AllocationDeps | undefined = overview && market
    ? { market, settings: overview.settings, now: options.now }
    : undefined;
  const income: IncomeDeps | undefined = overview && activityStore
    ? { activities: activityStore, settings: overview.settings, ...(market ? { market } : {}), now: options.now }
    : undefined;
  const news: RuntimeNews | undefined = (() => {
    if (!newsWanted || !config.news || !newsStore || !market) return undefined;
    const store = newsStore;
    const fetcher = options.newsFetch ?? (globalThis.fetch as unknown as FetchLike);
    const now = options.now ?? (() => new Date());
    const budget = config.news.marketauxDailyBudget;
    const freeTier = budget <= 100;
    const jev = new JevClient({ apiKey: config.news.typesafeApiKey, model: config.news.typesafeModel, fetch: fetcher, now });
    const service = new NewsRefreshService({
      store,
      marketaux: marketauxFetcher({ apiKey: config.news.marketauxApiKey, fetch: fetcher, now, pageSize: freeTier ? 3 : 20 }),
      edgar: edgarFetcher({ userAgent: config.news.edgarUserAgent, fetch: fetcher, now }),
      rater: { rateUnrated: (o) => rateUnrated({ store, jev, now, ...o }) },
      market,
      budget,
      freeTier,
      now,
    });
    return { service, store };
  })();
  // News tools need the overview's settings; the image proxy is mounted only alongside them.
  const newsTools: NewsDeps | undefined = news && overview && market
    ? {
        store: news.store, refresh: news.service, market, settings: overview.settings,
        budget: config.news!.marketauxDailyBudget, publicOrigin: new URL(config.appBaseUrl).origin, now: options.now,
      }
    : undefined;
  // Calendar and alerts read the same cache as the news tools; alerts ledger deliveries per app user. Dividend dates
  // are projected per request from the requesting user's own stored payments (no provider read, never shared).
  const userDividends: UserDividends | undefined = newsTools && activityStore
    ? async (authSubject, accounts) => {
        const appUserId = await activityStore.userId(authSubject);
        return appUserId ? dividendPayments(activityStore, appUserId, accounts, torontoDay((options.now ?? (() => new Date()))()), { market: newsTools.market }) : [];
      }
    : undefined;
  const calendar: CalendarDeps | undefined = newsTools
    ? { store: newsTools.store, settings: newsTools.settings, market: newsTools.market, now: options.now, ...(userDividends ? { dividends: userDividends } : {}) }
    : undefined;
  const alerts: AlertsDeps | undefined = newsTools && activityStore
    ? { store: newsTools.store, market: newsTools.market, appUserId: (authSubject) => activityStore.userId(authSubject), dividends: userDividends, now: options.now }
    : undefined;
  const newsImages = newsTools
    ? (() => {
        const lookup = options.newsImageLookup ?? systemLookup;
        return imageProxyRouter({ store: newsTools.store, lookup, fetch: options.newsImageFetch ?? (createPinnedHttpsFetch(lookup) as ImageFetch) });
      })()
    : undefined;
  // TFSA over-limit alert (normal mode only, like memory): evaluated nightly and on reserved memory changes.
  const roomAlertService = roomAlertPrisma ? new RoomAlertService({ prisma: roomAlertPrisma, now: options.now }) : undefined;
  const roomAlertDeps: RoomAlertDeps | undefined = roomAlertService && memoryRepository && roomPrisma
    ? { loader: { prisma: roomPrisma, memory: memoryRepository, ...(market ? { market } : {}) }, alerts: roomAlertService, now: options.now }
    : undefined;
  // Thesis-condition and limit nudges (normal mode only, like the room alert): evaluated nightly from the accounts the
  // snapshot step read, read by get_portfolio_alerts and the dashboard. Built once memory exists (below).
  const nudgesComposed = nudgePrisma !== undefined && memoryRepository !== undefined && market !== undefined;
  let nudgeService: NudgeService | undefined;
  const pipeline = snapshots && market && activityStore && cachedPortfolio && historyPrisma && dailyValuePrisma
    ? new NightlyPipeline({
        users: () => dailyValuePrisma.appUser.findMany({ where: { authSubject: OWNER_SUBJECT }, select: { id: true, authSubject: true } }),
        ...(pendingHistoryPort ? { pending: ((port) => () => findPendingHistoryUsers(port, (options.now ?? (() => new Date()))()))(pendingHistoryPort) } : {}),
        sync: new ActivitySyncService({
          identity,
          provider: createSnapTradeActivityProvider(readGateway),
          store: activityStore,
          now: options.now,
        }),
        reconstruct: new ReconstructionService({
          store: activityStore,
          portfolio: cachedPortfolio,
          market,
          dailyValues: historyPrisma,
          now: options.now,
        }),
        snapshot: snapshots,
        purgeCache: () => market.purgeExpiredCache(),
        // The pipeline derives news symbols from the portfolios its snapshot step already read.
        ...(news ? { news: news.service } : {}),
        ...(roomAlertDeps ? { roomAlerts: { evaluate: async (subject: string) => (await reevaluateRoomAlert(roomAlertDeps, subject)).outcome } } : {}),
        ...(nudgesComposed
          ? {
              nudges: {
                evaluate: (subject: string, portfolio: { accounts: PortfolioPresentation["accounts"] }) => {
                  if (!nudgeService) throw new Error("nudges_unavailable");
                  return nudgeService.evaluateNudges(subject, undefined, {
                    portfolio: { connectionRequired: false, generatedAt: new Date(0).toISOString(), totals: [], errors: [], accounts: portfolio.accounts },
                  });
                },
              },
            }
          : {}),
      })
    : undefined;
  const history = new PortfolioHistoryService({
    identity,
    gateway: readGateway,
    now: options.now,
  });
  const connectionPortal = new ConnectionService({
    identity,
    gateway: snapTradeGateway,
    appBaseUrl: config.appBaseUrl,
  });
  const connectionStatus = new ConnectionStatusService({
    identity,
    gateway: readGateway,
  });
  const connections = {
    getConnections: (authSubject: string) =>
      connectionStatus.getConnections(authSubject),
    createConnectionPortal: (
      authSubject: string,
      connectionOptions: { reconnect?: string } = {},
    ) =>
      connectionPortal.createConnectionPortal(
        authSubject,
        connectionOptions,
      ),
  };
  const dataControls = dataControlRepository
    ? new DataControlService({
        identity,
        gateway: snapTradeGateway,
        repository: dataControlRepository,
        // Forget, not invalidate: a stale fallback would still show the removed connection.
        evict: (authSubject) => cachedPortfolio?.forget(authSubject),
        now: options.now,
      })
    : undefined;
  const memory = memoryRepository
    ? new MemoryService({
        repository: memoryRepository,
        ...(memoryLinks ? { links: memoryLinks } : {}),
        now: options.now,
        // Changing or deleting a reserved TFSA input re-evaluates the alert in the same request (best effort).
        ...(roomAlertDeps ? { onReservedChange: (subject: string) => reevaluateRoomAlert(roomAlertDeps, subject) } : {}),
      })
    : undefined;
  // MCP memory and room tools: normal mode only, like memory itself. The room reads stored data only.
  const memoryTools: MemoryToolDeps | undefined = memory ? { service: memory, ...(memoryLinks ? { links: memoryLinks } : {}) } : undefined;
  const room: RoomDeps | undefined = memory && memoryRepository && roomPrisma
    ? {
        loader: { prisma: roomPrisma, memory: memoryRepository, ...(market ? { market } : {}) },
        context: { repository: memoryRepository, ...(memoryLinks ? { links: memoryLinks } : {}), now: options.now },
        now: options.now,
        appBaseUrl: config.appBaseUrl,
        ...(roomAlertDeps ? { alerts: roomAlertDeps.alerts } : {}),
      }
    : undefined;
  nudgeService = nudgesComposed && memory && market && nudgePrisma
    ? new NudgeService({
        prisma: nudgePrisma, memory, market, now: options.now,
        portfolio: async (subject) => buildPortfolioPresentation(await portfolio.getPortfolio(subject)),
      })
    : undefined;
  // Thesis, limit and goal tools: normal mode with memory only; stored data, cached market data and the news cache.
  const portfolioFacts: PortfolioFactDeps | undefined = memoryTools && factPrisma && snapshots && market
    ? { prisma: factPrisma, dailyValues: snapshots, market, ...(news ? { news: news.store } : {}), ...(nudgeService ? { nudges: nudgeService } : {}), now: options.now }
    : undefined;
  const accountExport = exportPrisma
    ? new AccountExportService({
        prisma: exportPrisma,
        aiApps: gateway.aiApps,
        ...(memory ? { memory } : {}),
        ...(roomAlertService ? { roomAlerts: roomAlertService } : {}),
        ...(nudgeService ? { nudges: nudgeService } : {}),
        now: options.now,
      })
    : undefined;
  const retention = dataControlRepository
    ? new RetentionService({
        store: dataControlRepository,
        sweepDisconnects: () => dataControls!.sweepPendingDisconnects(),
        sweepSubjectRevocations: (before) => dataControlRepository.purgeSubjectRevocations(before),
        now: options.now,
      })
    : undefined;
  // One report card cache per process: every hit re-reads the subject's data-version marker, so a delete or sync on
  // another instance still forces a recompute here; the webhook purge below and the DELETE routes also forget.
  const versionPort = reportVersionPrisma;
  const reportCards = options.reportCards
    ?? createReportCardCache<ReportCard>(versionPort ? { version: (subject) => reportDataVersion(versionPort, subject) } : {});
  // Built only when webhooks are enabled: with them off there is no verifier and the consumer key is never used for it.
  const webhooks = config.webhooksEnabled
    ? new WebhookIngestionService({
      repository: new PrismaWebhookEventRepository(prisma, options.now),
      clientId: config.snapTrade.clientId,
      consumerKey: config.snapTrade.consumerKey,
      now: options.now,
      onRecorded: cachedPortfolio
        ? async ({ eventType, brokerageAuthorizationId }) => {
            if (dataControls && eventType === "CONNECTION_DELETED" && brokerageAuthorizationId) {
              // Never throws: a failure is logged (connection_purge_failed) and the confirmed
              // marker stored with the receipt makes the nightly sweep retry the purge.
              await dataControls.purgeDeletedConnection(brokerageAuthorizationId);
            }
            // One owner per instance: every verified webhook concerns the owner.
            const authSubject = OWNER_SUBJECT;
            // A deleted connection must not survive as a stale fallback; other events keep one.
            if (eventType === "CONNECTION_DELETED") {
              cachedPortfolio.forget(authSubject);
              reportCards.forget(authSubject);
            } else cachedPortfolio.invalidate(authSubject);
            if (activityStore && isHistoryChangeEvent(eventType)) {
              try {
                const appUserId = await activityStore.userId(authSubject);
                if (appUserId) await activityStore.markDirty(appUserId);
              } catch {
                // Best effort: the nightly 30-day re-read still picks up the change.
              }
            }
          }
        : undefined,
    })
    : undefined;

  const lock = advisoryLock;
  // Background manual refreshes, so shutdown can wait for them (bounded) before the database closes.
  const backgroundRuns = new Set<Promise<void>>();
  const trackBackground = (run: Promise<void>) => {
    backgroundRuns.add(run);
    void run.finally(() => backgroundRuns.delete(run));
  };
  const log = (event: Record<string, unknown>) => console.warn(JSON.stringify(event));
  // The nightly weekday job and the 10-minute history catch-up, each under its own lock name. The manual refresh takes
  // the "nightly" lock too, so it never overlaps the nightly run.
  const jobs: ScheduledJob[] = [];
  if (lock && (pipeline || snapshots)) {
    jobs.push({
      name: "nightly",
      spec: { kind: "daily", hour: 17, minute: 30, weekdaysOnly: true },
      run: () => runNightly({ ...(pipeline ? { pipeline } : {}), ...(snapshots ? { snapshots } : {}), ...(retention ? { retention } : {}), log }),
    });
  }
  if (lock && pipeline) jobs.push(historyCatchupJob(pipeline, log, lock));

  return {
    app: createPortfolioApi({
      sessions,
      portfolio,
      history,
      connections,
      ...(webhooks ? { webhooks } : {}),
      appBaseUrl: config.appBaseUrl,
      ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
      mcpResourceUrl: config.mcpResourceUrl,
      ownerRouters,
      staticAssetsDirectory: config.webDistDirectory,
      ...(overview ? { overview, assets: widgetAssets } : {}),
      ...(widgetLoader ? { widgetLoader } : {}),
      ...(performance ? { performance } : {}),
      ...(activity ? { activity } : {}),
      ...(holdings ? { holdings } : {}),
      ...(allocation ? { allocation } : {}),
      ...(income ? { income } : {}),
      ...(newsTools && newsImages ? { news: newsTools, newsImages } : {}),
      ...(newsTools && newsImages && calendar ? { calendar } : {}),
      ...(newsTools && newsImages && alerts ? { alerts } : {}),
      ...(memoryTools ? { memory: memoryTools } : {}),
      ...(room ? { room } : {}),
      ...(portfolioFacts ? { portfolioFacts } : {}),
      reportCards,
      ...(nudgeService ? { nudges: nudgeService } : {}),
      ...(dataControls ? { dataControls } : {}),
      ...(accountExport ? { accountExport } : {}),
      ...(lock && pipeline ? { refresh: { run: () => pipeline.refreshUsers(), lock, track: trackBackground } } : {}),
      gateway,
    }),
    news,
    memory,
    /** Resolves once the owner row exists; rejects if it could not be created. */
    ready,
    /** The owner session store: the REST side authenticates the dashboard with the same sessions. */
    ownerSessions: sessions,
    /** The scheduled jobs (empty without a job lock). */
    jobs,
    /** Arms the in-process schedule (call after `listen`); `stop()` clears the timers. Nothing runs at startup. */
    startScheduler: () => startScheduler({ jobs, lock: lock ?? (async () => false), now: options.now, log }),
    /** Resolves when every background manual refresh has settled. Shutdown races it against its bound. */
    drainBackground: async () => { await Promise.allSettled([...backgroundRuns]); },
    close: async () => { gateway.close(); await prisma.$disconnect(); },
  };
}
