import { env } from "../config/env.js";

export type TelegramSettings = {
  botToken: string;
  botUsername: string;
  pollSeconds: number;
};

export const TELEGRAM_SETTINGS = Symbol("TELEGRAM_SETTINGS");

export const telegramSettings: TelegramSettings = {
  botToken: env.TELEGRAM_BOT_TOKEN,
  botUsername: env.TELEGRAM_BOT_USERNAME,
  pollSeconds: env.TELEGRAM_POLL_SECONDS,
};
