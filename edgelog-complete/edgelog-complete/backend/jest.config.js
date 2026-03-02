// ─────────────────────────────────────────────────────────────────
// EDGELOG — Configuration Jest (v2 — corrigée)
// Corrections :
//   - coverageThreshold (singulier) — l'ancienne typo était ignorée
//   - setupFilesAfterEnv branché sur perTest.setup.js
//   - moduleNameMapper pour Prisma
//   - Timeout augmenté à 15s
// ─────────────────────────────────────────────────────────────────
"use strict";

module.exports = {
  // ── Environnement ──────────────────────────────────────────────
  testEnvironment: "node",

  // ── Fichiers de setup ──────────────────────────────────────────
  globalSetup:        "./__tests__/setup/global.setup.js",
  setupFiles:         ["./__tests__/setup/env.setup.js"],
  setupFilesAfterEnv: ["./__tests__/setup/perTest.setup.js"],
  globalTeardown:     "./__tests__/setup/global.teardown.js",

  // ── Découverte des tests ───────────────────────────────────────
  testMatch: [
    "**/__tests__/**/*.test.js",
    "**/__tests__/**/*.spec.js",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/setup/",
    "/__tests__/helpers/",
    "/__tests__/fixtures/",
    "/__tests__/integration/",
  ],

  // ── Mocks ─────────────────────────────────────────────────────
  automock:     false,
  clearMocks:   true,
  resetMocks:   true,
  restoreMocks: true,

  // Redirige les imports vers __mocks__/prisma.js
  moduleNameMapper: {
    "^../src/lib/prisma$":    "<rootDir>/__mocks__/prisma.js",
    "^../../src/lib/prisma$": "<rootDir>/__mocks__/prisma.js",
  },

  // ── Timeouts ──────────────────────────────────────────────────
  testTimeout: 15000,

  // ── Coverage ──────────────────────────────────────────────────
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/index.js",
    "!src/lib/prisma.js",
    "!src/lib/cron.js",
    "!src/lib/brokers.js",
    "!src/lib/oauth.js",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "html"],

  // CORRECTION : "coverageThreshold" (singulier)
  // L'ancienne typo "coverageThresholds" était silencieusement ignorée
  coverageThreshold: {
    global: {
      branches:   70,
      functions:  75,
      lines:      75,
      statements: 75,
    },
  },

  // ── Affichage ─────────────────────────────────────────────────
  verbose:           true,
  forceExit:         true,
  detectOpenHandles: false,
  transform: {},
};
