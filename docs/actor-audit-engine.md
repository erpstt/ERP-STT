# Auditoría de actores

La migración `20260913090000_actor_audit_engine.sql` agrega las columnas solicitadas a las tablas de negocio y maestras del esquema `public`, además de las cinco tablas de bitácora existentes. Los esquemas administrados por Supabase (`auth`, `storage`, etc.) no son tablas operativas del ERP y no se modifican.

Cada INSERT toma la identidad autenticada y reemplaza cualquier dato de autor enviado en el cuerpo. Cada UPDATE rechaza cambios a los seis campos de creación y recalcula los datos del último actor. Se agrega `updated_execution_context_id` para conservar también la traza de la modificación. La bitácora existente registra INSERT, UPDATE y DELETE en la misma transacción; sus columnas de actor describen quién ejecutó cada evento, independientemente del creador del documento. Un rollback revierte también la auditoría.

Los eventos, cambios y registros eliminados son inmutables frente a UPDATE, DELETE y TRUNCATE, incluso para conexiones de servicio ordinarias. Se bloquea TRUNCATE en tablas operativas porque omite los eventos individuales; se utiliza DELETE. Un administrador propietario/superusuario sigue teniendo capacidad de alterar el esquema o desactivar triggers: la protección no pretende resistir a quien controla PostgreSQL.

## Identidades

PostgreSQL consulta `auth.users` usando el UUID autenticado. El correo procede de esa cuenta. El nombre se toma de `raw_app_meta_data.actor_name`, del nombre registrado en el ERP o, como último recurso, del correo. El tipo y origen se configuran exclusivamente mediante administración de Supabase Auth, en `app_metadata`:

```json
{
  "actor_type": "AI_AGENT",
  "actor_name": "Agente de compras",
  "actor_source": "Claude API / Anthropic"
}
```

Los valores admitidos son `HUMAN`, `AI_AGENT`, `SYSTEM_JOB` y `EXTERNAL_API`. Usuarios sin configuración especial se identifican como `HUMAN`, con origen registrado `Nexo Web App`. Cada agente o integración necesita una cuenta propia, con correo, permisos, sesión y dispositivo válidos según los controles existentes. Nunca debe compartir el token de un humano. El origen es el canal registrado de la cuenta, no una prueba independiente del dispositivo o proveedor utilizado. No se concede acceso nuevo ni se crean agentes automáticamente.

Los trabajos existentes con `service_role` se identifican como `SYSTEM_JOB`, `system@nexo.local`, «Proceso de sistema Nexo». Las conexiones SQL administrativas sin JWT se identifican como `database@nexo.local`, «Proceso de base de datos», con el rol SQL en el origen. Estos son identificadores técnicos, no buzones de correo. Para distinguir servicios individuales se deben usar cuentas dedicadas. La clave de servicio compartida no identifica un agente específico.

No se confía en `user_metadata` ni en cabeceras de identidad. Supabase permite al usuario editar `user_metadata`; `app_metadata` es administrada. Referencia: [Usuarios de Supabase Auth](https://supabase.com/docs/guides/auth/users).

## Contexto y cobertura

El middleware genera un UUID por solicitud, aislado mediante `AsyncLocalStorage`, que acompaña todas sus llamadas REST/RPC. Los planificadores generan uno por ejecución. `fetchSupabase` elimina cabeceras `x-audit-*` aportadas al adaptador y establece su propia traza. Fuera del middleware genera un UUID por llamada. La base acepta la traza como dato de correlación, nunca como identidad o autorización; accesos SQL sin cabecera usan el identificador de transacción. Un cliente directo a Supabase puede aportar un identificador de thread/trace en `x-audit-execution-context-id` (máximo 100 caracteres).

Todas las llamadas REST de los módulos pasan por el adaptador. Las escrituras no se reintentan automáticamente ante una desconexión: podrían haberse confirmado antes de perder la respuesta.

Un event trigger instala la cobertura cuando se crea una tabla en `public`, incluidas las particiones por herencia de triggers del padre. CREATE TABLE AS y SELECT INTO se rechazan: deben separarse en CREATE TABLE e INSERT para auditar cada fila. Referencia: [Event trigger functions de PostgreSQL](https://www.postgresql.org/docs/17/functions-event-triggers.html).

Los datos anteriores se marcan como «Registro histórico: autor no disponible», con correo `legacy-unknown@nexo.invalid` y origen «Migración histórica / origen desconocido». `SYSTEM_JOB` identifica esa migración, no al autor original desconocido. No se inventa una identidad histórica. Los últimos modificadores permanecen nulos hasta la siguiente actualización.

## Validación y activación

```powershell
npm.cmd run build
node --test scripts/actor-audit-context.test.mjs
node scripts/actor-audit-tests.mjs
node scripts/actor-audit-tests.mjs --apply
```

Los dos últimos comandos requieren `SUPABASE_DB_PASSWORD` en `.env`, además de `SUPABASE_URL`; host, puerto y usuario son configurables. El comando sin `--apply` revierte toda la migración después de verificarla. Con `--apply`, las pruebas se revierten a un savepoint y solo la migración se confirma si todas pasan. La consulta de cobertura exige un trigger activo en cada tabla actual. Los tests no dejan cuentas ni documentos de prueba. Después de aplicar, reiniciar el servidor para cargar el middleware y los adaptadores.

Para SQL en PostgreSQL temporal, sin acceso a Supabase:

```powershell
npm.cmd install --prefix .tmp/actor-audit-validation --no-save --package-lock=false @electric-sql/pglite
node scripts/actor-audit-tests.mjs --local
```

Esta modalidad recrea el esquema mínimo y la auditoría anterior. Valida comportamiento SQL, no reemplaza la comprobación contra el esquema completo y los permisos de la instancia real.

## Consulta dentro del registro

Cada catálogo incluye el botón **Autoría** y el formulario de consulta/edición muestra el bloque **Autoría del registro**. Presenta **Creado por** y **Última modificación por**, con nombre, correo y tipo de actor. El origen y la referencia de ejecución pueden desplegarse. Los registros antiguos y los que aún no tienen modificaciones se describen explícitamente, sin atribuirles el usuario que los está consultando.

El componente compartido `public/record-audit.js` también se integra en facturas y notas de ventas/compras, asientos, documentos comerciales, pagos y cobros, solicitudes de pago, bancos, activos, depreciaciones, saldos iniciales, revaluaciones, operaciones de caja, programaciones y plantillas PDF. Para un editor nuevo se utiliza `NexoRecordAudit.show(tabla, id, contenedor)`; para un listado se utiliza `NexoRecordAudit.button(tabla, id)`. Al cambiar de registro hay que actualizar el id, y al crear uno nuevo se pasa `null`.

La migración `20260913110000_record_actor_audit_view.sql` agrega una consulta de solo lectura con `SECURITY INVOKER`: conserva los permisos SELECT y las políticas RLS de la tabla original. La ruta `/api/audit/record-actor` mantiene la validación de sesión y dispositivo del servidor. Devuelve únicamente los campos de autoría, nunca el contenido completo del registro ni los permisos de una cuenta de servicio.

Comprobaciones de esta integración:

```powershell
npm.cmd run build
node --test scripts/record-audit-depreciations.test.mjs
node scripts/record-actor-audit-tests.mjs
# Activar únicamente la consulta de lectura, después de sus pruebas:
node scripts/record-actor-audit-tests.mjs --apply
npm.cmd install --prefix .tmp/record-audit-validation --no-save --package-lock=false playwright-core
node scripts/record-audit-ui.test.mjs
```

La prueba de navegador usa Chrome instalado y respuestas simuladas en un contexto aislado; no inicia sesión con usuarios reales ni modifica documentos. Comprueba las pantallas de transacción, el modal Vue del catálogo, los estados históricos/sin modificaciones y el tratamiento seguro de nombres como texto.
