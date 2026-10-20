# Operia API

**Multi-tenant back-office API for small businesses: sales documents, cash register, stock and customer accounts.**

![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![NestJS 12](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Prisma 7](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Tests](https://img.shields.io/badge/tests-435%20unit%20%2B%20198%20e2e-brightgreen)

## Overview

Operia helps a small business run its day-to-day operations from one place: register customers, issue sales documents, collect payments, open and close the cash register, track stock and see how the day is going on a dashboard.

One installation serves several companies (tenants) at the same time. Each user can belong to more than one company, but every session works on a single active company, and the data of one company is never visible to another.

This repository is the **API**. The web application that consumes it lives in its own repository (see [Related](#related)).

## Key features

- **Multi-company isolation:** every query is scoped by the active company stored in the server-side session.
- **Roles and permissions:** system and custom roles with fine-grained permissions enforced on every endpoint.
- **Customers and customer accounts:** CUIT validation, accent-insensitive search, running balance and applied payments.
- **Products and inventory:** catalog with categories and sub-types, stock movements and low-stock alerts.
- **Sales documents:** numbered documents with items, totals and payment detail.
- **Cash register:** opening, collections, movements and closing with totals.
- **Notifications:** in-app notifications, email through an outbox with retries, and orders received through a Telegram bot.
- **Dashboard:** daily sales, collections, outstanding balances and recent activity.

## Tech stack

| Area          | Choice                                                         |
| ------------- | -------------------------------------------------------------- |
| Runtime       | Node.js 22, TypeScript, ESM                                    |
| Framework     | NestJS 12 on Express 5                                         |
| Database      | PostgreSQL 16 with Prisma 7 (migrations, typed client, seed)   |
| Validation    | Zod on every request body and query                            |
| Security      | argon2id, Helmet, rate limiting, origin checks                 |
| Testing       | Vitest (unit) and Supertest (end-to-end against a test database) |
| Documentation | OpenAPI contract with Swagger UI                               |
| Tooling       | pnpm 11, ESLint, Prettier                      |

## Security and quality highlights

- Passwords hashed with **argon2id**; login returns a random opaque token and the database stores only its **SHA-256**.
- Session cookie is `HttpOnly` and `SameSite=Lax`, `Secure` by default in production, and is cleared on any authentication failure.
- Sessions expire by age, by **inactivity** (60 minutes by default), are capped per user, are purged periodically.
- **Rate limiting** for login (per IP, per IP and email, and per email) and for the API in general; trusted proxy hops are configurable.
- State-changing requests validate `Origin`/`Referer` against an allow-list; request bodies are limited to 32 KB and oversized requests answer `413`.
- API documentation is off by default in production and its Swagger UI assets are pinned and checked with Subresource Integrity.
- Dependency audit (`pnpm audit --prod`) reports no known vulnerabilities.
- Built with a **spec-driven workflow**: behavior is written down as testable requirements before it is implemented.

## Architecture

```
Web app (Next.js)  ──►  Operia API (NestJS)  ──►  PostgreSQL
                         │
                         ├─ email outbox worker (SMTP)
                         └─ Telegram bot (long polling)
```

```
src/
├─ auth/            login, logout, opaque sessions, inactivity and cleanup
├─ companies/       company list and active-company switch
├─ users/, roles/, permissions/   user management, roles and permission catalog
├─ customers/, customer-account/  customers, balances and applied payments
├─ products/, elem-types/, inventory/   catalog, categories and stock
├─ documents/       sales documents
├─ cash/            cash sessions, collections and closing
├─ dashboard/       daily summary and recent activity
├─ notifications/, telegram/      in-app and email notifications, Telegram orders
├─ geo/             provinces and localities lookup
├─ docs/            OpenAPI contract and Swagger UI
├─ common/          HTTP security, errors, i18n (es/en), rate limiting, helpers
├─ config/          environment validation
└─ database/        Prisma service
prisma/             schema, migrations and seed
test/               end-to-end tests
docs/               architecture decisions and multi-tenancy notes
```

## Getting started

Requirements: Node.js 22, pnpm 11 and PostgreSQL 16.

```bash
cp .env.example .env      # then edit DATABASE_URL and the demo passwords
pnpm install
pnpm db:setup             # generate client, apply migrations, load demo data
pnpm start:dev
```

The API listens on `http://localhost:3001`. Check it with:

```bash
curl http://localhost:3001/health
```

The demo users and their passwords come from `.env.example`. They are public by design: use them only locally and never reuse them anywhere else.

The full project also ships a Docker Compose setup (API, web app, PostgreSQL and a local mail catcher). It applies the migrations on start and loads the demo data only when `RUN_SEED=true`.

## API documentation

With `DOCS_ENABLED=true` (the default outside production):

- Swagger UI: `http://localhost:3001/docs`
- OpenAPI contract: `http://localhost:3001/docs-json`
- Export the contract without a database: `pnpm openapi:export` (writes `openapi.json`)

Example login, keeping the session cookie in a file:

```bash
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"email":"demo@operia.local","password":"<demo password>"}' \
  http://localhost:3001/auth/login
curl -b cookies.txt http://localhost:3001/auth/me
```

## Scripts

| Command                       | What it does                                                       |
| ----------------------------- | ------------------------------------------------------------------ |
| `pnpm start:dev`              | Start NestJS in watch mode                                         |
| `pnpm build`                  | Generate the Prisma client and compile                             |
| `pnpm test`                   | Unit tests                                                         |
| `pnpm test:e2e`               | Prepare and seed `operia_test`, then run the end-to-end tests      |
| `pnpm lint` / `pnpm format:check` | ESLint and Prettier checks                                     |
| `pnpm typecheck`              | Type-check the whole project                                       |
| `pnpm audit:prod`             | Audit production dependencies                                      |
| `pnpm prisma:migrate:dev`     | Create and apply migrations in development                         |
| `pnpm prisma:migrate:deploy`  | Apply existing migrations without resetting data                   |
| `pnpm prisma:seed`            | Run the idempotent seed                                            |
| `pnpm openapi:export`         | Export the OpenAPI contract to `openapi.json`                      |

End-to-end tests refuse to run unless `DATABASE_URL_TEST` ends exactly in `/operia_test`, so they can never touch the development database. `operia_test` is created by `../.docker/postgres/init.sql` when the PostgreSQL volume is first initialized; create it manually if your volume already existed.

## Configuration

All variables are validated at startup. `DATABASE_URL` and the demo passwords (at least 12 characters) are required; everything else has a default.

| Variable                                | Default                     | Description                                               |
| --------------------------------------- | --------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                          | required                    | PostgreSQL connection string                              |
| `DATABASE_URL_TEST`                     | none                        | Test database, must end in `/operia_test`                 |
| `PORT`                                  | `3001`                      | HTTP port                                                 |
| `ALLOWED_ORIGINS`                       | `http://localhost:3000`     | Comma-separated origins for CORS and origin checks        |
| `SESSION_TTL_HOURS`                     | `8`                         | Maximum session age                                       |
| `SESSION_IDLE_MINUTES`                  | `60`                        | Inactivity timeout, `0` disables it                       |
| `SESSION_MAX_PER_USER`                  | `10`                        | Concurrent sessions per user; the oldest are dropped      |
| `SESSION_CLEANUP_MINUTES`               | `60`                        | Expired-session cleanup interval, `0` disables it         |
| `COOKIE_SECURE`                         | `true` in production        | Send the session cookie only over HTTPS                   |
| `DOCS_ENABLED`                          | `false` in production       | Expose `/docs` and `/docs-json`                           |
| `TRUST_PROXY_HOPS`                      | `0`                         | Number of trusted reverse proxies (`1` behind one proxy)  |
| `RATE_LIMIT_LOGIN_ATTEMPTS`             | `5`                         | Login attempts per IP and email in the window             |
| `RATE_LIMIT_LOGIN_IP_ATTEMPTS`          | `30`                        | Login attempts per IP in the window                       |
| `RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS`     | `100`                       | Login attempts per email in the window                    |
| `RATE_LIMIT_LOGIN_WINDOW_MINUTES`       | `15`                        | Login rate-limit window                                   |
| `RATE_LIMIT_API_PER_MINUTE`             | `600`                       | Authenticated requests per session per minute             |
| `RATE_LIMIT_ANONYMOUS_PER_MINUTE`       | `100`                       | Anonymous requests per IP per minute                      |
| `SMTP_*`, `MAIL_FROM`, `MAIL_POLL_SECONDS`, `MAIL_MAX_ATTEMPTS` | empty / `15` / `6` | Outgoing email through the outbox worker       |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_POLL_SECONDS` | empty / `0` (off)     | Telegram orders; run polling on a single instance only    |

Local sample values are in `.env.example`.

## Project status

This is a demo project that is actively developed.

- Rate limiting is in memory per process; use a shared store before running several replicas.
- Session data lives in PostgreSQL, but there is no distributed cache.
- The demo login and credentials are meant for demonstration, not for production use.
- The API must sit behind an edge proxy that sets `X-Forwarded-For` (with `TRUST_PROXY_HOPS=1`) and should not be exposed directly to the internet.

## Related

- [Web application](https://github.com/MatiasOlivaRqta/operia_demo_ui/tree/develop) (Next.js, React, TypeScript)

## License

All rights reserved. Source available for viewing and evaluation only. See [LICENSE](LICENSE).

## Author

**Matias Oliva** — Full-stack developer (NestJS · TypeScript · PostgreSQL)

[LinkedIn](https://www.linkedin.com/in/matias-oliva-rqta) · [Email](mailto:matias.oliva.rqta@gmail.com)
