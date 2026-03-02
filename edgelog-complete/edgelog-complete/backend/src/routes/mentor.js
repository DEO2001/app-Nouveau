// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Mentor / Coach
// GET    /api/mentor/list           → mentors de l'utilisateur
// POST   /api/mentor/invite         → inviter un mentor
// DELETE /api/mentor/:id            → révoquer un mentor
// POST   /api/mentor/feedback       → ajouter un feedback (mentor)
// GET    /api/mentor/shared/:userId → journal public (lecture)
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const prisma  = require("../lib/prisma");
const { authenticate } = require("../middleware/errorHandler");

const router = express.Router();

// ── GET /mentor/list ──────────────────────────────────────────────
router.get("/list", authenticate, async (req, res, next) => {
  try {
    const relations = await prisma.mentorRelation.findMany({
      where: { studentId: req.user.id },
      include: {
        mentor: { select: { id: true, name: true, email: true, avatar: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ mentors: relations });
  } catch (err) {
    next(err);
  }
});

// ── POST /mentor/invite ────────────────────────────────────────────
router.post("/invite", authenticate, async (req, res, next) => {
  try {
    const { email, access } = req.body;
    if (!email) return res.status(400).json({ error: "Email requis." });

    const mentor = await prisma.user.findUnique({ where: { email } });
    if (!mentor) return res.status(404).json({ error: "Aucun utilisateur EDGELOG avec cet email." });
    if (mentor.id === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas vous inviter vous-même." });

    const existing = await prisma.mentorRelation.findFirst({
      where: { mentorId: mentor.id, studentId: req.user.id },
    });
    if (existing) return res.status(409).json({ error: "Ce mentor a déjà accès à votre journal." });

    const relation = await prisma.mentorRelation.create({
      data: {
        mentorId:  mentor.id,
        studentId: req.user.id,
        access:    access || "read",
      },
      include: {
        mentor: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });

    res.status(201).json({ relation });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /mentor/:id ────────────────────────────────────────────
router.delete("/:id", authenticate, async (req, res, next) => {
  try {
    const relation = await prisma.mentorRelation.findFirst({
      where: { id: req.params.id, studentId: req.user.id },
    });
    if (!relation) return res.status(404).json({ error: "Relation introuvable." });

    await prisma.mentorRelation.delete({ where: { id: req.params.id } });
    res.json({ message: "Accès mentor révoqué." });
  } catch (err) {
    next(err);
  }
});

// ── GET /mentor/feedback ───────────────────────────────────────────
// Récupère les feedbacks reçus par l'utilisateur connecté
router.get("/feedback", authenticate, async (req, res, next) => {
  try {
    const feedbacks = await prisma.feedback.findMany({
      where: {
        trade: { userId: req.user.id },
      },
      include: {
        author: { select: { id: true, name: true, avatar: true } },
        trade:  { select: { asset: true, date: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json({
      feedbacks: feedbacks.map(fb => ({
        id:         fb.id,
        comment:    fb.content,
        mentorName: fb.author.name,
        mentorAvatar: fb.author.avatar,
        tradeAsset: fb.trade?.asset,
        tradeDate:  fb.trade?.date,
        createdAt:  fb.createdAt,
        color:      "#38bdf8", // couleur par défaut
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /mentor/feedback ──────────────────────────────────────────
// Réservé aux mentors invités
router.post("/feedback", authenticate, async (req, res, next) => {
  try {
    const { tradeId, content } = req.body;
    if (!tradeId || !content) return res.status(400).json({ error: "tradeId et content requis." });

    // Vérifie que l'auteur est bien mentor du propriétaire du trade
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade) return res.status(404).json({ error: "Trade introuvable." });

    const relation = await prisma.mentorRelation.findFirst({
      where: { mentorId: req.user.id, studentId: trade.userId },
    });
    if (!relation) return res.status(403).json({ error: "Vous n'êtes pas mentor de ce trader." });

    const feedback = await prisma.feedback.create({
      data: { tradeId, authorId: req.user.id, content },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });

    res.status(201).json({ feedback });
  } catch (err) {
    next(err);
  }
});

// ── GET /mentor/shared/:userId ─────────────────────────────────────
// Journal public — accessible sans auth si le partage est activé
router.get("/shared/:userId", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, name: true, avatar: true, createdAt: true },
    });
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

    const trades = await prisma.trade.findMany({
      where:   { userId: req.params.userId, status: "CLOSED" },
      orderBy: { date: "desc" },
      take:    50,
      select: {
        id: true, asset: true, direction: true, date: true,
        pnl: true, rMultiple: true, setup: true, tags: true,
      },
    });

    const totalPnl  = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins      = trades.filter(t => t.pnl > 0).length;
    const winRate   = trades.length ? ((wins / trades.length) * 100).toFixed(1) : 0;

    res.json({
      trader: user,
      stats:  { totalPnl, winRate, tradeCount: trades.length },
      trades,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
