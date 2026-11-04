# Aplicar solicitudes de pago desde Tesorería

El rol **Encargado de Tesorería** puede aplicar solicitudes aprobadas si tiene **Ver** y **Editar** en **Tesorería → Solicitudes de Pago** y el usuario tiene ese rol activo y asignado, con acceso a la subsidiaria de la solicitud.

La corrección `allow_named_treasury_manager_payment_execution` incorpora los nombres exactos `Encargado de Tesorería` y `Encargado de Tesoreria` a los roles que reconoce el ejecutor existente. Conserva los nombres de Tesorería ya admitidos y la ejecución autorizada por lotes. No exige renombrar el rol ni modificar sus permisos actuales.

Al abrir una solicitud **APROBADA** que no esté bloqueada en un lote, aparece **Aplicar / Ejecutar Pago**. El usuario debe revisar banco, fecha, cambio, método y referencia antes de confirmar. La aprobación y la anulación conservan sus permisos y reglas independientes.

La migración sólo modifica la lista de nombres de `public.pr_can_execute()`, con comprobación de su definición anterior. Conserva el identificador de la función, propietario, permisos y configuración. No aplica pagos, modifica solicitudes ni cambia roles o asignaciones existentes.

La prueba `treasury-manager-execution-sql.test.mjs` usa PGlite y datos sintéticos para comprobar ejecución, separación de funciones, bloqueos y metadatos sin operar sobre la base de producción.
