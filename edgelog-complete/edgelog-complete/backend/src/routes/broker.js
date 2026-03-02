// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Broker Sync
// POST /api/broker/connect     → Connecter un broker (stocker creds chiffrés)
// POST /api/broker/sync        → Synchroniser les trades
// GET  /api/broker/status      → Statut de connexion
// DELETE /api/broker/:slug     → Déconnecter
// Réservé au plan PRO
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const crypto  = require("crypto");
const prisma  = require("../lib/prisma");
const { authenticate, requirePlan } = require("../middleware/errorHandler");
const { BROKERS, API_BROKERS }      = require("../lib/brokers");

const router = express.Router();
router.use(authenticate);
router.use(requirePlan("pro"));

// ── Chiffrement des credentials (AES-256-GCM) ─────────────────────
const CIPHER_KEY = Buffer.from(
  (process.env.BROKER_CIPHER_KEY || "").padEnd(64, "0").slice(0, 64),
  "hex"
);

function encryptCreds(creds) {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CIPHER_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(creds), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv:  iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  });
}

function decryptCreds(stored) {
  const { iv, tag, data } = JSON.parse(stored);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    CIPHER_KEY,
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

// ── POST /broker/connect ──────────────────────────────────────────
router.post("/connect", async (req, res, next) => {
  try {
    const { broker, credentials } = req.body;
    if (!broker || !BROKERS[broker]) {
      return res.status(400).json({ error: "Broker non supporté.", supported: Object.keys(BROKERS) });
    }
    if (!API_BROKERS.includes(broker)) {
      return res.status(400).json({ error: `${BROKERS[broker].name} utilise uniquement l'import CSV.` });
    }
    if (!credentials || typeof credentials !== "object") {
      return res.status(400).json({ error: "Credentials requis." });
    }

    // Stocke les credentials chiffrés dans le profil utilisateur
    // En prod : utiliser un champ dédié BrokerConnection dans Prisma
    const encrypted = encryptCreds(credentials);
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        // Stocké dans un champ JSON générique pour l'instant
        // À migrer vers un modèle BrokerConnection dédié
      },
    });

    res.json({
      message:  `${BROKERS[broker].name} connecté avec succès.`,
      broker,
      connected: true,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /broker/sync ─────────────────────────────────────────────
router.post("/sync", async (req, res, next) => {
  try {
    const { broker, accountId, credentials } = req.body;

    if (!broker || !BROKERS[broker]) {
      return res.status(400).json({ error: "Broker non supporté." });
    }
    if (!accountId) {
      return res.status(400).json({ error: "accountId requis." });
    }

    // Vérifie que le compte appartient à l'utilisateur
    const account = await prisma.account.findFirst({
      where: { id: accountId, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: "Compte introuvable." });

    const adapter = BROKERS[broker];

    // Date du dernier trade importé depuis ce broker
    const lastTrade = await prisma.trade.findFirst({
      where:   { userId: req.user.id, accountId, importSource: broker },
      orderBy: { date: "desc" },
    });
    const since = lastTrade ? new Date(lastTrade.date) : null;

    // Récupère les trades depuis le broker
    const rawTrades = await adapter.fetchTrades(credentials || {}, since);

    // Déduplique par externalId si disponible
    const existingIds = new Set(
      (await prisma.trade.findMany({
        where:  { userId: req.user.id, importSource: broker },
        select: { externalId: true },
      })).filter(t => t.externalId).map(t => t.externalId)
    );

    const newTrades = rawTrades.filter(t => !t.externalId || !existingIds.has(t.externalId));

    // Importe les nouveaux trades
    let imported = 0;
    for (const trade of newTrades) {
      try {
        await prisma.trade.create({
          data: { userId: req.user.id, accountId, ...trade },
        });
        imported++;
      } catch { /* skip duplicates */ }
    }

    res.json({
      broker,
      fetched:  rawTrades.length,
      imported,
      skipped:  rawTrades.length - imported,
      message:  `${imported} nouveaux trades importés depuis ${adapter.name}.`,
      since:    since?.toISOString() || null,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /broker/status ────────────────────────────────────────────
router.get("/status", async (req, res, next) => {
  try {
    // Compte les trades par source d'import pour l'utilisateur
    const importStats = await prisma.trade.groupBy({
      by:     ["importSource"],
      where:  { userId: req.user.id, importSource: { not: null } },
      _count: { importSource: true },
    });

    const brokerStatus = Object.entries(BROKERS).map(([slug, broker]) => {
      const stat = importStats.find(s => s.importSource === slug);
      return {
        slug,
        name:        broker.name,
        apiSupport:  API_BROKERS.includes(slug),
        tradesCount: stat?._count?.importSource || 0,
      };
    });

    res.json({ brokers: brokerStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
