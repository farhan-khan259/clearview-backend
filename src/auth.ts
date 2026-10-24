import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { users } from "./db.js";
import type { User } from "@clearview/shared";
export interface Authed extends Request {
  user: User;
}
export function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 48)
    throw new Error("JWT_SECRET must contain at least 48 characters");
  return s;
}
export async function auth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) return void res.status(401).json({ error: "Sign in required" });
    const claims = jwt.verify(token, secret(), {
      algorithms: ["HS256"],
      issuer: "clearview",
    }) as jwt.JwtPayload;
    const u = await users.findOne({ id: claims.sub, disabled: { $ne: true } });
    if (!u || u.sessionVersion !== claims.sv)
      return void res.status(401).json({ error: "Session expired" });
    (req as Authed).user = {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      permissions: u.permissions,
    };
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Sign in again." });
  }
}
