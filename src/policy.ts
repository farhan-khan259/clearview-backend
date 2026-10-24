import { can, type User, type Entity } from "@clearview/shared";
export function allowed(u: User, e: Entity, write = false) {
  if (u.role === "doctor") return true;
  if (e === "patients") return true;
  if (e === "visits") return true;
  if (e === "fees") return !write && can(u, "financial");
  if (e === "payments") return can(u, "financial");
  if (e === "expenses") return can(u, "expenses");
  return !write;
}
export function project(u: User, row: any) {
  if (row.entity !== "visits") return row;
  const out = { ...row, data: { ...row.data } };
  if (!can(u, "clinical")) delete out.data.clinical;
  if (!can(u, "financial")) {
    delete out.data.fee;
    delete out.data.discount;
    delete out.data.waived;
  }
  return out;
}
