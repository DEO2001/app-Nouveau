// ─────────────────────────────────────────────────────────────────
// EDGELOG — Setup variables d'environnement pour les tests
// Exécuté avant CHAQUE fichier de test (setupFiles)
// ─────────────────────────────────────────────────────────────────
"use strict";

const path = require("path");

// Charge .env.test s'il existe, sinon applique les valeurs par défaut
try {
  require("dotenv").config({ path: path.resolve(__dirname, "../../.env.test") });
} catch {}

// Variables d'environnement garanties pour les tests
// Ces valeurs n'ont pas besoin d'être réelles — elles sont mockées
process.env.NODE_ENV            = "test";
process.env.PORT                = "4001"; // Port différent pour ne pas conflictuer
process.env.DATABASE_URL        = "postgresql://test:test@localhost:5432/edgelog_test";
process.env.JWT_SECRET          = "test-jwt-secret-super-long-pour-les-tests-unitaires-jest-2024";
process.env.JWT_REFRESH_SECRET  = "test-refresh-secret-super-long-pour-les-tests-jest-2024";
process.env.FRONTEND_URL        = "http://localhost:5173";

// Stripe (clés de test Stripe — format valide mais non fonctionnelles sans mock)
process.env.STRIPE_SECRET_KEY             = "sk_test_fake_key_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET         = "whsec_test_fake_webhook_secret";
process.env.STRIPE_PRICE_PREMIUM_MONTHLY  = "price_test_premium_monthly";
process.env.STRIPE_PRICE_PREMIUM_ANNUAL   = "price_test_premium_annual";
process.env.STRIPE_PRICE_PRO_MONTHLY      = "price_test_pro_monthly";
process.env.STRIPE_PRICE_PRO_ANNUAL       = "price_test_pro_annual";

// Email (Resend — mockté, valeur fictive)
process.env.RESEND_API_KEY = "re_test_fake_key";
process.env.EMAIL_FROM     = "EDGELOG Test <noreply@test.edgelog.app>";

// Google OAuth (désactivé en test)
// Intentionnellement non défini → setupGoogleOAuth() ne s'initialise pas
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

// Broker cipher key (32 bytes hex = 64 chars)
process.env.BROKER_CIPHER_KEY = "0".repeat(64);

// Désactiver les logs Morgan en test
process.env.LOG_LEVEL = "silent";
