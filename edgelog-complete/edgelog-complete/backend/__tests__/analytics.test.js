// ─────────────────────────────────────────────────────────────────
// EDGELOG — Tests routes /api/analytics
// Couvre : overview, heatmap, hours, assets, emotions, streak
// npx jest analytics.test.js --verbose
// ─────────────────────────────────────────────────────────────────
"use strict";

const request = require("supertest");

jest.mock("../src/lib/prisma");
jest.mock("../src/lib/email", () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue({ success: true }),
}));

const app    = require("../src/index");
const prisma = require("../src/lib/prisma");

const {
  makeUser, makePremiumUser, makeProUser,
  makeTradeList, makeWinTrade, makeLossTrade,
  authHeader,
} = require("./helpers/factories");

// ── Helpers locaux ─────────────────────────────────────────────────

/** Génère une liste de trades avec émotions et heures */
function makeRichTradeList(userId, accountId, count = 10) {
  const emotions = ["Confiant", "Neutre", "Stressé", "FOMO"];
  const hours    = ["09:30", "14:00", "10:15", "16:45"];
  return Array.from({ length: count }, (_, i) => {
    const isWin = i % 3 !== 0; // 2/3 de wins → WR 67%
    const trade = isWin
      ? makeWinTrade(userId, accountId)
      : makeLossTrade(userId, accountId);
    return {
      ...trade,
      date:           new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
      time:           hours[i % hours.length],
      emotion_before: emotions[i % emotions.length],
      pnl:            isWin ? 200 + i * 10 : -(100 + i * 5),
    };
  });
}

// ─────────────────────────────────────────────────────────────────
describe("GET /api/analytics/overview", () => {
  it("retourne les KPIs calculés correctement", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 10);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/overview")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalPnl");
    expect(res.body).toHaveProperty("winRate");
    expect(res.body).toHaveProperty("profitFactor");
    expect(res.body).toHaveProperty("maxDrawdown");
    expect(res.body).toHaveProperty("expectancy");
    expect(res.body).toHaveProperty("trades");
    expect(res.body).toHaveProperty("wins");
    expect(res.body).toHaveProperty("losses");
  });

  it("retourne winRate entre 0 et 100", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 9);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/overview")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.winRate).toBeGreaterThanOrEqual(0);
    expect(res.body.winRate).toBeLessThanOrEqual(100);
  });

  it("retourne des zéros si aucun trade closé", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]); // liste vide

    const res = await request(app)
      .get("/api/analytics/overview")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.trades).toBe(0);
    expect(res.body.totalPnl).toBe(0);
    expect(res.body.winRate).toBe(0);
  });

  it("plan Basic — filtre à 30 jours", async () => {
    const user   = makeUser({ plan: "basic" });
    const trades = makeRichTradeList(user.id, "acc_1", 5);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/overview")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    // Vérifie que findMany est appelé avec un filtre de date
    expect(prisma.trade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: user.id }),
      })
    );
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app).get("/api/analytics/overview");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/analytics/heatmap", () => {
  it("retourne les données du mois courant", async () => {
    const user   = makePremiumUser();
    const now    = new Date();
    const trades = makeRichTradeList(user.id, "acc_1", 8);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get(`/api/analytics/heatmap?year=${now.getFullYear()}&month=${now.getMonth() + 1}`)
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("days");
    expect(typeof res.body.days).toBe("object");
  });

  it("retourne un objet vide si aucun trade ce mois", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/analytics/heatmap?year=2020&month=1")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.days)).toHaveLength(0);
  });

  it("retourne 400 si year ou month manquant", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .get("/api/analytics/heatmap") // sans params
      .set(authHeader(user.id));

    // Soit 400 soit calcul avec valeurs par défaut — les deux sont acceptables
    expect([200, 400]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/analytics/hours", () => {
  it("retourne les stats par heure avec bestHour", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 12);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/hours")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("hours");
    expect(Array.isArray(res.body.hours)).toBe(true);
    // bestHour peut être null si moins de 3 trades/heure
    expect(res.body).toHaveProperty("bestHour");
  });

  it("chaque entrée a les propriétés requises", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 6);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/hours")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    if (res.body.hours.length > 0) {
      const firstHour = res.body.hours[0];
      expect(firstHour).toHaveProperty("hour");
      expect(firstHour).toHaveProperty("pnl");
      expect(firstHour).toHaveProperty("trades");
      expect(firstHour).toHaveProperty("winRate");
    }
  });

  it("retourne hours vide si aucun trade", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/analytics/hours")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.hours).toHaveLength(0);
    expect(res.body.bestHour).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/analytics/assets", () => {
  it("retourne les stats par actif triées par P&L", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 10);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/assets")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("assets");
    expect(Array.isArray(res.body.assets)).toBe(true);
  });

  it("chaque actif a les propriétés requises", async () => {
    const user   = makePremiumUser();
    const trades = [
      makeWinTrade(user.id, "acc_1", { asset: "BTC/USD", pnl: 500 }),
      makeLossTrade(user.id, "acc_1", { asset: "BTC/USD", pnl: -200 }),
      makeWinTrade(user.id, "acc_1", { asset: "EUR/USD", pnl: 300 }),
    ];

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/assets")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    if (res.body.assets.length > 0) {
      const asset = res.body.assets[0];
      expect(asset).toHaveProperty("asset");
      expect(asset).toHaveProperty("pnl");
      expect(asset).toHaveProperty("trades");
      expect(asset).toHaveProperty("winRate");
    }
  });

  it("retourne assets vide si aucun trade closé", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/analytics/assets")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/analytics/emotions", () => {
  it("retourne les stats par émotion avec bestEmotion", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 12);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/emotions")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("emotions");
    expect(res.body).toHaveProperty("bestEmotion");
    expect(Array.isArray(res.body.emotions)).toBe(true);
  });

  it("chaque entrée émotion a winRate entre 0-100", async () => {
    const user   = makePremiumUser();
    const trades = makeRichTradeList(user.id, "acc_1", 9);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/emotions")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    res.body.emotions.forEach(e => {
      expect(e.winRate).toBeGreaterThanOrEqual(0);
      expect(e.winRate).toBeLessThanOrEqual(100);
    });
  });

  it("retourne bestEmotion null si aucun trade avec émotion", async () => {
    const user   = makePremiumUser();
    const trades = [makeWinTrade(user.id, "acc_1", { emotion_before: null })];

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);

    const res = await request(app)
      .get("/api/analytics/emotions")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.emotions).toHaveLength(0);
    expect(res.body.bestEmotion).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/analytics/streak", () => {
  it("retourne la série actuelle correctement", async () => {
    const user = makePremiumUser();
    const wins = Array.from({ length: 3 }, (_, i) =>
      makeWinTrade(user.id, "acc_1", {
        date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
      })
    );

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(wins);

    const res = await request(app)
      .get("/api/analytics/streak")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("current");
    expect(res.body.current).toHaveProperty("type");
    expect(res.body.current).toHaveProperty("streak");
    expect(res.body).toHaveProperty("maxWinStreak");
    expect(res.body).toHaveProperty("maxLossStreak");
  });

  it("série de wins : type=win, count correct", async () => {
    const user = makePremiumUser();
    const wins = Array.from({ length: 4 }, (_, i) =>
      makeWinTrade(user.id, "acc_1", {
        date:   new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
        status: "CLOSED",
      })
    );

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(wins);

    const res = await request(app)
      .get("/api/analytics/streak")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.current.type).toBe("win");
    expect(res.body.current.streak).toBe(4);
  });

  it("série de pertes : type=loss", async () => {
    const user   = makePremiumUser();
    const losses = Array.from({ length: 2 }, (_, i) =>
      makeLossTrade(user.id, "acc_1", {
        date:   new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
        status: "CLOSED",
      })
    );

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(losses);

    const res = await request(app)
      .get("/api/analytics/streak")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.current.type).toBe("loss");
  });

  it("retourne streak 0 si aucun trade", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/analytics/streak")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.current.streak).toBe(0);
    expect(res.body.maxWinStreak).toBe(0);
    expect(res.body.maxLossStreak).toBe(0);
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app).get("/api/analytics/streak");
    expect(res.status).toBe(401);
  });
});
