import { app } from "./app.js";
import { connect, client } from "./db.js";
import { secret } from "./auth.js";
secret();
await connect();
const server = app.listen(Number(process.env.PORT) || 4000, () =>
  console.log("Clearview API ready"),
);
process.on("SIGTERM", () => server.close(() => void client.close()));
