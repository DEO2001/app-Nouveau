// ─────────────────────────────────────────────────────────────────
// EDGELOG — Helpers de test
// Factories, générateurs de tokens, utilitaires partagés
// ─────────────────────────────────────────────────────────────────
"use strict";

const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcryptjs");

// ── Factories utilisateurs ────────────────────────────────────────

let _userCounter = 1;

function makeUser(overrides = {}) {
  const id = overrides.id || `user_${_userCounter++}`;
  return {
    id,
    email:          overrides.email    || `trader${id}@test.com`,
    name:           overrides.name     || "Test Trader",
    passwordHash:   overrides.passwordHash || bcrypt.hashSync("Password123!", 4), // rounds réduits pour la vitesse
    plan:           overrides.plan     || "basic",
    avatar:         overrides.avatar   || null,
    stripeCustomerId:     overrides.stripeCustomerId     || null,
    stripeSubscriptionId: overrides.stripeSubscriptionId || null,
    stripeStatus:         overrides.stripeStatus         || null,
    trialStart:     overrides.trialStart  || new Date().toISOString(),
    createdAt:      overrides.createdAt   || new Date(),
    updatedAt:      overrides.updatedAt   || new Date(),
    provider:       overrides.provider    || null,
    providerId:     overrides.providerId  || null,
    ...overrides,
  };
}

function makeBasicUser(overrides = {})   { return makeUser({ plan: "basic",   ...overrides }); }
function makePremiumUser(overrides = {}) { return makeUser({ plan: "premium", ...overrides }); }
function makeProUser(overrides = {})     { return makeUser({ plan: "pro",     ...overrides }); }

// ── Factory comptes ───────────────────────────────────────────────

let _accountCounter = 1;

function makeAccount(userId, overrides = {}) {
  const id = overrides.id || `acc_${_accountCounter++}`;
  return {
    id,
    userId,
    name:       overrides.name    || "Compte Principal",
    type:       overrides.type    || "Reel",
    balance:    overrides.balance || 10000,
    currency:   overrides.currency || "$",
    broker:     overrides.broker  || null,
    createdAt:  new Date(),
    updatedAt:  new Date(),
    ...overrides,
  };
}

// ── Factory trades ────────────────────────────────────────────────

let _tradeCounter = 1;

function makeTrade(userId, accountId, overrides = {}) {
  const id = overrides.id || `trade_${_tradeCounter++}`;
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  return {
    id,
    userId,
    accountId,
    asset:          overrides.asset      || "BTC/USD",
    direction:      overrides.direction  || "LONG",
    status:         overrides.status     || "CLOSED",
    date:           overrides.date       || daysAgo(1),
    time:           overrides.time       || "09:30",
    entry:          overrides.entry      || 50000,
    exit:           overrides.exit       || 51000,
    sl:             overrides.sl         || 49000,
    tp:             overrides.tp         || 52000,
    size:           overrides.size       || 0.1,
    fees:           overrides.fees       || 5,
    pnl:            overrides.pnl        || 95,       // (51000 - 50000) * 0.1 - 5
    rMultiple:      overrides.rMultiple  || 1.0,
    setup:          overrides.setup      || "Breakout",
    emotion_before: overrides.emotion_before || "Calme",
    emotion_after:  overrides.emotion_after  || "Satisfait",
    notes:          overrides.notes      || "",
    tags:           overrides.tags       || ["plan-respecté"],
    checklist:      overrides.checklist  || [true, true, true, true, true],
    importSource:   overrides.importSource   || null,
    externalId:     overrides.externalId     || null,
    createdAt:      new Date(),
    updatedAt:      new Date(),
    ...overrides,
  };
}

function makeWinTrade(userId, accountId, overrides = {}) {
  return makeTrade(userId, accountId, { pnl: 200, rMultiple: 2.0, ...overrides });
}

function makeLossTrade(userId, accountId, overrides = {}) {
  return makeTrade(userId, accountId, { pnl: -100, rMultiple: -1.0, exit: 49000, ...overrides });
}

function makeOpenTrade(userId, accountId, overrides = {}) {
  return makeTrade(userId, accountId, { status: "OPEN", exit: null, pnl: null, ...overrides });
}

// ── Générateurs de tokens JWT ─────────────────────────────────────

function makeAccessToken(userId, extra = {}) {
  return jwt.sign(
    { userId, ...extra },
    process.env.JWT_SECRET || "test-jwt-secret-super-long-pour-les-tests-unitaires-jest-2024",
    { expiresIn: "15m" }
  );
}

function makeRefreshToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET || "test-refresh-secret-super-long-pour-les-tests-jest-2024",
    { expiresIn: "7d" }
  );
}

function makeExpiredToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || "test-jwt-secret-super-long-pour-les-tests-unitaires-jest-2024",
    { expiresIn: "-1s" } // Expiré immédiatement
  );
}

// ── Headers d'autorisation ────────────────────────────────────────

function authHeader(userId) {
  return { Authorization: `Bearer ${makeAccessToken(userId)}` };
}

// ── Factory mentor relation ───────────────────────────────────────

function makeMentorRelation(mentorId, studentId, overrides = {}) {
  return {
    id:        `rel_${mentorId}_${studentId}`,
    mentorId,
    studentId,
    access:    overrides.access    || "read",
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Utilitaires ───────────────────────────────────────────────────

// Génère N trades avec mix de wins/losses
function makeTradeList(userId, accountId, count = 10, winRate = 0.6) {
  return Array.from({ length: count }, (_, i) => {
    const isWin = i / count < winRate;
    return isWin
      ? makeWinTrade(userId, accountId, { date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10) })
      : makeLossTrade(userId, accountId, { date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10) });
  });
}

// Wrapper pour les assertions async
async function expectError(promise, statusCode, errorMsg) {
  const res = await promise;
  expect(res.status).toBe(statusCode);
  if (errorMsg) expect(res.body.error).toMatch(errorMsg);
  return res;
}

module.exports = {
  // Factories
  makeUser, makeBasicUser, makePremiumUser, makeProUser,
  makeAccount,
  makeTrade, makeWinTrade, makeLossTrade, makeOpenTrade, makeTradeList,
  makeMentorRelation,
  // Tokens & auth
  makeAccessToken, makeRefreshToken, makeExpiredToken,
  authHeader,
  // Utilitaires
  expectError,
};
