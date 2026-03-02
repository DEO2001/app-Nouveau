// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Analytics
// GET /api/analytics/overview    → KPIs globaux
// GET /api/analytics/heatmap     → P&L par jour (calendrier)
// GET /api/analytics/hours       → Meilleure heure de trading
// GET /api/analytics/assets      → Stats par actif
// GET /api/analytics/emotions    → Corrélation émotion / P&L
// GET /api/analytics/streak      → Série actuelle wins/losses
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const prisma  = require("../lib/prisma");
const { authenticate }       = require("../middleware/errorHandler");
const { getHistoryFilter }   = require("../lib/plans");

const router = express.Router();
router.use(authenticate);

// ── GET /analytics/overview ───────────────────────────────────────
router.get("/overview", async (req, res, next) => {
  try {
    const { accountId } = req.query;
    const histFilter = getHistoryFilter(req.user.plan);

    const where = {
      userId: req.user.id,
      status: "CLOSED",
      ...histFilter,
      ...(accountId && { accountId }),
    };

    const trades = await prisma.trade.findMany({
      where,
      select: { pnl: true, rMultiple: true, date: true, asset: true, direction: true, emotion_before: true },
      orderBy: { date: "asc" },
    });

    if (trades.length === 0) return res.json({ trades: 0, message: "Aucun trade clôturé." });

    const pnls     = trades.map(t => t.pnl || 0);
    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const wins     = pnls.filter(p => p > 0);
    const losses   = pnls.filter(p => p < 0);
    const winRate  = ((wins.length / trades.length) * 100).toFixed(1);

    // Profit Factor
    const grossProfit = wins.reduce((s, p) => s + p, 0);
    const grossLoss   = Math.abs(losses.reduce((s, p) => s + p, 0));
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";

    // Drawdown max
    let peak = 0, balance = 0, maxDrawdown = 0;
    for (const pnl of pnls) {
      balance += pnl;
      if (balance > peak) peak = balance;
      const dd = peak - balance;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // R moyen
    const rTrades = trades.filter(t => t.rMultiple !== null);
    const avgR    = rTrades.length
      ? (rTrades.reduce((s, t) => s + t.rMultiple, 0) / rTrades.length).toFixed(2)
      : null;

    // Expectancy = (WR × AvgWin) - (LR × AvgLoss)
    const avgWin  = wins.length   ? wins.reduce((s,p)=>s+p,0)   / wins.length   : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,p)=>s+p,0)) / losses.length : 0;
    const lossRate    = losses.length / trades.length;
    const expectancy  = ((wins.length / trades.length) * avgWin - lossRate * avgLoss).toFixed(2);

    // Best / Worst day
    const byDay = {};
    trades.forEach(t => {
      byDay[t.date] = (byDay[t.date] || 0) + (t.pnl || 0);
    });
    const dayEntries = Object.entries(byDay);
    const bestDay    = dayEntries.reduce((b, d) => d[1] > b[1] ? d : b, ["", -Infinity]);
    const worstDay   = dayEntries.reduce((w, d) => d[1] < w[1] ? d : w, ["", Infinity]);

    res.json({
      trades:      trades.length,
      wins:        wins.length,
      losses:      losses.length,
      winRate:     parseFloat(winRate),
      totalPnl,
      grossProfit,
      grossLoss,
      profitFactor,
      maxDrawdown,
      avgR:        avgR ? parseFloat(avgR) : null,
      expectancy:  parseFloat(expectancy),
      avgWin:      Math.round(avgWin * 100) / 100,
      avgLoss:     Math.round(avgLoss * 100) / 100,
      bestDay:     { date: bestDay[0], pnl: Math.round(bestDay[1] * 100) / 100 },
      worstDay:    { date: worstDay[0], pnl: Math.round(worstDay[1] * 100) / 100 },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /analytics/heatmap ────────────────────────────────────────
router.get("/heatmap", async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year)  || new Date().getFullYear();
    const m = parseInt(month) || new Date().getMonth() + 1;

    const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
    const endDate   = `${y}-${String(m).padStart(2, "0")}-31`;

    const trades = await prisma.trade.findMany({
      where: { userId: req.user.id, status: "CLOSED", date: { gte: startDate, lte: endDate } },
      select: { date: true, pnl: true },
    });

    // Agrège par jour
    const days = {};
    trades.forEach(t => {
      if (!days[t.date]) days[t.date] = { pnl: 0, trades: 0 };
      days[t.date].pnl    += t.pnl || 0;
      days[t.date].trades += 1;
    });

    res.json({ year: y, month: m, days });
  } catch (err) {
    next(err);
  }
});

// ── GET /analytics/hours ──────────────────────────────────────────
router.get("/hours", async (req, res, next) => {
  try {
    const trades = await prisma.trade.findMany({
      where: { userId: req.user.id, status: "CLOSED", time: { not: null } },
      select: { time: true, pnl: true },
    });

    // Agrège par heure
    const hours = {};
    for (let h = 0; h < 24; h++) hours[h] = { pnl: 0, trades: 0, wins: 0 };

    trades.forEach(t => {
      const h = parseInt((t.time || "00:00").split(":")[0]);
      if (!hours[h]) return;
      hours[h].pnl    += t.pnl || 0;
      hours[h].trades += 1;
      if (t.pnl > 0) hours[h].wins++;
    });

    const result = Object.entries(hours).map(([hour, data]) => ({
      hour:     parseInt(hour),
      ...data,
      winRate:  data.trades > 0 ? Math.round((data.wins / data.trades) * 100) : 0,
    }));

    const bestHour = result.reduce((b, h) => h.trades > 2 && h.pnl > b.pnl ? h : b, { pnl: -Infinity, hour: 0 });

    res.json({ hours: result, bestHour: bestHour.hour });
  } catch (err) {
    next(err);
  }
});

// ── GET /analytics/assets ─────────────────────────────────────────
router.get("/assets", async (req, res, next) => {
  try {
    const histFilter = getHistoryFilter(req.user.plan);
    const trades = await prisma.trade.findMany({
      where: { userId: req.user.id, status: "CLOSED", ...histFilter },
      select: { asset: true, pnl: true, rMultiple: true, direction: true },
    });

    const assetMap = {};
    trades.forEach(t => {
      if (!assetMap[t.asset]) assetMap[t.asset] = { pnl: 0, trades: 0, wins: 0, rSum: 0, rCount: 0, long: 0, short: 0 };
      assetMap[t.asset].pnl    += t.pnl || 0;
      assetMap[t.asset].trades += 1;
      if (t.pnl > 0) assetMap[t.asset].wins++;
      if (t.rMultiple) { assetMap[t.asset].rSum += t.rMultiple; assetMap[t.asset].rCount++; }
      if (t.direction === "LONG") assetMap[t.asset].long++; else assetMap[t.asset].short++;
    });

    const assets = Object.entries(assetMap)
      .map(([asset, d]) => ({
        asset,
        pnl:       Math.round(d.pnl * 100) / 100,
        trades:    d.trades,
        winRate:   Math.round((d.wins / d.trades) * 100),
        avgR:      d.rCount ? Math.round((d.rSum / d.rCount) * 100) / 100 : null,
        longRatio: Math.round((d.long / d.trades) * 100),
      }))
      .sort((a, b) => b.pnl - a.pnl);

    res.json({ assets });
  } catch (err) {
    next(err);
  }
});

// ── GET /analytics/emotions ───────────────────────────────────────
router.get("/emotions", async (req, res, next) => {
  try {
    const trades = await prisma.trade.findMany({
      where: {
        userId:         req.user.id,
        status:         "CLOSED",
        emotion_before: { not: null },
      },
      select: { emotion_before: true, pnl: true, rMultiple: true },
    });

    const emotionMap = {};
    trades.forEach(t => {
      const e = t.emotion_before;
      if (!emotionMap[e]) emotionMap[e] = { pnl: 0, trades: 0, wins: 0, rSum: 0, rCount: 0 };
      emotionMap[e].pnl    += t.pnl || 0;
      emotionMap[e].trades += 1;
      if (t.pnl > 0) emotionMap[e].wins++;
      if (t.rMultiple) { emotionMap[e].rSum += t.rMultiple; emotionMap[e].rCount++; }
    });

    const emotions = Object.entries(emotionMap).map(([emotion, d]) => ({
      emotion,
      pnl:     Math.round(d.pnl * 100) / 100,
      trades:  d.trades,
      winRate: Math.round((d.wins / d.trades) * 100),
      avgR:    d.rCount ? Math.round((d.rSum / d.rCount) * 100) / 100 : null,
    })).sort((a, b) => b.winRate - a.winRate);

    // Émotion la plus rentable
    const best = emotions[0] || null;

    res.json({ emotions, bestEmotion: best?.emotion || null });
  } catch (err) {
    next(err);
  }
});

// ── GET /analytics/streak ─────────────────────────────────────────
router.get("/streak", async (req, res, next) => {
  try {
    const trades = await prisma.trade.findMany({
      where:   { userId: req.user.id, status: "CLOSED" },
      select:  { date: true, pnl: true },
      orderBy: { date: "desc" },
    });

    let currentStreak = 0;
    let currentType   = null; // "win" | "loss"
    let maxWinStreak  = 0;
    let maxLossStreak = 0;
    let tempWin = 0, tempLoss = 0;

    for (const t of trades) {
      const isWin = (t.pnl || 0) > 0;
      if (currentType === null) {
        currentType   = isWin ? "win" : "loss";
        currentStreak = 1;
      } else if ((isWin && currentType === "win") || (!isWin && currentType === "loss")) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Calcule les streaks max sur tout l'historique (ordre chronologique)
    const chronological = [...trades].reverse();
    for (const t of chronological) {
      const isWin = (t.pnl || 0) > 0;
      if (isWin) { tempWin++; tempLoss = 0; }
      else       { tempLoss++; tempWin = 0; }
      if (tempWin  > maxWinStreak)  maxWinStreak  = tempWin;
      if (tempLoss > maxLossStreak) maxLossStreak = tempLoss;
    }

    res.json({
      current:      { streak: currentStreak, type: currentType },
      maxWinStreak,
      maxLossStreak,
      totalTrades:  trades.length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
