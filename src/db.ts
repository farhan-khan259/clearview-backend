import { MongoClient } from "mongodb";
import "dotenv/config";
const mongodbUri = process.env.MONGODB_URI || process.env.MONGODB_URL;
if (!mongodbUri) throw new Error("MONGODB_URI is required");
export const client = new MongoClient(mongodbUri);
export const db = client.db(
  process.env.MONGODB_DATABASE || process.env.MONGODB_DB_NAME || "clearview",
);
export const records = db.collection("records");
export const users = db.collection("users");
export const operations = db.collection("operations");
export const audit = db.collection("audit");
export async function connect() {
  await client.connect();
  await Promise.all([
    records.createIndex({ entity: 1, id: 1 }, { unique: true }),
    records.createIndex(
      { entity: 1, "data.patientNumber": 1 },
      { unique: true, partialFilterExpression: { entity: "patients" } },
    ),
    records.createIndex({ entity: 1, "data.name": 1 }),
    records.createIndex({ entity: 1, "data.scheduledAt": 1 }),
    records.createIndex({ entity: 1, "data.patientId": 1 }),
    records.createIndex({ updatedAt: 1 }),
    users.createIndex({ email: 1 }, { unique: true }),
    operations.createIndex({ id: 1 }, { unique: true }),
    audit.createIndex({ at: 1 }),
  ]);
}
