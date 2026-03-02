// ─────────────────────────────────────────────────────────────────
// EDGELOG — Mock Setup Helper
// Fonctions réutilisables pour configurer les mocks Prisma
// selon des scénarios courants (user authentifié, trades existants…)
// ─────────────────────────────────────────────────────────────────
"use strict";

const { makeUser, makeAccount, makeTradeList } = require("./factories");

/**
 * Configure les mocks Prisma pour simuler un utilisateur connecté
 * avec des trades et un compte.
 *
 * @param {Object} prisma     - Le mock Prisma importé dans le test
 * @param {Object} [opts]     - Options de personnalisation
 */
function setupAuthenticatedUser(prisma, opts = {}) {
  const user    = opts.user    || makeUser({ plan: opts.plan || "basic" });
  const account = opts.account || makeAccount(user.id);
  const trades  = opts.trades  || makeTradeList(user.id, account.id, opts.tradeCount || 5);

  // Mock findUnique pour l'authentification JWT (middleware authenticate)
  prisma.user.findUnique.mockImplementation(({ where }) => {
    if (where.id === user.id) return Promise.resolve(user);
    if (where.email === user.email) return Promise.resolve(user);
    return Promise.resolve(null);
  });

  // Mock findFirst pour la validation de token/plan
  prisma.user.findFirst?.mockResolvedValue(user);

  // Mock des comptes
  prisma.account.findFirst.mockImplementation(({ where }) => {
    if (where?.userId === user.id) return Promise.resolve(account);
    return Promise.resolve(null);
  });
  prisma.account.findMany.mockResolvedValue([account]);

  // Mock des trades
  prisma.trade.findMany.mockResolvedValue(trades);
  prisma.trade.count.mockResolvedValue(trades.length);
  prisma.trade.findFirst.mockResolvedValue(trades[0] || null);

  return { user, account, trades };
}

/**
 * Configure Prisma pour simuler une réponse vide (aucune donnée)
 */
function setupEmptyDatabase(prisma) {
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.trade.findMany.mockResolvedValue([]);
  prisma.trade.count.mockResolvedValue(0);
  prisma.account.findMany.mockResolvedValue([]);
}

/**
 * Configure Prisma pour simuler une erreur de base de données
 */
function setupDatabaseError(prisma, method = "findMany") {
  const error = new Error("Connection timeout");
  error.code  = "P1001"; // Code d'erreur Prisma
  prisma.trade[method].mockRejectedValue(error);
  prisma.user[method]?.mockRejectedValue(error);
}

module.exports = {
  setupAuthenticatedUser,
  setupEmptyDatabase,
  setupDatabaseError,
};
