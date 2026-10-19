# Multi-tenant en Operia

Cada empresa (`Company`) es un tenant con sus propios datos dentro de la misma base. Un usuario puede pertenecer a varias empresas y cada sesión trabaja sobre una sola, la empresa activa.

## Modelo de datos

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : "pertenece a"
    COMPANY ||--o{ MEMBERSHIP : "tiene miembros"
    USER ||--o{ SESSION : "inicia"
    COMPANY ||--o{ SESSION : "empresa activa"
    COMPANY ||--o{ CUSTOMER : "posee"
    COMPANY ||--o{ PRODUCT : "posee"
    COMPANY ||--o{ DOCUMENT : "posee"
    COMPANY ||--o{ CASH_SESSION : "posee"
    COMPANY ||--o{ NOTIFICATION : "posee"
    COMPANY ||--o{ TELEGRAM_CHAT : "vincula"

    SESSION {
        uuid id
        string active_company_id
    }
    CUSTOMER {
        string id PK
        string company_id PK
    }
```

Las tablas de negocio usan clave compuesta `(id, companyId)`, así que el mismo `id` puede repetirse entre empresas y una consulta sin `companyId` no identifica ninguna fila.

## Qué pasa en cada pedido

```mermaid
sequenceDiagram
    participant C as Navegador
    participant G as AuthGuard
    participant S as Servicio
    participant DB as PostgreSQL

    C->>G: Request con cookie de sesión
    G->>DB: Busca la sesión y sus membresías
    G->>G: ¿Sigue siendo miembro de la empresa activa?
    alt No es miembro o la sesión venció
        G-->>C: 401
    else Es miembro
        G->>S: SessionContext (userId, companyId)
        S->>DB: Consulta con WHERE company_id = companyId de la sesión
        DB-->>S: Solo datos de esa empresa
        S-->>C: Respuesta
    end
```

El `companyId` sale de la sesión del servidor, nunca de un parámetro que mande el cliente.

## Cambiar de empresa

```mermaid
flowchart LR
    A[Selector del header] -->|PUT /session/company/:id| B{¿Es miembro de esa empresa?}
    B -->|No| C[Rechaza]
    B -->|Sí| D[Actualiza activeCompanyId de la sesión]
    D --> E[Clientes, caja y notificaciones pasan a la nueva empresa]
```

## Alcance del aislamiento

- El filtro por empresa es una convención del código de cada servicio. No hay row-level security en PostgreSQL.
- Los tests e2e de cada módulo verifican que una empresa no vea los datos de otra.
- `Membership` solo indica pertenencia. No hay roles ni permisos distintos por empresa.
- Los chats de Telegram se vinculan a una sola empresa, y sus pedidos llegan solo a ella.
