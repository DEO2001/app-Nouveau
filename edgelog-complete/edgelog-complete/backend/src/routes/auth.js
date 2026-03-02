// ─────────────────────────────────────────────────────────────────
// EDGELOG — Routes Auth
// POST /api/auth/register
// POST /api/auth/login
// POST /api/auth/refresh
// POST /api/auth/logout
// GET  /api/auth/me
// ─────────────────────────────────────────────────────────────────
const express  = require("express");
const bcrypt   = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const prisma   = require("../lib/prisma");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  refreshExpiresAt,
} = require("../lib/jwt");
const { authenticate } = require("../middleware/errorHandler");
const { sendWelcomeEmail } = require("../lib/email");

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────
function userPublic(user) {
  return {
    id:           user.id,
    email:        user.email,
    name:         user.name,
    avatar:       user.avatar,
    plan:         user.plan,
    stripeStatus: user.stripeStatus,
    createdAt:    user.createdAt,
  };
}

// ── POST /register ────────────────────────────────────────────────
router.post(
  "/register",
  [
    body("email").isEmail().normalizeEmail().withMessage("Email invalide."),
    body("password").isLength({ min: 8 }).withMessage("Mot de passe min. 8 caractères."),
    body("name").trim().notEmpty().withMessage("Nom requis."),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, name } = req.body;

      // Vérifie si l'email existe déjà
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
      }

      // Hash du mot de passe
      const passwordHash = await bcrypt.hash(password, 12);

      // Création utilisateur
      const user = await prisma.user.create({
        data: { email, name, passwordHash },
      });

      // Création compte de trading par défaut
      await prisma.account.create({
        data: {
          userId:  user.id,
          name:    "Compte Principal",
          type:    "Reel",
          balance: 10000,
        },
      });

      // Tokens
      const accessToken  = signAccessToken({ userId: user.id });
      const refreshToken = signRefreshToken({ userId: user.id });

      await prisma.refreshToken.create({
        data: {
          userId:    user.id,   // ← BUG FIX: était "userId" undefined
          token:     refreshToken,
          expiresAt: refreshExpiresAt(),
        },
      });

      // Email de bienvenue (async, ne bloque pas la réponse)
      sendWelcomeEmail({ to: user.email, name: user.name, plan: "basic" }).catch(()=>{});

      res.status(201).json({
        user: userPublic(user),
        accessToken,
        refreshToken,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /login ───────────────────────────────────────────────────
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect." });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect." });
      }

      // Tokens
      const accessToken  = signAccessToken({ userId: user.id });
      const refreshToken = signRefreshToken({ userId: user.id });

      await prisma.refreshToken.create({
        data: {
          userId:    user.id,
          token:     refreshToken,
          expiresAt: refreshExpiresAt(),
        },
      });

      res.json({
        user: userPublic(user),
        accessToken,
        refreshToken,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /refresh ─────────────────────────────────────────────────
router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token manquant." });
    }

    // Vérifie le JWT
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ error: "Refresh token invalide ou expiré." });
    }

    // Vérifie en DB (rotation de token)
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    if (!stored || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: "Refresh token révoqué ou expiré." });
    }

    // Rotation : supprime l'ancien, crée un nouveau
    await prisma.refreshToken.delete({ where: { token: refreshToken } });

    const newAccessToken  = signAccessToken({ userId: payload.userId });
    const newRefreshToken = signRefreshToken({ userId: payload.userId });

    await prisma.refreshToken.create({
      data: {
        userId:    payload.userId,
        token:     newRefreshToken,
        expiresAt: refreshExpiresAt(),
      },
    });

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /logout ──────────────────────────────────────────────────
router.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.json({ message: "Déconnecté avec succès." });
  } catch (err) {
    next(err);
  }
});

// ── GET /me ───────────────────────────────────────────────────────
router.get("/me", authenticate, async (req, res) => {
  res.json({ user: userPublic(req.user) });
});

module.exports = router;
