import type { RenderedEmail } from "./cash-close-email.js";

export const MAIL_TRANSPORT = Symbol("MAIL_TRANSPORT");
export type MailMessage = RenderedEmail & { recipients: readonly string[] };
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}
