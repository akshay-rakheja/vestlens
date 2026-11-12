export const PORTFOLIO_WIDGET_URI = "ui://portfolio/dashboard-v4";
export const PORTFOLIO_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export function portfolioWidgetHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Portfolio overview</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: light-dark(#f4f1e9, #111714);
      --card: light-dark(#fffdf8, #19211d);
      --card-strong: light-dark(#ffffff, #202a25);
      --ink: light-dark(#17211d, #f3f6f4);
      --muted: light-dark(#65716b, #a9b5af);
      --line: light-dark(#ddd9ce, #344039);
      --green: light-dark(#176b4d, #4ed59d);
      --green-soft: light-dark(#e5f1eb, #183b2d);
      --orange: light-dark(#b9522c, #ff9a70);
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: var(--bg); }
    button { font: inherit; color: inherit; }
    .shell { padding: 16px; }
    .hero {
      overflow: hidden;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--card);
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--green);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .09em;
      text-transform: uppercase;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 8px; font: 500 clamp(25px, 6vw, 40px)/1.05 Georgia, serif; letter-spacing: -.035em; }
    .subtitle, #status, #generated { color: var(--muted); font-size: 12px; line-height: 1.5; }
    #status { margin: 16px 0 0; }
    .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; margin-top: 18px; }
    .total {
      padding: 16px;
      border-radius: 15px;
      color: #fff;
      background: #17372b;
    }
    .total strong { display: block; font: 500 26px/1 Georgia, serif; letter-spacing: -.03em; }
    .total span { display: block; margin-top: 7px; color: rgba(255,255,255,.65); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
    .groups { display: grid; gap: 14px; margin-top: 14px; }
    .group { padding: 17px; border: 1px solid var(--line); border-radius: 17px; background: var(--card); }
    .group h2 { margin-bottom: 13px; font: 500 21px/1.15 Georgia, serif; letter-spacing: -.025em; }
    .bucket + .bucket { margin-top: 16px; }
    .bucket h3 { margin-bottom: 8px; color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
    .accounts { display: grid; gap: 8px; }
    .account { border: 1px solid var(--line); border-radius: 13px; background: var(--card-strong); }
    .account-button {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      padding: 13px 14px;
      border: 0;
      background: transparent;
      cursor: pointer;
      text-align: left;
    }
    .account-button:hover { background: var(--green-soft); }
    .account-name { display: block; font-size: 13px; font-weight: 780; }
    .account-meta { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
    .account-value { text-align: right; }
    .account-value strong { display: block; font-size: 13px; }
    .account-value span { display: block; margin-top: 3px; color: var(--muted); font-size: 9px; font-weight: 800; }
    .details { padding: 0 14px 13px; border-top: 1px solid var(--line); }
    .details[hidden] { display: none; }
    .position { display: flex; justify-content: space-between; gap: 12px; padding-top: 10px; font-size: 11px; }
    .position span:last-child { color: var(--muted); text-align: right; }
    .warning { margin-top: 8px; padding: 8px 10px; border-radius: 9px; color: var(--orange); background: light-dark(#fbe8dd, #3b241c); font-size: 10px; }
    .empty { padding: 18px; color: var(--muted); font-size: 12px; text-align: center; }
    .boundary { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 13px; color: var(--muted); background: var(--green-soft); font-size: 10px; line-height: 1.45; }
    @media (max-width: 460px) {
      .shell { padding: 10px; }
      .hero { padding: 17px; border-radius: 16px; }
      .account-button { grid-template-columns: 1fr; }
      .account-value { text-align: left; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Portfolio · read only</p>
      <h1>Portfolio overview</h1>
      <p class="subtitle">Brokerage-reported values remain separated by native currency.</p>
      <div id="totals" class="totals" aria-label="Brokerage-reported portfolio value"></div>
      <p id="generated"></p>
      <p id="status" role="status" aria-live="polite">Waiting for your authenticated portfolio…</p>
      <button id="refresh" type="button" disabled>Reload data</button>
    </section>
    <div id="groups" class="groups"></div>
    <div class="boundary">Viewing and analysis only. This component cannot submit orders, transfers, or recurring investments.</div>
  </main>
  <script>(function () {
    "use strict";
    var pendingRequests = new Map();
    var nextRequestId = 1;
    var latestPortfolio = null;
    var initialized = false;
    var hostTools = false;
    var destroyed = false;
    var refreshing = false;
    var reloadAfter = 0;
    var reloadTimer = null;
    var renderRevision = 0;
    var accountButtons = [];
    var REQUEST_TIMEOUT_MS = 15000;
    var RELOAD_INTERVAL_MS = 10000;
    var groupOrder = ["registered", "non_registered", "digital_assets", "other", "credit_products", "closed"];
    var totalsElement = document.getElementById("totals");
    var groupsElement = document.getElementById("groups");
    var statusElement = document.getElementById("status");
    var generatedElement = document.getElementById("generated");
    var refreshButton = document.getElementById("refresh");
    var rootElement = document.documentElement || null;
    var resizeObserver = null;
    var reportedHeight = 0;

    function applyHostContext(context) {
      if (!context || typeof context !== "object") return;
      // light-dark() tokens follow color-scheme, so the host theme wins over the OS.
      if ((context.theme === "light" || context.theme === "dark") && rootElement && rootElement.style) {
        rootElement.style.colorScheme = context.theme;
      }
    }

    function reportSize() {
      if (destroyed || !initialized || !rootElement) return;
      var height = Math.ceil(Number(rootElement.scrollHeight) || 0);
      if (!height || height === reportedHeight) return;
      reportedHeight = height;
      window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: height } }, "*");
    }

    function scheduleSizeReport() {
      Promise.resolve().then(reportSize);
    }

    function canCallTools() {
      return !destroyed && ((initialized && hostTools) ||
        (window.openai && typeof window.openai.callTool === "function"));
    }

    function updateControls() {
      refreshButton.disabled = !latestPortfolio || !canCallTools() || refreshing || Date.now() < reloadAfter;
      accountButtons.forEach(function (button) { button.disabled = !canCallTools(); });
    }

    function element(tagName, className, text) {
      var node = document.createElement(tagName);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function formatCurrency(amount, currency) {
      try {
        return new Intl.NumberFormat("en-CA", {
          style: "currency",
          currency: currency,
          maximumFractionDigits: 2
        }).format(amount);
      } catch (_error) {
        return String(amount) + " " + String(currency || "");
      }
    }

    function formatTimestamp(value) {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(new Date(value));
      } catch (_error) {
        return String(value || "");
      }
    }

    function settleRequest(id, error, result) {
      var pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      if (error) pending.reject(new Error("Portfolio request failed."));
      else pending.resolve(result);
    }

    function trackRequest(send) {
      if (destroyed) return Promise.reject(new Error("Portfolio view closed."));
      var id = nextRequestId++;
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          settleRequest(id, new Error("Portfolio request timed out."));
        }, REQUEST_TIMEOUT_MS);
        // Register before posting: a host may answer immediately.
        pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
        try { send(id); } catch (_error) { settleRequest(id, true); }
      });
    }

    function request(method, params) {
      return trackRequest(function (id) {
        window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
      });
    }

    function callTool(name, args) {
      if (!canCallTools()) return Promise.reject(new Error("Portfolio tools unavailable."));
      if (initialized && hostTools) return request("tools/call", { name: name, arguments: args });
      if (window.openai && typeof window.openai.callTool === "function") {
        return trackRequest(function (id) {
          Promise.resolve().then(function () { return window.openai.callTool(name, args); })
            .then(function (result) { settleRequest(id, null, result); }, function () { settleRequest(id, true); });
        });
      }
      return Promise.reject(new Error("Portfolio tools unavailable."));
    }

    function resultContent(result) {
      if (result && result.isError) throw new Error("Portfolio tool returned an error.");
      return result && result.structuredContent ? result.structuredContent : result;
    }

    function renderPositions(panel, account, result) {
      panel.replaceChildren();
      var content = resultContent(result) || {};
      if (!Array.isArray(content.positions)) throw new Error("Invalid positions result.");
      var positions = content.positions;
      if (positions.length === 0) {
        panel.append(element("div", "empty", "No positions are currently available."));
      } else {
        positions.forEach(function (position) {
          var row = element("div", "position");
          var identity = element("span", "", position.symbol || position.description || "Position");
          var calculated = position.calculatedMarketValue !== undefined ? position.calculatedMarketValue : position.marketValue;
          var value = calculated !== null && calculated !== undefined && position.currency
            ? formatCurrency(calculated, position.currency)
            : (position.units !== null && position.units !== undefined ? String(position.units) + " units" : "Value unavailable");
          row.append(identity, element("span", "", value));
          panel.append(row);
        });
      }
      (account.warnings || []).forEach(function (warning) {
        panel.append(element("div", "warning", warning));
      });
      scheduleSizeReport();
    }

    function accountCard(account) {
      var card = element("article", "account");
      var button = element("button", "account-button");
      button.type = "button";
      button.disabled = !canCallTools();
      button.setAttribute("aria-expanded", "false");
      accountButtons.push(button);
      var copy = element("span", "");
      copy.append(
        element("span", "account-name", account.classification && account.classification.label ? account.classification.label : account.name || "Account"),
        element("span", "account-meta", (account.name || account.institution || "Brokerage") + " · " + String(account.positionCount || 0) + " positions")
      );
      var value = element("span", "account-value");
      value.append(
        element("strong", "", account.value ? formatCurrency(account.value.amount, account.value.currency) : "Unavailable"),
        element("span", "", account.value ? account.value.currency : "Brokerage value")
      );
      button.append(copy, value);
      var details = element("div", "details");
      details.hidden = true;
      var loading = false;
      var revision = renderRevision;
      button.onclick = function () {
        if (!canCallTools()) return;
        details.hidden = !details.hidden;
        button.setAttribute("aria-expanded", String(!details.hidden));
        scheduleSizeReport();
        if (details.hidden || loading) return;
        loading = true;
        details.replaceChildren(element("div", "empty", "Loading positions…"));
        callTool("get_account_positions", { accountId: account.id })
          .then(function (result) {
            if (!destroyed && revision === renderRevision) renderPositions(details, account, result);
          })
          .catch(function () {
            if (!destroyed && revision === renderRevision) {
              details.replaceChildren(element("div", "warning", "Positions could not be loaded."));
            }
          })
          .finally(function () { loading = false; });
      };
      var freshness = account.freshness || {};
      var syncText = freshness.holdingsLastSyncedAt
        ? "Holdings synced " + formatTimestamp(freshness.holdingsLastSyncedAt)
        : "Holdings sync time unknown";
      if (freshness.positionsAsOf) syncText += " · Positions as of " + formatTimestamp(freshness.positionsAsOf);
      if (freshness.initialSyncCompleted === false) syncText += " · Initial sync pending";
      if (freshness.holdingsUnavailable) syncText += " · Holdings unavailable";
      card.append(button, element("div", "account-meta", syncText), details);
      return card;
    }

    function renderTotals(totals) {
      totalsElement.replaceChildren();
      if (!totals.length) {
        totalsElement.append(element("div", "empty", "Portfolio value unavailable"));
        return;
      }
      totals.forEach(function (total) {
        var card = element("div", "total");
        card.append(
          element("strong", "", formatCurrency(total.amount, total.currency)),
          element("span", "", total.currency + " · BROKERAGE REPORTED")
        );
        totalsElement.append(card);
      });
    }

    function renderGroups(accounts) {
      groupsElement.replaceChildren();
      accountButtons = [];
      groupOrder.forEach(function (groupId) {
        var groupAccounts = accounts.filter(function (account) {
          return account.classification && account.classification.group === groupId;
        });
        if (!groupAccounts.length) return;

        var group = element("section", "group");
        group.append(element("h2", "", groupAccounts[0].classification.groupLabel || "Accounts"));
        var buckets = new Map();
        groupAccounts.forEach(function (account) {
          var bucketId = account.classification.bucket || "other";
          if (!buckets.has(bucketId)) buckets.set(bucketId, []);
          buckets.get(bucketId).push(account);
        });
        buckets.forEach(function (bucketAccounts) {
          var bucket = element("section", "bucket");
          bucket.append(element("h3", "", bucketAccounts[0].classification.bucketLabel || "Accounts"));
          var accountList = element("div", "accounts");
          bucketAccounts.forEach(function (account) { accountList.append(accountCard(account)); });
          bucket.append(accountList);
          group.append(bucket);
        });
        groupsElement.append(group);
      });
    }

    function renderPortfolio(portfolio) {
      latestPortfolio = portfolio;
      renderRevision++;
      statusElement.textContent = "";
      renderTotals(Array.isArray(portfolio.totals) ? portfolio.totals : []);
      renderGroups(Array.isArray(portfolio.accounts) ? portfolio.accounts : []);
      generatedElement.textContent = portfolio.generatedAt
        ? "View assembled " + formatTimestamp(portfolio.generatedAt) + ". Brokerage sync times are shown per account."
        : "View assembly time unavailable. Brokerage sync times are shown per account.";
      if (portfolio.connectionRequired) {
        statusElement.textContent = "Connect Wealthsimple in the portfolio app before viewing accounts here.";
      } else if (portfolio.cache && portfolio.cache.stale) {
        statusElement.textContent = "The brokerage could not be reached. Showing data last read " +
          formatTimestamp(portfolio.cache.loadedAt) + "; it may be out of date.";
      } else if (Array.isArray(portfolio.errors) && portfolio.errors.length) {
        statusElement.textContent = "Some account data is temporarily unavailable; healthy accounts are shown.";
      }
      updateControls();
      scheduleSizeReport();
    }

    function acceptToolOutput(output) {
      var content = resultContent(output);
      if (!content || !Array.isArray(content.accounts) || !Array.isArray(content.totals)) {
        return false;
      }
      renderPortfolio(content);
      return true;
    }

    refreshButton.onclick = function () {
      if (refreshButton.disabled || !canCallTools()) return;
      refreshing = true;
      reloadAfter = Date.now() + RELOAD_INTERVAL_MS;
      reloadTimer = setTimeout(function () { reloadTimer = null; updateControls(); }, RELOAD_INTERVAL_MS);
      updateControls();
      statusElement.textContent = "Reloading portfolio data…";
      callTool("get_portfolio_snapshot", { refresh: true })
        .then(function (result) {
          if (!destroyed && !acceptToolOutput(result)) throw new Error("Invalid portfolio result.");
        })
        .catch(function () {
          if (!destroyed) statusElement.textContent = "Reload failed. Previous data remains displayed; check its brokerage sync times.";
        })
        .finally(function () { refreshing = false; updateControls(); });
    };

    function cleanUp() {
      if (destroyed) return;
      destroyed = true;
      pendingRequests.forEach(function (_pending, id) { settleRequest(id, true); });
      clearTimeout(reloadTimer);
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      latestPortfolio = null; totalsElement.replaceChildren(); groupsElement.replaceChildren(); generatedElement.textContent = "";
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", cleanUp);
      updateControls();
    }

    function onMessage(event) {
      if (event.source !== window.parent) return;
      var message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/resource-teardown" || message.method === "ping") {
        if (message.id !== undefined) window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
        if (message.method === "ui/resource-teardown") cleanUp();
        return;
      }
      if (!message.method && message.id !== undefined && ("result" in message || "error" in message)) {
        settleRequest(message.id, message.error, message.result);
        return;
      }
      if (message.method === "ui/notifications/host-context-changed") {
        applyHostContext(message.params);
        return;
      }
      if (message.method === "ui/notifications/tool-result") {
        try { acceptToolOutput(message.params); } catch (_error) {
          if (!destroyed) statusElement.textContent = "Portfolio data could not be loaded. Previous data, if any, remains displayed.";
        }
      }
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", cleanUp);

    function hydrateLegacyOutput() {
      if (destroyed || !window.openai || !window.openai.toolOutput) return;
      try { acceptToolOutput(window.openai.toolResponseMetadata ? { structuredContent: window.openai.toolOutput, _meta: window.openai.toolResponseMetadata } : window.openai.toolOutput); } catch (_error) {
        statusElement.textContent = "Portfolio data could not be loaded.";
      }
    }

    request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "vestlens", version: "4.0.0" },
      appCapabilities: { availableDisplayModes: ["inline"] }
    }).then(function (result) {
      if (destroyed) return;
      // Only stable methods are used, so any host-negotiated version is fine.
      var version = result && result.protocolVersion;
      if (typeof version !== "string" || !version) {
        throw new Error("Unsupported portfolio UI protocol.");
      }
      initialized = true;
      hostTools = !!(result.hostCapabilities && result.hostCapabilities.serverTools);
      applyHostContext(result.hostContext);
      window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      if (typeof ResizeObserver === "function" && rootElement) {
        resizeObserver = new ResizeObserver(reportSize);
        resizeObserver.observe(rootElement);
      }
      reportSize();
      updateControls();
    }).catch(function () {
      if (!destroyed && !latestPortfolio) statusElement.textContent = "Portfolio host initialization failed. Reopen the portfolio to try again.";
      updateControls();
    });

    hydrateLegacyOutput();
  }());</script>
</body>
</html>`;
}
