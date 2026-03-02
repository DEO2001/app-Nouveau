// ─────────────────────────────────────────────────────────────────
// EDGELOG — Global Teardown (exécuté UNE FOIS après tous les tests)
// ─────────────────────────────────────────────────────────────────
"use strict";

module.exports = async function globalTeardown() {
  console.log("\n✅ EDGELOG Test Suite — Terminé\n");
  // Rien à nettoyer (pas de vraie DB en tests unitaires)
  // En tests d'intégration : await prisma.$disconnect(); dropTestDb(); etc.
};
