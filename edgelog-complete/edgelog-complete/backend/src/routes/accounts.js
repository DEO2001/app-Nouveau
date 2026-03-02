// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Accounts
// GET    /api/accounts
// POST   /api/accounts
// PUT    /api/accounts/:id
// DELETE /api/accounts/:id
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const { body, validationResult } = require("express-validator");
const prisma  = require("../lib/prisma");
const { authenticate } = require("../middleware/errorHandler");
const { getPlanLimits } = require("../lib/plans");

const router = express.Router();
router.use(authenticate);

// ── GET /accounts ─────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const accounts = await prisma.account.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { trades: true } },
      },
    });
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

// ── POST /accounts ────────────────────────────────────────────────
router.post(
  "/",
  [
    body("name").trim().notEmpty().withMessage("Nom requis."),
    body("type").isIn(["Reel","Demo","PropFirm"]).withMessage("Type invalide."),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      // Vérifie la limite de comptes selon le plan
      const limits = getPlanLimits(req.user.plan);
      if (limits.maxAccounts !== null) {
        const count = await prisma.account.count({ where: { userId: req.user.id } });
        if (count >= limits.maxAccounts) {
          return res.status(403).json({
            error: `Limite de ${limits.maxAccounts} comptes atteinte sur ${limits.label}.`,
            code: "ACCOUNT_LIMIT_REACHED",
          });
        }
      }

      const { name, type, balance, currency, broker } = req.body;
      const account = await prisma.account.create({
        data: {
          userId:   req.user.id,
          name,
          type,
          balance:  parseFloat(balance) || 10000,
          currency: currency || "$",
          broker:   broker || null,
        },
      });
      res.status(201).json({ account });
    } catch (err) {
      next(err);
    }
  }
);

// ── PUT /accounts/:id ─────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.account.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Compte introuvable." });

    const { name, type, balance, currency, broker } = req.body;
    const account = await prisma.account.update({
      where: { id: req.params.id },
      data: {
        ...(name     && { name }),
        ...(type     && { type }),
        ...(balance  !== undefined && { balance: parseFloat(balance) }),
        ...(currency && { currency }),
        ...(broker   !== undefined && { broker }),
      },
    });
    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /accounts/:id ──────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.account.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Compte introuvable." });

    // Impossible de supprimer le seul compte
    const count = await prisma.account.count({ where: { userId: req.user.id } });
    if (count <= 1) {
      return res.status(400).json({ error: "Impossible de supprimer le seul compte." });
    }

    await prisma.account.delete({ where: { id: req.params.id } });
    res.json({ message: "Compte supprimé." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
