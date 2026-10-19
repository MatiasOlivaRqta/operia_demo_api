# Operia API, fases B, C y D

Backend NestJS con PostgreSQL y Prisma 7. Implementa acceso demo por cookie,
selección de empresa y el CRUD de clientes con aislamiento por empresa.

## Inicio local

Requisitos: Node.js 22, pnpm 11 y PostgreSQL 16. También se puede levantar la
base con Docker Compose desde la raíz del proyecto.

1. Copiá `back/.env.example` a `back/.env` y configurá PostgreSQL. Las
   contraseñas que trae el ejemplo son solo para desarrollo.
2. Instalá dependencias con `pnpm install`.
3. Ejecutá `pnpm db:setup` para generar el cliente, crear/aplicar la migración
   inicial en modo desarrollo y cargar los datos demo.
4. Iniciá Nest con `pnpm start:dev`; `GET /health` ejecuta una consulta real a
   PostgreSQL.

El Compose de la raíz aplica `prisma migrate deploy` y ejecuta el seed al iniciar
solo cuando `RUN_SEED=true`; por defecto Compose lo deja desactivado (`false`).
El archivo `.env.example` lo activa para desarrollo local y advierte que las
credenciales demo son públicas y no deben reutilizarse. Las empresas y los usuarios demo se crean fuera del repo;
el seed solo carga productos y comprobantes sobre empresas ya existentes. Los
movimientos de cuenta corriente del frontend no se importan.

## Datos y acceso demo

- Empresas: `operia-central` y `operia-hogar`.
- `demo@operia.local`: acceso a las dos empresas.
- `hogar@operia.local`: acceso solo a Operia Hogar.
- Las contraseñas iniciales están en `back/.env.example`. Cambialas antes de
  compartir el entorno; no son aptas para producción.
- `Company`, `User`, `Membership`, `Session` y `Customer` se mapean a tablas y
  columnas snake_case. Los clientes tienen CUIT de 11 dígitos y unicidad por
  empresa. El saldo y los movimientos se derivarán en fases posteriores.

El login crea un token aleatorio opaco; PostgreSQL almacena solo su SHA-256. La
cookie `operia_session` es HTTP-only, SameSite=Lax y expira según
`SESSION_TTL_HOURS` (8 horas por defecto). Las sesiones también expiran tras
`SESSION_IDLE_MINUTES` sin actividad (60 minutos por defecto); `0` desactiva
este vencimiento por inactividad. `COOKIE_SECURE=true` activa Secure
para HTTPS. El cambio de empresa valida membresía en una transacción serializable.
Las respuestas de login y sesión no se cachean.

## API de clientes

Los endpoints `GET /customers`, `GET /customers/{id}`, `POST /customers`,
`PATCH /customers/{id}`, `POST /customers/{id}/deactivation` y
`PATCH /customers/{id}/status` requieren la cookie de sesión. El servidor obtiene
la empresa activa de esa sesión; los campos `id`, `companyId` y `movements` no se
aceptan en los cuerpos de escritura. Los CUIT se guardan en 11 dígitos, se muestran
con guiones y son únicos dentro de cada empresa. Las respuestas no incluyen
movimientos de cuenta corriente.

La búsqueda admite razón social, nombre comercial, contacto, correo y CUIT, sin
distinguir acentos, mayúsculas ni separadores del CUIT. Aún no hay paginación.

La documentación está en `http://localhost:3001/docs` y el contrato OpenAPI en
`/docs-json` cuando `DOCS_ENABLED=true`. `DOCS_ENABLED` habilita la documentaciÃ³n
fuera de producciÃ³n por defecto y la deshabilita en producciÃ³n. Compose y los
archivos de ejemplo la habilitan para desarrollo local; en producciÃ³n configurÃ¡
`DOCS_ENABLED=false` salvo que quieras exponerla explÃ­citamente. Se puede exportar
el contrato sin base de datos con `pnpm openapi:export`.

`SESSION_MAX_PER_USER` limita a 10 las sesiones simultÃ¡neas por usuario y el
login invalida las mÃ¡s antiguas al superar ese lÃ­mite. `SESSION_CLEANUP_MINUTES`
elimina periÃ³dicamente sesiones vencidas (cada 60 minutos por defecto); el valor
`0` desactiva el proceso. `SESSION_IDLE_MINUTES` vence sesiones tras 60 minutos
sin actividad por defecto; el valor `0` desactiva la expiración por inactividad.

La limitación es en memoria por proceso: por defecto permite 30 intentos de login
por IP y 5 por combinación de IP + email normalizado cada 15 minutos, además de
un tope de respaldo de 100 intentos por email para ataques distribuidos. También
permite 100 solicitudes anónimas por IP por minuto. `TRUST_PROXY_HOPS=0` (default)
usa la conexión directa; detrás de un proxy de borde que agrega
`X-Forwarded-For` (por ejemplo, nginx con `$proxy_add_x_forwarded_for`) configurá
`TRUST_PROXY_HOPS=1`. El back no debe quedar publicado directamente al exterior.
No está compartida entre réplicas y debe sustituirse por almacenamiento
distribuido antes de escalar. Los métodos inseguros validan Origin o Referer
contra `ALLOWED_ORIGINS` si el navegador envía alguno; CORS usa la misma lista.

## Migraciones y comandos

- `pnpm prisma:generate`: genera el cliente en `src/generated/prisma` (ignorado
  por Git y recreado por los comandos de build, tipos y tests).
- `pnpm prisma:migrate:dev`: crea/aplica migraciones durante desarrollo.
- `pnpm prisma:migrate:deploy`: aplica migraciones existentes sin resetear datos.
- `pnpm prisma:seed`: ejecuta el seed idempotente.
- `pnpm test:e2e`: prepara y siembra la base `operia_test` antes de probar. Exige
  que `DATABASE_URL_TEST` termine exactamente en `/operia_test`; no apunta a la
  base de desarrollo.
- `pnpm build`: genera el cliente Prisma y compila NestJS.
- `pnpm openapi:export`: exporta el contrato OpenAPI a `openapi.json` sin conectar
  a PostgreSQL.

`operia_test` se crea mediante `../.docker/postgres/init.sql` al inicializar un
volumen PostgreSQL vacío. Si el volumen ya existía antes de agregar esa
instrucción, creá la base una vez manualmente antes de ejecutar e2e. Ningún
comando de pruebas borra o resetea la base principal.

Para correr los E2E localmente, copiá `.env.example` a `.env` dentro de `back/`,
revisá las credenciales demo y asegurate de que `DATABASE_URL_TEST` apunte a
`operia_test`. Luego ejecutá `pnpm test:e2e` desde `back/`.

## Configuración

`DATABASE_URL` y contraseñas demo son obligatorias. `DATABASE_URL_TEST`,
`PORT`, `ALLOWED_ORIGINS` (orígenes separados por coma), `SESSION_TTL_HOURS`,
`COOKIE_SECURE`, `SESSION_IDLE_MINUTES` (entero >= 0, default 60; `0` desactiva
la expiración por inactividad), `TRUST_PROXY_HOPS` (entero >= 0), emails demo y
límites de login se validan al iniciar. `RATE_LIMIT_LOGIN_IP_ATTEMPTS` (30) y
`RATE_LIMIT_LOGIN_ACCOUNT_ATTEMPTS` (100) configuran los topes adicionales;
ambos usan `RATE_LIMIT_LOGIN_WINDOW_MINUTES`. Los
valores locales de muestra están en `back/.env.example` y en el `.env.example`
de la raíz para Compose.

`DATABASE_URL` es obligatoria para ejecutar el back. Para las pruebas E2E,
configurá además `DATABASE_URL_TEST` con una conexión terminada exactamente en
`/operia_test`. El runner valida esa ruta antes de aplicar migraciones o ejecutar
el seed. `PORT`, `ALLOWED_ORIGINS`, `SESSION_TTL_HOURS`, `COOKIE_SECURE`, los
emails demo y los límites de login tienen valores de desarrollo en el archivo de
ejemplo; las contraseñas demo deben tener al menos 12 caracteres.

## Estructura

- `src/auth`: login, logout, sesiones opacas y tokens.
- `src/companies`: listado y cambio de empresa activa.
- `src/customers`: validación, búsqueda, mapper, servicio y endpoints de clientes.
- `src/common`: seguridad HTTP, errores, CUIT, contexto de sesión y limitadores.
- `prisma`: esquema, migraciones y seed demo.
- `test`: pruebas E2E con Supertest contra `operia_test`.
- `src/**/*.spec.ts`: pruebas unitarias ejecutadas con Vitest.

## Calidad

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

`test:e2e` requiere PostgreSQL disponible y usa únicamente `operia_test`. La
limitación de tasa y la persistencia de sesiones son locales al proceso/base,
respectivamente; el login demo no constituye autenticación de producción.

Las pruebas E2E eliminan sus sesiones y los clientes creados con el dominio
reservado `@e2e.operia.invalid` antes y después de cada caso. Los clientes demo
se conservan como fixtures para comprobar el aislamiento. La suite no requiere
un orden de ejecución particular.
