const { verifyAccessToken } = require("../lib/jwt");
const prisma = require("../lib/prisma");

/**
 * Middleware : vérifie le JWT dans le header Authorization
 * Injecte req.user avec les données de l'utilisateur
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token manquant ou invalide." });
    }

    const token = authHeader.split(" ")[1];
    const payload = verifyAccessToken(token);

    // Récupère l'utilisateur depuis la DB (vérifie qu'il existe encore)
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        avatar: true,
        stripeStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: "Utilisateur introuvable." });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expiré.", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Token invalide." });
  }
}

/**
 * Middleware : vérifie que l'utilisateur a un plan >= requis
 * Usage : requirePlan("premium") ou requirePlan("pro")
 */
function requirePlan(minPlan) {
  const hierarchy = { basic: 0, premium: 1, pro: 2 };
  return (req, res, next) => {
    const userLevel = hierarchy[req.user.plan] ?? 0;
    const required  = hierarchy[minPlan] ?? 0;
    if (userLevel < required) {
      return res.status(403).json({
        error: `Cette fonctionnalité nécessite le plan ${minPlan}.`,
        code: "PLAN_REQUIRED",
        required: minPlan,
        current: req.user.plan,
      });
    }
    next();
  };
}

/**
 * Middleware : error handler global
 */
function errorHandler(err, req, res, next) {
  console.error("[ERROR]", err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || "Erreur serveur interne.",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}

module.exports = { authenticate, requirePlan, errorHandler };
