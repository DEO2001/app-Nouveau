// ─────────────────────────────────────────────────────────────────
// EDGELOG — Tests Auth Routes (v2)
// npx jest auth.test.js --verbose
//
// Corrections v2 :
//   - Mock Prisma global (__mocks__/prisma.js) au lieu d'un mock inline
//   - Helpers factories pour les données de test
//   - /health aligné avec package.json version 1.0.0
//   - Cas limites ajoutés : refresh, /me, token expiré
// ─────────────────────────────────────────────────────────────────
"use strict";

const request = require("supertest");
const bcrypt  = require("bcryptjs");

jest.mock("../src/lib/prisma");
jest.mock("../src/lib/email", () => ({
  sendWelcomeEmail:       jest.fn().mockResolvedValue({ success: true }),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ success: true }),
}));

const app    = require("../src/index");
const prisma = require("../src/lib/prisma");

const { makeUser, makeAccessToken, makeRefreshToken, makeExpiredToken } = require("./helpers/factories");
const { authPayloads } = require("./fixtures");

// ─────────────────────────────────────────────────────────────────
describe("GET /health", () => {
  it("retourne status ok avec la version 1.0.0", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.version).toBe("1.0.0");
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/auth/register", () => {
  it("crée un compte avec email/password valides", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const user = makeUser({ email: authPayloads.registerValid.email });
    prisma.user.create.mockResolvedValue(user);
    prisma.account.create.mockResolvedValue({ id: "acc1" });
    prisma.refreshToken.create.mockResolvedValue({ id: "rt1" });

    const res = await request(app)
      .post("/api/auth/register")
      .send(authPayloads.registerValid);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
    expect(res.body.user.email).toBe(authPayloads.registerValid.email);
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("retourne 409 si l'email existe déjà", async () => {
    prisma.user.findUnique.mockResolvedValue(makeUser());

    const res = await request(app)
      .post("/api/auth/register")
      .send(authPayloads.registerValid);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/existe déjà/);
  });

  it("retourne 400 si le mot de passe est trop court", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(authPayloads.registerWeakPassword);

    expect(res.status).toBe(400);
  });

  it("retourne 400 si l'email est invalide", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(authPayloads.registerInvalidEmail);

    expect(res.status).toBe(400);
  });

  it("retourne 400 si le nom est manquant", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "test@test.com", password: "SecurePass123!" });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/auth/login", () => {
  it("retourne les tokens avec des identifiants valides", async () => {
    const passwordHash = await bcrypt.hash("Password123!", 4);
    prisma.user.findUnique.mockResolvedValue(
      makeUser({ email: "trader@test.com", passwordHash })
    );
    prisma.refreshToken.create.mockResolvedValue({ id: "rt1" });

    const res = await request(app)
      .post("/api/auth/login")
      .send(authPayloads.loginValid);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("retourne 401 avec un mauvais mot de passe", async () => {
    const passwordHash = await bcrypt.hash("correctpassword", 4);
    prisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));

    const res = await request(app)
      .post("/api/auth/login")
      .send(authPayloads.loginWrongPassword);

    expect(res.status).toBe(401);
  });

  it("retourne 401 si l'utilisateur n'existe pas", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "inconnu@test.com", password: "Password123!" });

    expect(res.status).toBe(401);
  });

  it("retourne 400 si l'email est manquant", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "Password123!" });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/auth/refresh", () => {
  it("retourne un nouvel accessToken avec un refreshToken valide", async () => {
    const user = makeUser();
    const rt   = makeRefreshToken(user.id);

    prisma.refreshToken.findUnique.mockResolvedValue({
      id: "rt1", token: rt, userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    });
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: rt });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
  });

  it("retourne 401 avec un refreshToken invalide", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "token_invalide" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("POST /api/auth/logout", () => {
  it("déconnecte et invalide le refresh token", async () => {
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post("/api/auth/logout")
      .send({ refreshToken: makeRefreshToken("u1") });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Déconnecté/);
  });

  it("retourne 200 même si le token n'existait pas (idempotent)", async () => {
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post("/api/auth/logout")
      .send({ refreshToken: "token_inexistant" });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("GET /api/auth/me (middleware authenticate)", () => {
  it("retourne le profil de l'utilisateur connecté", async () => {
    const user  = makeUser();
    const token = makeAccessToken(user.id);
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("retourne 401 sans token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("retourne 401 avec un token expiré", async () => {
    const token = makeExpiredToken("u1");

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it("retourne 401 avec un token malformé", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer token.invalide");

    expect(res.status).toBe(401);
  });

  it("retourne 401 si l'utilisateur a été supprimé", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const token = makeAccessToken("user_supprime");

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
  });
});
