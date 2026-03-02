// ─────────────────────────────────────────────────────────────────
// EDGELOG — Cron Jobs
// Installation : npm install node-cron
// Lancé depuis src/index.js
// ─────────────────────────────────────────────────────────────────
const cron   = require("node-cron");
const prisma = require("./prisma");
const {
  sendTrialEndingEmail,
  sendMonthlyReportEmail,
} = require("./email");

// ── Helpers ───────────────────────────────────────────────────────
function log(job, msg) {
  console.log(`[Cron:${job}] ${new Date().toISOString()} — ${msg}`);
}

// ─────────────────────────────────────────────────────────────────
// JOB 1 — Rappels fin d'essai Premium (J-3 et J-1)
// Tous les jours à 09h00
// ─────────────────────────────────────────────────────────────────
function scheduleTrialReminders() {
  cron.schedule("0 9 * * *", async () => {
    log("trial-reminder", "Vérification des essais en fin de période...");
    try {
      const now = new Date();
      const in3days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const in1day  = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

      // Trouve les abonnements en trial qui se terminent dans 1 ou 3 jours
      const expiringUsers = await prisma.user.findMany({
        where: {
          stripeStatus: "trialing",
          trialEndsAt: {
            gte: now,
            lte: in3days,
          },
        },
        select: { id: true, email: true, name: true, trialEndsAt: true },
      });

      for (const user of expiringUsers) {
        const msLeft   = user.trialEndsAt - now;
        const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));

        if (daysLeft === 3 || daysLeft === 1) {
          await sendTrialEndingEmail({ to: user.email, name: user.name, daysLeft });
          log("trial-reminder", `Email envoyé à ${user.email} (J-${daysLeft})`);
        }
      }

      // Rappels psychologie Basic (30j d'essai)
      const psychTrialUsers = await prisma.user.findMany({
        where: {
          plan: "basic",
          createdAt: {
            gte: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
            lte: new Date(now.getTime() - 27 * 24 * 60 * 60 * 1000),
          },
        },
        select: { id: true, email: true, name: true, createdAt: true },
      });

      for (const user of psychTrialUsers) {
        const daysSince = Math.floor((now - user.createdAt) / (24 * 60 * 60 * 1000));
        const daysLeft  = 30 - daysSince;
        if (daysLeft === 3) {
          await sendTrialEndingEmail({ to: user.email, name: user.name, daysLeft });
          log("trial-reminder", `Psycho trial reminder envoyé à ${user.email}`);
        }
      }

      log("trial-reminder", `${expiringUsers.length + psychTrialUsers.length} utilisateurs vérifiés`);
    } catch (err) {
      console.error("[Cron:trial-reminder] Erreur:", err.message);
    }
  }, { timezone: "Europe/Paris" });

  log("trial-reminder", "Job planifié — tous les jours à 09h00 (Paris)");
}

// ─────────────────────────────────────────────────────────────────
// JOB 2 — Rapport mensuel email
// Le 1er de chaque mois à 08h00
// ─────────────────────────────────────────────────────────────────
function scheduleMonthlyReports() {
  cron.schedule("0 8 1 * *", async () => {
    const now       = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthName = prevMonth.toLocaleDateString("fr-FR", { month: "long" });
    const year      = prevMonth.getFullYear();
    const monthNum  = prevMonth.getMonth();

    log("monthly-report", `Envoi des rapports ${monthName} ${year}...`);

    try {
      // Récupère tous les utilisateurs premium/pro actifs
      const users = await prisma.user.findMany({
        where: {
          plan:         { in: ["premium", "pro"] },
          stripeStatus: { in: ["active", "trialing"] },
        },
        select: { id: true, email: true, name: true },
      });

      log("monthly-report", `${users.length} utilisateurs à notifier`);

      for (const user of users) {
        try {
          // Calcule les stats du mois précédent
          const monthStart = `${year}-${String(monthNum + 1).padStart(2, "0")}-01`;
          const monthEnd   = `${year}-${String(monthNum + 1).padStart(2, "0")}-31`;

          const trades = await prisma.trade.findMany({
            where: {
              userId: user.id,
              status: "CLOSED",
              date:   { gte: monthStart, lte: monthEnd },
            },
            select: { pnl: true, rMultiple: true },
          });

          if (trades.length === 0) continue; // Pas de trades ce mois = pas d'email

          const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
          const wins     = trades.filter(t => t.pnl > 0).length;
          const winRate  = ((wins / trades.length) * 100).toFixed(1);
          const rTrades  = trades.filter(t => t.rMultiple);
          const avgR     = rTrades.length
            ? (rTrades.reduce((s, t) => s + t.rMultiple, 0) / rTrades.length).toFixed(2)
            : "—";

          await sendMonthlyReportEmail({
            to:    user.email,
            name:  user.name,
            month: monthName.charAt(0).toUpperCase() + monthName.slice(1),
            year,
            stats: { trades: trades.length, totalPnl, winRate: parseFloat(winRate), avgR },
          });

          log("monthly-report", `Rapport envoyé à ${user.email} (${trades.length} trades, ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}$)`);
        } catch (userErr) {
          console.error(`[Cron:monthly-report] Erreur pour ${user.email}:`, userErr.message);
        }
      }

      log("monthly-report", "Tous les rapports envoyés ✓");
    } catch (err) {
      console.error("[Cron:monthly-report] Erreur globale:", err.message);
    }
  }, { timezone: "Europe/Paris" });

  log("monthly-report", "Job planifié — 1er de chaque mois à 08h00 (Paris)");
}

// ─────────────────────────────────────────────────────────────────
// JOB 3 — Nettoyage refresh tokens expirés
// Tous les dimanches à 03h00
// ─────────────────────────────────────────────────────────────────
function scheduleTokenCleanup() {
  cron.schedule("0 3 * * 0", async () => {
    log("token-cleanup", "Nettoyage des refresh tokens expirés...");
    try {
      const result = await prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      log("token-cleanup", `${result.count} tokens supprimés`);
    } catch (err) {
      console.error("[Cron:token-cleanup] Erreur:", err.message);
    }
  }, { timezone: "Europe/Paris" });

  log("token-cleanup", "Job planifié — dimanches à 03h00 (Paris)");
}

// ─────────────────────────────────────────────────────────────────
// JOB 4 — Vérification abonnements expirés (sécurité)
// Tous les jours à 00h05 (backup si webhook raté)
// ─────────────────────────────────────────────────────────────────
function scheduleSubscriptionCheck() {
  cron.schedule("5 0 * * *", async () => {
    log("sub-check", "Vérification des abonnements expirés...");
    try {
      // Rétrograder les abonnements dont la période est dépassée
      const expired = await prisma.user.findMany({
        where: {
          plan:            { in: ["premium", "pro"] },
          currentPeriodEnd: { lt: new Date() },
          stripeStatus:    { not: "active" },
        },
        select: { id: true, email: true, plan: true },
      });

      for (const user of expired) {
        await prisma.user.update({
          where: { id: user.id },
          data:  { plan: "basic", stripeStatus: "canceled", stripeSubscriptionId: null },
        });
        log("sub-check", `User ${user.email} rétrogradé de ${user.plan} → basic`);
      }

      if (expired.length > 0) {
        log("sub-check", `${expired.length} abonnements rétrogradés`);
      }
    } catch (err) {
      console.error("[Cron:sub-check] Erreur:", err.message);
    }
  }, { timezone: "Europe/Paris" });

  log("sub-check", "Job planifié — tous les jours à 00h05 (Paris)");
}

// ─────────────────────────────────────────────────────────────────
// Démarrage de tous les jobs
// ─────────────────────────────────────────────────────────────────
function startAllCronJobs() {
  if (process.env.NODE_ENV === "test") {
    console.log("[Cron] Jobs désactivés en mode test");
    return;
  }

  console.log("\n⏰ Démarrage des cron jobs EDGELOG...");
  scheduleTrialReminders();
  scheduleMonthlyReports();
  scheduleTokenCleanup();
  scheduleSubscriptionCheck();
  console.log("✓ Tous les cron jobs sont actifs\n");
}

module.exports = { startAllCronJobs };
