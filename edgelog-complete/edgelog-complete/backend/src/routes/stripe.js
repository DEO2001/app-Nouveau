// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Stripe
// POST /api/stripe/create-checkout    → Crée une session Checkout
// POST /api/stripe/create-portal      → Portail client Stripe
// POST /api/stripe/cancel             → Résiliation
// POST /api/stripe/webhook            → Webhooks Stripe (SANS auth JWT)
// GET  /api/stripe/subscription       → Infos abonnement actuel
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);
const prisma  = require("../lib/prisma");
const { authenticate } = require("../middleware/errorHandler");
const {
  sendSubscriptionConfirmEmail,
  sendTrialEndingEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
} = require("../lib/email");

const router = express.Router();

// ── Price IDs par plan ────────────────────────────────────────────
const PRICE_IDS = {
  premium_monthly:  process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
  premium_annual:   process.env.STRIPE_PRICE_PREMIUM_ANNUAL,
  pro_monthly:      process.env.STRIPE_PRICE_PRO_MONTHLY,
  pro_annual:       process.env.STRIPE_PRICE_PRO_ANNUAL,
};

// Mapping Stripe priceId → plan EDGELOG
function planFromPriceId(priceId) {
  if ([PRICE_IDS.premium_monthly, PRICE_IDS.premium_annual].includes(priceId)) return "premium";
  if ([PRICE_IDS.pro_monthly,     PRICE_IDS.pro_annual    ].includes(priceId)) return "pro";
  return "basic";
}

// ── POST /create-checkout ──────────────────────────────────────────
// Crée une session Stripe Checkout (mode subscription avec trial 14j)
router.post("/create-checkout", authenticate, async (req, res, next) => {
  try {
    const { plan, billing } = req.body; // plan: "premium"|"pro", billing: "monthly"|"annual"
    const priceKey = `${plan}_${billing || "monthly"}`;
    const priceId  = PRICE_IDS[priceKey];

    if (!priceId) {
      return res.status(400).json({ error: "Plan ou facturation invalide." });
    }

    // Crée ou récupère le customer Stripe
    let customerId = req.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name:  req.user.name,
        metadata: { userId: req.user.id },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: req.user.id },
        data:  { stripeCustomerId: customerId },
      });
    }

    // Crée la session Checkout
    const session = await stripe.checkout.sessions.create({
      customer:              customerId,
      payment_method_types:  ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode:                  "subscription",
      subscription_data: {
        trial_period_days: 14,
        metadata: { userId: req.user.id, plan },
      },
      success_url: `${process.env.FRONTEND_URL}/dashboard?checkout=success&plan=${plan}`,
      cancel_url:  `${process.env.FRONTEND_URL}/offres?checkout=canceled`,
      metadata: { userId: req.user.id, plan },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    next(err);
  }
});

// ── POST /create-portal ────────────────────────────────────────────
// Redirige vers le portail client Stripe (modifier CB, factures, résiliation)
router.post("/create-portal", authenticate, async (req, res, next) => {
  try {
    if (!req.user.stripeCustomerId) {
      return res.status(400).json({ error: "Aucun abonnement actif." });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   req.user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/facturation`,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// ── POST /cancel ───────────────────────────────────────────────────
// Résilie l'abonnement à la fin de la période en cours
router.post("/cancel", authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: "Aucun abonnement actif." });
    }

    // cancel_at_period_end = true → garde l'accès jusqu'à la fin de la période
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { stripeStatus: "canceled" },
    });

    res.json({ message: "Abonnement résilié. Accès maintenu jusqu'à la fin de la période." });
  } catch (err) {
    next(err);
  }
});

// ── GET /subscription ──────────────────────────────────────────────
// Retourne les infos d'abonnement de l'utilisateur
router.get("/subscription", authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        plan: true,
        stripeStatus: true,
        stripePriceId: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        stripeSubscriptionId: true,
      },
    });

    let paymentMethod = null;
    if (user.stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
          expand: ["default_payment_method"],
        });
        const pm = sub.default_payment_method;
        if (pm?.card) {
          paymentMethod = {
            brand:  pm.card.brand.toUpperCase(),
            last4:  pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear:  pm.card.exp_year,
          };
        }
      } catch (_) { /* ignore if sub not found */ }
    }

    res.json({ subscription: { ...user, paymentMethod } });
  } catch (err) {
    next(err);
  }
});

// ── POST /webhook ──────────────────────────────────────────────────
// IMPORTANT : pas de middleware authenticate ici !
// Le body doit être RAW (configuré dans index.js)
router.post("/webhook", async (req, res) => {
  const sig     = req.headers["stripe-signature"];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[Webhook] Signature invalide :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Webhook] Événement reçu : ${event.type}`);

  try {
    switch (event.type) {

      // ── Essai démarré ──────────────────────────────────────────
      case "customer.subscription.trial_will_end": {
        const sub    = event.data.object;
        const userId = sub.metadata?.userId;
        if (userId) {
          // Envoyer un email de rappel J-3 (à implémenter avec Resend)
          console.log(`[Webhook] Trial se termine bientôt pour user ${userId}`);
        }
        break;
      }

      // ── Abonnement créé ou réactivé ────────────────────────────
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub     = event.data.object;
        const userId  = sub.metadata?.userId;
        if (!userId) break;

        const priceId = sub.items.data[0]?.price?.id;
        const plan    = planFromPriceId(priceId);

        // Détermine le statut
        const stripeStatus = sub.status; // active | trialing | past_due | canceled | etc.

        await prisma.user.update({
          where: { id: userId },
          data: {
            plan,
            stripeSubscriptionId: sub.id,
            stripePriceId:        priceId,
            stripeStatus,
            trialEndsAt:      sub.trial_end   ? new Date(sub.trial_end   * 1000) : null,
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
          },
        });
        console.log(`[Webhook] User ${userId} → plan ${plan} (${stripeStatus})`);
        break;
      }

      // ── Paiement réussi ────────────────────────────────────────
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub     = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId  = sub.metadata?.userId;
        if (userId) {
          const user = await prisma.user.findUnique({ where:{id:userId}, select:{email:true,name:true,plan:true,currentPeriodEnd:true} });
          if (user) {
            const planLabel = {premium:"Premium ⚡",pro:"Premium Pro 🚀"}[user.plan]||"Premium";
            const amount    = `${(invoice.amount_paid/100).toFixed(2)} €`;
            const nextDate  = user.currentPeriodEnd ? new Date(user.currentPeriodEnd).toLocaleDateString("fr-FR") : "—";
            sendSubscriptionConfirmEmail({ to:user.email, name:user.name, plan:user.plan, amount, nextBilling:nextDate }).catch(()=>{});
          }
          console.log(`[Webhook] Paiement réussi pour user ${userId} — ${(invoice.amount_paid/100).toFixed(2)} €`);
        }
        break;
      }

      // ── Paiement échoué ────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub     = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId  = sub.metadata?.userId;
        if (userId) {
          await prisma.user.update({ where:{id:userId}, data:{stripeStatus:"past_due"} });
          const user = await prisma.user.findUnique({ where:{id:userId}, select:{email:true,name:true} });
          if (user) {
            sendPaymentFailedEmail({ to:user.email, name:user.name, amount:`${(invoice.amount_due/100).toFixed(2)} €` }).catch(()=>{});
          }
          console.log(`[Webhook] Paiement échoué pour user ${userId}`);
        }
        break;
      }

      // ── Abonnement annulé (fin de période) ─────────────────────
      case "customer.subscription.deleted": {
        const sub    = event.data.object;
        const userId = sub.metadata?.userId;
        if (userId) {
          const user = await prisma.user.findUnique({ where:{id:userId}, select:{email:true,name:true,currentPeriodEnd:true} });
          await prisma.user.update({
            where: { id: userId },
            data: { plan:"basic", stripeSubscriptionId:null, stripePriceId:null, stripeStatus:"canceled", currentPeriodEnd:null },
          });
          if (user) {
            const accessUntil = user.currentPeriodEnd ? new Date(user.currentPeriodEnd).toLocaleDateString("fr-FR") : "immédiatement";
            sendCancellationEmail({ to:user.email, name:user.name, accessUntil }).catch(()=>{});
          }
          console.log(`[Webhook] Abonnement supprimé → user ${userId} rétrogradé Basic`);
        }
        break;
      }

      default:
        console.log(`[Webhook] Événement ignoré : ${event.type}`);
    }
  } catch (err) {
    console.error("[Webhook] Erreur traitement :", err.message);
    // On renvoie 200 quand même pour éviter les retries Stripe
  }

  res.json({ received: true });
});

module.exports = router;
