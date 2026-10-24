import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  schemas,
  can,
  charge,
  received,
  dayInPKT,
  patientNumber,
  type Entity,
  type User,
} from "@clearview/shared";
import { db, client, records, users, operations, audit } from "./db.js";
import { auth, secret, type Authed } from "./auth.js";
import { allowed, project } from "./policy.js";
const wrap =
  (fn: (req: any, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });
const opSchema = z.object({
  id: z.string().uuid(),
  entity: z.enum([
    "patients",
    "visits",
    "payments",
    "expenses",
    "fees",
    "settings",
  ]),
  recordId: z.string().min(1).max(80),
  baseVersion: z.number().int().min(0),
  data: z.record(z.unknown()),
});
export const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) =>
      cb(
        null,
        !origin ||
          (process.env.WEB_ORIGINS || "http://localhost:5173")
            .split(",")
            .includes(origin),
      ),
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
app.get(
  "/api/health",
  wrap(async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/auth/login",
  rateLimit({ windowMs: 900_000, limit: 15 }),
  wrap(async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    const u = await users.findOne({
      email: body.email.toLowerCase(),
      disabled: { $ne: true },
    });
    if (!u || !(await bcrypt.compare(body.password, u.passwordHash)))
      throw fail(401, "Invalid email or password");
    const user: User = {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      permissions: u.permissions,
    };
    res.json({
      user,
      token: jwt.sign({ sv: u.sessionVersion }, secret(), {
        subject: u.id,
        expiresIn: "8h",
        issuer: "clearview",
      }),
    });
  }),
);
app.use("/api", auth);
app.get("/api/auth/me", (req, res) => res.json((req as Authed).user));
app.post(
  "/api/auth/logout",
  wrap(async (req: Authed, res) => {
    await users.updateOne({ id: req.user.id }, { $inc: { sessionVersion: 1 } });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/sync/pull",
  wrap(async (req: Authed, res) => {
    const after = z
      .string()
      .datetime({ offset: true })
      .parse(req.query.after || "1970-01-01T00:00:00.000Z");
    const until = new Date().toISOString();
    const rows = await records
      .find({ updatedAt: { $gt: after, $lte: until } })
      .sort({ updatedAt: 1 })
      .limit(2001)
      .toArray();
    if (rows.length > 2000)
      throw fail(413, "Too many changes. Use paginated snapshot.");
    res.json({
      cursor: until,
      records: rows
        .filter((r) => allowed(req.user, r.entity))
        .map((r) => project(req.user, r)),
    });
  }),
);
app.get(
  "/api/snapshot",
  wrap(async (req: Authed, res) => {
    const skip = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.query.skip || 0);
    const until = z
      .string()
      .datetime({ offset: true })
      .parse(req.query.until || new Date().toISOString());
    const rows = await records
      .find({ updatedAt: { $lte: until } })
      .sort({ _id: 1 })
      .skip(skip)
      .limit(500)
      .toArray();
    res.json({
      cursor: until,
      next: rows.length === 500 ? skip + 500 : null,
      records: rows
        .filter((r) => allowed(req.user, r.entity))
        .map((r) => project(req.user, r)),
    });
  }),
);
app.post(
  "/api/sync/push",
  wrap(async (req: Authed, res) => {
    const op = opSchema.parse(req.body);
    if (!allowed(req.user, op.entity, true))
      throw fail(403, "Permission denied");
    let result: any;
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const duplicate = await operations.findOne({ id: op.id }, { session });
        if (duplicate) {
          if (duplicate.userId !== req.user.id)
            throw fail(403, "Operation belongs to another user");
          result = project(req.user, duplicate.result);
          return;
        }
        const existing = await records.findOne(
          { entity: op.entity, id: op.recordId },
          { session },
        );
        if ((existing?.version || 0) !== op.baseVersion)
          throw Object.assign(
            fail(409, "This record changed on another device"),
            { server: existing ? project(req.user, existing) : null },
          );
        let incoming = { ...op.data };
        if (op.entity === "visits" && req.user.role !== "doctor") {
          if (!can(req.user, "clinical")) {
            if (
              incoming.clinical &&
              JSON.stringify(incoming.clinical) !==
                JSON.stringify(existing?.data.clinical)
            )
              throw fail(403, "Clinical permission required");
            incoming.clinical = existing?.data.clinical;
          }
          if (!can(req.user, "financial")) {
            if (existing) {
              incoming.fee = existing.data.fee;
              incoming.discount = existing.data.discount;
              incoming.waived = existing.data.waived;
            } else {
              const fees = await records
                .find({ entity: "fees" }, { session })
                .sort({ "data.effectiveDate": -1 })
                .toArray();
              const f = fees.find(
                (f) =>
                  f.data.effectiveDate <=
                  dayInPKT(String(incoming.scheduledAt)),
              );
              incoming.fee = f
                ? incoming.type === "new"
                  ? f.data.standard
                  : f.data.followUp
                : 0;
              incoming.discount = 0;
              incoming.waived = false;
            }
          }
        }
        const data = schemas[op.entity].parse(incoming) as any;
        if (data.id !== op.recordId)
          throw fail(422, "Record ID does not match");
        if (existing && data.createdAt !== existing.data.createdAt)
          throw fail(422, "Original timestamp cannot change");
        if (!existing && op.baseVersion !== 0)
          throw fail(409, "Missing record");
        if (
          op.entity === "patients" &&
          !existing &&
          data.patientNumber !== patientNumber(data.id)
        )
          throw fail(
            422,
            "Patient number must be generated from its permanent ID",
          );
        if (
          op.entity === "patients" &&
          existing &&
          data.patientNumber !== existing.data.patientNumber
        )
          throw fail(422, "Patient number is permanent");
        if (op.entity === "payments" && existing)
          throw fail(422, "Payments are immutable; record an explicit refund");
        if (op.entity === "fees" && existing)
          throw fail(
            422,
            "Fee schedules are immutable; create a new effective date",
          );
        if (op.entity === "visits") {
          const patient = await records.findOne(
            { entity: "patients", id: data.patientId },
            { session },
          );
          if (!patient) throw fail(422, "Patient must synchronize first");
          if (existing && data.patientId !== existing.data.patientId)
            throw fail(422, "Visit patient cannot change");
          if (
            existing?.data.status === "completed" &&
            req.user.role !== "doctor"
          )
            throw fail(
              403,
              "Doctor authorization required to amend finalized visit",
            );
          if (data.status === "cancelled" && !data.cancellationReason.trim())
            throw fail(422, "Cancellation reason required");
          const pays = await records
            .find({ entity: "payments", "data.visitId": data.id }, { session })
            .toArray();
          if (pays.reduce((s, p) => s + received(p.data), 0) > charge(data))
            throw fail(
              422,
              "Refund payments before reducing or cancelling the charge",
            );
        }
        if (op.entity === "payments") {
          const visit = await records.findOne(
            { entity: "visits", id: data.visitId },
            { session },
          );
          if (!visit || visit.data.status !== "completed")
            throw fail(422, "Only completed consultations can be paid");
          const pays = await records
            .find(
              { entity: "payments", "data.visitId": data.visitId },
              { session },
            )
            .toArray();
          const net =
            pays.reduce((s, p) => s + received(p.data), 0) + received(data);
          if (net < 0 || net > charge(visit.data))
            throw fail(
              422,
              "Payment exceeds balance or refund exceeds collected amount",
            );
          if (data.kind === "refund" && !data.reason.trim())
            throw fail(422, "Refund reason required");
          await records.updateOne(
            { _id: visit._id },
            { $inc: { financeRevision: 1 } },
            { session },
          );
        }
        const row = {
          entity: op.entity,
          id: op.recordId,
          data,
          version: (existing?.version || 0) + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user.id,
        };
        await records.updateOne(
          { entity: op.entity, id: op.recordId },
          { $set: row },
          { upsert: true, session },
        );
        await audit.insertOne(
          {
            id: crypto.randomUUID(),
            at: row.updatedAt,
            userId: req.user.id,
            operationId: op.id,
            entity: op.entity,
            recordId: op.recordId,
            before: existing?.data || null,
            after: data,
          },
          { session },
        );
        result = project(req.user, row);
        await operations.insertOne(
          { id: op.id, userId: req.user.id, result, at: row.updatedAt },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    res.json(result);
  }),
);
app.get(
  "/api/users",
  wrap(async (req: Authed, res) => {
    if (req.user.role !== "doctor") throw fail(403, "Doctor only");
    res.json(
      await users
        .find(
          {},
          { projection: { _id: 0, passwordHash: 0, sessionVersion: 0 } },
        )
        .toArray(),
    );
  }),
);
app.post(
  "/api/users",
  wrap(async (req: Authed, res) => {
    if (req.user.role !== "doctor") throw fail(403, "Doctor only");
    const b = z
      .object({
        name: z.string().min(2).max(150),
        email: z.string().email(),
        password: z.string().min(12).max(100),
        permissions: z.array(z.enum(["clinical", "financial", "expenses"])),
      })
      .parse(req.body);
    const row = {
      id: crypto.randomUUID(),
      name: b.name,
      email: b.email.toLowerCase(),
      role: "attendant",
      permissions: b.permissions,
      passwordHash: await bcrypt.hash(b.password, 12),
      sessionVersion: 1,
      disabled: false,
    };
    await users.insertOne(row);
    await audit.insertOne({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      userId: req.user.id,
      action: "staff_created",
      recordId: row.id,
    });
    res.status(201).json({ id: row.id });
  }),
);
app.patch(
  "/api/users/:id",
  wrap(async (req: Authed, res) => {
    if (req.user.role !== "doctor") throw fail(403, "Doctor only");
    const b = z
      .object({
        permissions: z.array(z.enum(["clinical", "financial", "expenses"])),
        disabled: z.boolean(),
      })
      .parse(req.body);
    const target = await users.findOne({
      id: req.params.id,
      role: "attendant",
    });
    if (!target) throw fail(404, "Attendant not found");
    await users.updateOne(
      { id: target.id },
      { $set: b, $inc: { sessionVersion: 1 } },
    );
    await audit.insertOne({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      userId: req.user.id,
      action: "staff_permissions_updated",
      recordId: target.id,
      before: { permissions: target.permissions, disabled: target.disabled },
      after: b,
    });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/audit",
  wrap(async (req: Authed, res) => {
    if (req.user.role !== "doctor") throw fail(403, "Doctor only");
    res.json(
      await audit
        .find({}, { projection: { _id: 0, before: 0, after: 0 } })
        .sort({ at: -1 })
        .limit(200)
        .toArray(),
    );
  }),
);
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError)
    return void res.status(422).json({
      error: error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
  if (error.code === 11000)
    return void res
      .status(409)
      .json({ error: "Duplicate identifier; synchronize and retry" });
  res.status(error.status || 500).json({
    error: error.status ? error.message : "Request failed. Please retry.",
    ...(error.server ? { server: error.server } : {}),
  });
});
