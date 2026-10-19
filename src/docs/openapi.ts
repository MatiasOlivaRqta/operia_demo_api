import { customerInputOpenApiSchema } from "../customers/customer.schemas.js";
import {
  productInputOpenApiSchema,
  stockAdjustmentOpenApiSchema,
  stockMovementInputOpenApiSchema,
  reversalOpenApiSchema,
} from "../products/product.schemas.js";
import { subTypeInputOpenApiSchema } from "../elem-types/elem-type.schemas.js";
import {
  cancellationOpenApiSchema,
  createDocumentOpenApiSchema,
} from "../documents/document.schemas.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const page = (itemSchema: unknown) => ({
  type: "object",
  required: ["items", "page", "pageSize", "total"],
  properties: {
    items: { type: "array", items: itemSchema },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100, default: 25 },
    total: { type: "integer", minimum: 0 },
  },
});
const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string",
          enum: [
            "validation",
            "unauthenticated",
            "forbidden",
            "not_found",
            "conflict",
            "business_rule",
            "unexpected",
            "rate_limited",
            "payload_too_large",
          ],
        },
        message: { type: "string" },
        fieldErrors: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;
const commonErrors = {
  "413": {
    description: "El cuerpo de la solicitud supera el tamaño máximo permitido",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  "400": {
    description: "Datos inválidos",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  "401": {
    description: "Sesión inválida",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  "403": {
    description: "Permiso insuficiente (forbidden)",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  "404": {
    description: "Recurso no encontrado en la empresa activa",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  "409": { description: "Conflicto", content: { "application/json": { schema: ref("ApiError") } } },
  "422": {
    description: "Regla de negocio incumplida (business_rule)",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  "429": {
    description: "Límite de solicitudes excedido",
    headers: {
      "Retry-After": {
        schema: { type: "integer" },
        description: "Segundos hasta poder reintentar",
      },
    },
    content: { "application/json": { schema: ref("ApiError") } },
  },
} as const;
const pathId = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 100 },
});
const paginationParams = [
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
  {
    name: "pageSize",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  },
];
const jsonBody = (schema: unknown) => ({
  required: true,
  content: { "application/json": { schema } },
});
const secured = { operiaSession: [] };
const accountId = { type: "string", minLength: 1, maxLength: 100 } as const;
const positiveCents = { type: "integer", minimum: 1, maximum: 2_147_483_647 } as const;
const safeCents = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const paymentMethod = { type: "string", enum: ["CASH", "TRANSFER", "CARD"] } as const;
const sessionProperties = {
  id: { type: "string", format: "uuid" },
  openedAt: { type: "string", format: "date-time", description: "Hora argentina (-03:00)" },
  openedBy: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string" } },
  },
  openingBalanceCents: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
} as const;
const sessionRequired = ["id", "status", "openedAt", "openedBy", "openingBalanceCents"];
const sessionIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Operia API",
    version: "0.2.0",
    description:
      "API de Operia para sesión, empresas, clientes, productos, movimientos de stock, inventario y comprobantes.",
  },
  servers: [{ url: "http://localhost:3001" }],
  tags: [
    { name: "Productos" },
    { name: "Catálogo" },
    { name: "Inventario" },
    { name: "Comprobantes" },
    { name: "Clientes" },
    { name: "Geografía" },
    { name: "Sesión" },
    { name: "Empresas" },
    { name: "Salud" },
    { name: "Caja" },
    { name: "Inicio" },
    { name: "Notificaciones" },
    { name: "Telegram" },
  ],
  components: {
    securitySchemes: { operiaSession: { type: "apiKey", in: "cookie", name: "operia_session" } },
    schemas: {
      SessionPayload: {
        type: "object",
        additionalProperties: false,
        required: ["user", "companies", "activeCompany", "role", "permissions"],
        properties: {
          user: {
            type: "object",
            additionalProperties: false,
            required: ["id", "email", "name"],
            properties: {
              id: { type: "string" },
              email: { type: "string", format: "email" },
              name: { type: "string" },
            },
          },
          companies: { type: "array", items: { $ref: "#/components/schemas/SessionCompany" } },
          activeCompany: { $ref: "#/components/schemas/SessionCompany" },
          role: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
          permissions: { type: "array", items: { type: "string" } },
        },
      },
      SessionCompany: {
        type: "object",
        additionalProperties: false,
        required: ["id", "legalName", "name"],
        properties: {
          id: { type: "string" },
          legalName: { type: "string" },
          name: { type: "string" },
        },
      },
      OpenCashSessionInput: {
        type: "object",
        additionalProperties: false,
        required: ["openingBalanceCents"],
        properties: { openingBalanceCents: sessionProperties.openingBalanceCents },
      },
      CloseCashSessionInput: {
        type: "object",
        additionalProperties: false,
        required: ["declaredBalanceCents"],
        properties: {
          declaredBalanceCents: safeCents,
          observation: {
            type: "string",
            maxLength: 500,
            description: "Se recortan espacios; obligatoria y no vacía si hay diferencia (422)",
          },
        },
      },
      OpenCashSession: {
        type: "object",
        additionalProperties: false,
        required: sessionRequired,
        properties: { ...sessionProperties, status: { type: "string", enum: ["OPEN"] } },
      },
      ClosedCashSession: {
        type: "object",
        additionalProperties: false,
        required: [
          ...sessionRequired,
          "closedAt",
          "declaredBalanceCents",
          "theoreticalBalanceCents",
          "differenceCents",
          "closedBy",
        ],
        properties: {
          ...sessionProperties,
          status: { type: "string", enum: ["CLOSED"] },
          closedAt: { type: "string", format: "date-time", description: "Hora argentina (-03:00)" },
          declaredBalanceCents: safeCents,
          theoreticalBalanceCents: safeCents,
          differenceCents: {
            type: "integer",
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          observation: { type: "string", minLength: 1, maxLength: 500 },
          closedBy: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      CashCollectionInput: {
        type: "object",
        additionalProperties: false,
        required: ["customerId", "amountCents", "paymentMethod"],
        properties: {
          customerId: accountId,
          amountCents: positiveCents,
          paymentMethod,
          documentId: accountId,
        },
      },
      CashReceiptApplication: {
        type: "object",
        additionalProperties: false,
        required: ["documentId", "documentNumber", "amountCents"],
        properties: {
          documentId: accountId,
          documentNumber: { type: "string" },
          amountCents: positiveCents,
        },
      },
      CashReceipt: {
        type: "object",
        additionalProperties: false,
        required: [
          "receiptNumber",
          "movementId",
          "occurredAt",
          "customerId",
          "customerName",
          "paymentMethod",
          "amountCents",
          "documentId",
          "applications",
          "creditGeneratedCents",
          "customerCreditCents",
        ],
        properties: {
          receiptNumber: { type: "string", description: "Correlativo por empresa R-0001-NNNNNNNN" },
          movementId: { type: "string", format: "uuid" },
          occurredAt: {
            type: "string",
            format: "date-time",
            description: "Hora argentina (-03:00)",
          },
          customerId: accountId,
          customerName: { type: "string" },
          paymentMethod,
          amountCents: positiveCents,
          documentId: { ...accountId, nullable: true },
          applications: { type: "array", items: ref("CashReceiptApplication") },
          creditGeneratedCents: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
          customerCreditCents: {
            ...safeCents,
            description:
              "Saldo actual del cliente, recalculado también en una repetición idempotente",
          },
        },
      },
      PendingAccountDocument: {
        type: "object",
        additionalProperties: false,
        required: ["id", "internalNumber", "date", "totalCents", "paidCents", "pendingCents"],
        properties: {
          id: accountId,
          internalNumber: { type: "string" },
          date: { type: "string", format: "date-time", description: "Hora argentina (-03:00)" },
          totalCents: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
          paidCents: safeCents,
          pendingCents: { ...safeCents, minimum: 1 },
        },
      },
      CustomerAccount: {
        type: "object",
        additionalProperties: false,
        required: ["customerId", "debtCents", "creditCents", "netBalanceCents", "pending"],
        properties: {
          customerId: accountId,
          debtCents: safeCents,
          creditCents: safeCents,
          netBalanceCents: {
            type: "integer",
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          pending: { ...page(ref("PendingAccountDocument")), additionalProperties: false },
        },
      },
      CustomerAccountSummary: {
        type: "object",
        additionalProperties: false,
        required: ["customerId", "invoicedCents", "collectedCents", "netBalanceCents"],
        properties: {
          customerId: accountId,
          invoicedCents: safeCents,
          collectedCents: safeCents,
          netBalanceCents: {
            type: "integer",
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
      CustomerAccountMovement: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "kind",
          "occurredAt",
          "reference",
          "documentNumber",
          "documentId",
          "cashMovementId",
          "debitCents",
          "creditCents",
          "appliedCents",
          "balanceCents",
        ],
        properties: {
          id: { type: "string" },
          kind: {
            type: "string",
            enum: ["DOCUMENT", "CANCELLATION", "COLLECTION", "CREDIT_APPLIED"],
          },
          occurredAt: {
            type: "string",
            format: "date-time",
            description: "Hora argentina (-03:00)",
          },
          reference: { type: "string" },
          documentNumber: { anyOf: [{ type: "string" }, { type: "null" }] },
          documentId: { anyOf: [{ type: "string" }, { type: "null" }] },
          cashMovementId: { anyOf: [{ type: "string" }, { type: "null" }] },
          debitCents: safeCents,
          creditCents: safeCents,
          appliedCents: { anyOf: [safeCents, { type: "null" }] },
          balanceCents: {
            type: "integer",
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
      CustomerAccountMovementPage: {
        type: "object",
        additionalProperties: false,
        required: ["items", "nextCursor"],
        properties: {
          items: { type: "array", items: ref("CustomerAccountMovement") },
          nextCursor: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
        },
      },
      AccountApplicationInput: {
        type: "object",
        additionalProperties: false,
        required: ["documentId", "amountCents"],
        properties: { documentId: accountId, amountCents: positiveCents },
      },
      AccountApplicationResult: {
        type: "object",
        additionalProperties: false,
        required: ["application", "document", "creditCents"],
        properties: {
          application: {
            type: "object",
            additionalProperties: false,
            required: ["id", "customerId", "documentId", "amountCents", "createdAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              customerId: accountId,
              documentId: accountId,
              amountCents: positiveCents,
              createdAt: {
                type: "string",
                format: "date-time",
                description: "Hora argentina (-03:00)",
              },
            },
          },
          document: {
            type: "object",
            additionalProperties: false,
            required: ["id", "pendingCents"],
            properties: { id: accountId, pendingCents: safeCents },
          },
          creditCents: safeCents,
        },
      },
      CashMovement: {
        type: "object",
        required: [
          "id",
          "occurredAt",
          "type",
          "customerId",
          "customerName",
          "receiptNumber",
          "documentNumber",
          "paymentMethod",
          "amountCents",
        ],
        properties: {
          id: { type: "string" },
          occurredAt: { type: "string", format: "date-time" },
          type: { type: "string", enum: ["COBRO"] },
          customerId: { type: "string" },
          customerName: { type: "string" },
          receiptNumber: { type: "string" },
          documentNumber: { type: "string", nullable: true },
          paymentMethod: { type: "string", enum: ["CASH", "TRANSFER", "CARD"] },
          amountCents: { type: "integer", minimum: 1 },
        },
      },
      CashMovementPage: page(ref("CashMovement")),
      CashTotals: {
        type: "object",
        required: [
          "sessionId",
          "openedAt",
          "asOf",
          "openingBalanceCents",
          "byMethod",
          "netCollectedCents",
          "movementsCount",
          "theoreticalCashCents",
        ],
        properties: {
          sessionId: { type: "string" },
          openedAt: { type: "string", format: "date-time" },
          asOf: { type: "string", format: "date-time" },
          openingBalanceCents: { type: "integer" },
          byMethod: {
            type: "object",
            required: ["CASH", "TRANSFER", "CARD"],
            properties: {
              CASH: { type: "integer" },
              TRANSFER: { type: "integer" },
              CARD: { type: "integer" },
            },
          },
          netCollectedCents: { type: "integer" },
          movementsCount: { type: "integer" },
          theoreticalCashCents: { type: "integer" },
        },
      },
      Customer: {
        type: "object",
        required: [
          "id",
          "companyId",
          "address",
          "city",
          "commercialName",
          "contactEmail",
          "contactName",
          "contactPhone",
          "documentNumber",
          "documentType",
          "fiscalAddress",
          "legalName",
          "locality",
          "personType",
          "postalCode",
          "priceList",
          "province",
          "status",
          "vatCondition",
        ],
        properties: {
          ...customerInputOpenApiSchema.properties,
          id: { type: "string" },
          companyId: { type: "string" },
          documentNumber: {
            type: "string",
            description:
              "CUIT/CUIL con formato XX-XXXXXXXX-X; los demás documentos se devuelven normalizados.",
          },
        },
      },
      CustomerListItem: {
        allOf: [
          ref("Customer"),
          {
            type: "object",
            required: ["balanceCents"],
            properties: {
              balanceCents: {
                type: "integer",
                description:
                  "Saldo neto en centavos: comprobantes no anulados menos cobros de caja. Positivo = deuda.",
              },
            },
          },
        ],
      },
      CustomerPage: page(ref("CustomerListItem")),
      CustomerInput: customerInputOpenApiSchema,
      Role: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "isSystem", "permissions"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          isSystem: { type: "boolean" },
          permissions: { type: "array", items: { type: "string" } },
          userCount: { type: "integer", minimum: 0 },
        },
      },
      RoleInput: {
        type: "object",
        additionalProperties: false,
        required: ["name", "permissions"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          permissions: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "customers.read",
                "customers.write",
                "products.read",
                "products.write",
                "inventory.read",
                "inventory.write",
                "inventory.cancel",
                "documents.read",
                "documents.write",
                "documents.cancel",
                "cash.read",
                "cash.write",
                "account.read",
                "account.write",
                "dashboard.read",
                "users.manage",
              ],
            },
          },
        },
      },
      RoleUpdate: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          permissions: { type: "array", uniqueItems: true, items: { type: "string" } },
        },
      },
      PermissionModule: {
        type: "object",
        additionalProperties: false,
        required: ["module", "permissions"],
        properties: {
          module: { type: "string" },
          permissions: { type: "array", items: { type: "string" } },
        },
      },
      User: {
        type: "object",
        additionalProperties: false,
        required: ["id", "email", "name", "role"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          role: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: { id: { type: "string", format: "uuid" }, name: { type: "string" } },
          },
        },
      },
      UserInput: {
        type: "object",
        additionalProperties: false,
        required: ["email", "name", "password", "roleId"],
        properties: {
          email: { type: "string", format: "email" },
          name: { type: "string", minLength: 1, maxLength: 120 },
          password: { type: "string", minLength: 12, maxLength: 128, writeOnly: true },
          roleId: { type: "string", format: "uuid" },
        },
      },
      ProductInput: productInputOpenApiSchema,
      SubType: {
        type: "object",
        required: ["id", "elemTypeId", "description"],
        properties: {
          id: { type: "string" },
          elemTypeId: { type: "string" },
          description: { type: "string" },
        },
      },
      SubTypePage: page(ref("SubType")),
      SubTypeInput: subTypeInputOpenApiSchema,
      Product: {
        type: "object",
        required: [
          "id",
          "companyId",
          ...productInputOpenApiSchema.required,
          "category",
          "stock",
          "lowStock",
        ],
        properties: {
          ...productInputOpenApiSchema.properties,
          id: { type: "string" },
          companyId: { type: "string" },
          category: {
            type: "string",
            readOnly: true,
            description: "Descripción de la categoría (solo lectura); se asigna con categoryId.",
          },
          stock: { type: "integer", minimum: 0 },
          lowStock: { type: "boolean" },
        },
      },
      StockMovement: {
        type: "object",
        required: [
          "id",
          "productId",
          "productName",
          "sku",
          "date",
          "type",
          "quantity",
          "reference",
          "note",
          "reversed",
        ],
        properties: {
          id: { type: "string" },
          productId: { type: "string" },
          productName: { type: "string" },
          sku: { type: "string" },
          date: { type: "string", format: "date-time" },
          type: { type: "string", enum: ["Ingreso", "Salida", "Ajuste", "Reversion"] },
          quantity: { type: "integer" },
          reference: { type: "string" },
          note: { type: "string" },
          documentId: { type: "string" },
          reversesMovementId: { type: "string" },
          reversed: { type: "boolean" },
        },
      },
      ProductPage: page(ref("Product")),
      StockMovementPage: page(ref("StockMovement")),
      ProductMovementCursorPage: {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: { type: "array", items: ref("StockMovement") },
          nextCursor: { type: "string", nullable: true },
        },
      },
      InventorySummary: {
        type: "object",
        required: ["activeProducts", "totalUnits", "lowStockCount", "inventoryValueCents"],
        properties: {
          activeProducts: { type: "integer" },
          totalUnits: { type: "integer" },
          lowStockCount: { type: "integer" },
          inventoryValueCents: { type: "integer" },
        },
      },
      DashboardSummary: {
        type: "object",
        additionalProperties: false,
        required: ["date", "salesToday", "collectionsToday", "receivables", "lowStockCount"],
        properties: {
          date: { type: "string", format: "date", description: "Día en hora de Argentina" },
          salesToday: {
            type: "object",
            additionalProperties: false,
            required: ["totalCents", "count", "previousDayTotalCents"],
            properties: {
              totalCents: safeCents,
              count: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
              previousDayTotalCents: safeCents,
            },
          },
          collectionsToday: {
            type: "object",
            additionalProperties: false,
            required: ["totalCents", "count"],
            properties: {
              totalCents: safeCents,
              count: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            },
          },
          receivables: {
            type: "object",
            additionalProperties: false,
            required: ["balanceCents", "customersWithBalance"],
            properties: {
              balanceCents: safeCents,
              customersWithBalance: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
              },
            },
          },
          lowStockCount: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        },
      },
      DashboardActivityItem: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "id",
              "occurredAt",
              "reference",
              "counterparty",
              "amountCents",
              "status",
              "refId",
            ],
            properties: {
              kind: { type: "string", enum: ["document"] },
              id: accountId,
              occurredAt: {
                type: "string",
                format: "date-time",
                description: "Hora argentina (-03:00)",
              },
              reference: { type: "string" },
              counterparty: { type: "string" },
              amountCents: safeCents,
              status: { type: "string", enum: ["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] },
              refId: accountId,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "id",
              "occurredAt",
              "reference",
              "counterparty",
              "amountCents",
              "status",
              "refId",
            ],
            properties: {
              kind: { type: "string", enum: ["collection"] },
              id: accountId,
              occurredAt: {
                type: "string",
                format: "date-time",
                description: "Hora argentina (-03:00)",
              },
              reference: { type: "string" },
              counterparty: { type: "string" },
              amountCents: safeCents,
              status: { type: "string", enum: ["COLLECTED"] },
              refId: accountId,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "id",
              "occurredAt",
              "reference",
              "counterparty",
              "quantity",
              "status",
              "refId",
            ],
            properties: {
              kind: { type: "string", enum: ["stock_movement"] },
              id: accountId,
              occurredAt: {
                type: "string",
                format: "date-time",
                description: "Hora argentina (-03:00)",
              },
              reference: { type: "string" },
              counterparty: { type: "string" },
              quantity: { type: "integer" },
              status: { type: "string", enum: ["INGRESO", "SALIDA", "AJUSTE", "REVERSION"] },
              refId: accountId,
            },
          },
        ],
      },
      DashboardActivity: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: { items: { type: "array", items: ref("DashboardActivityItem") } },
      },
      DocumentSummary: {
        type: "object",
        required: [
          "id",
          "companyId",
          "customerId",
          "customerName",
          "date",
          "internalNumber",
          "pointOfSale",
          "status",
          "totalCents",
          "itemCount",
        ],
        properties: {
          id: { type: "string" },
          companyId: { type: "string" },
          customerId: { type: "string" },
          customerName: { type: "string" },
          date: { type: "string", format: "date-time" },
          internalNumber: { type: "string" },
          pointOfSale: { type: "string" },
          status: { type: "string", enum: ["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] },
          cancelledBy: { type: "string" },
          totalCents: { type: "integer" },
          itemCount: { type: "integer" },
        },
      },
      DocumentItem: {
        type: "object",
        required: [
          "productId",
          "productName",
          "sku",
          "quantity",
          "unitPriceCents",
          "discountRate",
          "taxRate",
        ],
        properties: {
          productId: { type: "string" },
          productName: { type: "string" },
          sku: { type: "string" },
          quantity: { type: "integer" },
          unitPriceCents: { type: "integer" },
          discountRate: { type: "number", minimum: 0, maximum: 100 },
          taxRate: { type: "number", minimum: 0, maximum: 100 },
        },
      },
      Document: {
        allOf: [
          ref("DocumentSummary"),
          {
            type: "object",
            required: ["pendingCents", "items"],
            properties: {
              pendingCents: { type: "integer", minimum: 0 },
              items: { type: "array", items: ref("DocumentItem") },
            },
          },
        ],
      },
      DocumentPage: page(ref("DocumentSummary")),
      DocumentCollectionItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "occurredAt",
          "amountCents",
          "paymentMethod",
          "receiptNumber",
          "cashMovementId",
        ],
        properties: {
          kind: { type: "string", enum: ["PAYMENT", "CREDIT_APPLIED"] },
          occurredAt: {
            type: "string",
            format: "date-time",
            description: "Hora argentina (-03:00)",
          },
          amountCents: safeCents,
          paymentMethod: {
            anyOf: [paymentMethod, { type: "null" }],
          },
          receiptNumber: { anyOf: [{ type: "string" }, { type: "null" }] },
          cashMovementId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      DocumentCollections: {
        type: "object",
        additionalProperties: false,
        required: ["items", "totalCents", "paidCents", "pendingCents"],
        properties: {
          items: { type: "array", items: ref("DocumentCollectionItem") },
          totalCents: safeCents,
          paidCents: safeCents,
          pendingCents: safeCents,
        },
      },
      CustomerCollectionDocument: {
        type: "object",
        additionalProperties: false,
        required: ["documentId", "documentNumber", "amountCents", "status"],
        properties: {
          documentId: { type: "string" },
          documentNumber: { type: "string" },
          amountCents: safeCents,
          status: { type: "string", enum: ["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] },
        },
      },
      CustomerCollectionApplications: {
        type: "object",
        additionalProperties: false,
        required: [
          "cashMovementId",
          "receiptNumber",
          "paymentMethod",
          "occurredAt",
          "totalCents",
          "documents",
          "creditGeneratedCents",
        ],
        properties: {
          cashMovementId: { type: "string" },
          receiptNumber: { anyOf: [{ type: "string" }, { type: "null" }] },
          paymentMethod,
          occurredAt: {
            type: "string",
            format: "date-time",
            description: "Hora argentina (-03:00)",
          },
          totalCents: safeCents,
          documents: { type: "array", items: ref("CustomerCollectionDocument") },
          creditGeneratedCents: safeCents,
        },
      },
      CreateDocumentInput: createDocumentOpenApiSchema,
      Notification: {
        type: "object",
        required: ["id", "type", "title", "body", "payload", "readAt", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          type: { type: "string", enum: ["ORDER_MESSAGE"] },
          title: { type: "string" },
          body: { type: "string" },
          payload: { type: "object", additionalProperties: true },
          readAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      NotificationPage: {
        type: "object",
        required: ["items", "page", "pageSize", "total"],
        properties: {
          items: { type: "array", items: ref("Notification") },
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          total: { type: "integer", minimum: 0 },
        },
      },
      NotificationUnreadCount: {
        type: "object",
        required: ["count"],
        properties: { count: { type: "integer", minimum: 0 } },
      },
      NotificationReadResult: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", enum: [true] } },
      },
      NotificationReadAllResult: {
        type: "object",
        required: ["updated"],
        properties: { updated: { type: "integer", minimum: 0 } },
      },
      TelegramLinkToken: {
        type: "object",
        required: ["url", "expiresAt"],
        properties: {
          url: { type: "string", format: "uri" },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      ApiError: errorSchema,
    },
  },
  paths: {
    "/notifications": {
      get: {
        tags: ["Notificaciones"],
        security: [secured],
        summary: "Lista las notificaciones de la empresa activa",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          {
            name: "pageSize",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        ],
        responses: {
          "200": {
            description: "Notificaciones recientes paginadas",
            content: { "application/json": { schema: ref("NotificationPage") } },
          },
          ...commonErrors,
        },
      },
    },
    "/notifications/unread-count": {
      get: {
        tags: ["Notificaciones"],
        security: [secured],
        summary: "Cuenta notificaciones sin leer",
        responses: {
          "200": {
            description: "Contador",
            content: { "application/json": { schema: ref("NotificationUnreadCount") } },
          },
          ...commonErrors,
        },
      },
    },
    "/notifications/{id}/read": {
      post: {
        tags: ["Notificaciones"],
        security: [secured],
        summary: "Marca una notificación como leída",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Notificación marcada",
            content: { "application/json": { schema: ref("NotificationReadResult") } },
          },
          ...commonErrors,
        },
      },
    },
    "/notifications/read-all": {
      post: {
        tags: ["Notificaciones"],
        security: [secured],
        summary: "Marca todas las notificaciones como leídas",
        responses: {
          "200": {
            description: "Cantidad actualizada",
            content: { "application/json": { schema: ref("NotificationReadAllResult") } },
          },
          ...commonErrors,
        },
      },
    },
    "/telegram/link-token": {
      post: {
        tags: ["Telegram"],
        security: [secured],
        summary: "Genera un link de vinculación para la empresa activa",
        responses: {
          "201": {
            description: "Link válido por 15 minutos",
            content: { "application/json": { schema: ref("TelegramLinkToken") } },
          },
          "401": commonErrors["401"],
          "503": {
            description: "La integración de Telegram no está configurada",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },
    "/dashboard/summary": {
      get: {
        tags: ["Inicio"],
        security: [secured],
        summary: "Consulta los indicadores del día de la empresa activa",
        responses: {
          "200": {
            description: "Resumen del día calculado en hora de Argentina",
            content: { "application/json": { schema: ref("DashboardSummary") } },
          },
          ...commonErrors,
        },
      },
    },
    "/dashboard/activity": {
      get: {
        tags: ["Inicio"],
        security: [secured],
        summary: "Consulta la actividad reciente de comprobantes, cobros e inventario",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 20, default: 10 },
          },
        ],
        responses: {
          "200": {
            description: "Actividad reciente ordenada del evento más nuevo al más viejo",
            content: { "application/json": { schema: ref("DashboardActivity") } },
          },
          ...commonErrors,
        },
      },
    },
    "/cash/sessions": {
      post: {
        tags: ["Caja"],
        security: [secured],
        summary: "Abre la única caja de la empresa activa",
        requestBody: jsonBody(ref("OpenCashSessionInput")),
        responses: {
          "201": {
            description: "Caja abierta",
            content: { "application/json": { schema: ref("OpenCashSession") } },
          },
          ...commonErrors,
        },
      },
    },
    "/cash/sessions/current": {
      get: {
        tags: ["Caja"],
        security: [secured],
        summary: "Consulta la caja abierta",
        responses: {
          "200": {
            description: "Caja abierta o JSON null si no hay ninguna",
            content: {
              "application/json": {
                schema: {
                  anyOf: [ref("OpenCashSession"), { type: "object", nullable: true, enum: [null] }],
                },
              },
            },
          },
          ...commonErrors,
        },
      },
    },
    "/cash/sessions/{id}/close": {
      post: {
        tags: ["Caja"],
        security: [secured],
        summary: "Cierra la caja calculando el efectivo teórico y la diferencia",
        parameters: [sessionIdParam],
        requestBody: jsonBody(ref("CloseCashSessionInput")),
        responses: {
          "200": {
            description: "Caja cerrada; observación omitida si está vacía",
            content: { "application/json": { schema: ref("ClosedCashSession") } },
          },
          ...commonErrors,
          "409": { ...commonErrors["409"], description: "La caja ya está cerrada" },
          "422": {
            ...commonErrors["422"],
            description: "Diferencia sin observación (campo observation)",
          },
        },
      },
    },
    "/cash/sessions/{id}/collections": {
      post: {
        tags: ["Caja"],
        security: [secured],
        summary: "Cobra a un cliente e imputa a comprobantes, con excedente a saldo a favor",
        description:
          "Acepta clientes activos o inactivos. Sin documentId imputa del más antiguo al más nuevo. Con documentId relee el pendiente bajo lock: si se saldó después de la lectura de admisión, el cobro genera saldo a favor. Una repetición puede responder 200 incluso después del cierre.",
        parameters: [
          sessionIdParam,
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 8, maxLength: 100 },
          },
        ],
        requestBody: jsonBody(ref("CashCollectionInput")),
        responses: {
          "201": {
            description: "Cobro registrado con recibo e imputaciones en una transacción",
            content: { "application/json": { schema: ref("CashReceipt") } },
          },
          "200": {
            description:
              "Mismo recibo por repetición idempotente; saldo actual del cliente recalculado",
            content: { "application/json": { schema: ref("CashReceipt") } },
          },
          ...commonErrors,
          "400": {
            ...commonErrors["400"],
            description: "Entrada inválida o Idempotency-Key ausente o fuera de 8..100 caracteres",
          },
          "409": {
            ...commonErrors["409"],
            description: "Caja cerrada o clave reutilizada con otros datos",
          },
          "422": {
            ...commonErrors["422"],
            description: "Comprobante de otro cliente, anulado o ya saldado al admitir el cobro",
          },
        },
      },
    },
    "/customers/{id}/account": {
      get: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Consulta deuda, saldo a favor y comprobantes pendientes paginados",
        description:
          "Pendientes ordenados por fecha e ID; totales de toda la cuenta, independientes de la página. Solo admite page y pageSize como query.",
        parameters: [pathId(), ...paginationParams],
        responses: {
          "200": {
            description: "Cuenta corriente con página de pendientes",
            content: { "application/json": { schema: ref("CustomerAccount") } },
          },
          ...commonErrors,
        },
      },
    },
    "/customers/{id}/account/summary": {
      get: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Consulta totales facturados, cobrados y saldo neto del cliente",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Totales de la cuenta corriente",
            content: { "application/json": { schema: ref("CustomerAccountSummary") } },
          },
          "400": commonErrors["400"],
          "401": commonErrors["401"],
          "404": commonErrors["404"],
        },
      },
    },
    "/customers/{id}/account/movements": {
      get: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Lista movimientos de cuenta corriente con saldo y cursor",
        parameters: [
          pathId(),
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          { name: "cursor", in: "query", schema: { type: "string", maxLength: 500 } },
        ],
        responses: {
          "200": {
            description: "Página de movimientos en orden cronológico inverso",
            content: { "application/json": { schema: ref("CustomerAccountMovementPage") } },
          },
          "400": commonErrors["400"],
          "401": commonErrors["401"],
          "404": commonErrors["404"],
        },
      },
    },
    "/customers/{id}/account/collections/{cashMovementId}": {
      get: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Consulta los comprobantes cubiertos por un cobro",
        parameters: [pathId(), pathId("cashMovementId")],
        responses: {
          "200": {
            description: "Comprobantes imputados y saldo a favor generado",
            content: { "application/json": { schema: ref("CustomerCollectionApplications") } },
          },
          "401": commonErrors["401"],
          "403": commonErrors["403"],
          "404": commonErrors["404"],
        },
      },
    },
    "/customers/{id}/account/applications": {
      post: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Aplica saldo a favor a un comprobante",
        description: "No requiere caja abierta ni genera un movimiento de caja.",
        parameters: [pathId()],
        requestBody: jsonBody(ref("AccountApplicationInput")),
        responses: {
          "201": {
            description: "Aplicación, pendiente y saldo a favor resultantes",
            content: { "application/json": { schema: ref("AccountApplicationResult") } },
          },
          ...commonErrors,
          "422": {
            ...commonErrors["422"],
            description:
              "Comprobante no admisible o importe superior al pendiente o al saldo a favor",
          },
        },
      },
    },
    "/cash/movements": {
      get: {
        tags: ["Caja"],
        security: [secured],
        summary: "Lista movimientos de caja paginados",
        parameters: [
          ...paginationParams,
          { name: "sessionId", in: "query", schema: { type: "string", format: "uuid" } },
          {
            name: "paymentMethod",
            in: "query",
            schema: { type: "string", enum: ["CASH", "TRANSFER", "CARD"] },
          },
          {
            name: "customerId",
            in: "query",
            schema: { type: "string", minLength: 1, maxLength: 100 },
          },
          { name: "from", in: "query", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", schema: { type: "string", format: "date" } },
        ],
        responses: {
          "200": {
            description: "Página de movimientos",
            content: { "application/json": { schema: ref("CashMovementPage") } },
          },
          ...commonErrors,
        },
      },
    },
    "/cash/sessions/current/totals": {
      get: {
        tags: ["Caja"],
        security: [secured],
        summary: "Consulta totales de la caja abierta",
        responses: {
          "200": {
            description: "Totales o null si no hay caja abierta",
            content: {
              "application/json": { schema: { anyOf: [ref("CashTotals"), { type: "null" }] } },
            },
          },
          ...commonErrors,
        },
      },
    },
    "/health": {
      get: {
        tags: ["Salud"],
        summary: "Comprueba la API y PostgreSQL",
        responses: {
          "200": { description: "Servicio disponible" },
          "503": { description: "Base de datos no disponible" },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Sesión"],
        summary: "Inicia sesión",
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 1 },
          },
        }),
        responses: {
          "200": {
            description: "Sesión iniciada; establece operia_session",
            content: { "application/json": { schema: ref("SessionPayload") } },
          },
          "401": {
            description: "Credenciales inválidas",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Sesión"],
        security: [secured],
        summary: "Cierra sesión",
        responses: { "204": { description: "Sesión cerrada" } },
      },
    },
    "/auth/logout-all": {
      post: {
        tags: ["Sesión"],
        security: [secured],
        summary: "Cierra todas las sesiones del usuario actual",
        responses: {
          "204": { description: "Todas las sesiones fueron cerradas" },
          "401": { description: "Sesión inválida" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Sesión"],
        security: [secured],
        summary: "Devuelve la sesión actual",
        responses: {
          "200": {
            description: "Usuario, empresas, empresa activa, rol y permisos de la empresa activa",
            content: { "application/json": { schema: ref("SessionPayload") } },
          },
          "401": { description: "Sesión inválida" },
        },
      },
    },
    "/companies": {
      get: {
        tags: ["Empresas"],
        security: [secured],
        summary: "Lista las empresas disponibles",
        responses: { "200": { description: "Empresas de la sesión" } },
      },
    },
    "/session/company/{id}": {
      put: {
        tags: ["Empresas"],
        security: [secured],
        summary: "Cambia la empresa activa",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Empresa activa con su rol y permisos recalculados",
            content: { "application/json": { schema: ref("SessionPayload") } },
          },
          "404": { description: "Empresa no disponible" },
        },
      },
    },
    "/geo/provinces": {
      get: {
        tags: ["Geografía"],
        security: [secured],
        summary: "Lista las provincias de Argentina",
        responses: {
          "200": {
            description: "Provincias ordenadas alfabéticamente",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "name"],
                    properties: { id: { type: "string" }, name: { type: "string" } },
                  },
                },
              },
            },
          },
          "400": commonErrors["400"],
          "401": commonErrors["401"],
          "503": {
            description: "Georef no disponible y sin datos en caché",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },
    "/geo/provinces/{provinceId}/localities": {
      get: {
        tags: ["Geografía"],
        security: [secured],
        summary: "Lista las localidades de una provincia",
        parameters: [
          {
            name: "provinceId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^\\d{2}$" },
          },
        ],
        responses: {
          "200": {
            description: "Localidades ordenadas alfabéticamente",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "name", "department"],
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      department: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          "400": commonErrors["400"],
          "401": commonErrors["401"],
          "503": {
            description: "Georef no disponible y sin datos en caché",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },
    "/roles/permissions": {
      get: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Lista permisos agrupados por módulo",
        responses: {
          "200": {
            description: "Catálogo de permisos",
            content: {
              "application/json": { schema: { type: "array", items: ref("PermissionModule") } },
            },
          },
          ...commonErrors,
        },
      },
    },
    "/roles": {
      get: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Lista roles de la empresa activa",
        responses: {
          "200": {
            description: "Roles",
            content: { "application/json": { schema: { type: "array", items: ref("Role") } } },
          },
          ...commonErrors,
        },
      },
      post: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Crea un rol",
        requestBody: jsonBody(ref("RoleInput")),
        responses: {
          "201": {
            description: "Rol creado",
            content: { "application/json": { schema: ref("Role") } },
          },
          ...commonErrors,
        },
      },
    },
    "/roles/{id}": {
      patch: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Actualiza un rol",
        parameters: [{ ...pathId(), schema: { type: "string", format: "uuid" } }],
        requestBody: jsonBody(ref("RoleUpdate")),
        responses: {
          "200": {
            description: "Rol actualizado",
            content: { "application/json": { schema: ref("Role") } },
          },
          ...commonErrors,
        },
      },
      delete: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Borra un rol sin membresías",
        parameters: [{ ...pathId(), schema: { type: "string", format: "uuid" } }],
        responses: { "204": { description: "Rol borrado" }, ...commonErrors },
      },
    },
    "/users": {
      get: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Lista miembros de la empresa activa",
        responses: {
          "200": {
            description: "Usuarios sin credenciales",
            content: { "application/json": { schema: { type: "array", items: ref("User") } } },
          },
          ...commonErrors,
        },
      },
      post: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Agrega una membresía o crea un usuario",
        requestBody: jsonBody(ref("UserInput")),
        responses: {
          "201": {
            description: "Usuario agregado",
            content: { "application/json": { schema: ref("User") } },
          },
          ...commonErrors,
        },
      },
    },
    "/users/{id}": {
      patch: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Cambia el rol de un miembro",
        parameters: [{ ...pathId(), schema: { type: "string", format: "uuid" } }],
        requestBody: jsonBody({
          type: "object",
          additionalProperties: false,
          required: ["roleId"],
          properties: { roleId: { type: "string", format: "uuid" } },
        }),
        responses: {
          "200": {
            description: "Usuario actualizado",
            content: { "application/json": { schema: ref("User") } },
          },
          ...commonErrors,
        },
      },
      delete: {
        tags: ["Usuarios y roles"],
        security: [secured],
        summary: "Quita la membresía de la empresa activa",
        parameters: [{ ...pathId(), schema: { type: "string", format: "uuid" } }],
        responses: { "204": { description: "Membresía borrada" }, ...commonErrors },
      },
    },
    "/customers": {
      get: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Lista clientes paginados de la empresa activa",
        parameters: [
          ...paginationParams,
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "inactive"] } },
          {
            name: "vatCondition",
            in: "query",
            schema: {
              type: "string",
              enum: ["Consumidor final", "Exento", "Monotributista", "Responsable inscripto"],
            },
          },
        ],
        responses: {
          "200": {
            description: "Página de clientes ordenados por nombre comercial",
            content: { "application/json": { schema: ref("CustomerPage") } },
          },
          ...commonErrors,
        },
      },
      post: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Crea un cliente",
        requestBody: jsonBody(ref("CustomerInput")),
        responses: {
          "201": {
            description: "Cliente creado",
            content: { "application/json": { schema: ref("Customer") } },
          },
          ...commonErrors,
        },
      },
    },
    "/customers/{id}": {
      get: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Obtiene un cliente de la empresa activa",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Cliente",
            content: { "application/json": { schema: ref("Customer") } },
          },
          "404": commonErrors["404"],
        },
      },
      patch: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Actualiza un cliente",
        parameters: [pathId()],
        requestBody: jsonBody(ref("CustomerInput")),
        responses: {
          "200": {
            description: "Cliente actualizado",
            content: { "application/json": { schema: ref("Customer") } },
          },
          ...commonErrors,
        },
      },
    },
    "/customers/{id}/deactivation": {
      post: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Da de baja un cliente",
        parameters: [pathId()],
        responses: { "200": { description: "Cliente actualizado" }, ...commonErrors },
      },
    },
    "/customers/{id}/status": {
      patch: {
        tags: ["Clientes"],
        security: [secured],
        summary: "Cambia el estado de un cliente",
        parameters: [pathId()],
        requestBody: jsonBody({
          type: "object",
          required: ["status"],
          properties: { status: { type: "string", enum: ["active", "inactive"] } },
        }),
        responses: { "200": { description: "Cliente actualizado" }, ...commonErrors },
      },
    },
    "/elem-types/{typeId}/sub-types": {
      get: {
        tags: ["Catálogo"],
        security: [secured],
        summary: "Lista los subtipos de la empresa activa para un tipo (por ejemplo PROD_CAT)",
        parameters: [
          { name: "typeId", in: "path", required: true, schema: { type: "string" } },
          ...paginationParams,
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
        ],
        responses: {
          "200": {
            description: "Página de subtipos ordenados por descripción",
            content: { "application/json": { schema: ref("SubTypePage") } },
          },
          ...commonErrors,
        },
      },
      post: {
        tags: ["Catálogo"],
        security: [secured],
        summary: "Crea un subtipo o devuelve el equivalente existente",
        parameters: [{ name: "typeId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: jsonBody(ref("SubTypeInput")),
        responses: {
          "200": {
            description: "Ya existía una descripción equivalente; se devuelve sin cambios",
            content: { "application/json": { schema: ref("SubType") } },
          },
          "201": {
            description: "Subtipo creado",
            content: { "application/json": { schema: ref("SubType") } },
          },
          ...commonErrors,
        },
      },
    },
    "/products": {
      get: {
        tags: ["Productos"],
        security: [secured],
        summary: "Lista productos paginados",
        parameters: [
          ...paginationParams,
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "inactive"] } },
          { name: "lowStock", in: "query", schema: { type: "string", enum: ["true"] } },
        ],
        responses: {
          "200": {
            description: "Página de productos",
            content: { "application/json": { schema: ref("ProductPage") } },
          },
          ...commonErrors,
        },
      },
      post: {
        tags: ["Productos"],
        security: [secured],
        summary: "Crea un producto",
        requestBody: jsonBody(ref("ProductInput")),
        responses: {
          "201": {
            description: "Producto creado",
            content: { "application/json": { schema: ref("Product") } },
          },
          ...commonErrors,
        },
      },
    },
    "/products/{id}": {
      get: {
        tags: ["Productos"],
        security: [secured],
        summary: "Obtiene un producto",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Producto",
            content: { "application/json": { schema: ref("Product") } },
          },
          ...commonErrors,
        },
      },
      patch: {
        tags: ["Productos"],
        security: [secured],
        summary: "Actualiza un producto",
        parameters: [pathId()],
        requestBody: jsonBody(ref("ProductInput")),
        responses: {
          "200": {
            description: "Producto actualizado",
            content: { "application/json": { schema: ref("Product") } },
          },
          ...commonErrors,
        },
      },
    },
    "/products/{id}/stock-movements": {
      post: {
        tags: ["Productos"],
        security: [secured],
        summary: "Registra un ingreso o salida",
        parameters: [pathId()],
        requestBody: jsonBody(stockMovementInputOpenApiSchema),
        responses: {
          "201": {
            description: "Movimiento creado",
            content: { "application/json": { schema: ref("StockMovement") } },
          },
          ...commonErrors,
        },
      },
    },
    "/products/{id}/stock-adjustments": {
      post: {
        tags: ["Productos"],
        security: [secured],
        summary: "Ajusta el stock a un valor",
        parameters: [pathId()],
        requestBody: jsonBody(stockAdjustmentOpenApiSchema),
        responses: {
          "201": {
            description: "Ajuste creado",
            content: { "application/json": { schema: ref("StockMovement") } },
          },
          ...commonErrors,
        },
      },
    },
    "/products/{id}/stock-movements/{movementId}/reversal": {
      post: {
        tags: ["Productos"],
        security: [secured],
        summary: "Revierte un movimiento",
        parameters: [pathId(), pathId("movementId")],
        requestBody: jsonBody(reversalOpenApiSchema),
        responses: {
          "201": {
            description: "Reversión creada",
            content: { "application/json": { schema: ref("StockMovement") } },
          },
          ...commonErrors,
        },
      },
    },
    "/products/{id}/movements": {
      get: {
        tags: ["Productos"],
        security: [secured],
        summary: "Lista movimientos de un producto",
        parameters: [
          pathId(),
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Página de movimientos",
            content: { "application/json": { schema: ref("ProductMovementCursorPage") } },
          },
          ...commonErrors,
        },
      },
    },
    "/stock-movements": {
      get: {
        tags: ["Inventario"],
        security: [secured],
        summary: "Lista movimientos de stock",
        parameters: [
          ...paginationParams,
          {
            name: "type",
            in: "query",
            schema: { type: "string", enum: ["Ingreso", "Salida", "Ajuste", "Reversion"] },
          },
          {
            name: "productId",
            in: "query",
            schema: { type: "string", minLength: 1, maxLength: 100 },
          },
          { name: "from", in: "query", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", schema: { type: "string", format: "date" } },
        ],
        responses: {
          "200": {
            description: "Página de movimientos",
            content: { "application/json": { schema: ref("StockMovementPage") } },
          },
          ...commonErrors,
        },
      },
    },
    "/inventory/summary": {
      get: {
        tags: ["Inventario"],
        security: [secured],
        summary: "Resume el inventario de productos activos",
        responses: {
          "200": {
            description: "Resumen de inventario",
            content: { "application/json": { schema: ref("InventorySummary") } },
          },
          ...commonErrors,
        },
      },
    },
    "/documents": {
      get: {
        tags: ["Comprobantes"],
        security: [secured],
        summary: "Lista comprobantes paginados",
        parameters: [
          ...paginationParams,
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"] },
          },
          {
            name: "customerId",
            in: "query",
            schema: { type: "string", minLength: 1, maxLength: 100 },
          },
        ],
        responses: {
          "200": {
            description: "Página de comprobantes",
            content: { "application/json": { schema: ref("DocumentPage") } },
          },
          ...commonErrors,
        },
      },
      post: {
        tags: ["Comprobantes"],
        security: [secured],
        summary: "Crea un comprobante y descuenta stock",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 8, maxLength: 100 },
          },
        ],
        requestBody: jsonBody(ref("CreateDocumentInput")),
        responses: {
          "201": {
            description: "Comprobante creado",
            content: { "application/json": { schema: ref("Document") } },
          },
          "200": {
            description: "Respuesta idempotente: comprobante ya creado",
            content: { "application/json": { schema: ref("Document") } },
          },
          ...commonErrors,
        },
      },
    },
    "/documents/{id}": {
      get: {
        tags: ["Comprobantes"],
        security: [secured],
        summary: "Obtiene el detalle de un comprobante",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Comprobante y líneas",
            content: { "application/json": { schema: ref("Document") } },
          },
          ...commonErrors,
        },
      },
    },
    "/documents/{id}/collections": {
      get: {
        tags: ["Comprobantes"],
        security: [secured],
        summary: "Lista cobros y aplicaciones de saldo a favor de un comprobante",
        parameters: [pathId()],
        responses: {
          "200": {
            description: "Imputaciones en orden cronológico y saldo del comprobante",
            content: { "application/json": { schema: ref("DocumentCollections") } },
          },
          "401": commonErrors["401"],
          "403": commonErrors["403"],
          "404": commonErrors["404"],
        },
      },
    },
    "/documents/{id}/cancellation": {
      post: {
        tags: ["Comprobantes"],
        security: [secured],
        summary: "Anula un comprobante",
        description:
          "Rechaza con 409 comprobantes con cobros o saldo a favor imputados; requiere reversiones para poder anularlos.",
        parameters: [pathId()],
        requestBody: jsonBody(cancellationOpenApiSchema),
        responses: {
          "201": {
            description: "Comprobante anulado",
            content: { "application/json": { schema: ref("Document") } },
          },
          ...commonErrors,
          "409": {
            ...commonErrors["409"],
            description: "Comprobante ya anulado o con cobros o saldo a favor imputados",
          },
        },
      },
    },
  },
} as const;
