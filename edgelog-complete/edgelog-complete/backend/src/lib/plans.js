// ─────────────────────────────────────────────────────────────────
// EDGELOG — Plan enforcement (miroir du frontend)
// Toujours vérifier côté serveur, jamais faire confiance au client
// ─────────────────────────────────────────────────────────────────

const PLANS = {
  basic: {
    label:        "Basic",
    tradeLimit:   15,
    historyDays:  30,       // null = illimité
    psychTrial:   30,       // jours d'essai psychologie
    canCalendar:  false,
    canAnalyses:  false,
    canImport:    false,
    canAI:        false,
    maxAccounts:  2,
  },
  premium: {
    label:        "Premium",
    tradeLimit:   100,
    historyDays:  90,
    psychTrial:   0,
    canCalendar:  true,
    canAnalyses:  true,
    canImport:    false,
    canAI:        false,
    maxAccounts:  null,     // illimité
  },
  pro: {
    label:        "Premium Pro",
    tradeLimit:   null,     // illimité
    historyDays:  null,
    psychTrial:   0,
    canCalendar:  true,
    canAnalyses:  true,
    canImport:    true,
    canAI:        true,
    maxAccounts:  null,
  },
};

/**
 * Retourne les limites du plan de l'utilisateur
 */
function getPlanLimits(plan) {
  return PLANS[plan] || PLANS.basic;
}

/**
 * Vérifie si l'utilisateur peut ajouter un nouveau trade
 * @returns {object} { allowed: boolean, message?: string }
 */
async function checkTradeLimit(userId, prisma) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true },
  });

  const limits = getPlanLimits(user.plan);
  if (limits.tradeLimit === null) return { allowed: true };

  const count = await prisma.trade.count({ where: { userId } });
  if (count >= limits.tradeLimit) {
    return {
      allowed: false,
      message: `Limite de ${limits.tradeLimit} trades atteinte sur ${limits.label}. Passez au plan supérieur.`,
      code: "TRADE_LIMIT_REACHED",
    };
  }
  return { allowed: true };
}

/**
 * Applique le filtre d'historique selon le plan
 * Retourne un objet "where" Prisma pour filtrer les dates
 */
function getHistoryFilter(plan) {
  const limits = getPlanLimits(plan);
  if (!limits.historyDays) return {}; // pas de filtre

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - limits.historyDays);
  return { date: { gte: cutoff.toISOString().slice(0, 10) } };
}

/**
 * Vérifie si l'utilisateur peut accéder à une feature
 */
function canAccess(plan, feature) {
  const limits = getPlanLimits(plan);
  return limits[feature] === true || limits[feature] === null;
}

/**
 * Vérifie si l'essai psychologie est encore actif (Basic seulement)
 */
function isPsychTrialActive(user) {
  if (user.plan !== "basic") return true;
  if (!user.createdAt) return true;
  const daysSince = (Date.now() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24);
  return daysSince <= PLANS.basic.psychTrial;
}

module.exports = {
  PLANS,
  getPlanLimits,
  checkTradeLimit,
  getHistoryFilter,
  canAccess,
  isPsychTrialActive,
};
