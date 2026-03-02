// ─────────────────────────────────────────────────────────────────
// EDGELOG — Google OAuth (Passport.js)
// Installation : npm install passport passport-google-oauth20
//
// Variables requises dans .env :
//   GOOGLE_CLIENT_ID=...
//   GOOGLE_CLIENT_SECRET=...
//   SESSION_SECRET=...  (random 64 chars)
//
// Dans Google Cloud Console :
//   - Créer un projet OAuth 2.0
//   - Authorized redirect URI : https://votre-api.com/api/auth/google/callback
// ─────────────────────────────────────────────────────────────────
const passport       = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const prisma         = require("./prisma");
const { signAccessToken, signRefreshToken, refreshExpiresAt } = require("./jwt");
const { sendWelcomeEmail } = require("./email");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

function setupGoogleOAuth(app) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.log("[OAuth] Google OAuth désactivé — variables GOOGLE_CLIENT_ID/SECRET manquantes");
    return;
  }

  // ── Stratégie Google ───────────────────────────────────────────
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.API_URL || "http://localhost:4000"}/api/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email  = profile.emails?.[0]?.value;
        const name   = profile.displayName || email?.split("@")[0] || "Trader";
        const avatar = profile.photos?.[0]?.value;

        if (!email) return done(new Error("Email Google non disponible"), null);

        // Cherche l'utilisateur existant
        let user = await prisma.user.findUnique({ where: { email } });

        if (user) {
          // Met à jour avatar si changé
          if (avatar && user.avatar !== avatar) {
            user = await prisma.user.update({
              where: { id: user.id },
              data:  { avatar, provider: "google", providerId: profile.id },
            });
          }
        } else {
          // Crée un nouvel utilisateur via Google
          user = await prisma.user.create({
            data: {
              email,
              name,
              avatar,
              provider:   "google",
              providerId: profile.id,
              // Pas de passwordHash pour les utilisateurs OAuth
            },
          });

          // Compte de trading par défaut
          await prisma.account.create({
            data: { userId: user.id, name: "Compte Principal", type: "Reel", balance: 10000 },
          });

          // Email de bienvenue
          sendWelcomeEmail({ to: email, name, plan: "basic" }).catch(() => {});
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  ));

  // ── Initialiser Passport dans Express ─────────────────────────
  app.use(passport.initialize());

  console.log("[OAuth] Google OAuth activé ✓");
}

// ── Handler callback Google ────────────────────────────────────────
// Appelé par /api/auth/google/callback après authentification
async function handleGoogleCallback(user, res) {
  try {
    const accessToken  = signAccessToken({ userId: user.id });
    const refreshToken = signRefreshToken({ userId: user.id });

    await prisma.refreshToken.create({
      data: {
        userId:    user.id,
        token:     refreshToken,
        expiresAt: refreshExpiresAt(),
      },
    });

    // Redirige vers le frontend avec les tokens en query params
    // En prod : préférer un cookie httpOnly sécurisé
    const redirectUrl = new URL(`${FRONTEND_URL}/auth/callback`);
    redirectUrl.searchParams.set("access",  accessToken);
    redirectUrl.searchParams.set("refresh", refreshToken);
    redirectUrl.searchParams.set("name",    user.name);
    redirectUrl.searchParams.set("plan",    user.plan);

    res.redirect(redirectUrl.toString());
  } catch (err) {
    res.redirect(`${FRONTEND_URL}/login?error=oauth_failed`);
  }
}

module.exports = { setupGoogleOAuth, handleGoogleCallback };
