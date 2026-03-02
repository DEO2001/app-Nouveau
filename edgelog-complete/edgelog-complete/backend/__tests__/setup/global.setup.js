// ─────────────────────────────────────────────────────────────────
// EDGELOG — Global Setup (exécuté UNE FOIS avant tous les tests)
// ─────────────────────────────────────────────────────────────────
"use strict";

module.exports = async function globalSetup() {
  console.log("\n🧪 EDGELOG Test Suite — Démarrage\n");

  // Définir les variables d'env minimales avant tout import
  process.env.NODE_ENV           = "test";
  process.env.JWT_SECRET         = "test-jwt-secret-super-long-pour-les-tests-unitaires-jest-2024";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret-super-long-pour-les-tests-jest-2024";
  process.env.STRIPE_SECRET_KEY  = "sk_test_fake_key_for_unit_tests";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake_webhook_secret";

  // Note : la connexion à la DB n'est PAS établie ici car Prisma est entièrement mocké.
  // Si on voulait des tests d'intégration avec une vraie DB, on ferait :
  //   await runMigrations();
  //   await seedTestDatabase();
};
