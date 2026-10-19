# Decisiones de arquitectura

## D10. Telegram por long polling

`TelegramBot` consulta `getUpdates` por long polling y conserva el `offset` en memoria; al fallar la red reintenta después del intervalo configurado. El token del bot solo se usa para construir las solicitudes y nunca se incluye en logs ni errores. El polling se desactiva con `TELEGRAM_POLL_SECONDS=0`.

Cada mensaje de pedido usa `telegram:<chatId>:<messageId>` como `dedupeKey`, único por empresa en PostgreSQL. Telegram puede volver a entregar updates después de reinicios o errores, y el índice único evita crear notificaciones duplicadas.

Solo una instancia del backend debe tener polling activo, ya que Telegram no permite consumidores `getUpdates` simultáneos para el mismo bot. Las demás instancias deben dejar `TELEGRAM_POLL_SECONDS=0`.

## D11. Detalle de cobros por comprobante

El detalle de cobros se construye desde `AccountEntry`, que registra las imputaciones `PAYMENT_APPLIED`, `CREDIT_APPLIED` y `CREDIT_GENERATED`. No se deriva de `cash_movements.document_id`: ese campo queda nulo en los cobros automáticos que se imputan a varios comprobantes.

La consulta por comprobante usa el índice completo `(company_id, document_id)`, llamado `account_entries_company_id_document_id_full_idx`. El índice `account_entries_company_id_document_id_idx` ya existía como índice parcial con `WHERE document_id IS NOT NULL`, por lo que el nuevo índice tiene nombre distinto.

Una aplicación de saldo a favor (`CREDIT_APPLIED`) no se traza hasta el cobro que generó ese crédito. Se muestra como saldo aplicado, sin recibo ni vínculo con el cobro de origen.

## Resumen y actividad del inicio

`GET /dashboard/summary` usa el `companyId` de la sesión y ejecuta una consulta
SQL parametrizada para ventas, cobranzas y cuenta corriente. Ventas y cobros se
agrupan por `created_at` entre el inicio argentino inclusive y el siguiente día
argentino exclusivo; ventas solo considera comprobantes `COMPLETED`. El día
anterior usa el mismo rango calculado para la fecha argentina anterior. Por eso,
un registro de las 23:30 argentinas pertenece a ese día aunque su fecha UTC ya
sea la siguiente, y uno de las 00:00 pertenece al día nuevo.

La cuenta corriente agrupa comprobantes completados y cobros por cliente, resta
los cobros de los comprobantes y suma únicamente saldos positivos; el saldo a
favor de otro cliente no reduce el total adeudado. Las sumas se elevan a
`bigint` en PostgreSQL y se convierten con `accountSafeInteger`, igual que la
cuenta corriente por cliente. `lowStockCount` viene de
`InventoryService.summary`, que mantiene una única regla para stock bajo.

`GET /dashboard/activity` limita cada rama de `UNION ALL` por
`(company_id, created_at DESC, id DESC)`, ordena y recorta el conjunto combinado.
Todos los eventos representan su `created_at`; un comprobante anulado sigue
visible con estado `CANCELLED` y no suma en ventas. `occurredAt` se serializa con
el offset de Argentina. Las cobranzas incluyen movimientos de cualquier sesión
de caja de la empresa.

## Fase C: aislamiento y búsquedas de clientes

Cada lectura y escritura incluye `companyId` de la sesión. Las actualizaciones usan
`updateMany` con `id` y `companyId` para que un identificador de otra empresa
produzca el mismo `not_found` que uno inexistente. El CUIT se normaliza a los 11
dígitos antes de persistir y la restricción única de PostgreSQL por empresa es la
protección final contra carreras.

La búsqueda se limita primero a los clientes de la empresa activa y luego se
normalizan acentos y mayúsculas en memoria. El corte no pagina, así que se evita
agregar una extensión PostgreSQL (`unaccent`) o SQL específico antes de que el
tamaño real de los datos requiera esa optimización. La búsqueda del CUIT ignora
guiones y otros separadores.

Las escrituras validan el objeto completo y rechazan propiedades desconocidas,
incluidos `id`, `companyId` y `movements`; el servidor toma la empresa del contexto
de sesión. La baja (`POST /customers/{id}/deactivation`) siempre fija el estado a
inactivo. El cambio de estado (`PATCH /customers/{id}/status`) acepta explícitamente
ambos estados y permite reactivar.

## OpenAPI

El registro npm no estuvo disponible durante este cambio (`pnpm add @nestjs/swagger`
falló al consultar el registry), por lo que se mantuvo el pipe Zod propio y se
definió un documento OpenAPI 3.0 desde los contratos Zod. `/docs-json` expone el
documento y `/docs` carga Swagger UI. `pnpm openapi:export` escribe `openapi.json`
sin crear la aplicación ni conectarse a PostgreSQL. Swagger UI se sirve desde
unpkg; el JSON sigue disponible directamente si ese CDN no está accesible.

Revisado contra la guía oficial de [OpenAPI de NestJS](https://docs.nestjs.com/openapi/introduction)
y la documentación de [generación de Prisma Client 7](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/generating-prisma-client).

## Fase D: seguridad y calidad

La suite se mantiene en Vitest y Supertest. El proyecto ya utiliza Vitest en los
tests unitarios y E2E; migrar a Jest agregaría una segunda configuración y no
mejoraría la cobertura requerida. La base E2E se valida por el nombre exacto
`operia_test` antes de migrar o sembrar. Cada test limpia sesiones y clientes
temporales etiquetados con `@e2e.operia.invalid`; las filas demo se conservan.

Las contraseñas se procesan con Argon2id. Los IDs de empresa y los IDs de los
clientes demo son estables para conservar referencias de los mocks; los nuevos
clientes y usuarios reciben UUID. Las cookies habilitan `Secure` cuando
`COOKIE_SECURE=true`; localmente permanece desactivado para HTTP. La validación
usa el pipe Zod propio, compatible con Zod 4. La paginación queda fuera de este
corte de la Fase D; la Fase E incorpora paginación offset para productos, movimientos y comprobantes. El limitador usa memoria por proceso y los tests E2E reinician su estado
entre casos para no hacer depender los resultados del orden de ejecución.

## Fase E: productos, stock y comprobantes

El stock disponible se mantiene denormalizado en `products.stock_on_hand` y se actualiza en la misma transacción que cada movimiento. La invariante es que el stock coincide con la suma de los movimientos y nunca queda por debajo de cero (restricción `CHECK`). Los movimientos son append-only: las correcciones se registran como ajustes o reversiones, sin editar ni borrar el historial.

Las salidas actualizan el producto de forma condicional y atómica (`stock_on_hand >= cantidad` junto con `decrement`), evitando la carrera de leer y luego escribir. Cuando una transacción toca varios productos, procesa sus IDs en orden ascendente para reducir deadlocks.

Productos y comprobantes usan `search_text` normalizado con índice GIN `pg_trgm`; los productos se ordenan por `name_normalized` e ID. Esto reemplaza para este dominio la decisión de la Fase C de filtrar en memoria sin paginar. Los clientes siguen filtrándose en memoria y sin paginar; queda como seguimiento optimizar ese listado.

Los listados paginados usan `page` y `pageSize` por offset, con tamaños entre 1 y 100 (25 por defecto), e incluyen `total`. Los importes de la API son centavos enteros; no se envían importes decimales en pesos.

La creación de comprobantes requiere `Idempotency-Key` (8–100 caracteres). Se calcula una huella SHA-256 del payload canónico: repetir clave y payload devuelve el mismo comprobante con 200; repetir la clave con otro payload devuelve 409. La restricción única resuelve la carrera entre solicitudes concurrentes. La numeración se asigna con una tabla contador por empresa y `ON CONFLICT`. El contador solo incrementa y no se decrementa al anular: las transacciones fallidas revierten también su incremento, pero una numeración ya confirmada no se reutiliza.

La anulación revierte las salidas reales del comprobante, omitiendo las que ya tienen reversión. Los comprobantes históricos del seed que no tienen movimientos asociados solo cambian de estado. En la reversión de movimientos se valida primero que el recurso exista en la empresa (404), luego que la operación sea admisible (409 si ya fue revertido) y recién después se modifica stock; intentar revertir una reversión o dejar el stock negativo es una regla de negocio (422). Este orden evita el bug previo en que el stock se modificaba antes de detectar la condición de conflicto.

Las líneas históricas del seed conservan referencias de productos de otra empresa: no se agrega una FK a `products` para esas líneas. El seed corre en cada arranque y es no destructivo: usa `createMany` con `skipDuplicates` y no pisa ediciones existentes.

El rate limit de API identifica sesiones con el bucket `session:<sessionId validado>`; nunca usa la cookie cruda, porque el limitador conserva buckets en memoria y existe un techo de entradas. Las solicitudes sin sesión y las rutas públicas usan bucket anónimo por IP; al exceder el límite se devuelve `Retry-After`. El limitador vive en memoria por proceso, por lo que varias instancias no comparten el conteo. Detrás del rewrite de Next, el tráfico anónimo comparte la IP del proxy; configurar `trust proxy` queda como mejora futura.

### Medición con 100.000 productos

Se cargó una empresa con 100.000 productos y 300.000 movimientos sintéticos (`pnpm db:seed:load`, ids `load-*`) y se midió la API directa, 20 requests por escenario. La primera medición mostró que el listado por defecto (sin filtro de estado) hacía `Seq Scan` y un orden `top-N` sobre todos los productos: el índice `(company_id, status, name_normalized, id)` no puede dar el orden por nombre cuando no se filtra por estado, porque `status` queda entre la igualdad y las columnas de orden. Se agregó el índice `(company_id, name_normalized, id)` (migración `20261009000000_products_name_sort_index`). El `EXPLAIN` de la lista pasó de 21 ms a 0,07 ms, y la página 200 (offset 5.000) tarda 1,3 ms.

Resultado final por la API con 100.000 productos (p95): lista por defecto 19 ms, página 200 16 ms, `pageSize=100` 21 ms, filtro de estado 30 ms, búsqueda selectiva por trigram 8 ms (usa `Bitmap Index Scan` sobre `products_search_text_trgm_idx`), búsqueda amplia 24 ms, `lowStock` 14 ms, resumen de inventario 21 ms. Los objetivos del plan (lista < 150 ms, búsqueda < 200 ms) se cumplen con amplio margen. En el navegador la pantalla de productos renderiza 25 filas y unos 700 nodos DOM con 100.000 productos.

Quedan dos costos lineales conocidos. El total exacto (`count(*)`) recorre todas las filas de la empresa (unos 14 ms con 100.000 productos); si una empresa llegara a cientos de miles de filas conviene un total estimado o acotado, o paginación por cursor. Una búsqueda cuyo término coincide con casi todos los productos no puede usar el índice trigram y hace `Seq Scan`, que es el plan correcto en ese caso. El filtro `lowStock` compara dos columnas y hoy recorre la empresa (9 ms con 100.000 productos); un índice parcial sobre `stock_on_hand <= minimum_stock` lo resolvería si hiciera falta, pero Prisma no puede declararlo y generaría deriva en `migrate diff`.

## Fase F: lectura de caja

Los estados y tipos se modelan con enums Prisma legibles (`OPEN`, `CLOSED`, `COBRO`) y `@map` a las letras almacenadas (`O`, `C`, `C`). La API expone siempre los nombres; CASH, TRANSFER y CARD coinciden entre base y API. Los movimientos conservan snapshots de `customer_name` y `document_number` para que el historial no cambie al editar cliente o comprobante.

El listado usa paginación offset y limita `from`/`to` a 30 días calendario inclusivos. Sin sesión ni fechas usa los 30 días hasta hoy, en calendario argentino; con `sessionId` no aplica ese límite y las fechas son opcionales. `from` y `to` deben enviarse juntos. La conversión de fechas y límites de día se centraliza en `common/argentina-time.ts`. El offset puede desplazar filas entre páginas si ingresan cobros mientras se pagina; se acepta hasta que el producto requiera cursor.

El spike de precisión confirmó que Prisma 7.10 con `adapter-pg` devuelve exactamente 3.000.000.000 en `groupBy` `_sum.amount`; los totales usan `groupBy`, sin SQL crudo, y validan `Number.isSafeInteger` antes de responder. Las columnas de cierre `declared_balance`, `theoretical_balance` y `difference` son `BigInt` desde el inicio. Se descartó `INCLUDE (amount)` en el índice `(company_id, session_id, payment_method)`: Prisma no representa `INCLUDE` y `prisma migrate dev` generaría una migración espuria por el drift; se pierde el index-only scan, que importa poco sobre un conjunto acotado a una sesión.

Limitaciones conocidas: todavía no hay RBAC dentro de la empresa ni reversiones de cobros; cualquier miembro puede consultar todos los movimientos de su empresa. La paginación offset admite desplazamientos con cobros entrantes.

## Apertura, cobro, cierre y cuenta corriente

### D1. Cuenta corriente derivada

La deuda y los saldos se derivan del libro inmutable de imputaciones
`account_entries`; no se guardan como importes en comprobantes ni se crean cargos
al emitir. El estado de cobro sí se guarda como caché, sin reemplazar esa fuente
de verdad; ver [Estado de cobro de comprobantes](#d10-estado-de-cobro-de-comprobantes).
El pendiente es el total menos los cobros y el saldo a favor imputados; el crédito
es el excedente generado menos el crédito aplicado. Las sumas se calculan en SQL,
con índices por empresa, cliente, comprobante y movimiento. Las restricciones de
la base exigen importes positivos y referencias coherentes con cada tipo de
imputación. La aplicación explícita de crédito no exige caja abierta ni genera
movimiento de caja.

### D2. Imputación y excedentes

La imputación vive en la función pura `allocate`. Sin comprobante indicado, recorre los pendientes del más antiguo al más nuevo (`created_at`, luego `id`), aplica hasta el pendiente de cada uno y deja el excedente como saldo a favor. Con comprobante indicado, aplica hasta su pendiente y el resto también queda a favor. La consulta usa una suma acumulada en SQL para traer solo los pendientes necesarios para cubrir el importe, con parámetros mediante `Prisma.sql`.

### D3. Orden de locks y admisión de cobros

El orden es sesión de caja → cliente → contador de recibos, para reducir deadlocks. El cobro toma `FOR SHARE` sobre la sesión: permite cobros concurrentes y obliga al cierre, que toma `FOR UPDATE`, a esperar a los cobros en curso. Los cobros nuevos sobre una caja cerrada se rechazan con 409. Luego se bloquea el cliente con `FOR UPDATE`, compartido por cobros, aplicaciones de crédito y anulaciones, para que no se impute más que el pendiente. El contador se toma al final, dentro de la transacción, para retener su lock lo mínimo; si falla la operación, el número no se consume. La apertura se protege con el índice único parcial de caja abierta por empresa y traduce `P2002` a 409.

En cobros contra un comprobante, el pendiente se lee después del lock de sesión pero antes del lock de cliente y se relee bajo el lock de cliente. Esto distingue un comprobante ya saldado al admitir el cobro (422) de uno que se saldó mientras la solicitud esperaba el lock: en ese caso se acepta el cobro y el excedente queda a favor. La relectura también valida cliente y estado del comprobante.

### D4. Idempotencia de cobros

El encabezado obligatorio `Idempotency-Key` acepta entre 8 y 100 caracteres. La huella SHA-256 usa un objeto canónico con `amountCents`, `customerId`, `documentId` (null si falta), `paymentMethod` y `sessionId` en orden fijo. Las columnas `idempotency_key` y `request_fingerprint` son nullable para conservar filas anteriores; la clave es única por empresa. Una repetición con la misma huella reconstruye el mismo recibo y responde 200; otros datos con la misma clave responden 409. La carrera por `P2002` relee el movimiento. El saldo `customerCreditCents` se calcula al responder, también en repeticiones: puede diferir del saldo de la primera respuesta. Una repetición válida puede devolver el recibo aunque la caja ya esté cerrada.

### D5. Cierre y precisión

El teórico se calcula bajo `FOR UPDATE` sobre la sesión y dentro de la transacción del cierre: saldo inicial más la suma de cobros `CASH`. TRANSFER y CARD no suman efectivo. La diferencia es declarado menos teórico; cualquier diferencia distinta de cero exige observación no vacía (422 sobre `observation`). La observación se recorta y se omite en la respuesta si queda vacía. Las columnas `declared_balance`, `theoretical_balance` y `difference` son `BigInt`; la API verifica enteros seguros antes de exponer números. El declarado llega hasta `Number.MAX_SAFE_INTEGER`, mientras el saldo inicial, cobros e imputaciones quedan hasta 2.147.483.647. Las restricciones de consistencia distinguen sesión abierta sin datos de cierre y sesión cerrada con todos los datos obligatorios. Un segundo cierre responde 409.

### D6. Correo mediante outbox en PostgreSQL

El aviso es de bajo volumen y se escribe en `mail_outbox` en la misma transacción del cierre, solo cuando hay diferencia y destinatarios. PostgreSQL evita la escritura doble que introducirían Redis y BullMQ. El envío se realiza fuera de la solicitud y de la transacción: SMTP lento o caído no retrasa ni revierte el cierre. La clave única `cash-close:<sessionId>` evita encolar dos avisos del mismo cierre.

La entrega es "al menos una vez": si el proceso cae entre enviar y marcar como enviado, el correo puede duplicarse. La selección usa `FOR UPDATE SKIP LOCKED` y un lease de 10 minutos; la actualización de estado comprueba lease e intento para no sobrescribir el trabajo de otro procesador. Los reintentos esperan 1 minuto, 5 minutos, 30 minutos, 2 horas y 6 horas (esa última espera se mantiene para intentos adicionales); `MAIL_MAX_ATTEMPTS` limita los intentos, con 6 por defecto. Al agotarlos queda fallido. `last_error` conserva solo la clase del error, sin mensajes ni credenciales.

Los destinatarios salen de `CASH_ALERT_EMAILS` y se guardan como snapshot al encolar; cambiar la variable no altera avisos pendientes. Sin destinatarios se omite el aviso y se registra una advertencia sin datos personales. La configuración se valida al arrancar y exige SMTP y remitente cuando hay destinatarios. `MAIL_POLL_SECONDS` vale 15 por defecto; `MAIL_POLL_SECONDS=0` desactiva el worker automático, aunque `processDue()` sigue disponible para ejecución explícita. El transporte tiene un puerto `MailTransport` y un adaptador nodemailer. El render es puro, escapa texto libre en HTML, sanea saltos de línea en el nombre de empresa del asunto y formatea pesos con aritmética entera `BigInt`.

### D7. Anulación con imputaciones

La anulación bloquea al cliente dentro de la transacción y consulta `hasImputations` antes de cambiar el comprobante o revertir stock. Un comprobante con cobros o crédito aplicado se rechaza con 409 hasta que existan reversiones, para no dejar deuda y pagos inconsistentes. Sin imputaciones se conserva la anulación existente. `DocumentsModule` importa `CustomerAccountModule`, que depende de la base y no de comprobantes, evitando una dependencia circular.

### D8. Contrato y valores almacenados frente a expuestos

Las seis rutas nuevas requieren sesión válida y toman `companyId` del contexto autenticado; los objetos de entrada Zod son estrictos y rechazan propiedades desconocidas. Las sesiones usan UUID; clientes y comprobantes aceptan identificadores de texto de 1 a 100 caracteres por los IDs estables del seed. Los importes se exponen en centavos, las fechas en ISO con `-03:00` y la consulta de caja abierta devuelve JSON null cuando no hay sesión. La sesión cerrada expone `closedBy` como `{ name }`; el recibo incluye `documentId` nullable, imputaciones y saldo a favor generado y actual. La cuenta devuelve `pending` con `items`, `page`, `pageSize` y `total`; su lectura usa `RepeatableRead` para que totales y página compartan un snapshot. La aplicación responde con `application`, `document` y `creditCents`.

Se mantienen dos representaciones para estados y tipos: letras en la base y nombres legibles en Prisma y la API. Caja guarda `O`/`C` para `OPEN`/`CLOSED` y `C` para `COBRO`; imputaciones guardan `P`/`G`/`A` para `PAYMENT_APPLIED`/`CREDIT_GENERATED`/`CREDIT_APPLIED`; outbox guarda `P`/`S`/`F` para `PENDING`/`SENT`/`FAILED`. Los medios `CASH`, `TRANSFER` y `CARD` coinciden entre base y API.

### D9. Estructura y búsqueda de clientes

`cash` separa lecturas (`cash.service.ts`), sesiones (`cash-sessions.service.ts`) y cobros (`cash-collections.service.ts`), con esquemas, mappers y funciones puras de imputación y cierre. `customer-account` concentra consultas de pendientes, agregados, locks e imputaciones y los comparte con caja y comprobantes. `notifications` separa outbox, worker, puerto de transporte, adaptador SMTP y render. La configuración de entorno y OpenAPI documentan estos contratos sin crear la aplicación para exportar el JSON.

No se agrega Redis para buscar clientes: el cuello de botella es el filtrado en memoria de `GET /customers`, no la falta de una caché. La solución prevista es buscar en PostgreSQL con `pg_trgm` y límite de resultados, en un change aparte, siguiendo el camino ya usado para productos y comprobantes.

### D10. Estado de cobro de comprobantes

El estado guardado es una caché del importe imputado y se recalcula en la misma
transacción, después de escribir las entradas `PAYMENT_APPLIED` (cobros) o
`CREDIT_APPLIED` (`applyCredit`), bajo el lock `FOR UPDATE` del cliente.
`settlementStatus` (`src/cash/settlement-status.ts`) calcula el estado a partir
del total y de lo imputado; `CustomerAccountService.updateSettlementStatuses`
persiste el resultado para cada comprobante afectado. Los importes de deuda,
pendiente y crédito siguen derivados de `AccountEntry`, no del estado guardado.
`COMPLETED` significa saldado. Para las consultas, un comprobante “vigente” es
cualquiera cuyo estado sea distinto de `CANCELLED`.

La migración se divide en dos pasos porque PostgreSQL no permite usar un valor
de enum recién agregado dentro de la misma transacción, y Prisma ejecuta cada
migración en una transacción: primero agrega `PENDING` y `PARTIAL`; después
reclasifica los comprobantes no anulados mediante la suma de `PAYMENT_APPLIED` y
`CREDIT_APPLIED` por comprobante (sin imputaciones: `PENDING`; parcial:
`PARTIAL`; saldado: `COMPLETED`) y establece `PENDING` como valor por defecto.
Los `CANCELLED` no cambian.

La admisión inicial de un cobro contra comprobante exige `PENDING` o `PARTIAL` y
pendiente mayor que cero; si no se cumple, responde `422`. Se conserva la
relectura bajo el lock del cliente descrita en D3: si el comprobante se salda
mientras la solicitud espera ese lock, se acepta el cobro ya admitido y el
excedente queda como saldo a favor. `applyCredit` aplica la regla estricta bajo
el lock y rechaza con `422` un comprobante ya saldado o sin pendiente.

Solo se puede anular un comprobante `PENDING`; se conserva el chequeo de
imputaciones, que responde `409` cuando las hay. El detalle `GET /documents/:id`
incluye `pendingCents` (total menos la suma de cobros y crédito aplicado; `0`
para `COMPLETED` y `CANCELLED`); el mismo campo se incluye en la respuesta de
`POST /documents`, pero no en el endpoint de listado.

Fuera de alcance quedan las reversiones de cobros, la anulación de comprobantes
con imputaciones, incluidos los parciales o saldados, y los vencimientos, la mora y los recordatorios.

El entrypoint de `back` corre `prisma migrate deploy` al arrancar: reiniciar el
servicio con migraciones pendientes las aplica solas, así que conviene respaldar
la base antes de reiniciar.

### Limitaciones conocidas

- Hay roles y permisos por empresa; todavía no hay reversiones de cobros ni de cierres. Los comprobantes con imputaciones no pueden anularse; para la regla de estado de cobro, ver [D10](#d10-estado-de-cobro-de-comprobantes).
- Sin historial ni detalle de sesiones de caja.
- Las filas de `mail_outbox` no tienen política de retención y guardan nombre y correo de quien cierra, además de la observación. El correo puede duplicarse ante una caída entre enviar y marcar.
- `GET /customers` sigue sin paginar y filtra en memoria.

## Catálogo de tipos y categorías de producto

- `elem_types` (tipos comunes a todas las empresas) y `elem_sub_types` (valores por empresa, PK `(id, company_id)`, único por `(company_id, elem_type_id, description_normalized)`). `PROD_CAT` lo inserta la migración, no hay seeder de `elem_types`; los seeds de ejemplo sí crean las categorías de sus productos.
- `products.category` (texto) pasó a `products.category_id`, con FK compuesta `(category_id, company_id)` y `ON DELETE RESTRICT`: la base impide apuntar a una categoría de otra empresa. Que el subtipo sea de tipo `PROD_CAT` lo valida el servicio.
- La migración unifica variantes de una categoría (mayúsculas, tildes y espacios) con la misma normalización que la búsqueda y conserva la variante más usada como descripción. Al aplicarla sobre datos reales, respaldar la base antes: `DROP COLUMN category` no se deshace con Prisma.
- `GET` y `POST /elem-types/{typeId}/sub-types`; el alta es idempotente (201 al crear, 200 si ya existe una equivalente) y resuelve la carrera por el índice único devolviendo la fila ganadora.
- El `search_text` del producto usa la descripción vigente al guardarlo. Al agregar renombrado de categorías habrá que reindexar los productos afectados.
- Límites conocidos: sin ABM (una categoría mal escrita no se puede borrar desde la app) y la descripción sólo se recorta de extremos; la clave normalizada sí compacta espacios internos.

## Mensajes de error por clave e idioma

- Los errores de la API se redactan por clave (`back/src/common/i18n/es.ts` y `en.ts`, con `{parámetros}`) y se resuelven con `Accept-Language` (`resolveLocale`: prioridades `q`, tags regionales como `en-US`; sin cabecera, inválida o no soportada → español). El estado HTTP, el `code` y la forma `{ error: { code, message, fieldErrors? } }` no cambian.
- `ApiException` recibe una `MessageKey` tipada; el filtro traduce. Una clave sin traducción cae al español y, si tampoco existe, se devuelve la clave y se loguea sin datos personales. Tests: paridad de claves y parámetros entre catálogos y uso de claves existentes.
- El idioma llega a `ZodValidationPipe` por un `AsyncLocalStorage` iniciado en un middleware (`runWithRequestLocale`), de modo que los controllers siguen usando `new ZodValidationPipe(schema)`.
- Fuera de alcance (siguen en español): correo de cierre de caja, bot de Telegram, notificaciones ya guardadas (guardan texto, traducirlas exige guardar clave y parámetros) y OpenAPI.

## Empresas y usuarios demo

Se verificó que `prisma/seed.ts`, `prisma/seed-load.ts`, las migraciones,
`src/`, `scripts/` y `.docker/` no crean las empresas `operia-central` y
`operia-hogar`, los usuarios `demo@operia.local` y `hogar@operia.local`, ni sus
membresías. Esos datos existen en las bases de desarrollo y test: los usuarios,
con hash Argon2, se crearon el 2026-10-07 mediante un seed anterior que ya no
está en el repo. Solo `DEMO_USER_*` y `HOGAR_USER_*` en `.env` y Compose nombran
esas cuentas. `README.md` y `README-docker.md` deben aclarar que las empresas y
usuarios se crean fuera del repo y que el seed solo carga productos y
comprobantes sobre empresas existentes.

Una base nueva queda sin empresas ni usuarios, por lo que el seed falla por FK.
La migración de roles debe crear ADMIN para cada fila de `companies` y asignarlo
a todas las membresías existentes. En una base nueva no hay filas que migrar;
quien cree una empresa deberá crear su ADMIN (seed o helpers de tests, tarea
1.3).

## Roles y permisos por empresa

Cada membresía tiene un rol de su empresa mediante `Membership.roleId` y la FK compuesta `(role_id, company_id) → roles(id, company_id)`, con `ON DELETE RESTRICT`. La clave primaria de la membresía mantiene un solo rol por usuario y empresa; un usuario puede tener roles diferentes en otras empresas. Los roles de nombres no reservados guardan sus permisos en `Role.permissions`. El catálogo fijo y tipado vive en `src/permissions/permissions.catalog.ts`; `permissionsForRole` calcula todos los permisos para el rol de sistema `ADMIN`, marcado `isSystem` y con `permissions` vacío en la base, y para los demás roles filtra los valores contra el catálogo: permisos desconocidos se ignoran al evaluar y se rechazan al guardar.

`AuthService.authenticate` carga la membresía y el rol de la empresa activa en cada pedido. Los permisos no se incluyen en la cookie ni se mantienen como autorización en caché: al cambiar un rol, el siguiente pedido ya usa los permisos nuevos. El guard global de permisos corre después del `AuthGuard`; las rutas declaran `@RequirePermission` y aceptan cualquiera de los permisos indicados. `src/permissions/route-permissions.spec.ts` recorre los controladores para exigir permiso en toda ruta protegida y verifica también que las excepciones abiertas existan y no sean rutas de negocio.

El mapa vigente de permisos por método y ruta es:

| Permiso                              | Métodos y rutas                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers.read` o `documents.write` | `GET /customers`, `GET /customers/:id`                                                                                                                               |
| `customers.write`                    | `POST /customers`, `PATCH /customers/:id`, `POST /customers/:id/deactivation`, `PATCH /customers/:id/status`                                                         |
| `products.read` o `documents.write`  | `GET /products`, `GET /products/:id`                                                                                                                                 |
| `products.write`                     | `POST /products`, `PATCH /products/:id`                                                                                                                              |
| `inventory.read`                     | `GET /products/:id/movements`, `GET /inventory/summary`, `GET /stock-movements`                                                                                      |
| `inventory.write`                    | `POST /products/:id/stock-movements`, `POST /products/:id/stock-adjustments`                                                                                         |
| `inventory.cancel`                   | `POST /products/:id/stock-movements/:movementId/reversal`                                                                                                            |
| `documents.read`                     | `GET /documents`, `GET /documents/:id`                                                                                                                               |
| `documents.write`                    | `POST /documents`                                                                                                                                                    |
| `documents.cancel`                   | `POST /documents/:id/cancellation`                                                                                                                                   |
| `cash.read`                          | `GET /cash/sessions/current`, `GET /cash/movements`, `GET /cash/sessions/current/totals`                                                                             |
| `cash.write`                         | `POST /cash/sessions`, `POST /cash/sessions/:id/close`, `POST /cash/sessions/:id/collections`                                                                        |
| `account.read`                       | `GET /customers/:id/account`, `GET /customers/:id/account/summary`, `GET /customers/:id/account/movements`                                                           |
| `account.write`                      | `POST /customers/:id/account/applications`                                                                                                                           |
| `dashboard.read`                     | `GET /dashboard/summary`, `GET /dashboard/activity`                                                                                                                  |
| `users.manage`                       | `GET /roles/permissions`, `GET /roles`, `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`, `GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` |

Las lecturas auxiliares `GET /customers` y `GET /products` aceptan también `documents.write` para completar el formulario de comprobantes; los listados y detalles de comprobantes sí requieren `documents.read`. La lista abierta explícita del test contiene: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /companies`, `PUT /session/company/:id`, `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `POST /telegram/link-token`, `GET /geo/provinces`, `GET /geo/provinces/:provinceId/localities`, `GET /elem-types/:typeId/sub-types`, `POST /elem-types/:typeId/sub-types`, `GET /health`, `GET /docs` y `GET /docs-json`.

La migración crea un `ADMIN` por empresa existente, asigna ese rol a todas sus membresías y después vuelve `roleId` obligatorio. El rol `ADMIN` calcula el catálogo completo y no se puede modificar ni borrar. Los cambios de rol y bajas bloquean con `SELECT ... FOR UPDATE` la fila del rol `ADMIN` dentro de la transacción; una empresa debe conservar al menos una membresía ADMIN y un ADMIN no puede cambiarse a otro rol ni darse de baja a sí mismo. El intento que rompe estas reglas responde 422 `business_rule`; borrar un rol asignado o editar/borrar un rol de sistema responde 409 `conflict`. El rechazo al quitar al último ADMIN se prueba con un actor que tiene `users.manage` y no es ADMIN en esa empresa: un actor ADMIN contaría como otro administrador y la baja no dejaría la empresa sin acceso de administración.

Al crear un usuario nuevo, la contraseña inicial exige entre 12 y 128 caracteres y se usa solo para generar un hash Argon2id; nunca se devuelve ni se almacena en claro. Si el correo ya existe, se agrega solo la membresía y se conservan el nombre y el hash. Los listados de usuarios y roles son arreglos simples y el catálogo se expone agrupado como `{ module, permissions }`.

Las empresas y los usuarios demo se crean fuera del repo; la sección [Empresas y usuarios demo](#empresas-y-usuarios-demo) detalla el origen observado y el alcance del seed. La migración asigna ADMIN a empresas existentes; quien cree empresas nuevas debe crear su ADMIN en el proceso externo correspondiente.

Fuera de alcance: varios roles por usuario; permisos por registro, tipo de persona o campo; roles compartidos entre empresas; auditoría; invitaciones y recuperación de contraseña; permisos para notificaciones y Telegram; y ABM de empresas con creación de su ADMIN.
