// ─────────────────────────────────────────────────────────────────
// EDGELOG — Tests routes /api/stripe
// Couvre : checkout, billing portal, cancel, webhooks
// npx jest stripe.test.js --verbose
// ─────────────────────────────────────────────────────────────────
"use strict";

const request = require("supertest");

jest.mock("../src/lib/prisma");
jest.mock("../src/lib/email", () => ({
  sendWelcomeEmail:              jest.fn().mockResolvedValue({ success: true }),
  sendSubscriptionConfirmEmail:  jest.fn().mockResolvedValue({ success: true }),
  sendPaymentFailedEmail:        jest.fn().mockResolvedValue({ success: true }),
  sendCancellationEmail:         jest.fn().mockResolvedValue({ success: true }),
}));

const app    = require("../src/index");
const prisma = require("../src/lib/prisma");

const {
  makeUser, makePremiumUser, makeProUser, authHeader,
} = require("./helpers/factories");
const { stripeFixtures } = require("./fixtures");

// Helper pour construire un webhook request
function webhookRequest(payload) {
  return request(app)
    .post("/api/stripe/webhook")
    .set("stripe-signature", "t=fake,v1=fake_sig") // stripeFixtures mock bypass
    .set("Content-Type", "application/json")
    .send(JSON.stringify(payload));
}

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/checkout", () => {
  it("crée une session checkout Premium Monthly", async () => {
    const user = makeUser({ stripeCustomerId: "cus_test_123" });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/checkout")
      .set(authHeader(user.id))
      .send({ plan: "premium", billing: "monthly" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
    expect(res.body.url).toContain("stripe.com");
  });

  it("crée une session checkout Premium Annual", async () => {
    const user = makeUser({ stripeCustomerId: "cus_test_123" });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/checkout")
      .set(authHeader(user.id))
      .send({ plan: "premium", billing: "annual" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
  });

  it("crée une session checkout Pro Monthly", async () => {
    const user = makeUser({ stripeCustomerId: "cus_test_456" });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/checkout")
      .set(authHeader(user.id))
      .send({ plan: "pro", billing: "monthly" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
  });

  it("retourne 400 si plan invalide", async () => {
    const user = makeUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/checkout")
      .set(authHeader(user.id))
      .send({ plan: "ultra_vip", billing: "monthly" }); // plan inexistant

    expect(res.status).toBe(400);
  });

  it("retourne 400 si billing manquant", async () => {
    const user = makeUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/checkout")
      .set(authHeader(user.id))
      .send({ plan: "premium" }); // pas de billing

    expect(res.status).toBe(400);
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app)
      .post("/api/stripe/checkout")
      .send({ plan: "premium", billing: "monthly" });

    expect(res.status).toBe(401);
  });

  it("ne permet pas à un Basic de souscrire à basic", async () => {
    const user = makeUser({ plan: "basic" });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/checkout")
      .set(authHeader(user.id))
      .send({ plan: "basic", billing: "monthly" }); // downgrade invalide

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/portal", () => {
  it("retourne l'URL du portail billing pour un Premium", async () => {
    const user = makePremiumUser({
      stripeCustomerId:     "cus_premium_123",
      stripeSubscriptionId: "sub_premium_123",
    });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/portal")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
    expect(res.body.url).toContain("stripe.com");
  });

  it("retourne 403 si l'utilisateur est Basic (pas d'abonnement actif)", async () => {
    const user = makeUser({ plan: "basic", stripeCustomerId: null });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/portal")
      .set(authHeader(user.id));

    expect(res.status).toBe(403);
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app).post("/api/stripe/portal");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/cancel", () => {
  it("annule l'abonnement d'un Premium", async () => {
    const user = makePremiumUser({
      stripeSubscriptionId: "sub_to_cancel",
      stripeCustomerId:     "cus_test_123",
    });
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, plan: "basic", stripeStatus: "canceled" });

    const res = await request(app)
      .post("/api/stripe/cancel")
      .set(authHeader(user.id));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/annul/i);
  });

  it("retourne 403 si pas d'abonnement actif", async () => {
    const user = makeUser({ plan: "basic", stripeSubscriptionId: null });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/stripe/cancel")
      .set(authHeader(user.id));

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/webhook — checkout.session.completed", () => {
  it("upgade l'utilisateur vers Premium après paiement réussi", async () => {
    const user    = makeUser({ id: "user_test_123", stripeCustomerId: "cus_test_123" });
    const payload = stripeFixtures.checkoutCompleted(
      "cus_test_123",
      "sub_new_123",
      "price_test_premium_monthly"
    );

    // Le webhook récupère l'utilisateur via stripeCustomerId
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({
      ...user,
      plan:                 "premium",
      stripeSubscriptionId: "sub_new_123",
      stripeStatus:         "active",
    });
    prisma.subscription.upsert.mockResolvedValue({ id: "sub_db_1" });

    const res = await webhookRequest(payload);

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("upgade vers Pro si priceId contient 'pro'", async () => {
    const user    = makeUser({ id: "user_test_123", stripeCustomerId: "cus_pro_test" });
    const payload = stripeFixtures.checkoutCompleted(
      "cus_pro_test",
      "sub_pro_123",
      "price_test_pro_monthly"
    );

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, plan: "pro" });
    prisma.subscription.upsert.mockResolvedValue({ id: "sub_db_2" });

    const res = await webhookRequest(payload);

    expect(res.status).toBe(200);
    // Vérifie que update a été appelé avec plan: "pro"
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ plan: "pro" }),
      })
    );
  });

  it("retourne 200 même si l'utilisateur est introuvable (idempotence)", async () => {
    const payload = stripeFixtures.checkoutCompleted("cus_inconnu", "sub_123");

    prisma.user.findUnique.mockResolvedValue(null);

    const res = await webhookRequest(payload);

    // Le webhook doit retourner 200 (Stripe retry sinon)
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/webhook — customer.subscription.deleted", () => {
  it("downgrade l'utilisateur vers Basic à la suppression d'abonnement", async () => {
    const user = makePremiumUser({
      stripeCustomerId:     "cus_downgrade_test",
      stripeSubscriptionId: "sub_to_delete",
    });
    const payload = stripeFixtures.subscriptionDeleted(
      "cus_downgrade_test",
      "sub_to_delete"
    );

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, plan: "basic", stripeStatus: "canceled" });

    const res = await webhookRequest(payload);

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ plan: "basic" }),
      })
    );
  });

  it("retourne 200 même si utilisateur introuvable (idempotence)", async () => {
    const payload = stripeFixtures.subscriptionDeleted("cus_inconnu", "sub_inconnu");
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await webhookRequest(payload);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/webhook — invoice.payment_failed", () => {
  it("envoie un email de paiement échoué", async () => {
    const email = require("../src/lib/email");
    const user  = makePremiumUser({ stripeCustomerId: "cus_failed_pay" });
    const payload = stripeFixtures.invoicePaymentFailed("cus_failed_pay", "sub_123");

    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue(user);

    const res = await webhookRequest(payload);

    expect(res.status).toBe(200);
    // L'email de paiement échoué doit être envoyé
    expect(email.sendPaymentFailedEmail).toHaveBeenCalled();
  });

  it("ne plante pas si utilisateur introuvable", async () => {
    const payload = stripeFixtures.invoicePaymentFailed("cus_ghost");
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await webhookRequest(payload);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/stripe/webhook — événements inconnus", () => {
  it("retourne 200 pour un événement non géré (idempotence Stripe)", async () => {
    const payload = {
      id:   "evt_unknown",
      type: "payment_intent.created", // non géré par EDGELOG
      data: { object: {} },
    };

    const res = await webhookRequest(payload);
    expect(res.status).toBe(200);
  });
});
