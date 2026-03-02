// ─────────────────────────────────────────────────────────────────
// EDGELOG — Setup par fichier de test (setupFilesAfterEnv)
// Exécuté après le chargement de Jest, avant chaque fichier de test.
//
// Responsabilités :
//   1. Reset complet du mock Prisma entre chaque test
//   2. Mock global de Stripe et Resend (services externes)
//   3. Helpers globaux disponibles sans import (expect.extend)
//   4. Silencer les logs console pendant les tests
// ─────────────────────────────────────────────────────────────────
"use strict";

// ── 1. Silencer console.log/warn en test (garde les erreurs visibles) ──
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  // On garde console.error pour détecter les vraies erreurs
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ── 2. Mock global Stripe ─────────────────────────────────────────
// Empêche tout appel réseau réel vers l'API Stripe
jest.mock("stripe", () => {
  const stripeMock = {
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id:  "cs_test_mock_session",
          url: "https://checkout.stripe.com/test/mock",
        }),
      },
    },
    billingPortal: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          url: "https://billing.stripe.com/test/mock",
        }),
      },
    },
    subscriptions: {
      cancel: jest.fn().mockResolvedValue({
        id:     "sub_test_mock",
        status: "canceled",
      }),
      retrieve: jest.fn().mockResolvedValue({
        id:     "sub_test_mock",
        status: "active",
        items:  { data: [{ price: { id: "price_test_premium_monthly" } }] },
      }),
    },
    customers: {
      create: jest.fn().mockResolvedValue({ id: "cus_test_mock" }),
      retrieve: jest.fn().mockResolvedValue({ id: "cus_test_mock", email: "test@test.com" }),
    },
    // webhooks.constructEvent est utilisé pour valider la signature Stripe
    webhooks: {
      constructEvent: jest.fn((body, sig, secret) => {
        // Retourne l'objet body parsé tel quel (bypass de la signature)
        if (typeof body === "string") return JSON.parse(body);
        if (Buffer.isBuffer(body)) return JSON.parse(body.toString());
        return body;
      }),
    },
  };
  // Le module stripe exporte une fonction constructeur
  return jest.fn(() => stripeMock);
});

// ── 3. Mock global Resend ─────────────────────────────────────────
// Empêche l'envoi d'emails réels pendant les tests
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ id: "email_test_mock_id", error: null }),
    },
  })),
}));

// ── 4. Mock global node-cron ──────────────────────────────────────
// Empêche les cron jobs de démarrer pendant les tests
jest.mock("node-cron", () => ({
  schedule: jest.fn(() => ({
    start: jest.fn(),
    stop:  jest.fn(),
    destroy: jest.fn(),
  })),
  validate: jest.fn().mockReturnValue(true),
}));

// ── 5. Extensions expect personnalisées ───────────────────────────
expect.extend({
  // Vérifie qu'une réponse supertest a le bon status + body.error
  toBeApiError(received, expectedStatus, msgFragment) {
    const statusOk = received.status === expectedStatus;
    const msgOk    = msgFragment
      ? received.body?.error?.includes(msgFragment) || received.body?.message?.includes(msgFragment)
      : true;

    if (statusOk && msgOk) {
      return { pass: true, message: () => `Expected response NOT to be an API error ${expectedStatus}` };
    }
    return {
      pass: false,
      message: () =>
        `Expected API error ${expectedStatus}${msgFragment ? ` with message matching "${msgFragment}"` : ""}\n` +
        `Received status: ${received.status}\n` +
        `Received body: ${JSON.stringify(received.body)}`,
    };
  },

  // Vérifie qu'une réponse contient des tokens JWT
  toHaveTokens(received) {
    const hasAccess  = typeof received.body?.accessToken  === "string";
    const hasRefresh = typeof received.body?.refreshToken === "string";
    if (hasAccess && hasRefresh) {
      return { pass: true, message: () => "Expected response NOT to have tokens" };
    }
    return {
      pass: false,
      message: () =>
        `Expected response to have accessToken and refreshToken\n` +
        `accessToken:  ${received.body?.accessToken}\n` +
        `refreshToken: ${received.body?.refreshToken}`,
    };
  },
});
