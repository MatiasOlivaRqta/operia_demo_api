import "dotenv/config";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error(
    "DATABASE_URL_TEST es obligatorio para e2e; no se ejecutarán pruebas contra la base de desarrollo.",
  );
}

const parsedUrl = new URL(testUrl);
if (decodeURIComponent(parsedUrl.pathname) !== "/operia_test") {
  throw new Error("DATABASE_URL_TEST debe apuntar a la base operia_test.");
}

const childEnv = { ...process.env, DATABASE_URL: testUrl };
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  const result = spawnSync(packageManager, args, {
    env: childEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["exec", "prisma", "migrate", "deploy"]);
run(["exec", "prisma", "generate"]);
run(["exec", "prisma", "db", "seed"]);
run(["exec", "vitest", "run", "--config", "vitest.e2e.config.mts"]);
