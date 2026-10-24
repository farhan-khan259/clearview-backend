import { connect, users, client } from "./db.js";
import bcrypt from "bcryptjs";
await connect();
const {
  DOCTOR_EMAIL: email,
  DOCTOR_PASSWORD: password,
  DOCTOR_NAME: name,
} = process.env;
if (!email || !password || password.length < 12)
  throw new Error(
    "Set DOCTOR_EMAIL, DOCTOR_NAME and a password of at least 12 characters",
  );
if (await users.countDocuments({ role: "doctor" }))
  throw new Error("Doctor already exists; bootstrap refused");
await users.insertOne({
  id: crypto.randomUUID(),
  email: email.toLowerCase(),
  name: name || "Doctor",
  role: "doctor",
  permissions: ["clinical", "financial", "expenses"],
  passwordHash: await bcrypt.hash(password, 12),
  sessionVersion: 1,
  disabled: false,
});
console.log("Doctor created");
await client.close();
