// Builds the frontend when frontend/dist is missing or older than its sources.
// Called by the root `npm start` and `npm run demo` so the backend always serves a current build.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.QORVEX_SKIP_WEB_BUILD === "1") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(root, "dist", "index.html");

function newest(p) {
  if (!fs.existsSync(p)) return 0;
  const s = fs.statSync(p);
  if (!s.isDirectory()) return s.mtimeMs;
  return Math.max(s.mtimeMs, ...fs.readdirSync(p).map((f) => newest(path.join(p, f))));
}

const sources = ["src", "public", "index.html", "vite.config.ts", "package.json"].map((f) => newest(path.join(root, f)));
const stale = !fs.existsSync(built) || Math.max(...sources) > fs.statSync(built).mtimeMs;
if (stale) {
  console.log("Building the Qorvex frontend (frontend/dist)...");
  const r = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
