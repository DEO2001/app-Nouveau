// ─────────────────────────────────────────────────────────────────
// EDGELOG — Fixtures de test
// Données statiques réutilisables : payloads Stripe, CSV, etc.
// ─────────────────────────────────────────────────────────────────
"use strict";

// ── Payloads Stripe Webhook ────────────────────────────────────────

const stripeFixtures = {
  // Paiement réussi → activer/upgrader l'abonnement
  checkoutCompleted: (customerId, subscriptionId, priceId) => ({
    id:   "evt_test_checkout_completed",
    type: "checkout.session.completed",
    data: {
      object: {
        id:              "cs_test_checkout_session",
        customer:        customerId || "cus_test_123",
        subscription:    subscriptionId || "sub_test_123",
        payment_status:  "paid",
        metadata: {
          userId: "user_test_123",
          plan:   priceId?.includes("pro") ? "pro" : "premium",
          billing: "monthly",
        },
      },
    },
  }),

  // Abonnement supprimé → downgrade vers basic
  subscriptionDeleted: (customerId, subscriptionId) => ({
    id:   "evt_test_subscription_deleted",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id:       subscriptionId || "sub_test_123",
        customer: customerId || "cus_test_123",
        status:   "canceled",
      },
    },
  }),

  // Paiement échoué → notifier l'utilisateur
  invoicePaymentFailed: (customerId, subscriptionId) => ({
    id:   "evt_test_invoice_payment_failed",
    type: "invoice.payment_failed",
    data: {
      object: {
        subscription: subscriptionId || "sub_test_123",
        customer:     customerId || "cus_test_123",
        attempt_count: 1,
        amount_due:    999,
        currency:      "eur",
      },
    },
  }),

  // Abonnement mis à jour (changement de plan)
  subscriptionUpdated: (customerId, subscriptionId, newPriceId) => ({
    id:   "evt_test_subscription_updated",
    type: "customer.subscription.updated",
    data: {
      object: {
        id:       subscriptionId || "sub_test_123",
        customer: customerId || "cus_test_123",
        status:   "active",
        items: {
          data: [{
            price: { id: newPriceId || "price_test_premium_monthly" }
          }]
        },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  }),
};

// ── CSV Import Fixtures ────────────────────────────────────────────

const csvFixtures = {
  // CSV Binance standard
  binanceValid: `Date,Pair,Type,Amount,Price,Total,Fee
2024-01-15,BTC/USDT,BUY,0.1,43500,4350,5
2024-01-16,BTC/USDT,SELL,0.1,44200,4420,5
2024-01-17,ETH/USDT,BUY,1,2500,2500,3
2024-01-18,ETH/USDT,SELL,1,2600,2600,3`,

  // CSV générique EDGELOG
  edgelogFormat: `date,asset,direction,entry,exit,sl,tp,size,pnl,setup,emotion_before,tags
2024-01-15,BTC/USD,LONG,43500,44200,42000,46000,0.1,65,Breakout,Calme,plan-respecté
2024-01-16,EUR/USD,SHORT,1.0900,1.0850,1.0950,1.0800,10000,450,Résistance,Neutre,plan-respecté
2024-01-17,NAS100,LONG,17500,,17000,18000,0.5,,Pullback,Confiant,`,

  // CSV avec erreurs
  csvWithErrors: `date,asset
2024-01-15
invalid_line
,`,

  // CSV vide
  csvEmpty: `date,asset,direction`,
};

// ── Trade data valide pour POST /api/trades ───────────────────────

const tradePayloads = {
  valid: {
    asset:          "BTC/USD",
    direction:      "LONG",
    status:         "CLOSED",
    date:           "2024-01-15",
    time:           "09:30",
    entry:          43500,
    exit:           44200,
    sl:             42000,
    tp:             46000,
    size:           0.1,
    fees:           5,
    pnl:            65,
    setup:          "Breakout",
    emotion_before: "Calme",
    emotion_after:  "Satisfait",
    notes:          "Bon setup.",
    tags:           ["plan-respecté"],
    checklist:      [true, true, true, true, true],
  },

  openTrade: {
    asset:     "ETH/USD",
    direction: "SHORT",
    status:    "OPEN",
    date:      "2024-01-16",
    time:      "14:00",
    entry:     2500,
    sl:        2600,
    tp:        2300,
    size:      1,
    setup:     "Résistance",
  },

  missingFields: {
    asset: "BTC/USD",
    // direction, status, date manquants → doit échouer
  },

  invalidDirection: {
    asset:     "BTC/USD",
    direction: "BUY",    // ← Intentionnellement invalide (LONG/SHORT attendus)
    status:    "CLOSED",
    date:      "2024-01-15",
    entry:     43500,
    size:      0.1,
    // Ce payload DOIT retourner 422 — le commentaire le précise explicitement
  },
};

// ── Auth payloads ─────────────────────────────────────────────────

const authPayloads = {
  registerValid: {
    email:    "nouveau@trader.com",
    password: "SecurePass123!",
    name:     "Nouveau Trader",
  },
  registerWeakPassword: {
    email:    "test@test.com",
    password: "abc",  // Trop court
    name:     "Test",
  },
  registerInvalidEmail: {
    email:    "pas-un-email",
    password: "SecurePass123!",
    name:     "Test",
  },
  loginValid: {
    email:    "trader@test.com",
    password: "Password123!",
  },
  loginWrongPassword: {
    email:    "trader@test.com",
    password: "wrong_password",
  },
};

module.exports = {
  stripeFixtures,
  csvFixtures,
  tradePayloads,
  authPayloads,
};
