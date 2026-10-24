import { test } from "node:test";
import assert from "node:assert/strict";
import {
  totals,
  charge,
  received,
  patientSchema,
  visitSchema,
  patientNumber,
  applicableFee,
  dayInPKT,
  type Visit,
} from "@clearview/shared";
import { allowed, project } from "../src/policy.js";
const v = {
  id: crypto.randomUUID(),
  patientId: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  scheduledAt: new Date().toISOString(),
  type: "new",
  status: "completed",
  fee: 200000,
  discount: 20000,
  waived: false,
  cancellationReason: "",
} as Visit;
test("partial payment, refund and expense reflect actual cash and outstanding", () => {
  const p: any = [
    { amount: 100000, kind: "payment" },
    { amount: 10000, kind: "refund" },
  ];
  assert.deepEqual(totals([v], p, [{ amount: 25000 } as any]), {
    charged: 180000,
    collected: 90000,
    expenses: 25000,
    outstanding: 90000,
    profit: 65000,
  });
});
test("cancelled, waiting and waived consultations do not earn fees", () => {
  for (const status of [
    "cancelled",
    "waiting",
    "scheduled",
    "no_show",
  ] as const)
    assert.equal(charge({ ...v, status }), 0);
  assert.equal(charge({ ...v, waived: true }), 0);
});
test("notes and prescription are optional", () => {
  assert.equal(visitSchema.safeParse(v).success, true);
});
test("invalid discount and missing patient identification rejected", () => {
  assert.equal(
    visitSchema.safeParse({ ...v, discount: 300000 }).success,
    false,
  );
  assert.equal(patientSchema.safeParse({ name: "Test" }).success, false);
});
test("permanent offline identifiers do not depend on device clock", () => {
  const ids = new Set(
    Array.from({ length: 10000 }, () => patientNumber(crypto.randomUUID())),
  );
  assert.equal(ids.size, 10000);
});
test("fee schedule does not alter historical visit", () => {
  assert.equal(
    applicableFee(
      [
        {
          id: "x",
          standard: 500000,
          followUp: 200000,
          effectiveDate: "2026-11-01",
          createdAt: "",
        },
      ],
      "2026-10-22",
      "new",
    ),
    0,
  );
  assert.equal(charge(v), 180000);
});
test("attendant cannot see financial or clinical records", () => {
  const u: any = { role: "attendant", permissions: [] };
  assert.equal(allowed(u, "payments"), false);
  assert.equal(allowed(u, "settings", true), false);
  const out = project(u, {
    entity: "visits",
    data: {
      clinical: { diagnosis: "private" },
      fee: 20,
      discount: 0,
      waived: false,
      status: "waiting",
    },
  });
  assert.equal(out.data.clinical, undefined);
  assert.equal(out.data.fee, undefined);
  assert.equal(out.data.status, "waiting");
});
test("clinic day uses Pakistan midnight", () => {
  assert.equal(dayInPKT("2026-10-21T20:01:00Z"), "2026-10-22");
});
