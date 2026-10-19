import { URL } from "node:url";

export function assertTestDatabaseUrl(url: string | undefined): void {
  let databaseName: string | undefined;
  try {
    databaseName = url ? decodeURIComponent(new URL(url).pathname.slice(1)) : undefined;
  } catch {
    databaseName = undefined;
  }

  if (databaseName !== "operia_test") {
    throw new Error(
      "Los tests E2E solo pueden ejecutarse contra la base operia_test. Configurá DATABASE_URL=.../operia_test; no se ejecutarán contra la base de desarrollo.",
    );
  }
}
