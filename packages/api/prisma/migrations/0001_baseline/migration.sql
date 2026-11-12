-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "AppUser" (
    "id" UUID NOT NULL,
    "authSubject" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "snapTradeAccountId" VARCHAR(64) NOT NULL,
    "dedupeKey" VARCHAR(64) NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "symbol" VARCHAR(40),
    "securityCurrency" VARCHAR(3),
    "isOption" BOOLEAN NOT NULL DEFAULT false,
    "units" DECIMAL(30,10),
    "price" DECIMAL(30,10),
    "amount" DECIMAL(30,10),
    "fee" DECIMAL(30,10),
    "fxRate" DECIMAL(30,10),
    "currency" VARCHAR(3),
    "tradeDate" DATE,
    "settlementDate" DATE,
    "description" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivitySyncState" (
    "appUserId" UUID NOT NULL,
    "snapTradeAccountId" VARCHAR(64) NOT NULL,
    "backfillCompletedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" VARCHAR(64),
    "activityCount" INTEGER NOT NULL DEFAULT 0,
    "earliestTradeDate" DATE,
    "dirty" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ActivitySyncState_pkey" PRIMARY KEY ("appUserId","snapTradeAccountId")
);

-- CreateTable
CREATE TABLE "AccountHistoryQuality" (
    "appUserId" UUID NOT NULL,
    "snapTradeAccountId" VARCHAR(64) NOT NULL,
    "method" VARCHAR(24) NOT NULL,
    "reason" VARCHAR(48),
    "driftFraction" DECIMAL(12,6),
    "unrecordedFlows" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountHistoryQuality_pkey" PRIMARY KEY ("appUserId","snapTradeAccountId")
);

-- CreateTable
CREATE TABLE "BrokerageConnection" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "snapTradeConnectionId" VARCHAR(64) NOT NULL,
    "brokerageSlug" VARCHAR(128),
    "brokerageName" VARCHAR(255),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "dataFreshnessMode" VARCHAR(32),
    "lastWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerageConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingDisconnect" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "snapTradeConnectionId" VARCHAR(64) NOT NULL,
    "snapTradeAccountIds" VARCHAR(64)[] DEFAULT ARRAY[]::VARCHAR(64)[],
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "PendingDisconnect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerageAccount" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "snapTradeAccountId" VARCHAR(64) NOT NULL,
    "institutionAccountId" VARCHAR(255),
    "displayName" TEXT,
    "maskedNumber" TEXT,
    "institutionName" TEXT NOT NULL,
    "rawType" TEXT,
    "category" VARCHAR(32),
    "status" VARCHAR(32),
    "isPaper" BOOLEAN NOT NULL DEFAULT false,
    "reportedTotal" DECIMAL(30,10),
    "reportedCurrency" VARCHAR(3),
    "holdingsUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "holdingsLastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerageAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "accountId" UUID,
    "snapTradeAccountId" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "positionsAsOf" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "snapTradeWebhookId" VARCHAR(64) NOT NULL,
    "appUserId" UUID,
    "snapTradeUserId" VARCHAR(255),
    "eventType" VARCHAR(128) NOT NULL,
    "bodyDigest" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "failureCode" VARCHAR(64),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSettings" (
    "appUserId" UUID NOT NULL,
    "benchmark" VARCHAR(16) NOT NULL DEFAULT 'sp500',
    "cadView" BOOLEAN NOT NULL DEFAULT true,
    "privacyDefault" BOOLEAN NOT NULL DEFAULT false,
    "targetAllocation" JSONB,
    "contributionRoom" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioSettings_pkey" PRIMARY KEY ("appUserId")
);

-- CreateTable
CREATE TABLE "DailyValue" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "snapTradeAccountId" VARCHAR(64) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "value" DECIMAL(30,10) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDataCache" (
    "key" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketDataCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "clientId" VARCHAR(64) NOT NULL,
    "clientSecretHash" CHAR(64),
    "redirectUris" JSONB NOT NULL,
    "clientName" VARCHAR(200),
    "tokenEndpointAuthMethod" VARCHAR(24) NOT NULL,
    "grantTypes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "McpOAuthCimdCache" (
    "url" VARCHAR(2048) NOT NULL,
    "document" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "freshUntil" TIMESTAMP(3) NOT NULL,
    "staleUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthCimdCache_pkey" PRIMARY KEY ("url")
);

-- CreateTable
CREATE TABLE "McpOAuthPending" (
    "id" VARCHAR(64) NOT NULL,
    "clientKey" VARCHAR(2048) NOT NULL,
    "redirectUri" VARCHAR(2048) NOT NULL,
    "state" VARCHAR(2048),
    "codeChallenge" VARCHAR(128) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "resource" VARCHAR(2048) NOT NULL,
    "upstreamState" VARCHAR(128) NOT NULL,
    "upstreamNonce" VARCHAR(128) NOT NULL,
    "upstreamVerifier" VARCHAR(128) NOT NULL,
    "subject" VARCHAR(255),
    "consentCsrf" VARCHAR(128),
    "browserBindingHash" CHAR(64) NOT NULL,
    "upstreamClaimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthPending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthCode" (
    "codeHash" CHAR(64) NOT NULL,
    "clientKey" VARCHAR(2048) NOT NULL,
    "redirectUri" VARCHAR(2048) NOT NULL,
    "codeChallenge" VARCHAR(128) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "resource" VARCHAR(2048) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "familyId" VARCHAR(64) NOT NULL,

    CONSTRAINT "McpOAuthCode_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "McpOAuthRefreshToken" (
    "tokenHash" CHAR(64) NOT NULL,
    "familyId" VARCHAR(64) NOT NULL,
    "clientKey" VARCHAR(2048) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "resource" VARCHAR(2048) NOT NULL,
    "parentHash" CHAR(64),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "familyExpiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpOAuthRefreshToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "McpOAuthRevokedFamily" (
    "familyId" VARCHAR(64) NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthRevokedFamily_pkey" PRIMARY KEY ("familyId")
);

-- CreateTable
CREATE TABLE "McpOAuthClientRevocation" (
    "id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "clientKey" VARCHAR(2048) NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthClientRevocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthConsent" (
    "id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "clientKey" VARCHAR(2048) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsArticle" (
    "id" UUID NOT NULL,
    "urlHash" CHAR(64) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "headline" VARCHAR(500) NOT NULL,
    "snippet" VARCHAR(200),
    "source" VARCHAR(200) NOT NULL,
    "imageUrl" VARCHAR(2048),
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "symbols" VARCHAR(32)[],
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsRating" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "ratedAt" TIMESTAMP(3) NOT NULL,
    "relevant" DOUBLE PRECISION NOT NULL,
    "sentiment" DOUBLE PRECISION NOT NULL,
    "sentimentConfidence" DOUBLE PRECISION NOT NULL,
    "materiality" DOUBLE PRECISION NOT NULL,
    "eventType" VARCHAR(64),
    "eventConfidence" DOUBLE PRECISION NOT NULL,
    "credible" DOUBLE PRECISION NOT NULL,
    "clickbait" DOUBLE PRECISION NOT NULL,
    "duplicateOf" VARCHAR(64),

    CONSTRAINT "NewsRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsSymbolFetch" (
    "symbol" VARCHAR(32) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsSymbolFetch_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "NewsSymbolStats" (
    "symbol" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "closes" INTEGER NOT NULL,
    "typicalMove" DOUBLE PRECISION,
    "lastClose" DOUBLE PRECISION,
    "prevClose" DOUBLE PRECISION,
    "lastCloseDate" VARCHAR(10),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsSymbolStats_pkey" PRIMARY KEY ("symbol","currency")
);

-- CreateTable
CREATE TABLE "NewsCalendarEvent" (
    "id" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "amountPerUnit" DOUBLE PRECISION,
    "currency" VARCHAR(8),

    CONSTRAINT "NewsCalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsAlertDelivery" (
    "id" UUID NOT NULL,
    "appUserId" UUID NOT NULL,
    "clientKey" VARCHAR(512) NOT NULL,
    "alertId" VARCHAR(128) NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsBudget" (
    "day" VARCHAR(10) NOT NULL,
    "spent" INTEGER NOT NULL,

    CONSTRAINT "NewsBudget_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "MemoryFact" (
    "id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "nodeType" VARCHAR(16) NOT NULL,
    "nodeKey" VARCHAR(120) NOT NULL,
    "property" VARCHAR(64) NOT NULL,
    "value" JSONB,
    "text" VARCHAR(2000) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "provenance" VARCHAR(16) NOT NULL,
    "validFrom" DATE,
    "validTo" DATE,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "source" VARCHAR(64),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributionRoomAlert" (
    "id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "year" INTEGER NOT NULL,
    "excessCad" DECIMAL(14,2) NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(400),
    "raisedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "ContributionRoomAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioNudge" (
    "id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "target" VARCHAR(120) NOT NULL,
    "conditionId" VARCHAR(120),
    "basis" VARCHAR(32),
    "text" VARCHAR(400) NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "PortfolioNudge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerSession" (
    "id" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_authSubject_key" ON "AppUser"("authSubject");

-- CreateIndex
CREATE INDEX "Activity_appUserId_snapTradeAccountId_tradeDate_idx" ON "Activity"("appUserId", "snapTradeAccountId", "tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_appUserId_dedupeKey_key" ON "Activity"("appUserId", "dedupeKey");

-- CreateIndex
CREATE INDEX "BrokerageConnection_appUserId_disabled_idx" ON "BrokerageConnection"("appUserId", "disabled");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerageConnection_appUserId_snapTradeConnectionId_key" ON "BrokerageConnection"("appUserId", "snapTradeConnectionId");

-- CreateIndex
CREATE INDEX "PendingDisconnect_confirmedAt_requestedAt_idx" ON "PendingDisconnect"("confirmedAt", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingDisconnect_appUserId_snapTradeConnectionId_key" ON "PendingDisconnect"("appUserId", "snapTradeConnectionId");

-- CreateIndex
CREATE INDEX "BrokerageAccount_appUserId_connectionId_idx" ON "BrokerageAccount"("appUserId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerageAccount_appUserId_snapTradeAccountId_key" ON "BrokerageAccount"("appUserId", "snapTradeAccountId");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_appUserId_capturedAt_idx" ON "PortfolioSnapshot"("appUserId", "capturedAt");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_appUserId_snapTradeAccountId_capturedAt_idx" ON "PortfolioSnapshot"("appUserId", "snapTradeAccountId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_appUserId_snapTradeAccountId_positionsAsOf_ke" ON "PortfolioSnapshot"("appUserId", "snapTradeAccountId", "positionsAsOf");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_snapTradeWebhookId_key" ON "WebhookEvent"("snapTradeWebhookId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_bodyDigest_key" ON "WebhookEvent"("bodyDigest");

-- CreateIndex
CREATE INDEX "WebhookEvent_appUserId_receivedAt_idx" ON "WebhookEvent"("appUserId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_snapTradeUserId_receivedAt_idx" ON "WebhookEvent"("snapTradeUserId", "receivedAt");

-- CreateIndex
CREATE INDEX "DailyValue_appUserId_date_idx" ON "DailyValue"("appUserId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyValue_appUserId_date_snapTradeAccountId_currency_key" ON "DailyValue"("appUserId", "date", "snapTradeAccountId", "currency");

-- CreateIndex
CREATE INDEX "MarketDataCache_expiresAt_idx" ON "MarketDataCache"("expiresAt");

-- CreateIndex
CREATE INDEX "McpOAuthClient_lastUsedAt_idx" ON "McpOAuthClient"("lastUsedAt");

-- CreateIndex
CREATE INDEX "McpOAuthCimdCache_staleUntil_idx" ON "McpOAuthCimdCache"("staleUntil");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthPending_upstreamState_key" ON "McpOAuthPending"("upstreamState");

-- CreateIndex
CREATE INDEX "McpOAuthPending_expiresAt_idx" ON "McpOAuthPending"("expiresAt");

-- CreateIndex
CREATE INDEX "McpOAuthCode_familyId_idx" ON "McpOAuthCode"("familyId");

-- CreateIndex
CREATE INDEX "McpOAuthCode_expiresAt_idx" ON "McpOAuthCode"("expiresAt");

-- CreateIndex
CREATE INDEX "McpOAuthCode_subject_idx" ON "McpOAuthCode"("subject");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_familyId_idx" ON "McpOAuthRefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_subject_idx" ON "McpOAuthRefreshToken"("subject");

-- CreateIndex
CREATE INDEX "McpOAuthRefreshToken_familyExpiresAt_idx" ON "McpOAuthRefreshToken"("familyExpiresAt");

-- CreateIndex
CREATE INDEX "McpOAuthRevokedFamily_revokedAt_idx" ON "McpOAuthRevokedFamily"("revokedAt");

-- CreateIndex
CREATE INDEX "McpOAuthClientRevocation_revokedAt_idx" ON "McpOAuthClientRevocation"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClientRevocation_subject_clientKey_key" ON "McpOAuthClientRevocation"("subject", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthConsent_subject_clientKey_key" ON "McpOAuthConsent"("subject", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "NewsArticle_urlHash_key" ON "NewsArticle"("urlHash");

-- CreateIndex
CREATE INDEX "NewsArticle_publishedAt_idx" ON "NewsArticle"("publishedAt");

-- CreateIndex
CREATE INDEX "NewsArticle_symbols_idx" ON "NewsArticle" USING GIN ("symbols");

-- CreateIndex
CREATE INDEX "NewsRating_symbol_idx" ON "NewsRating"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "NewsRating_articleId_symbol_key" ON "NewsRating"("articleId", "symbol");

-- CreateIndex
CREATE INDEX "NewsCalendarEvent_symbol_date_idx" ON "NewsCalendarEvent"("symbol", "date");

-- CreateIndex
CREATE INDEX "NewsAlertDelivery_appUserId_idx" ON "NewsAlertDelivery"("appUserId");

-- CreateIndex
CREATE INDEX "NewsAlertDelivery_deliveredAt_idx" ON "NewsAlertDelivery"("deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "NewsAlertDelivery_appUserId_clientKey_alertId_key" ON "NewsAlertDelivery"("appUserId", "clientKey", "alertId");

-- CreateIndex
CREATE INDEX "MemoryFact_subject_nodeType_nodeKey_property_recordedAt_idx" ON "MemoryFact"("subject", "nodeType", "nodeKey", "property", "recordedAt");

-- CreateIndex
CREATE INDEX "MemoryFact_subject_recordedAt_idx" ON "MemoryFact"("subject", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContributionRoomAlert_subject_year_key" ON "ContributionRoomAlert"("subject", "year");

-- CreateIndex
CREATE INDEX "PortfolioNudge_subject_clearedAt_idx" ON "PortfolioNudge"("subject", "clearedAt");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySyncState" ADD CONSTRAINT "ActivitySyncState_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHistoryQuality" ADD CONSTRAINT "AccountHistoryQuality_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerageConnection" ADD CONSTRAINT "BrokerageConnection_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDisconnect" ADD CONSTRAINT "PendingDisconnect_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerageAccount" ADD CONSTRAINT "BrokerageAccount_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerageAccount" ADD CONSTRAINT "BrokerageAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BrokerageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerageAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSettings" ADD CONSTRAINT "PortfolioSettings_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyValue" ADD CONSTRAINT "DailyValue_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsRating" ADD CONSTRAINT "NewsRating_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "NewsArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsAlertDelivery" ADD CONSTRAINT "NewsAlertDelivery_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written below: Prisma cannot declare these (CHECK constraints, a partial index, an expression index).
-- `prisma migrate diff` ignores them, so the schema-drift check stays clean.

-- MemoryFact: allowed values.
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_nodeType_check" CHECK ("nodeType" IN ('account', 'security', 'sector', 'tax_year', 'goal', 'rule', 'activity', 'user'));
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_nodeKey_check" CHECK ("nodeKey" ~ '^[A-Za-z0-9_.:-]+$');
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_kind_check" CHECK ("kind" IN ('fact', 'plan', 'reason', 'note'));
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_provenance_check" CHECK ("provenance" IN ('stated', 'inferred', 'imported', 'derived'));

-- At most one current fact per topic (partial, expression index).
CREATE UNIQUE INDEX "MemoryFact_current_topic_key" ON "MemoryFact"("subject", "nodeType", "nodeKey", "property", COALESCE("validFrom", DATE 'epoch')) WHERE "supersededAt" IS NULL;

-- PortfolioNudge: allowed kinds.
ALTER TABLE "PortfolioNudge" ADD CONSTRAINT "PortfolioNudge_kind_check" CHECK ("kind" IN ('thesis_condition', 'limit'));

-- One row per (subject, kind, target, condition) (expression index).
CREATE UNIQUE INDEX "PortfolioNudge_subject_kind_target_condition_key" ON "PortfolioNudge"("subject", "kind", "target", COALESCE("conditionId", ''));
