// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Google OAuth
// GET /api/auth/google           → Redirige vers Google
// GET /api/auth/google/callback  → Callback après auth Google
// ─────────────────────────────────────────────────────────────────
const express  = require("express");
const passport = require("passport");
const { handleGoogleCallback } = require("../lib/oauth");

const router      = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ── GET /auth/google ───────────────────────────────────────────────
// Redirige l'utilisateur vers la page de connexion Google
router.get(
  "/google",
  passport.authenticate("google", {
    scope:  ["email", "profile"],
    session: false,
    prompt: "select_account", // Toujours afficher la sélection de compte
  })
);

// ── GET /auth/google/callback ──────────────────────────────────────
// Google redirige ici après authentification
router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${FRONTEND_URL}/login?error=google_auth_failed`,
  }),
  async (req, res) => {
    try {
      await handleGoogleCallback(req.user, res);
    } catch (err) {
      console.error("[OAuth] Callback error:", err.message);
      res.redirect(`${FRONTEND_URL}/login?error=oauth_error`);
    }
  }
);

module.exports = router;
