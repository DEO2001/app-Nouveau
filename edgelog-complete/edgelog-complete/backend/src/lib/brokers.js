// ─────────────────────────────────────────────────────────────────
// EDGELOG — Intégrations Broker
// Support : Binance, MT5 (via API tiers), cTrader, FTMO
//
// Architecture : chaque broker a un adapter avec la même interface :
//   fetchTrades(credentials, since?) → Trade[]
//   normalizeTradeFromBroker(raw)    → Trade standard EDGELOG
// ─────────────────────────────────────────────────────────────────

// ── BINANCE ADAPTER ───────────────────────────────────────────────
const BinanceAdapter = {
  name: "Binance",
  slug: "binance",

  /**
   * Récupère l'historique des trades Binance
   * @param {Object} creds - { apiKey, apiSecret }
   * @param {Date}   since - Date depuis laquelle récupérer
   */
  async fetchTrades(creds, since = null) {
    const BINANCE_API = "https://api.binance.com";
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
    const allTrades = [];

    for (const symbol of symbols) {
      try {
        const params = new URLSearchParams({
          symbol,
          limit: "500",
          ...(since && { startTime: since.getTime().toString() }),
        });

        // Signature HMAC-SHA256 requise pour Binance
        const timestamp = Date.now().toString();
        params.append("timestamp", timestamp);

        const crypto = require("crypto");
        const signature = crypto
          .createHmac("sha256", creds.apiSecret)
          .update(params.toString())
          .digest("hex");
        params.append("signature", signature);

        const res = await fetch(`${BINANCE_API}/api/v3/myTrades?${params}`, {
          headers: { "X-MBX-APIKEY": creds.apiKey },
        });

        if (!res.ok) continue;
        const trades = await res.json();
        allTrades.push(...trades.map(t => this.normalizeTrade(t, symbol)));
      } catch { /* ignore symbol errors */ }
    }

    return allTrades;
  },

  normalizeTrade(raw, symbol) {
    const pnl = parseFloat(raw.isBuyer ? 0 : raw.realizedPnl || 0);
    return {
      asset:     symbol.replace("USDT", "/USDT"),
      direction: raw.isBuyer ? "LONG" : "SHORT",
      status:    "CLOSED",
      date:      new Date(raw.time).toISOString().slice(0, 10),
      time:      new Date(raw.time).toISOString().slice(11, 16),
      entry:     parseFloat(raw.price),
      size:      parseFloat(raw.qty),
      pnl,
      tags:      ["binance", "import-auto"],
      importSource: "binance",
      externalId:   String(raw.id),
    };
  },
};

// ── MT5 ADAPTER (via mt5-http ou DXtrade API) ─────────────────────
const MT5Adapter = {
  name: "MetaTrader 5",
  slug: "mt5",

  /**
   * MT5 n'a pas d'API REST native.
   * Options : 1) Expert Advisor + webhook local, 2) DXtrade API, 3) MyFXBook API
   * Ici on supporte MyFXBook comme intermédiaire
   */
  async fetchTrades(creds, since = null) {
    const { session } = creds;

    // Via MyFXBook API (gratuit, supporte MT4/MT5)
    const sinceParam = since ? `&start=${since.toISOString().slice(0,10)}` : "";
    const url = `https://www.myfxbook.com/api/get-history.json?session=${session}${sinceParam}`;

    try {
      const res  = await fetch(url);
      const data = await res.json();
      if (data.error || !data.history?.trades) return [];
      return data.history.trades.map(t => this.normalizeTrade(t));
    } catch {
      return [];
    }
  },

  normalizeTrade(raw) {
    return {
      asset:     raw.symbol?.replace("_", "/") || raw.symbol,
      direction: raw.action === "Buy" ? "LONG" : "SHORT",
      status:    "CLOSED",
      date:      raw.openTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      entry:     parseFloat(raw.openPrice) || null,
      exit:      parseFloat(raw.closePrice) || null,
      pnl:       parseFloat(raw.profit) || null,
      size:      parseFloat(raw.lots) || null,
      tags:      ["mt5", "myfxbook", "import-auto"],
      importSource: "mt5",
      externalId:   String(raw.id),
    };
  },
};

// ── CTRADER ADAPTER (Open API) ────────────────────────────────────
const CTraderAdapter = {
  name: "cTrader",
  slug: "ctrader",

  /**
   * cTrader Open API — nécessite OAuth 2.0
   * Doc : https://connect.ctrader.com/
   */
  async fetchTrades(creds, since = null) {
    const { accessToken, accountId } = creds;
    const from = since ? since.getTime() : Date.now() - 30 * 24 * 60 * 60 * 1000;

    try {
      const res = await fetch(
        `https://live.ctraderapi.com/v2/webserv/traders/${accountId}/deals?from=${from}&to=${Date.now()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data.deal || []).map(d => this.normalizeTrade(d));
    } catch {
      return [];
    }
  },

  normalizeTrade(raw) {
    const pnl = (raw.closePositionDetail?.grossProfit || 0) / 100; // cTrader retourne en centimes
    return {
      asset:     raw.symbolName || "UNKNOWN",
      direction: raw.tradeSide === "BUY" ? "LONG" : "SHORT",
      status:    "CLOSED",
      date:      new Date(raw.executionTimestamp).toISOString().slice(0, 10),
      entry:     raw.openPrice / 100000, // cTrader retourne prix * 100000
      exit:      raw.closePrice / 100000,
      pnl,
      size:      (raw.volume || 0) / 100000,
      tags:      ["ctrader", "import-auto"],
      importSource: "ctrader",
      externalId:   String(raw.dealId),
    };
  },
};

// ── FTMO ADAPTER (scraping via export CSV) ────────────────────────
// FTMO ne fournit pas d'API publique → utiliser export CSV manuel
// L'adapter parse le CSV exporté depuis le tableau de bord FTMO
const FTMOAdapter = {
  name: "FTMO",
  slug: "ftmo",

  // Colonnes du CSV FTMO standard
  COLUMN_MAP: {
    date:      "Open Time",
    asset:     "Symbol",
    side:      "Type",
    entry:     "Open Price",
    exit:      "Close Price",
    size:      "Lots",
    pnl:       "Profit",
  },

  parseCsvRow(row) {
    return {
      asset:     row["Symbol"] || "UNKNOWN",
      direction: (row["Type"] || "").toLowerCase().includes("buy") ? "LONG" : "SHORT",
      status:    "CLOSED",
      date:      (row["Close Time"] || row["Open Time"] || "").slice(0, 10),
      entry:     parseFloat(row["Open Price"])  || null,
      exit:      parseFloat(row["Close Price"]) || null,
      pnl:       parseFloat(row["Profit"])       || null,
      size:      parseFloat(row["Lots"])         || null,
      tags:      ["ftmo", "prop-firm", "import-auto"],
      importSource: "ftmo",
    };
  },
};

// ── BROKER REGISTRY ───────────────────────────────────────────────
const BROKERS = {
  binance: BinanceAdapter,
  mt5:     MT5Adapter,
  ctrader: CTraderAdapter,
  ftmo:    FTMOAdapter,
};

// Brokers supportant la connexion API directe (pas juste CSV)
const API_BROKERS = ["binance", "mt5", "ctrader"];

module.exports = { BROKERS, API_BROKERS, BinanceAdapter, MT5Adapter, CTraderAdapter, FTMOAdapter };
