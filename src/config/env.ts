import "dotenv/config";
import { envSchema } from "./env.schema.js";

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const invalidVariables = [
    ...new Set(parsedEnv.error.issues.map((issue) => issue.path.join("."))),
  ];
  throw new Error(`Invalid environment variables: ${invalidVariables.join(", ")}`);
}

export const env = parsedEnv.data;
