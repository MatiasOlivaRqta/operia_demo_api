import type { IncomingMessage, ServerResponse } from "node:http";
import type { Permission } from "../permissions/permissions.catalog.js";

export interface HttpRequest extends IncomingMessage {
  body?: unknown;
  ip?: string;
  path?: string;
  sessionContext?: {
    userId: string;
    companyId: string;
    sessionId: string;
    permissions: Permission[];
  };
}

export interface HttpResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
  cookie(name: string, value: string, options: CookieOptions): this;
  clearCookie(name: string, options: CookieOptions): this;
}

export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  expires?: Date;
};

export type Next = (error?: unknown) => void;
