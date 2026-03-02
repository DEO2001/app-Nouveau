// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes User
// GET  /api/user/profile     → profil complet
// PUT  /api/user/profile     → modifier nom / avatar
// GET  /api/user/plan        → infos plan + usage
// DELETE /api/user           → supprimer le compte
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const bcrypt  = require("bcryptjs");
const prisma  = require("../lib/prisma");
const { authenticate }                    = require("../middleware/errorHandler");
const { getPlanLimits, isPsychTrialActive } = require("../lib/plans");

const router = express.Router();
router.use(authenticate);

// ── GET /user/profile ─────────────────────────────────────────────
router.get("/profile", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, name: true, avatar: true,
        plan: true, createdAt: true, stripeStatus: true,
        trialEndsAt: true, currentPeriodEnd: true,
      },
    });
    const tradeCount = await prisma.trade.count({ where: { userId: req.user.id } });
    const limits     = getPlanLimits(user.plan);
    const inTrial    = isPsychTrialActive(user);

    res.json({
      user: {
        ...user,
        tradeCount,
        tradeLimit:      limits.tradeLimit,
        inPsychTrial:    inTrial,
        psychTrialDays:  limits.psychTrial,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── PUT /user/profile ─────────────────────────────────────────────
router.put("/profile", async (req, res, next) => {
  try {
    const { name, avatar, currentPassword, newPassword } = req.body;
    const updateData = {};

    if (name)   updateData.name   = name.trim();
    if (avatar) updateData.avatar = avatar;

    // Changement de mot de passe
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Mot de passe actuel requis." });
      }
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const valid = await bcrypt.compare(currentPassword, user.passwordHash || "");
      if (!valid) {
        return res.status(401).json({ error: "Mot de passe actuel incorrect." });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: "Nouveau mot de passe min. 8 caractères." });
      }
      updateData.passwordHash = await bcrypt.hash(newPassword, 12);
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data:  updateData,
      select: { id: true, email: true, name: true, avatar: true, plan: true },
    });

    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

// ── GET /user/plan ─────────────────────────────────────────────────
router.get("/plan", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        plan: true, stripeStatus: true, stripePriceId: true,
        trialEndsAt: true, currentPeriodEnd: true,
      },
    });

    const tradeCount    = await prisma.trade.count({ where: { userId: req.user.id } });
    const accountCount  = await prisma.account.count({ where: { userId: req.user.id } });
    const limits        = getPlanLimits(user.plan);

    res.json({
      plan:            user.plan,
      limits,
      usage: {
        trades:   { current: tradeCount,   max: limits.tradeLimit },
        accounts: { current: accountCount, max: limits.maxAccounts },
      },
      subscription: {
        status:          user.stripeStatus,
        trialEndsAt:     user.trialEndsAt,
        currentPeriodEnd: user.currentPeriodEnd,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /user ───────────────────────────────────────────────────
router.delete("/", async (req, res, next) => {
  try {
    const { password } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (user.passwordHash) {
      if (!password) return res.status(400).json({ error: "Mot de passe requis pour supprimer le compte." });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: "Mot de passe incorrect." });
    }

    // Cascade : supprime tous les trades, comptes, tokens via Prisma cascade
    await prisma.user.delete({ where: { id: req.user.id } });

    res.json({ message: "Compte supprimé. À bientôt !" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
