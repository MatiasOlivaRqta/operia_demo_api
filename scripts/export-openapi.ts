import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openApiDocument } from "../src/docs/openapi.js";

await writeFile(
  resolve(process.cwd(), "openapi.json"),
  `${JSON.stringify(openApiDocument, null, 2)}\n`,
  "utf8",
);
