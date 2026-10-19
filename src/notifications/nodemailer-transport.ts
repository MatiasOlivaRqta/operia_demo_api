import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import type { MailMessage, MailTransport } from "./mail-transport.js";

@Injectable()
export class NodemailerTransport implements MailTransport {
  private readonly transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  async send(message: MailMessage): Promise<void> {
    const result = await this.transport.sendMail({
      from: env.MAIL_FROM,
      to: [...message.recipients],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    // Partial SMTP acceptance must remain retryable; the outbox is at-least-once.
    if (result.rejected.length > 0) throw new Error("SMTP rejected recipients");
  }
}
