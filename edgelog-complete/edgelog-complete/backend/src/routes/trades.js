// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Trades
// GET    /api/trades            → liste (avec filtre historique plan)
// POST   /api/trades            → créer (vérifie limite plan)
// GET    /api/trades/:id        → détail
// PUT    /api/trades/:id        → modifier
// DELETE /api/trades/:id        → supprimer
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const { body, query, validationResult } = require("express-validator");
const prisma  = require("../lib/prisma");
const { authenticate }          = require("../middleware/errorHandler");
const { checkTradeLimit, getHistoryFilter } = require("../lib/plans");

const router = express.Router();
router.use(authenticate);

// ── GET /trades ───────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { accountId, status, asset, tag, from, to, limit, offset } = req.query;

    // Filtre historique selon le plan
    const histFilter = getHistoryFilter(req.user.plan);

    const where = {
      userId: req.user.id,
      ...histFilter,
      ...(accountId && { accountId }),
      ...(status    && { status }),
      ...(asset     && { asset }),
      ...(tag       && { tags: { has: tag } }),
      ...(from      && { date: { gte: from, ...(histFilter.date?.gte && { gte: histFilter.date.gte }) } }),
      ...(to        && { date: { ...where?.date, lte: to } }),
    };

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take:  parseInt(limit)  || 200,
        skip:  parseInt(offset) || 0,
      }),
      prisma.trade.count({ where }),
    ]);

    res.json({ trades, total });
  } catch (err) {
    next(err);
  }
});

// ── POST /trades ──────────────────────────────────────────────────
router.post(
  "/",
  [
    body("asset").notEmpty().withMessage("Actif requis."),
    body("direction").isIn(["LONG", "SHORT"]).withMessage("Direction invalide."),
    body("date").isDate().withMessage("Date invalide."),
    body("accountId").notEmpty().withMessage("Compte requis."),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Vérifie la limite de trades du plan
      const limit = await checkTradeLimit(req.user.id, prisma);
      if (!limit.allowed) {
        return res.status(403).json({ error: limit.message, code: limit.code });
      }

      // Vérifie que le compte appartient à l'utilisateur
      const account = await prisma.account.findFirst({
        where: { id: req.body.accountId, userId: req.user.id },
      });
      if (!account) {
        return res.status(404).json({ error: "Compte introuvable." });
      }

      const {
        asset, direction, status, date, time,
        entry, exit, size, pnl, rMultiple,
        stopLoss, takeProfit, mfe, mae,
        setup, emotion_before, emotion_after,
        notes, tags, checklistDone, intraday,
        accountId,
      } = req.body;

      const trade = await prisma.trade.create({
        data: {
          userId: req.user.id,
          accountId,
          asset,
          direction,
          status:         status || "OPEN",
          date,
          time,
          entry:          entry     ? parseFloat(entry)     : null,
          exit:           exit      ? parseFloat(exit)      : null,
          size:           size      ? parseFloat(size)      : null,
          pnl:            pnl       ? parseFloat(pnl)       : null,
          rMultiple:      rMultiple ? parseFloat(rMultiple) : null,
          stopLoss:       stopLoss  ? parseFloat(stopLoss)  : null,
          takeProfit:     takeProfit? parseFloat(takeProfit): null,
          mfe:            mfe       ? parseFloat(mfe)       : null,
          mae:            mae       ? parseFloat(mae)       : null,
          setup,
          emotion_before,
          emotion_after,
          notes,
          tags:           Array.isArray(tags) ? tags : [],
          checklistDone:  Array.isArray(checklistDone) ? checklistDone : [],
          intraday:       intraday || null,
        },
      });

      res.status(201).json({ trade });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /trades/:id ───────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const trade = await prisma.trade.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        feedbacks: {
          include: { author: { select: { id: true, name: true, avatar: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!trade) return res.status(404).json({ error: "Trade introuvable." });
    res.json({ trade });
  } catch (err) {
    next(err);
  }
});

// ── PUT /trades/:id ───────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    // Vérifie que le trade appartient à l'utilisateur
    const existing = await prisma.trade.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Trade introuvable." });

    const {
      asset, direction, status, date, time,
      entry, exit, size, pnl, rMultiple,
      stopLoss, takeProfit, mfe, mae,
      setup, emotion_before, emotion_after,
      notes, tags, checklistDone, intraday,
    } = req.body;

    const trade = await prisma.trade.update({
      where: { id: req.params.id },
      data: {
        ...(asset          && { asset }),
        ...(direction      && { direction }),
        ...(status         && { status }),
        ...(date           && { date }),
        ...(time           !== undefined && { time }),
        ...(entry          !== undefined && { entry:      entry      ? parseFloat(entry)      : null }),
        ...(exit           !== undefined && { exit:       exit       ? parseFloat(exit)       : null }),
        ...(size           !== undefined && { size:       size       ? parseFloat(size)       : null }),
        ...(pnl            !== undefined && { pnl:        pnl        ? parseFloat(pnl)        : null }),
        ...(rMultiple      !== undefined && { rMultiple:  rMultiple  ? parseFloat(rMultiple)  : null }),
        ...(stopLoss       !== undefined && { stopLoss:   stopLoss   ? parseFloat(stopLoss)   : null }),
        ...(takeProfit     !== undefined && { takeProfit: takeProfit ? parseFloat(takeProfit) : null }),
        ...(mfe            !== undefined && { mfe:        mfe        ? parseFloat(mfe)        : null }),
        ...(mae            !== undefined && { mae:        mae        ? parseFloat(mae)        : null }),
        ...(setup          !== undefined && { setup }),
        ...(emotion_before !== undefined && { emotion_before }),
        ...(emotion_after  !== undefined && { emotion_after }),
        ...(notes          !== undefined && { notes }),
        ...(tags           !== undefined && { tags: Array.isArray(tags) ? tags : [] }),
        ...(checklistDone  !== undefined && { checklistDone: Array.isArray(checklistDone) ? checklistDone : [] }),
        ...(intraday       !== undefined && { intraday }),
      },
    });

    res.json({ trade });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /trades/:id ────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.trade.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Trade introuvable." });

    await prisma.trade.delete({ where: { id: req.params.id } });
    res.json({ message: "Trade supprimé." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
