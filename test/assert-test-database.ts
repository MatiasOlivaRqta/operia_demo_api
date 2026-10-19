import { assertTestDatabaseUrl } from "../src/config/test-database.guard.js";

assertTestDatabaseUrl(process.env.DATABASE_URL);
