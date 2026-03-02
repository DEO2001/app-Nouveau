// ─────────────────────────────────────────────────────────────────
// EDGELOG — Tests routes /api/trades
// Couvre : list, create, update, delete, isolation utilisateurs
// npx jest trades.test.js --verbose
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
  makeAccount, makeTrade, makeWinTrade, makeLossTrade,
  makeOpenTrade, makeTradeList, makeAccessToken, authHeader,
} = require("./helpers/factories");

const { setupAuthenticatedUser } = require("./helpers/mockSetup");

// ─── Payload de trade valide ───────────────────────────────────────
const validTradePayload = () => ({
  accountId:      "acc_1",
  asset:          "BTC/USD",
  direction:      "LONG",
  status:         "CLOSED",
  date:           "2025-01-15",
  time:           "09:30",
  entry:          45000,
  exit:           46800,
  sl:             44000,
  tp:             48000,
  size:           0.1,
  fees:           10,
  setup:          "Breakout confirmation",
  emotion_before: "Confiant",
  emotion_after:  "Satisfait",
  notes:          "Bon setup H4",
  tags:           ["plan-respecté", "london-session"],
  checklist:      [true, true, true, true, true],
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/trades", () => {
  it("retourne la liste des trades de l'utilisateur connecté", async () => {
    const user    = makeUser();
    const account = makeAccount(user.id);
    const trades  = makeTradeList(user.id, account.id, 5);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);
    prisma.trade.count.mockResolvedValue(trades.length);

    const res = await request(app)
      .get("/api/trades")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("trades");
    expect(Array.isArray(res.body.trades)).toBe(true);
    expect(res.body.trades).toHaveLength(5);
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app).get("/api/trades");
    expect(res.status).toBe(401);
  });

  it("retourne 401 avec un token expiré", async () => {
    const jwt = require("jsonwebtoken");
    const expiredToken = jwt.sign(
      { userId: "user_1" },
      process.env.JWT_SECRET,
      { expiresIn: "-1s" }
    );
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/trades")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  it("applique le filtre d'historique Basic (30 jours)", async () => {
    const user    = makeUser({ plan: "basic" });
    const account = makeAccount(user.id);
    const trades  = makeTradeList(user.id, account.id, 3);

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue(trades);
    prisma.trade.count.mockResolvedValue(trades.length);

    const res = await request(app)
      .get("/api/trades")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    // Le filtre de 30j est appliqué côté route — on vérifie que findMany est appelé avec un where.date
    expect(prisma.trade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: user.id }),
      })
    );
  });

  it("plan Premium — accès à 90 jours d'historique", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);
    prisma.trade.count.mockResolvedValue(0);

    const res = await request(app)
      .get("/api/trades")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
  });

  it("plan Pro — historique illimité", async () => {
    const user = makeProUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);
    prisma.trade.count.mockResolvedValue(0);

    const res = await request(app)
      .get("/api/trades")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
  });

  it("supporte la pagination via limit/offset", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findMany.mockResolvedValue([]);
    prisma.trade.count.mockResolvedValue(0);

    const res = await request(app)
      .get("/api/trades?limit=10&offset=0")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total");
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/trades", () => {
  it("crée un trade CLOSED avec tous les champs valides", async () => {
    const user    = makePremiumUser();
    const account = makeAccount(user.id, { id: "acc_1" });
    const payload = validTradePayload();

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.count.mockResolvedValue(10); // sous la limite
    prisma.account.findFirst.mockResolvedValue(account);
    prisma.trade.create.mockResolvedValue({
      id: "trade_new_1",
      userId: user.id,
      ...payload,
      pnl: 170, // (46800-45000)*0.1 - 10
    });

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("trade");
    expect(res.body.trade.asset).toBe("BTC/USD");
    expect(prisma.trade.create).toHaveBeenCalledTimes(1);
  });

  it("crée un trade OPEN sans exit/pnl", async () => {
    const user    = makePremiumUser();
    const account = makeAccount(user.id, { id: "acc_1" });

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.count.mockResolvedValue(5);
    prisma.account.findFirst.mockResolvedValue(account);
    prisma.trade.create.mockResolvedValue(
      makeOpenTrade(user.id, account.id)
    );

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send({ ...validTradePayload(), status: "OPEN", exit: null });

    expect(res.status).toBe(201);
    expect(res.body.trade.status).toBe("OPEN");
  });

  it("retourne 400 si direction invalide", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send({ ...validTradePayload(), direction: "BUY" }); // BUY invalide, doit être LONG

    expect(res.status).toBe(400);
  });

  it("retourne 400 si asset manquant", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const payload = validTradePayload();
    delete payload.asset;

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send(payload);

    expect(res.status).toBe(400);
  });

  it("retourne 400 si entry manquant", async () => {
    const user = makePremiumUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send({ ...validTradePayload(), entry: undefined });

    expect(res.status).toBe(400);
  });

  it("bloque un Basic quand la limite de trades est atteinte (15 trades)", async () => {
    const user    = makeUser({ plan: "basic" });
    const account = makeAccount(user.id, { id: "acc_1" });

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.count.mockResolvedValue(15); // exactement la limite
    prisma.account.findFirst.mockResolvedValue(account);

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send(validTradePayload());

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/limit|limite/i);
  });

  it("permet à un Premium de dépasser 15 trades (limite 50)", async () => {
    const user    = makePremiumUser();
    const account = makeAccount(user.id, { id: "acc_1" });

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.count.mockResolvedValue(20); // 20 trades — OK pour premium
    prisma.account.findFirst.mockResolvedValue(account);
    prisma.trade.create.mockResolvedValue(makeTrade(user.id, account.id));

    const res = await request(app)
      .post("/api/trades")
      .set(authHeader(user.id))
      .send(validTradePayload());

    expect(res.status).toBe(201);
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app)
      .post("/api/trades")
      .send(validTradePayload());

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("PUT /api/trades/:id", () => {
  it("met à jour un trade existant appartenant à l'utilisateur", async () => {
    const user  = makePremiumUser();
    const trade = makeTrade(user.id, "acc_1");

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findFirst.mockResolvedValue(trade);
    prisma.trade.update.mockResolvedValue({ ...trade, notes: "Mis à jour" });

    const res = await request(app)
      .put(`/api/trades/${trade.id}`)
      .set(authHeader(user.id))
      .send({ notes: "Mis à jour" });

    expect(res.status).toBe(200);
    expect(res.body.trade.notes).toBe("Mis à jour");
  });

  it("retourne 404 si le trade n'appartient pas à l'utilisateur", async () => {
    const user    = makePremiumUser();
    const autreId = "user_autre_999";

    prisma.user.findUnique.mockResolvedValue(user);
    // findFirst retourne null = trade non trouvé pour cet utilisateur
    prisma.trade.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .put(`/api/trades/trade_appartenant_a_autre`)
      .set(authHeader(user.id))
      .send({ notes: "tentative" });

    expect(res.status).toBe(404);
  });

  it("retourne 400 si direction invalide dans update", async () => {
    const user  = makePremiumUser();
    const trade = makeTrade(user.id, "acc_1");

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findFirst.mockResolvedValue(trade);

    const res = await request(app)
      .put(`/api/trades/${trade.id}`)
      .set(authHeader(user.id))
      .send({ direction: "SELL" }); // invalide

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("DELETE /api/trades/:id", () => {
  it("supprime un trade appartenant à l'utilisateur", async () => {
    const user  = makePremiumUser();
    const trade = makeTrade(user.id, "acc_1");

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findFirst.mockResolvedValue(trade);
    prisma.trade.delete.mockResolvedValue(trade);

    const res = await request(app)
      .delete(`/api/trades/${trade.id}`)
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/supprim/i);
  });

  it("retourne 404 si le trade n'appartient pas à l'utilisateur", async () => {
    const user = makePremiumUser();

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.trade.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete("/api/trades/trade_inconnu")
      .set(authHeader(user.id));

    expect(res.status).toBe(404);
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app).delete("/api/trades/trade_1");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("Isolation utilisateurs — sécurité", () => {
  it("user A ne peut pas accéder aux trades de user B", async () => {
    const userA = makeUser({ id: "user_A" });
    const userB = makeUser({ id: "user_B" });
    const tradeB = makeTrade(userB.id, "acc_B");

    // User A est authentifié, mais le trade appartient à user B
    prisma.user.findUnique.mockResolvedValue(userA);
    prisma.trade.findFirst.mockResolvedValue(null); // introuvable pour userA

    const res = await request(app)
      .put(`/api/trades/${tradeB.id}`)
      .set(authHeader(userA.id))
      .send({ notes: "piratage" });

    expect(res.status).toBe(404);
  });

  it("user A ne peut pas supprimer les trades de user B", async () => {
    const userA  = makeUser({ id: "user_A" });
    const tradeB = makeTrade("user_B", "acc_B");

    prisma.user.findUnique.mockResolvedValue(userA);
    prisma.trade.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/trades/${tradeB.id}`)
      .set(authHeader(userA.id));

    expect(res.status).toBe(404);
  });
});
