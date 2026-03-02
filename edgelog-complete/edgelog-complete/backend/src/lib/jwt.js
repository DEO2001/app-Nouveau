const jwt = require("jsonwebtoken");

const ACCESS_SECRET  = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_EXP     = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_EXP    = process.env.JWT_REFRESH_EXPIRES_IN || "30d";

/**
 * Signe un access token (courte durée)
 */
function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXP });
}

/**
 * Signe un refresh token (longue durée)
 */
function signRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXP });
}

/**
 * Vérifie un access token
 */
function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

/**
 * Vérifie un refresh token
 */
function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

/**
 * Calcule la date d'expiration du refresh token
 */
function refreshExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  refreshExpiresAt,
};
