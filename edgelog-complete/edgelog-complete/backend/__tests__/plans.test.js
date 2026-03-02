// ─────────────────────────────────────────────────────────────────
// EDGELOG — Tests Plans & Limites
// npx jest plans.test.js
// ─────────────────────────────────────────────────────────────────
const {
  PLANS,
  getPlanLimits,
  getHistoryFilter,
  canAccess,
  isPsychTrialActive,
} = require("../src/lib/plans");

describe("PLANS — constantes", () => {
  it("Basic a une limite de 15 trades", () => {
    expect(PLANS.basic.tradeLimit).toBe(15);
  });
  it("Premium a une limite de 100 trades", () => {
    expect(PLANS.premium.tradeLimit).toBe(100);
  });
  it("Pro a une limite null (illimitée)", () => {
    expect(PLANS.pro.tradeLimit).toBeNull();
  });
  it("Basic a 30 jours d'historique", () => {
    expect(PLANS.basic.historyDays).toBe(30);
  });
  it("Pro a null jours d'historique (illimité)", () => {
    expect(PLANS.pro.historyDays).toBeNull();
  });
});

describe("getPlanLimits", () => {
  it("retourne les limites basic pour un plan inconnu", () => {
    const limits = getPlanLimits("unknown");
    expect(limits.tradeLimit).toBe(15);
  });
  it("retourne les limites pro correctes", () => {
    const limits = getPlanLimits("pro");
    expect(limits.canAI).toBe(true);
    expect(limits.canImport).toBe(true);
  });
});

describe("getHistoryFilter", () => {
  it("retourne un filtre de date pour Basic (30j)", () => {
    const filter = getHistoryFilter("basic");
    expect(filter).toHaveProperty("date");
    expect(filter.date.gte).toBeDefined();
    const cutoff = new Date(filter.date.gte);
    const daysAgo = Math.round((Date.now() - cutoff) / (24 * 60 * 60 * 1000));
    expect(daysAgo).toBeCloseTo(30, 0);
  });
  it("retourne un filtre de 90j pour Premium", () => {
    const filter = getHistoryFilter("premium");
    const cutoff = new Date(filter.date.gte);
    const daysAgo = Math.round((Date.now() - cutoff) / (24 * 60 * 60 * 1000));
    expect(daysAgo).toBeCloseTo(90, 0);
  });
  it("retourne {} pour Pro (pas de filtre)", () => {
    const filter = getHistoryFilter("pro");
    expect(filter).toEqual({});
  });
});

describe("canAccess", () => {
  it("Basic ne peut pas accéder à l'IA", () => {
    expect(canAccess("basic", "canAI")).toBe(false);
  });
  it("Basic ne peut pas importer", () => {
    expect(canAccess("basic", "canImport")).toBe(false);
  });
  it("Premium peut accéder au calendrier", () => {
    expect(canAccess("premium", "canCalendar")).toBe(true);
  });
  it("Pro peut accéder à l'IA", () => {
    expect(canAccess("pro", "canAI")).toBe(true);
  });
});

describe("isPsychTrialActive", () => {
  it("retourne true pour un user Premium", () => {
    const user = { plan: "premium", createdAt: new Date() };
    expect(isPsychTrialActive(user)).toBe(true);
  });
  it("retourne true pour un user Basic créé il y a 10 jours", () => {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const user = { plan: "basic", createdAt: d };
    expect(isPsychTrialActive(user)).toBe(true);
  });
  it("retourne false pour un user Basic créé il y a 35 jours", () => {
    const d = new Date();
    d.setDate(d.getDate() - 35);
    const user = { plan: "basic", createdAt: d };
    expect(isPsychTrialActive(user)).toBe(false);
  });
  it("retourne true si createdAt est null (mode démo)", () => {
    const user = { plan: "basic", createdAt: null };
    expect(isPsychTrialActive(user)).toBe(true);
  });
});

describe("checkTradeLimit (mock)", () => {
  it("devrait être défini comme fonction", () => {
    const { checkTradeLimit } = require("../src/lib/plans");
    expect(typeof checkTradeLimit).toBe("function");
  });
});
