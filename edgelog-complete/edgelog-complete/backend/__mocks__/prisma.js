// ─────────────────────────────────────────────────────────────────
// EDGELOG — Mock Prisma Client
// Placé dans __mocks__/ → utilisé automatiquement par Jest
// quand les tests font : jest.mock("../src/lib/prisma")
//
// Couvre tous les modèles utilisés dans EDGELOG :
//   user, account, trade, refreshToken, mentorRelation, feedback,
//   subscription, brokerConnection
// ─────────────────────────────────────────────────────────────────
"use strict";

// Fabrique un objet mock complet pour un modèle Prisma
function createModelMock() {
  return {
    findUnique:  jest.fn(),
    findFirst:   jest.fn(),
    findMany:    jest.fn(),
    create:      jest.fn(),
    update:      jest.fn(),
    upsert:      jest.fn(),
    delete:      jest.fn(),
    deleteMany:  jest.fn(),
    count:       jest.fn(),
    groupBy:     jest.fn(),
    aggregate:   jest.fn(),
    // Prisma transactions
    createMany:  jest.fn(),
    updateMany:  jest.fn(),
  };
}

const prismaMock = {
  // ── Modèles ──────────────────────────────────────────────────
  user:             createModelMock(),
  account:          createModelMock(),
  trade:            createModelMock(),
  refreshToken:     createModelMock(),
  mentorRelation:   createModelMock(),
  feedback:         createModelMock(),
  subscription:     createModelMock(),
  brokerConnection: createModelMock(),

  // ── Méthodes Prisma client ─────────────────────────────────
  $connect:    jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  $transaction: jest.fn(async (fn) => {
    // Simule une transaction en appelant la fonction avec le mock lui-même
    if (typeof fn === "function") return fn(prismaMock);
    if (Array.isArray(fn)) return Promise.all(fn);
    return fn;
  }),
  $queryRaw:   jest.fn().mockResolvedValue([]),
  $executeRaw: jest.fn().mockResolvedValue(0),
};

module.exports = prismaMock;
