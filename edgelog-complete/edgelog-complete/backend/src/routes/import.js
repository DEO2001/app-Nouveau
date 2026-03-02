// ─────────────────────────────────────────────────────────────────
// EDGELOG — Route Import CSV
// POST /api/import/preview   → analyse CSV, retourne aperçu
// POST /api/import/confirm   → importe les trades en base
// Réservé au plan PRO
// ─────────────────────────────────────────────────────────────────
const express  = require("express");
const multer   = require("multer");
const Papa     = require("papaparse");
const prisma   = require("../lib/prisma");
const { authenticate, requirePlan } = require("../middleware/errorHandler");

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticate);
router.use(requirePlan("pro"));

// ── Détection auto des colonnes ───────────────────────────────────
function detectColumns(headers) {
  const h = headers.map(h => h.toLowerCase().trim());
  const find = (keywords) => headers[h.findIndex(col => keywords.some(k => col.includes(k)))] || null;
  return {
    date:   find(["date","time","open time"]),
    asset:  find(["symbol","pair","instrument","asset","market"]),
    side:   find(["side","direction","type","buy/sell","b/s"]),
    entry:  find(["entry","open","open price","entry price"]),
    exit:   find(["exit","close","close price","exit price"]),
    pnl:    find(["pnl","profit","net profit","realized pnl","profit & loss"]),
    size:   find(["size","qty","quantity","volume","amount"]),
  };
}

// ── Normalise la direction ────────────────────────────────────────
function normalizeDirection(val) {
  if (!val) return "LONG";
  const v = val.toString().toLowerCase();
  if (v.includes("sell") || v.includes("short") || v === "s") return "SHORT";
  return "LONG";
}

// ── POST /preview ─────────────────────────────────────────────────
router.post("/preview", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier requis." });

    const content = req.file.buffer.toString("utf-8");
    const { data, errors } = Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });

    if (errors.length && data.length === 0) {
      return res.status(400).json({ error: "Fichier CSV invalide." });
    }

    const headers    = Object.keys(data[0] || {});
    const mapping    = detectColumns(headers);
    const preview    = data.slice(0, 5);
    const detected   = Object.values(mapping).filter(Boolean).length;

    res.json({
      totalRows:  data.length,
      headers,
      mapping,
      preview,
      confidence: Math.round((detected / 7) * 100),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /confirm ──────────────────────────────────────────────────
router.post("/confirm", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file)         return res.status(400).json({ error: "Fichier requis." });
    if (!req.body.accountId) return res.status(400).json({ error: "Compte requis." });

    // Vérifie que le compte appartient à l'utilisateur
    const account = await prisma.account.findFirst({
      where: { id: req.body.accountId, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: "Compte introuvable." });

    const content  = req.file.buffer.toString("utf-8");
    const { data } = Papa.parse(content, { header: true, skipEmptyLines: true });
    const mapping  = JSON.parse(req.body.mapping || "{}");
    const broker   = req.body.broker || "custom";

    // Parse et crée les trades
    const created = [];
    for (const row of data) {
      try {
        const trade = await prisma.trade.create({
          data: {
            userId:    req.user.id,
            accountId: account.id,
            asset:     row[mapping.asset]     || "UNKNOWN",
            direction: normalizeDirection(row[mapping.side]),
            status:    "CLOSED",
            date:      row[mapping.date]?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            entry:     parseFloat(row[mapping.entry]) || null,
            exit:      parseFloat(row[mapping.exit])  || null,
            pnl:       parseFloat(row[mapping.pnl])   || null,
            size:      parseFloat(row[mapping.size])  || null,
            tags:      ["import", broker],
            importSource: broker,
          },
        });
        created.push(trade.id);
      } catch (_) { /* skip malformed rows */ }
    }

    res.json({
      imported: created.length,
      skipped:  data.length - created.length,
      message:  `${created.length} trades importés avec succès.`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
