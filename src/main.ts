import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { env } from "./config/env.js";
import { AppModule } from "./app.module.js";
import { configureHttpSecurity } from "./common/http-security.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureHttpSecurity(app);
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
