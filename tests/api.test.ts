import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import bcrypt from "bcryptjs";
let repl: MongoMemoryReplSet,
  request: any,
  db: any,
  client: any,
  token: string,
  attendant: string;
const uuid = () => crypto.randomUUID(),
  at = () => new Date().toISOString();
let patient: any, visit: any;
let lastOp: any;
const op = (entity: string, data: any, baseVersion = 0) => ({
  id: uuid(),
  entity,
  recordId: data.id,
  baseVersion,
  data,
});
const push = (o: any, t = token) =>
  request
    .post("/api/sync/push")
    .set("Authorization", "Bearer " + t)
    .send(o);
before(
  async () => {
    repl = await MongoMemoryReplSet.create({
      instanceOpts: [{ args: ["--nounixsocket"] }],
      replSet: { count: 1, storageEngine: "wiredTiger" },
      binary: { version: "7.0.14" },
    });
    process.env.MONGODB_URI = repl.getUri();
    process.env.JWT_SECRET = crypto.randomUUID() + crypto.randomUUID();
    process.env.MONGODB_DATABASE = "clearview_test";
    const database = await import("../src/db.js");
    db = database.db;
    client = database.client;
    await database.connect();
    const { app } = await import("../src/app.js");
    request = supertest(app);
    for (const [email, role] of [
      ["doctor@test.com", "doctor"],
      ["attendant@test.com", "attendant"],
    ])
      await database.users.insertOne({
        id: uuid(),
        name: role,
        email,
        role,
        permissions:
          role === "doctor" ? ["clinical", "financial", "expenses"] : [],
        passwordHash: await bcrypt.hash("test-password-123", 4),
        sessionVersion: 1,
      });
    token = (
      await request
        .post("/api/auth/login")
        .send({ email: "doctor@test.com", password: "test-password-123" })
    ).body.token;
    attendant = (
      await request
        .post("/api/auth/login")
        .send({ email: "attendant@test.com", password: "test-password-123" })
    ).body.token;
    assert.ok(token);
    assert.ok(attendant);
  },
  { timeout: 120000 },
);
after(async () => {
  await client?.close();
  await repl?.stop();
});
test("protected API requires authentication", async () => {
  assert.equal((await request.get("/api/snapshot")).status, 401);
});
test("register patient and retry safely without duplicate", async () => {
  const id = uuid();
  patient = {
    id,
    patientNumber: "CV-" + id,
    name: "Synthetic Test Patient",
    age: 42,
    address: "Test locality",
    phone: "",
    gender: "male",
    createdAt: at(),
  };
  lastOp = op("patients", patient);
  assert.equal((await push(lastOp)).status, 200);
  assert.equal((await push(lastOp)).status, 200);
  assert.equal(
    await db.collection("records").countDocuments({ entity: "patients" }),
    1,
  );
});
test("returning visit keeps one patient profile, optional notes", async () => {
  visit = {
    id: uuid(),
    patientId: patient.id,
    createdAt: at(),
    scheduledAt: at(),
    type: "follow_up",
    status: "completed",
    fee: 200000,
    discount: 20000,
    waived: false,
    cancellationReason: "",
  };
  const r = await push(op("visits", visit));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.clinical, undefined);
  assert.equal(
    await db.collection("records").countDocuments({ entity: "patients" }),
    1,
  );
});
test("partial payment, refund, immutable ledger and limits", async () => {
  const p = {
    id: uuid(),
    visitId: visit.id,
    amount: 100000,
    kind: "payment",
    method: "cash",
    createdAt: at(),
    reason: "",
  };
  lastOp = op("payments", p);
  assert.equal((await push(lastOp)).status, 200);
  assert.equal((await push(lastOp)).status, 200);
  assert.equal(
    (await push(op("payments", { ...p, amount: 90000 }, 1))).status,
    422,
  );
  assert.equal(
    (await push(op("payments", { ...p, id: uuid(), amount: 100000 }))).status,
    422,
  );
  assert.equal(
    (
      await push(
        op("payments", {
          ...p,
          id: uuid(),
          kind: "refund",
          amount: 20000,
          reason: "Test refund",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await push(
        op("payments", {
          ...p,
          id: uuid(),
          kind: "refund",
          amount: 100000,
          reason: "Too much",
        }),
      )
    ).status,
    422,
  );
  assert.equal(
    await db.collection("records").countDocuments({ entity: "payments" }),
    2,
  );
});
test("cannot cancel a paid visit until refunded", async () => {
  assert.equal(
    (
      await push(
        op(
          "visits",
          { ...visit, status: "cancelled", cancellationReason: "Test" },
          1,
        ),
      )
    ).status,
    422,
  );
});
test("concurrent collections cannot overpay", async () => {
  const p = {
    visitId: visit.id,
    amount: 70000,
    kind: "payment",
    method: "bank",
    createdAt: at(),
    reason: "",
  };
  const results = await Promise.all([
    push(op("payments", { ...p, id: uuid() })),
    push(op("payments", { ...p, id: uuid() })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 422).length, 1);
});
test("optimistic conflict returns authoritative version", async () => {
  const a = await push(
    op("patients", { ...patient, address: "Updated locality" }, 1),
  );
  assert.equal(a.status, 200);
  const b = await push(
    op("patients", { ...patient, address: "Conflicting locality" }, 1),
  );
  assert.equal(b.status, 409);
  assert.equal(b.body.server.data.address, "Updated locality");
});
test("attendant financial writes rejected and clinical values redacted", async () => {
  assert.equal(
    (
      await push(
        op("expenses", {
          id: uuid(),
          title: "Test",
          category: "miscellaneous",
          amount: 200,
          method: "cash",
          date: "2026-10-22",
          description: "",
          createdAt: at(),
        }),
        attendant,
      )
    ).status,
    403,
  );
  const r = await request
    .get("/api/snapshot")
    .set("Authorization", "Bearer " + attendant);
  const row = r.body.records.find((r: any) => r.entity === "visits");
  assert.equal(row.data.fee, undefined);
  assert.equal(row.data.clinical, undefined);
  assert.equal(
    r.body.records.some((r: any) => r.entity === "payments"),
    false,
  );
  assert.equal(
    (
      await request
        .get("/api/users")
        .set("Authorization", "Bearer " + attendant)
    ).status,
    403,
  );
});
test("attendant cannot change fee schedules or finalized consultation", async () => {
  assert.equal(
    (
      await push(
        op("fees", {
          id: uuid(),
          standard: 100,
          followUp: 100,
          effectiveDate: "2026-10-22",
          createdAt: at(),
        }),
        attendant,
      )
    ).status,
    403,
  );
  assert.equal((await push(op("visits", visit, 1), attendant)).status, 403);
});
test("every accepted financial operation has audit history", async () => {
  const n = await db
    .collection("records")
    .countDocuments({ entity: "payments" });
  assert.equal(
    await db.collection("audit").countDocuments({ entity: "payments" }),
    n,
  );
});
