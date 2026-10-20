# Multi-tenancy in Operia

Each company (`Company`) is a tenant with its own data inside the same database. A user can belong to several companies, and each session works on a single one, the active company.

## Data model

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : "belongs to"
    COMPANY ||--o{ MEMBERSHIP : "has members"
    USER ||--o{ SESSION : "starts"
    COMPANY ||--o{ SESSION : "active company"
    COMPANY ||--o{ CUSTOMER : "owns"
    COMPANY ||--o{ PRODUCT : "owns"
    COMPANY ||--o{ DOCUMENT : "owns"
    COMPANY ||--o{ CASH_SESSION : "owns"
    COMPANY ||--o{ NOTIFICATION : "owns"
    COMPANY ||--o{ TELEGRAM_CHAT : "links"

    SESSION {
        uuid id
        string active_company_id
    }
    CUSTOMER {
        string id PK
        string company_id PK
    }
```

Business tables use a composite key `(id, companyId)`, so the same `id` can repeat across companies and a query without `companyId` does not identify any row.

## What happens on each request

```mermaid
sequenceDiagram
    participant C as Browser
    participant G as AuthGuard
    participant S as Service
    participant DB as PostgreSQL

    C->>G: Request with session cookie
    G->>DB: Look up the session and its memberships
    G->>G: Is the user still a member of the active company?
    alt Not a member or the session expired
        G-->>C: 401
    else Is a member
        G->>S: SessionContext (userId, companyId)
        S->>DB: Query with WHERE company_id = session companyId
        DB-->>S: Only that company's data
        S-->>C: Response
    end
```

The `companyId` comes from the server-side session, never from a parameter sent by the client.

## Switching company

```mermaid
flowchart LR
    A[Header selector] -->|PUT /session/company/:id| B{Is the user a member of that company?}
    B -->|No| C[Reject]
    B -->|Yes| D[Update the session's activeCompanyId]
    D --> E[Customers, cash register and notifications switch to the new company]
```

## Scope of the isolation

- Filtering by company is a convention in each service's code. There is no row-level security in PostgreSQL.
- The e2e tests of each module verify that one company cannot see another company's data.
- `Membership` only records belonging. Roles and permissions are managed separately; see "Roles and permissions per company" in [decisions.md](decisions.md).
- Telegram chats are linked to a single company, and their orders reach only that company.
