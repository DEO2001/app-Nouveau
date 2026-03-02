// ─────────────────────────────────────────────────────────────────
// EDGELOG — Seed de démonstration
// Usage : npm run db:seed
// Crée un compte démo avec trades réalistes
// ─────────────────────────────────────────────────────────────────
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function rnd(min, max) {
  return Math.random() * (max - min) + min;
}

// ── Trades de démonstration ───────────────────────────────────────
const DEMO_TRADES = [
  { asset:"EUR/USD", direction:"LONG",  status:"CLOSED", date:daysAgo(2),  entry:1.0850, exit:1.0920, size:1.0,  pnl:700,   rMultiple:2.1,  setup:"Breakout",    emotion_before:"Confiant",  emotion_after:"Satisfait",   tags:["plan-respecté","bon-RR"],   notes:"Setup propre sur le H4, entrée précise." },
  { asset:"NAS100",  direction:"LONG",  status:"CLOSED", date:daysAgo(3),  entry:17800,  exit:17950,  size:0.5,  pnl:750,   rMultiple:2.5,  setup:"Pullback",    emotion_before:"Neutre",    emotion_after:"Satisfait",   tags:["plan-respecté"],            notes:"Tendance haussière confirmée." },
  { asset:"BTC/USD", direction:"SHORT", status:"CLOSED", date:daysAgo(5),  entry:43500,  exit:43200,  size:0.1,  pnl:300,   rMultiple:1.5,  setup:"Résistance",  emotion_before:"Neutre",    emotion_after:"Neutre",      tags:["plan-respecté","scalp"],    notes:"Résistance majeure H1." },
  { asset:"GBP/USD", direction:"SHORT", status:"CLOSED", date:daysAgo(6),  entry:1.2680, exit:1.2780, size:1.0,  pnl:-1000, rMultiple:-1.0, setup:"Breakout",    emotion_before:"FOMO",      emotion_after:"Frustré",     tags:["FOMO","stop-touché"],       notes:"Entrée précipitée, pas attendu la confirmation." },
  { asset:"OR",      direction:"LONG",  status:"CLOSED", date:daysAgo(8),  entry:2020,   exit:2040,   size:0.5,  pnl:1000,  rMultiple:2.0,  setup:"Support",     emotion_before:"Confiant",  emotion_after:"Satisfait",   tags:["plan-respecté","bon-RR"],   notes:"Support daily tenu parfaitement." },
  { asset:"EUR/USD", direction:"SHORT", status:"CLOSED", date:daysAgo(10), entry:1.0900, exit:1.0850, size:1.0,  pnl:500,   rMultiple:1.5,  setup:"Double top",  emotion_before:"Neutre",    emotion_after:"Satisfait",   tags:["plan-respecté"],            notes:"Pattern double top validé." },
  { asset:"V75",     direction:"LONG",  status:"CLOSED", date:daysAgo(12), entry:820,    exit:830,    size:0.5,  pnl:500,   rMultiple:2.0,  setup:"EMA Cross",   emotion_before:"Neutre",    emotion_after:"Satisfait",   tags:["plan-respecté","synthétique"], notes:"Croisement EMA 20/50 propre." },
  { asset:"SP500",   direction:"LONG",  status:"CLOSED", date:daysAgo(14), entry:4800,   exit:4750,   size:0.5,  pnl:-250,  rMultiple:-0.5, setup:"Pullback",    emotion_before:"Impatient", emotion_after:"Frustré",     tags:["revenge-trade","early-entry"], notes:"Entrée trop tôt, pas attendu la clôture." },
  { asset:"NAS100",  direction:"SHORT", status:"CLOSED", date:daysAgo(16), entry:17600,  exit:17450,  size:0.5,  pnl:750,   rMultiple:1.5,  setup:"Résistance",  emotion_before:"Confiant",  emotion_after:"Satisfait",   tags:["plan-respecté"],            notes:"Zone de résistance respectée." },
  { asset:"BTC/USD", direction:"LONG",  status:"CLOSED", date:daysAgo(20), entry:41000,  exit:43000,  size:0.1,  pnl:2000,  rMultiple:3.0,  setup:"Breakout",    emotion_before:"Confiant",  emotion_after:"Très satisfait", tags:["plan-respecté","bon-RR","home-run"], notes:"Breakout mensuel, objectif atteint." },
  { asset:"EUR/USD", direction:"LONG",  status:"CLOSED", date:daysAgo(22), entry:1.0780, exit:1.0820, size:1.0,  pnl:400,   rMultiple:1.3,  setup:"EMA",         emotion_before:"Neutre",    emotion_after:"Neutre",      tags:["plan-respecté"],            notes:"Trade dans la tendance." },
  { asset:"OR",      direction:"SHORT", status:"CLOSED", date:daysAgo(25), entry:2050,   exit:2030,   size:0.5,  pnl:1000,  rMultiple:2.0,  setup:"Double top",  emotion_before:"Confiant",  emotion_after:"Satisfait",   tags:["plan-respecté","bon-RR"],   notes:"Retournement sur résistance." },
  { asset:"GBP/JPY", direction:"LONG",  status:"OPEN",   date:daysAgo(1),  entry:189.50, exit:null,   size:0.5,  pnl:null,  rMultiple:null, setup:"Tendance",    emotion_before:"Confiant",  emotion_after:null,           tags:["swing"],                    notes:"Trade swing, objectif 191.00." },
  { asset:"ETH/USD", direction:"LONG",  status:"OPEN",   date:daysAgo(2),  entry:2450,   exit:null,   size:0.2,  pnl:null,  rMultiple:null, setup:"Support",     emotion_before:"Neutre",    emotion_after:null,           tags:["crypto","swing"],           notes:"Support H4, SL sous 2380." },
];

async function main() {
  console.log("🌱 Démarrage du seed EDGELOG...\n");

  // ── Nettoyage ──────────────────────────────────────────────────
  await prisma.feedback.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.account.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.mentorRelation.deleteMany();
  await prisma.user.deleteMany();
  console.log("✓ Base nettoyée");

  // ── Utilisateur démo ───────────────────────────────────────────
  const passwordHash = await bcrypt.hash("demo1234", 12);

  const demoUser = await prisma.user.create({
    data: {
      email:        "demo@edgelog.app",
      name:         "Alexandre Martin",
      passwordHash,
      plan:         "premium",
      stripeStatus: "active",
      createdAt:    new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45 jours
      currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    },
  });
  console.log(`✓ Utilisateur démo créé : ${demoUser.email}`);

  // ── Utilisateur mentor ─────────────────────────────────────────
  const mentorUser = await prisma.user.create({
    data: {
      email:        "mentor@edgelog.app",
      name:         "Sophie Leclair",
      passwordHash: await bcrypt.hash("mentor1234", 12),
      plan:         "pro",
      stripeStatus: "active",
    },
  });
  console.log(`✓ Utilisateur mentor créé : ${mentorUser.email}`);

  // ── Compte de trading ──────────────────────────────────────────
  const account = await prisma.account.create({
    data: {
      userId:   demoUser.id,
      name:     "Compte Principal",
      type:     "Reel",
      balance:  10000,
      currency: "$",
      broker:   "MetaTrader 5",
    },
  });

  const accountDemo = await prisma.account.create({
    data: {
      userId:   demoUser.id,
      name:     "Compte Démo",
      type:     "Demo",
      balance:  50000,
      currency: "$",
      broker:   "cTrader",
    },
  });
  console.log(`✓ 2 comptes créés`);

  // ── Trades ─────────────────────────────────────────────────────
  for (const trade of DEMO_TRADES) {
    await prisma.trade.create({
      data: {
        userId:         demoUser.id,
        accountId:      account.id,
        ...trade,
        checklistDone: [true, true, true, false, true],
      },
    });
  }
  console.log(`✓ ${DEMO_TRADES.length} trades créés`);

  // ── Relation mentor ────────────────────────────────────────────
  await prisma.mentorRelation.create({
    data: {
      mentorId:  mentorUser.id,
      studentId: demoUser.id,
      access:    "complet",
    },
  });
  console.log(`✓ Relation mentor créée`);

  // ── Résumé ─────────────────────────────────────────────────────
  const closedTrades = DEMO_TRADES.filter(t => t.status === "CLOSED");
  const totalPnl     = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate      = ((closedTrades.filter(t => t.pnl > 0).length / closedTrades.length) * 100).toFixed(1);

  console.log("\n─────────────────────────────────────");
  console.log("✅ Seed terminé !\n");
  console.log("📧 Comptes créés :");
  console.log(`   demo@edgelog.app   / demo1234   (Premium)`);
  console.log(`   mentor@edgelog.app / mentor1234 (Pro)`);
  console.log(`\n📊 Stats démo : ${closedTrades.length} trades | P&L: +${totalPnl}$ | WR: ${winRate}%`);
  console.log("─────────────────────────────────────\n");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
