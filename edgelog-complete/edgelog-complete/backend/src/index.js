// ─────────────────────────────────────────────────────────────────
// EDGELOG — Serveur Express
// ─────────────────────────────────────────────────────────────────
require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const rateLimit  = require("express-rate-limit");

const authRoutes     = require("./routes/auth");
const userRoutes     = require("./routes/user");
const accountRoutes  = require("./routes/accounts");
const tradeRoutes    = require("./routes/trades");
const stripeRoutes   = require("./routes/stripe");
const importRoutes   = require("./routes/import");
const mentorRoutes   = require("./routes/mentor");
const oauthRoutes    = require("./routes/oauth");
const brokerRoutes   = require("./routes/broker");
const analyticsRoutes = require("./routes/analytics");
const { errorHandler } = require("./middleware/errorHandler");
const { startAllCronJobs } = require("./lib/cron");
const { setupGoogleOAuth }  = require("./lib/oauth");

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Sécurité ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

// ── Google OAuth ──────────────────────────────────────────────────
setupGoogleOAuth(app);

// ── Rate limiting ─────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: "Trop de requêtes, réessayez dans 15 minutes." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Trop de tentatives de connexion." },
});
app.use("/api", limiter);
app.use("/api/auth", authLimiter);

// ── Body parsing ──────────────────────────────────────────────────
// IMPORTANT: le webhook Stripe nécessite le body RAW (avant JSON.parse)
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Logs ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// ── Health check ──────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

// ── Routes ────────────────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/auth",      oauthRoutes);      // Google OAuth
app.use("/api/user",      userRoutes);
app.use("/api/accounts",  accountRoutes);
app.use("/api/trades",    tradeRoutes);
app.use("/api/stripe",    stripeRoutes);
app.use("/api/import",    importRoutes);
app.use("/api/mentor",    mentorRoutes);
app.use("/api/broker",    brokerRoutes);     // Broker sync (Pro)
app.use("/api/analytics", analyticsRoutes);  // Stats avancés

// Fichiers statiques PWA
app.use(express.static("public"));

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} introuvable.` });
});

// ── Error handler global ──────────────────────────────────────────
app.use(errorHandler);

// ── Start (désactivé en mode test — supertest gère le démarrage) ──
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`\n🚀 EDGELOG API démarrée sur http://localhost:${PORT}`);
    console.log(`   Environnement : ${process.env.NODE_ENV}`);
    console.log(`   Frontend autorisé : ${process.env.FRONTEND_URL}\n`);
    startAllCronJobs();
  });
}

module.exports = app;
