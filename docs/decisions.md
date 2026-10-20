# Architecture decisions

## D10. Telegram through long polling

`TelegramBot` queries `getUpdates` through long polling and keeps the `offset` in memory; when the network fails it retries after the configured interval. The bot token is only used to build requests and is never included in logs or errors. Polling is disabled with `TELEGRAM_POLL_SECONDS=0`.

Each order message uses `telegram:<chatId>:<messageId>` as its `dedupeKey`, unique per company in PostgreSQL. Telegram may redeliver updates after restarts or errors, and the unique index prevents creating duplicate notifications.

Only one backend instance should have polling enabled, since Telegram does not allow simultaneous `getUpdates` consumers for the same bot. The other instances must set `TELEGRAM_POLL_SECONDS=0`.

## D11. Payment detail per document

The payment detail is built from `AccountEntry`, which records the `PAYMENT_APPLIED`, `CREDIT_APPLIED` and `CREDIT_GENERATED` allocations. It is not derived from `cash_movements.document_id`: that field stays null for automatic payments allocated across several documents.

The per-document query uses the full index `(company_id, document_id)`, named `account_entries_company_id_document_id_full_idx`. The index `account_entries_company_id_document_id_idx` already existed as a partial index with `WHERE document_id IS NOT NULL`, so the new index has a different name.

An application of credit balance (`CREDIT_APPLIED`) is not traced back to the payment that generated that credit. It is shown as an applied balance, with no receipt or link to the originating payment.

## Dashboard summary and activity

`GET /dashboard/summary` uses the session's `companyId` and runs a parameterized
SQL query for sales, collections and customer accounts. Sales and payments are
grouped by `created_at` between the start of the Argentine day (inclusive) and
the start of the next Argentine day (exclusive); sales only counts `COMPLETED`
documents. The previous day uses the same range computed for the previous
Argentine date. So a record at 23:30 Argentine time belongs to that day even if
its UTC date is already the next one, and a record at 00:00 belongs to the new day.

The customer account groups completed documents and payments per customer,
subtracts payments from documents and adds up only positive balances; one
customer's credit balance does not reduce the total owed. Sums are cast to
`bigint` in PostgreSQL and converted with `accountSafeInteger`, the same as the
per-customer account. `lowStockCount` comes from `InventoryService.summary`,
which keeps a single rule for low stock.

`GET /dashboard/activity` limits each `UNION ALL` branch by
`(company_id, created_at DESC, id DESC)`, then sorts and trims the combined set.
All events represent their `created_at`; a cancelled document remains visible
with status `CANCELLED` and does not count toward sales. `occurredAt` is
serialized with the Argentine offset. Collections include movements from any
cash session of the company.

## Phase C: customer isolation and search

Every read and write includes the session's `companyId`. Updates use
`updateMany` with `id` and `companyId` so that an identifier from another company
produces the same `not_found` as a nonexistent one. The CUIT is normalized to its
11 digits before persisting, and PostgreSQL's per-company unique constraint is
the final protection against races.

The search is first limited to the active company's customers, and then accents
and case are normalized in memory. The cut does not paginate, so adding a
PostgreSQL extension (`unaccent`) or specific SQL is avoided until the real data
size requires that optimization. CUIT search ignores hyphens and other separators.

Writes validate the whole object and reject unknown properties, including `id`,
`companyId` and `movements`; the server takes the company from the session
context. Deactivation (`POST /customers/{id}/deactivation`) always sets the status
to inactive. The status change (`PATCH /customers/{id}/status`) explicitly accepts
both states and allows reactivation.

## Phase D: security and quality

The test suite stays on Vitest and Supertest. The project already uses Vitest in
unit and E2E tests; migrating to Jest would add a second configuration and would
not improve the required coverage. The E2E database is validated by the exact
name `operia_test` before migrating or seeding. Each test cleans up temporary
sessions and customers tagged with `@e2e.operia.invalid`; the demo rows are kept.

Passwords are processed with Argon2id. Company IDs and demo customer IDs are
stable to preserve references from the mocks; new customers and users get UUIDs.
Cookies enable `Secure` when `COOKIE_SECURE=true`; locally it stays disabled for
HTTP. Validation uses the project's own Zod pipe, compatible with Zod 4.
Pagination is out of scope for this cut of Phase D; Phase E adds offset pagination
for products, movements and documents. The rate limiter uses per-process memory,
and the E2E tests reset its state between cases so that results do not depend on
execution order.

## Phase E: products, stock and documents

Available stock is kept denormalized in `products.stock_on_hand` and is updated
in the same transaction as each movement. The invariant is that stock equals the
sum of the movements and never drops below zero (`CHECK` constraint). Movements
are append-only: corrections are recorded as adjustments or reversals, without
editing or deleting the history.

Outflows update the product conditionally and atomically (`stock_on_hand >= quantity`
together with `decrement`), avoiding the read-then-write race. When a transaction
touches several products, it processes their IDs in ascending order to reduce deadlocks.

Products and documents use a normalized `search_text` with a `pg_trgm` GIN index;
products are sorted by `name_normalized` and ID. For this domain, this replaces
Phase C's decision to filter in memory without paginating. Customers are still
filtered in memory and not paginated; optimizing that listing remains as follow-up.

Paginated listings use offset `page` and `pageSize`, with sizes between 1 and 100
(25 by default), and include `total`. API amounts are whole cents; no decimal peso
amounts are sent.

Creating documents requires `Idempotency-Key` (8–100 characters). A SHA-256
fingerprint of the canonical payload is computed: repeating the key and payload
returns the same document with 200; repeating the key with a different payload
returns 409. The unique constraint resolves the race between concurrent requests.
Numbering is assigned with a per-company counter table and `ON CONFLICT`. The
counter only increments and is not decremented on cancellation: failed
transactions also roll back their increment, but an already committed number is
not reused.

Cancellation reverses the document's actual outflows, skipping those that already
have a reversal. Historical seed documents that have no associated movements only
change status. When reversing movements, the order is: first validate that the
resource exists in the company (404), then that the operation is admissible (409
if already reversed), and only then modify stock; trying to reverse a reversal or
leaving stock negative is a business rule (422). This order avoids the earlier bug
in which stock was modified before the conflict condition was detected.

Historical seed lines keep product references from another company: no FK to
`products` is added for those lines. The seed runs on every startup and is
non-destructive: it uses `createMany` with `skipDuplicates` and does not overwrite
existing edits.

The API rate limit identifies sessions with the bucket `session:<validated sessionId>`;
it never uses the raw cookie, because the limiter keeps buckets in memory and there
is a cap on entries. Requests without a session and public routes use an anonymous
per-IP bucket; when the limit is exceeded, `Retry-After` is returned. The limiter
lives in memory per process, so several instances do not share the count. Behind
the Next rewrite, anonymous traffic shares the proxy's IP; configuring `trust proxy`
remains a future improvement.

### Measurement with 100,000 products

A company with 100,000 products and 300,000 synthetic movements was loaded
(`pnpm db:seed:load`, ids `load-*`) and the API was measured directly, 20 requests
per scenario. The first measurement showed that the default listing (no status
filter) did a `Seq Scan` and a `top-N` sort over all products: the index
`(company_id, status, name_normalized, id)` cannot provide the name order when
there is no status filter, because `status` sits between the equality and the sort
columns. The index `(company_id, name_normalized, id)` was added (migration
`20261009000000_products_name_sort_index`). The list's `EXPLAIN` went from 21 ms
to 0.07 ms, and page 200 (offset 5,000) takes 1.3 ms.

Final result through the API with 100,000 products (p95): default list 19 ms, page
200 16 ms, `pageSize=100` 21 ms, status filter 30 ms, selective trigram search
8 ms (uses `Bitmap Index Scan` on `products_search_text_trgm_idx`), broad search
24 ms, `lowStock` 14 ms, inventory summary 21 ms. The plan's targets (list
< 150 ms, search < 200 ms) are met with a wide margin. In the browser, the
products screen renders 25 rows and about 700 DOM nodes with 100,000 products.

Two known linear costs remain. The exact total (`count(*)`) scans all the
company's rows (about 14 ms with 100,000 products); if a company grew to hundreds
of thousands of rows, an estimated or bounded total, or cursor pagination, would
be advisable. A search whose term matches almost all products cannot use the
trigram index and does a `Seq Scan`, which is the correct plan in that case. The
`lowStock` filter compares two columns and currently scans the company (9 ms with
100,000 products); a partial index on `stock_on_hand <= minimum_stock` would solve
it if needed, but Prisma cannot declare it and it would cause drift in `migrate diff`.

## Phase F: cash register reads

States and types are modeled with readable Prisma enums (`OPEN`, `CLOSED`,
`COBRO`) and `@map` to the stored letters (`O`, `C`, `C`). The API always exposes
the names; CASH, TRANSFER and CARD match between database and API. Movements keep
snapshots of `customer_name` and `document_number` so that the history does not
change when a customer or document is edited.

The listing uses offset pagination and limits `from`/`to` to 30 inclusive calendar
days. With no session and no dates it uses the 30 days up to today, in the
Argentine calendar; with `sessionId` that limit does not apply and the dates are
optional. `from` and `to` must be sent together. Date conversion and day limits
are centralized in `common/argentina-time.ts`. Offset pagination can shift rows
between pages if payments come in while paging; this is accepted until the product
requires a cursor.

The precision spike confirmed that Prisma 7.10 with `adapter-pg` returns exactly
3,000,000,000 in `groupBy` `_sum.amount`; totals use `groupBy`, without raw SQL,
and validate `Number.isSafeInteger` before responding. The closing columns
`declared_balance`, `theoretical_balance` and `difference` are `BigInt` from the
start. `INCLUDE (amount)` on the index `(company_id, session_id, payment_method)`
was ruled out: Prisma cannot represent `INCLUDE` and `prisma migrate dev` would
generate a spurious migration because of drift; the index-only scan is lost, which
matters little over a set bounded to one session.

Known limitations: there is still no RBAC within the company and no payment
reversals; any member can query all of their company's movements. Offset
pagination allows shifts when payments come in.

## Opening, payment, closing and customer account

### D1. Derived customer account

Debt and balances are derived from the immutable allocation ledger
`account_entries`; they are not stored as amounts on documents, and no charges
are created when documents are issued. The payment status is stored as a cache,
without replacing that source of truth; see [Document settlement status](#d10-document-settlement-status).
The pending amount is the total minus the allocated payments and credit balance;
the credit is the generated surplus minus the applied credit. Sums are computed in
SQL, with indexes by company, customer, document and movement. The database
constraints require positive amounts and references consistent with each kind of
allocation. Explicitly applying credit does not require an open cash register and
does not generate a cash movement.

### D2. Allocation and surpluses

Allocation lives in the pure function `allocate`. Without a given document, it
walks the pending documents from oldest to newest (`created_at`, then `id`),
applies up to each one's pending amount and leaves the surplus as credit balance.
With a given document, it applies up to its pending amount and the rest also
becomes credit. The query uses a running sum in SQL to fetch only the pending
documents needed to cover the amount, with parameters through `Prisma.sql`.

### D3. Lock order and payment admission

The order is cash session → customer → receipt counter, to reduce deadlocks. A
payment takes `FOR SHARE` on the session: it allows concurrent payments and forces
the closing, which takes `FOR UPDATE`, to wait for in-flight payments. New
payments on a closed register are rejected with 409. Then the customer is locked
with `FOR UPDATE`, shared by payments, credit applications and cancellations, so
that no more than the pending amount is allocated. The counter is taken last,
inside the transaction, to hold its lock as briefly as possible; if the operation
fails, the number is not consumed. Opening is protected by the partial unique
index for an open register per company and translates `P2002` to 409.

For payments against a document, the pending amount is read after the session
lock but before the customer lock, and re-read under the customer lock. This
distinguishes a document that was already settled when the payment was admitted
(422) from one that got settled while the request waited for the lock: in that
case the payment is accepted and the surplus becomes credit. The re-read also
validates the customer and the document's status.

### D4. Payment idempotency

The mandatory `Idempotency-Key` header accepts between 8 and 100 characters. The
SHA-256 fingerprint uses a canonical object with `amountCents`, `customerId`,
`documentId` (null if absent), `paymentMethod` and `sessionId` in a fixed order.
The columns `idempotency_key` and `request_fingerprint` are nullable to keep
earlier rows; the key is unique per company. A repeat with the same fingerprint
rebuilds the same receipt and responds 200; different data with the same key
responds 409. The `P2002` race re-reads the movement. The `customerCreditCents`
balance is computed when responding, also on repeats: it may differ from the
balance in the first response. A valid repeat may return the receipt even if the
register is already closed.

### D5. Closing and precision

The theoretical amount is computed under `FOR UPDATE` on the session and inside
the closing transaction: opening balance plus the sum of `CASH` payments.
TRANSFER and CARD do not add cash. The difference is declared minus theoretical;
any non-zero difference requires a non-empty observation (422 on `observation`).
The observation is trimmed and omitted from the response if it ends up empty. The
columns `declared_balance`, `theoretical_balance` and `difference` are `BigInt`;
the API verifies safe integers before exposing numbers. The declared amount goes
up to `Number.MAX_SAFE_INTEGER`, while the opening balance, payments and
allocations go up to 2,147,483,647. The consistency constraints distinguish an
open session with no closing data from a closed session with all required data.
A second closing responds 409.

### D6. Email through an outbox in PostgreSQL

The notice is low volume and is written to `mail_outbox` in the same transaction
as the closing, only when there is a difference and there are recipients.
PostgreSQL avoids the dual write that Redis and BullMQ would introduce. Sending
happens outside the request and the transaction: a slow or down SMTP server does
not delay or roll back the closing. The unique key `cash-close:<sessionId>`
prevents enqueueing two notices for the same closing.

Delivery is "at least once": if the process dies between sending and marking as
sent, the email may be duplicated. Selection uses `FOR UPDATE SKIP LOCKED` and a
10-minute lease; the status update checks lease and attempt so as not to
overwrite another processor's work. Retries wait 1 minute, 5 minutes, 30 minutes,
2 hours and 6 hours (that last wait is kept for additional attempts);
`MAIL_MAX_ATTEMPTS` limits the attempts, with 6 by default. Once exhausted, the
row is marked failed. `last_error` keeps only the error class, without messages
or credentials.

Recipients come from `CASH_ALERT_EMAILS` and are stored as a snapshot when
enqueued; changing the variable does not alter pending notices. Without
recipients, the notice is skipped and a warning is logged without personal data.
The configuration is validated at startup and requires SMTP and a sender when
there are recipients. `MAIL_POLL_SECONDS` defaults to 15; `MAIL_POLL_SECONDS=0`
disables the automatic worker, although `processDue()` stays available for
explicit execution. The transport has a `MailTransport` port and a nodemailer
adapter. Rendering is pure, escapes free text in HTML, sanitizes line breaks in
the company name in the subject and formats pesos with integer `BigInt` arithmetic.

### D7. Cancellation with allocations

Cancellation locks the customer inside the transaction and checks
`hasImputations` before changing the document or reversing stock. A document with
payments or applied credit is rejected with 409 until reversals exist, so as not
to leave debt and payments inconsistent. Without allocations, the existing
cancellation is kept. `DocumentsModule` imports `CustomerAccountModule`, which
depends on the database and not on documents, avoiding a circular dependency.

### D8. Contract and stored versus exposed values

The six new routes require a valid session and take `companyId` from the
authenticated context; the Zod input objects are strict and reject unknown
properties. Sessions use UUIDs; customers and documents accept text identifiers of
1 to 100 characters because of the seed's stable IDs. Amounts are exposed in
cents, dates in ISO with `-03:00`, and the open-register query returns JSON null
when there is no session. A closed session exposes `closedBy` as `{ name }`; the
receipt includes a nullable `documentId`, allocations, and the generated and
current credit balance. The account returns `pending` with `items`, `page`,
`pageSize` and `total`; its read uses `RepeatableRead` so that totals and page
share a snapshot. The application responds with `application`, `document` and
`creditCents`.

Two representations are kept for states and types: letters in the database and
readable names in Prisma and the API. Cash stores `O`/`C` for `OPEN`/`CLOSED` and
`C` for `COBRO`; allocations store `P`/`G`/`A` for
`PAYMENT_APPLIED`/`CREDIT_GENERATED`/`CREDIT_APPLIED`; the outbox stores
`P`/`S`/`F` for `PENDING`/`SENT`/`FAILED`. The methods `CASH`, `TRANSFER` and
`CARD` match between database and API.

### D9. Customer structure and search

`cash` separates reads (`cash.service.ts`), sessions (`cash-sessions.service.ts`)
and payments (`cash-collections.service.ts`), with schemas, mappers and pure
allocation and closing functions. `customer-account` concentrates queries for
pending documents, aggregates, locks and allocations and shares them with cash and
documents. `notifications` separates the outbox, worker, transport port, SMTP
adapter and renderer. The environment configuration and OpenAPI document these
contracts without creating the application to export the JSON.

Redis is not added for customer search: the bottleneck is the in-memory filtering
of `GET /customers`, not the lack of a cache. The planned solution is to search in
PostgreSQL with `pg_trgm` and a result limit, in a separate change, following the
path already used for products and documents.

### D10. Document settlement status

The stored status is a cache of the allocated amount and is recalculated in the
same transaction, after writing the `PAYMENT_APPLIED` (payments) or
`CREDIT_APPLIED` (`applyCredit`) entries, under the customer's `FOR UPDATE` lock.
`settlementStatus` (`src/cash/settlement-status.ts`) computes the status from the
total and what is allocated; `CustomerAccountService.updateSettlementStatuses`
persists the result for each affected document. The debt, pending and credit
amounts remain derived from `AccountEntry`, not from the stored status.
`COMPLETED` means settled. For queries, a "current" document is any whose status
is different from `CANCELLED`.

The migration is split in two steps because PostgreSQL does not allow using a
newly added enum value within the same transaction, and Prisma runs each
migration in a transaction: first it adds `PENDING` and `PARTIAL`; then it
reclassifies the non-cancelled documents using the sum of `PAYMENT_APPLIED` and
`CREDIT_APPLIED` per document (no allocations: `PENDING`; partial: `PARTIAL`;
settled: `COMPLETED`) and sets `PENDING` as the default. `CANCELLED` documents do
not change.

The initial admission of a payment against a document requires `PENDING` or
`PARTIAL` and a pending amount greater than zero; if not met, it responds `422`.
The re-read under the customer lock described in D3 is kept: if the document gets
settled while the request waits for that lock, the already admitted payment is
accepted and the surplus becomes credit balance. `applyCredit` applies the strict
rule under the lock and rejects with `422` a document that is already settled or
has no pending amount.

Only a `PENDING` document can be cancelled; the allocation check is kept and
responds `409` when there are any. The detail `GET /documents/:id` includes
`pendingCents` (total minus the sum of payments and applied credit; `0` for
`COMPLETED` and `CANCELLED`); the same field is included in the `POST /documents`
response, but not in the listing endpoint.

Out of scope are payment reversals, cancelling documents with allocations
(including partial or settled ones), and due dates, late fees and reminders.

The `back` entrypoint runs `prisma migrate deploy` on startup: restarting the
service with pending migrations applies them on its own, so it is advisable to
back up the database before restarting.

### Known limitations

- There are roles and permissions per company; there are still no reversals of
  payments or closings. Documents with allocations cannot be cancelled; for the
  settlement status rule, see [D10](#d10-document-settlement-status).
- No history or detail of cash sessions.
- The `mail_outbox` rows have no retention policy and store the name and email of
  whoever closes, plus the observation. The email may be duplicated if the process
  dies between sending and marking.
- `GET /customers` is still not paginated and filters in memory.

## Product type and category catalog

- `elem_types` (types common to all companies) and `elem_sub_types` (per-company
  values, PK `(id, company_id)`, unique by `(company_id, elem_type_id, description_normalized)`).
  `PROD_CAT` is inserted by the migration, there is no `elem_types` seeder; the
  sample seeds do create their products' categories.
- `products.category` (text) became `products.category_id`, with a composite FK
  `(category_id, company_id)` and `ON DELETE RESTRICT`: the database prevents
  pointing to another company's category. That the subtype is of type `PROD_CAT`
  is validated by the service.
- The migration unifies variants of a category (case, accents and spaces) with the
  same normalization as the search and keeps the most used variant as the
  description. When applying it to real data, back up the database first:
  `DROP COLUMN category` cannot be undone with Prisma.
- `GET` and `POST /elem-types/{typeId}/sub-types`; creation is idempotent (201 on
  create, 200 if an equivalent one already exists) and resolves the race through
  the unique index by returning the winning row.
- A product's `search_text` uses the description in effect when it is saved. When
  category renaming is added, the affected products will need to be reindexed.
- Known limits: no CRUD screens (a misspelled category cannot be deleted from the
  app) and the description is only trimmed at the ends; the normalized key does
  collapse inner spaces.

## Error messages by key and language

- API errors are written by key (`back/src/common/i18n/es.ts` and `en.ts`, with
  `{parameters}`) and resolved with `Accept-Language` (`resolveLocale`: `q`
  priorities, regional tags such as `en-US`; with no header, an invalid one or an
  unsupported one → Spanish). The HTTP status, the `code` and the shape
  `{ error: { code, message, fieldErrors? } }` do not change.
- `ApiException` receives a typed `MessageKey`; the filter translates. A key
  without a translation falls back to Spanish and, if that is missing too, the key
  is returned and logged without personal data. Tests: key and parameter parity
  between catalogs, and use of existing keys.
- The language reaches `ZodValidationPipe` through an `AsyncLocalStorage` started
  in a middleware (`runWithRequestLocale`), so controllers keep using
  `new ZodValidationPipe(schema)`.
- Out of scope (still in Spanish): the cash-closing email, the Telegram bot,
  already stored notifications (they store text; translating them requires storing
  key and parameters) and OpenAPI.

## Demo companies and users

It was verified that `prisma/seed.ts`, `prisma/seed-load.ts`, the migrations,
`src/`, `scripts/` and `.docker/` do not create the companies `operia-central`
and `operia-hogar`, the users `demo@operia.local` and `hogar@operia.local`, or
their memberships. That data exists in the development and test databases: the
users, with an Argon2 hash, were created on 2026-10-07 through an earlier seed
that is no longer in the repo. Only `DEMO_USER_*` and `HOGAR_USER_*` in `.env` and
Compose name those accounts. `README.md` and `README-docker.md` must clarify that
the companies and users are created outside the repo and that the seed only loads
products and documents onto existing companies.

A fresh database has no companies or users, so the seed fails on FKs. The roles
migration must create ADMIN for each row of `companies` and assign it to all
existing memberships. On a fresh database there are no rows to migrate; whoever
creates a company will have to create its ADMIN (seed or test helpers, task 1.3).

## Roles and permissions per company

Each membership has a role of its company through `Membership.roleId` and the
composite FK `(role_id, company_id) → roles(id, company_id)`, with
`ON DELETE RESTRICT`. The membership's primary key keeps a single role per user
and company; a user can have different roles in other companies. Roles with
non-reserved names store their permissions in `Role.permissions`. The fixed, typed
catalog lives in `src/permissions/permissions.catalog.ts`; `permissionsForRole`
computes all permissions for the system role `ADMIN`, marked `isSystem` and with
empty `permissions` in the database, and for the other roles filters the values
against the catalog: unknown permissions are ignored when evaluating and rejected
when saving.

`AuthService.authenticate` loads the active company's membership and role on every
request. Permissions are not included in the cookie or kept as cached
authorization: when a role changes, the next request already uses the new
permissions. The global permissions guard runs after the `AuthGuard`; routes
declare `@RequirePermission` and accept any of the listed permissions.
`src/permissions/route-permissions.spec.ts` walks the controllers to require a
permission on every protected route and also verifies that the explicit open
exceptions exist and are not business routes.

The current permission map by method and route is:

| Permission                         | Methods and routes                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers.read` or `documents.write` | `GET /customers`, `GET /customers/:id`                                                                                                                            |
| `customers.write`                  | `POST /customers`, `PATCH /customers/:id`, `POST /customers/:id/deactivation`, `PATCH /customers/:id/status`                                                         |
| `products.read` or `documents.write` | `GET /products`, `GET /products/:id`                                                                                                                               |
| `products.write`                   | `POST /products`, `PATCH /products/:id`                                                                                                                              |
| `inventory.read`                   | `GET /products/:id/movements`, `GET /inventory/summary`, `GET /stock-movements`                                                                                      |
| `inventory.write`                  | `POST /products/:id/stock-movements`, `POST /products/:id/stock-adjustments`                                                                                         |
| `inventory.cancel`                 | `POST /products/:id/stock-movements/:movementId/reversal`                                                                                                            |
| `documents.read`                   | `GET /documents`, `GET /documents/:id`                                                                                                                               |
| `documents.write`                  | `POST /documents`                                                                                                                                                    |
| `documents.cancel`                 | `POST /documents/:id/cancellation`                                                                                                                                   |
| `cash.read`                        | `GET /cash/sessions/current`, `GET /cash/movements`, `GET /cash/sessions/current/totals`                                                                             |
| `cash.write`                       | `POST /cash/sessions`, `POST /cash/sessions/:id/close`, `POST /cash/sessions/:id/collections`                                                                        |
| `account.read`                     | `GET /customers/:id/account`, `GET /customers/:id/account/summary`, `GET /customers/:id/account/movements`                                                           |
| `account.write`                    | `POST /customers/:id/account/applications`                                                                                                                           |
| `dashboard.read`                   | `GET /dashboard/summary`, `GET /dashboard/activity`                                                                                                                  |
| `users.manage`                     | `GET /roles/permissions`, `GET /roles`, `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`, `GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` |

The auxiliary reads `GET /customers` and `GET /products` also accept
`documents.write` to fill in the document form; document listings and details do
require `documents.read`. The test's explicit open list contains: `POST /auth/login`,
`POST /auth/logout`, `GET /auth/me`, `GET /companies`, `PUT /session/company/:id`,
`GET /notifications`, `GET /notifications/unread-count`,
`POST /notifications/:id/read`, `POST /notifications/read-all`,
`POST /telegram/link-token`, `GET /geo/provinces`,
`GET /geo/provinces/:provinceId/localities`, `GET /elem-types/:typeId/sub-types`,
`POST /elem-types/:typeId/sub-types`, `GET /health`, `GET /docs` and `GET /docs-json`.

The migration creates one `ADMIN` per existing company, assigns that role to all
its memberships and then makes `roleId` mandatory. The `ADMIN` role computes the
full catalog and cannot be modified or deleted. Role changes and removals lock the
`ADMIN` role row with `SELECT ... FOR UPDATE` inside the transaction; a company
must keep at least one ADMIN membership, and an ADMIN cannot switch to another
role or remove themselves. An attempt that breaks these rules responds 422
`business_rule`; deleting an assigned role or editing/deleting a system role
responds 409 `conflict`. The rejection when removing the last ADMIN is tested with
an actor that has `users.manage` and is not ADMIN in that company: an ADMIN actor
would count as another administrator and the removal would not leave the company
without admin access.

When creating a new user, the initial password must be between 12 and 128
characters and is used only to generate an Argon2id hash; it is never returned or
stored in plain text. If the email already exists, only the membership is added
and the name and hash are kept. The user and role listings are plain arrays and
the catalog is exposed grouped as `{ module, permissions }`.

Demo companies and users are created outside the repo; the section
[Demo companies and users](#demo-companies-and-users) details the observed origin
and the seed's scope. The migration assigns ADMIN to existing companies; whoever
creates new companies must create their ADMIN in the corresponding external process.

Out of scope: several roles per user; permissions per record, person type or
field; roles shared between companies; auditing; invitations and password
recovery; permissions for notifications and Telegram; and company CRUD with
creation of its ADMIN.
