// Server-side recovery: removes every passkey and session, so the next server start prints a new setup code.
// This is the only way back in if all passkeys are lost; it needs shell access to the server, by design.
//
//   npm run auth:reset -- --yes
import { openAuthDb, resetAuth } from "../src/auth.ts";
import { authDbPath, loadDotEnv } from "../src/config.ts";

loadDotEnv();
const file = authDbPath();
if (!process.argv.includes("--yes")) {
  console.error(`This removes every passkey and signs everyone out of ${file}.\nRun again with --yes to confirm.`);
  process.exit(1);
}
const db = openAuthDb(file);
const { n } = db.prepare("SELECT COUNT(*) AS n FROM auth_credentials").get() as { n: number };
resetAuth(db);
db.close();
console.log(`Removed ${n} passkey(s) and all sessions. Restart the server: it will print a new one-time setup code.`);
