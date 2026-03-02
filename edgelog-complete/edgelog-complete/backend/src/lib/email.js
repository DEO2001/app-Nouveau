// ─────────────────────────────────────────────────────────────────
// EDGELOG — Service Email (Resend)
// Tous les emails transactionnels de la plateforme
// Installation : npm install resend
// ─────────────────────────────────────────────────────────────────

// NOTE: Uncomment when resend is installed:
// const { Resend } = require("resend");
// const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.EMAIL_FROM || "EDGELOG <noreply@edgelog.app>";
const APP_URL = process.env.FRONTEND_URL || "https://edgelog.app";

// ── Envoi générique ───────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[Email] (Mock) À: ${to} | Sujet: ${subject}`);
    return { success: true, mock: true };
  }
  try {
    const { Resend } = require("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({ from: FROM, to, subject, html });
    console.log(`[Email] Envoyé à ${to}: ${subject}`);
    return { success: true, id: result.id };
  } catch (err) {
    console.error(`[Email] Erreur envoi à ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Template de base ──────────────────────────────────────────────
function baseTemplate(content) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { margin:0; padding:0; background:#0a0e1a; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e1e8f0; }
    .wrapper { max-width:560px; margin:0 auto; padding:32px 16px; }
    .card { background:#111827; border:1px solid #1e2d3d; border-radius:14px; padding:32px; margin-bottom:16px; }
    .logo { font-size:22px; font-weight:900; letter-spacing:-0.5px; margin-bottom:24px; }
    .logo em { color:#00e5a0; font-style:normal; }
    .btn { display:inline-block; padding:13px 28px; background:#00e5a0; color:#0a0e1a; text-decoration:none; border-radius:8px; font-weight:700; font-size:14px; }
    .btn-ghost { background:transparent; color:#00e5a0; border:1px solid rgba(0,229,160,.4); }
    .muted { color:#6b7fa3; font-size:12px; }
    .divider { height:1px; background:#1e2d3d; margin:20px 0; }
    .stat-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #1e2d3d; font-size:13px; }
    .green { color:#00e5a0; } .red { color:#ff4d6d; } .amber { color:#f59e0b; }
    h1 { font-size:22px; font-weight:800; letter-spacing:-0.3px; margin:0 0 8px; }
    p { color:#9eb3cc; line-height:1.7; font-size:14px; margin:0 0 16px; }
    footer { text-align:center; padding:16px 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="logo">EDGE<em>LOG</em></div>
      ${content}
    </div>
    <footer>
      <p class="muted">EDGELOG · Journal de trading professionnel<br/>
      <a href="${APP_URL}/unsubscribe" style="color:#6b7fa3">Se désabonner</a> · 
      <a href="${APP_URL}/privacy" style="color:#6b7fa3">Confidentialité</a></p>
    </footer>
  </div>
</body>
</html>`;
}

// ── 1. Email de bienvenue ─────────────────────────────────────────
async function sendWelcomeEmail({ to, name, plan }) {
  const planLabel = { basic:"Basic 🌱", premium:"Premium ⚡", pro:"Premium Pro 🚀" }[plan] || "Basic";
  return sendEmail({
    to,
    subject: `Bienvenue sur EDGELOG, ${name} ! 🚀`,
    html: baseTemplate(`
      <h1>Bienvenue, ${name} ! 🎉</h1>
      <p>Votre compte EDGELOG est activé. Vous êtes sur le plan <strong style="color:#00e5a0">${planLabel}</strong>.</p>
      <p>EDGELOG vous aide à analyser vos trades, identifier vos patterns et progresser en tant que trader.</p>
      <div class="divider"></div>
      <p><strong>Pour démarrer :</strong></p>
      <p>① Ajoutez votre premier trade<br/>
      ② Remplissez la checklist pré-trade<br/>
      ③ Consultez votre dashboard après 5 trades</p>
      <div class="divider"></div>
      <a href="${APP_URL}/dashboard" class="btn">Accéder à mon journal →</a>
    `),
  });
}

// ── 2. Confirmation abonnement ────────────────────────────────────
async function sendSubscriptionConfirmEmail({ to, name, plan, amount, nextBilling }) {
  const planLabel = { premium:"Premium ⚡", pro:"Premium Pro 🚀" }[plan] || plan;
  return sendEmail({
    to,
    subject: `Abonnement ${planLabel} activé ✅`,
    html: baseTemplate(`
      <h1>Abonnement activé !</h1>
      <p>Votre abonnement <strong style="color:#f59e0b">${planLabel}</strong> est maintenant actif.</p>
      <div style="background:#0d1b2a;border:1px solid #1e2d3d;border-radius:8px;padding:16px;margin:16px 0;">
        <div class="stat-row"><span>Plan</span><span class="amber">${planLabel}</span></div>
        <div class="stat-row"><span>Montant</span><span>${amount} / mois</span></div>
        <div class="stat-row" style="border:none"><span>Prochain prélèvement</span><span>${nextBilling}</span></div>
      </div>
      <a href="${APP_URL}/facturation" class="btn">Voir mon abonnement →</a>
      <p class="muted" style="margin-top:16px">Pour modifier votre abonnement ou télécharger vos factures, rendez-vous sur la page Facturation.</p>
    `),
  });
}

// ── 3. Rappel fin d'essai (J-3) ───────────────────────────────────
async function sendTrialEndingEmail({ to, name, daysLeft }) {
  return sendEmail({
    to,
    subject: `⏰ Votre essai se termine dans ${daysLeft} jours`,
    html: baseTemplate(`
      <h1>Votre essai se termine bientôt</h1>
      <p>Bonjour ${name},</p>
      <p>Il vous reste <strong style="color:#f59e0b">${daysLeft} jours</strong> sur votre essai gratuit EDGELOG Premium.</p>
      <p>Après cette période, vous serez redirigé vers le plan Basic (15 trades max, historique 30 jours).</p>
      <div class="divider"></div>
      <p><strong>Ce que vous perdrez :</strong><br/>
      ✗ Analyses avancées & MFE/MAE<br/>
      ✗ Calendrier P&L interactif<br/>
      ✗ Historique illimité<br/>
      ✗ Psychologie complète</p>
      <div class="divider"></div>
      <a href="${APP_URL}/offres" class="btn">Continuer avec Premium →</a>
    `),
  });
}

// ── 4. Confirmation résiliation ───────────────────────────────────
async function sendCancellationEmail({ to, name, accessUntil }) {
  return sendEmail({
    to,
    subject: "Confirmation de résiliation EDGELOG",
    html: baseTemplate(`
      <h1>Abonnement résilié</h1>
      <p>Bonjour ${name},</p>
      <p>Votre abonnement a bien été résilié. Vous conservez l'accès Premium jusqu'au <strong>${accessUntil}</strong>.</p>
      <p>Après cette date, votre compte passera automatiquement sur le plan Basic gratuit. Vos données seront conservées pendant 90 jours.</p>
      <div class="divider"></div>
      <p>Nous espérons vous revoir bientôt. Si vous avez des retours à nous faire, répondez à cet email.</p>
      <a href="${APP_URL}/offres" class="btn btn-ghost" style="border-color:rgba(0,229,160,.4)">Se réabonner →</a>
    `),
  });
}

// ── 5. Paiement échoué ────────────────────────────────────────────
async function sendPaymentFailedEmail({ to, name, amount }) {
  return sendEmail({
    to,
    subject: "⚠️ Échec du paiement EDGELOG",
    html: baseTemplate(`
      <h1 style="color:#ff4d6d">Paiement échoué</h1>
      <p>Bonjour ${name},</p>
      <p>Le prélèvement de <strong>${amount}</strong> a échoué. Veuillez mettre à jour votre moyen de paiement pour conserver votre abonnement.</p>
      <div class="divider"></div>
      <a href="${APP_URL}/facturation" class="btn" style="background:#ff4d6d">Mettre à jour ma CB →</a>
      <p class="muted" style="margin-top:16px">Si vous ne mettez pas à jour votre moyen de paiement dans les 7 jours, votre abonnement sera annulé.</p>
    `),
  });
}

// ── 6. Rapport mensuel (résumé email) ─────────────────────────────
async function sendMonthlyReportEmail({ to, name, stats, month, year }) {
  const pnlColor = stats.totalPnl >= 0 ? "#00e5a0" : "#ff4d6d";
  const pnlSign  = stats.totalPnl >= 0 ? "+" : "";
  return sendEmail({
    to,
    subject: `📊 Votre rapport EDGELOG — ${month} ${year}`,
    html: baseTemplate(`
      <h1>Rapport ${month} ${year}</h1>
      <p>Bonjour ${name}, voici votre résumé mensuel EDGELOG.</p>
      <div style="background:#0d1b2a;border:1px solid #1e2d3d;border-radius:8px;padding:16px;margin:16px 0;">
        <div class="stat-row"><span>Trades clôturés</span><span>${stats.trades}</span></div>
        <div class="stat-row"><span>P&L total</span><span style="color:${pnlColor};font-weight:700">${pnlSign}${stats.totalPnl.toFixed(2)} $</span></div>
        <div class="stat-row"><span>Win Rate</span><span style="color:${stats.winRate>=50?"#00e5a0":"#ff4d6d"}">${stats.winRate}%</span></div>
        <div class="stat-row" style="border:none"><span>R Moyen</span><span>${stats.avgR}</span></div>
      </div>
      <a href="${APP_URL}/analyses" class="btn">Voir les analyses complètes →</a>
    `),
  });
}

// ── 7. Invitation mentor ──────────────────────────────────────────
async function sendMentorInviteEmail({ to, studentName, mentorName }) {
  return sendEmail({
    to,
    subject: `${studentName} vous invite à rejoindre son journal EDGELOG`,
    html: baseTemplate(`
      <h1>Invitation à coacher 🏆</h1>
      <p><strong>${studentName}</strong> vous a invité à accéder à son journal de trading EDGELOG en tant que mentor.</p>
      <p>Vous pourrez consulter ses trades, analyser ses performances et laisser des feedbacks pour l'aider à progresser.</p>
      <div class="divider"></div>
      <a href="${APP_URL}/coach" class="btn">Accéder au journal →</a>
      <p class="muted" style="margin-top:16px">Vous devez avoir un compte EDGELOG pour accéder au journal.</p>
    `),
  });
}

module.exports = {
  sendWelcomeEmail,
  sendSubscriptionConfirmEmail,
  sendTrialEndingEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
  sendMonthlyReportEmail,
  sendMentorInviteEmail,
};
