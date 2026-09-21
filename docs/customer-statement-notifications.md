# Estados de cuenta automáticos

Disponible en **Configuración → Plantillas de Notificación → Envío de Estado de Cuenta**. El editor admite `empresa_nombre`, `cliente_nombre`, `fecha_corte`, `saldo_total` y `moneda`; permite previsualizar sin enviar. La plantilla es independiente de la de pagos a proveedores y se configura por subsidiaria.

En **Entidades → Clientes**, la sección Crédito y Cobro incluye **Envío de Estado de Cuenta Automático**, desactivado por defecto. Al activarlo se exige un correo válido, tanto en el formulario como en el backend y la base de datos. En la ficha del cliente están el botón de envío y **Historial de Comunicaciones**. El reporte de Antigüedad de Saldos también ofrece el envío en las acciones del cliente y respeta la subsidiaria seleccionada.

El envío manual muestra destinatario, corte e importe antes de confirmar y permite añadir una nota de hasta 2.000 caracteres. Cada confirmación usa un identificador para que reintentar una petición de red no duplique el correo. Se puede descargar el PDF incluso sin SMTP.

## Programación

El día y la hora elegidos en la plantilla de cada subsidiaria (por defecto, **día 1 a las 08:00 America/Costa_Rica**), el proceso selecciona clientes habilitados y con saldo neto positivo al cierre del mes anterior. No envía meses históricos ni recupera ejecuciones de días anteriores. Si el servidor reinicia durante el día programado, los identificadores persistentes por subsidiaria, cliente y corte impiden duplicar envíos.

La plantilla de la subsidiaria y `EMAIL_NOTIFICATIONS_ENABLED=true` deben estar activadas. Se usa el mismo SMTP corporativo del motor de pagos a proveedores; no hay nuevas credenciales. Con SMTP desactivado tampoco se ejecuta el calendario ni se aceptan envíos manuales. Las plantillas y las preferencias pueden prepararse previamente.

## Datos y PDF

Se reutiliza `run_aging_report` en moneda local, consultando todas sus páginas. La autorización de usuarios sigue exigiendo acceso a la subsidiaria; el proceso del servidor usa exclusivamente el rol de servicio. Los anticipos se muestran por separado y el resumen informa el saldo neto. El documento utiliza el HTML y CSS existentes de `account-statement`, y el servicio de generación PDF del ERP produce el adjunto en memoria después de renderizarlo con Chrome. Se conserva la configuración `CHROME_PATH` existente.

El PDF no carga recursos remotos: imprime el nombre corporativo y el logo cuando está almacenado como imagen incorporada. Los logos HTTPS pueden aparecer en el cuerpo del correo. Los campos del cliente y la nota se escapan; el texto enriquecido se sanitiza.

Los estados e intentos se registran en `comunicaciones_logs` y `comunicaciones_intentos`. Un error de PDF impide enviar un mensaje sin adjunto. Cada cliente se procesa de forma aislada en la programación mensual. Si cambia el correo, la asignación a la subsidiaria o la preferencia antes de tomar el envío, se cancela la notificación pendiente. Los errores no se reenvían automáticamente; el usuario puede revisar y confirmar un nuevo envío. Una aceptación SMTP no confirma lectura. Ante un resultado incierto, debe revisarse el servidor antes de reenviar.

## Instalación y pruebas

Migración: `supabase/migrations/20260920140000_customer_statement_notifications.sql`. Aplicarla después de la migración del motor de pagos a proveedores, compilar y reiniciar el ERP. Mantener SMTP desactivado hasta disponer de su configuración.

```text
npm run build
node scripts/test-customer-statements.mjs
node scripts/test-customer-statements-ui.mjs
node scripts/test-customer-statements-db.mjs
```

La prueba de base de datos usa rollback, simula el primer día del mes dentro de esa transacción y no utiliza SMTP. También verifica que se incluyan todas las páginas de un reporte de 501 documentos. La prueba de adjuntos genera un PDF de 270 documentos y usa transporte simulado.

El día admite valores del 1 al 31; para meses más cortos se usa el último día. La hora admite horas y minutos. Se guarda con **Guardar plantilla** y no requiere reiniciar el servidor. Un cambio no duplica cortes ya procesados. Migración de esta configuración: `20260921100000_customer_statement_schedule.sql`.
