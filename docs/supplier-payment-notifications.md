# Notificaciones de pagos a proveedores

## Solicitudes aprobadas: aviso interno a Tesorería

En **Subsidiarias → Información de la empresa**, el campo opcional **Correo electrónico Tesorería** está junto al correo general y antes del teléfono. Acepta una dirección por subsidiaria. El correo general no reemplaza este destinatario.

En **Configuración → Plantillas de Notificación → Solicitud de pago aprobada · Tesorería** se editan el asunto, la introducción, las variables y la activación para la subsidiaria seleccionada. La vista previa usa datos de ejemplo y no envía mensajes. Se respetan los permisos de consulta y edición de plantillas del rol activo.

Al completar la aprobación final de una solicitud, se registra un aviso con su número, subsidiaria, beneficiario, concepto, importe y moneda, fechas, solicitante y aprobador. El enlace abre la solicitud con autenticación y exige seleccionar la subsidiaria correspondiente. La pantalla muestra su estado actual; abrir el enlace no ejecuta el pago.

La plantilla se crea con un texto inicial activo al consultarla o ante la primera aprobación futura. Para recibir avisos, se debe guardar el correo de Tesorería y tener habilitado el transporte SMTP existente (`EMAIL_NOTIFICATIONS_ENABLED`, `SMTP_*` y la URL pública HTTPS del ERP). La configuración no genera avisos de aprobaciones anteriores. Si falta el destinatario o la plantilla está desactivada cuando se aprueba, ese aviso no se recupera automáticamente al completar la configuración.

La cola es independiente del aviso al proveedor por un pago ya aplicado. Cada ciclo de aprobación admite un solo aviso. Antes de enviar se comprueba que la aprobación siga vigente, que la plantilla esté activa y que el destinatario no haya cambiado. Se cancelan avisos pendientes de solicitudes aplicadas o anuladas. Los rechazos SMTP temporales confirmados tienen hasta tres intentos; un resultado incierto queda para revisión sin repetir el envío automáticamente. El servicio conserva los estados de entrega en `payment_request_approved_email_outbox`, sin exponer acceso directo a usuarios.

Validación local de esta funcionalidad, con PGlite, navegador y SMTP simulado:

```text
npm run build
node --test --test-concurrency=1 scripts/payment-request-approved-email-sql.test.mjs scripts/payment-request-approved-email.test.mjs scripts/payment-request-approved-settings.test.mjs scripts/payment-request-approved-ui.test.mjs
```

La migración `add_payment_request_approved_treasury_email` no modifica solicitudes ni aprobaciones existentes. Estas pruebas no necesitan una conexión a la base de producción ni un destinatario real.

Configuración → Plantillas de Notificación → Notificación Pago a Proveedores permite editar asunto, introducción enriquecida, variables y vista previa por subsidiaria. Solo el administrador puede modificar la plantilla. Se conserva la identidad de creación y de actualización mediante la auditoría central del ERP.

Los pagos de Compras y las solicitudes CXP aplicadas en Tesorería alimentan una cola transaccional al terminar de registrar sus facturas, retenciones y anticipos. No se exige cancelar por completo las facturas. El correo usa el desembolso neto de `supplier_payment.amount_paid` y valida que concilie con las aplicaciones y el movimiento bancario. Las retenciones al registrar la factura no se descuentan nuevamente. Cuando hay anticipos, el detalle muestra el importe aplicado neto por factura y el pie descuenta el anticipo del total transferido.

## Preparación y activación

1. Aplicar `supabase/migrations/20260920120000_supplier_payment_email_notifications.sql` con el procedimiento de migraciones del entorno.
2. Compilar con `npm run build` y reiniciar el servidor.
3. Configurar las siguientes variables exclusivamente en el servidor (no guardar secretos en Git):

```dotenv
EMAIL_NOTIFICATIONS_ENABLED=false
SMTP_HOST=
SMTP_PORT=587
SMTP_FROM=
SMTP_USER=
SMTP_PASSWORD=
```

Se usa TLS implícito en el puerto 465 y STARTTLS obligatorio en los demás. Para relays corporativos sin autenticación se omiten usuario y contraseña. Si el proveedor requiere OAuth o un método distinto de usuario/contraseña, configurar el relay corporativo correspondiente antes de activar. No se deshabilita la validación de certificados.

4. Habilitar la plantilla de las subsidiarias que deban notificar. La instalación crea las plantillas deshabilitadas por defecto.
5. Cuando el SMTP esté listo, establecer `EMAIL_NOTIFICATIONS_ENABLED=true` y reiniciar. El proceso usa la clave de servicio Supabase que ya está configurada en el servidor.

Con el envío desactivado no se abre conexión SMTP. No se encolan pagos históricos al aplicar la migración ni al habilitar una plantilla. Los pagos registrados con la plantilla desactivada quedan como OMITIDO; pueden reenviarse individualmente después. Si se habilita la plantilla mientras el motor SMTP permanece desactivado, los pagos nuevos quedan PENDIENTES y se enviarán al activar el motor; revisar esa cola antes de la activación.

## Historial y recuperación

En el recibo del pago se muestran destinatario, estado, fecha e intentos. Desde una solicitud CXP aplicada se accede con “Ver recibo y notificación”. El correo introducido para reenviar afecta solo esa notificación, no cambia la ficha del proveedor.

La cola persiste entre reinicios y usa bloqueos y una concesión de procesamiento para impedir que dos procesos envíen el mismo intento. Cada versión del pago tiene una huella única; cambios que invalidan el pago cancelan las versiones pendientes. No se reintentan automáticamente errores SMTP: el usuario puede corregir y reenviar desde el recibo. Un resultado ambiguo o un proceso interrumpido queda INCIERTO y requiere verificar el SMTP antes de reenviar, para evitar duplicados. Un rechazo definitivo queda ERROR. “Enviado” significa aceptación por SMTP, no entrega final ni lectura.

El HTML introductorio se sanitiza al guardar y al renderizar. El logo se obtiene de la subsidiaria y solo admite HTTPS. La API no expone las credenciales SMTP. Las funciones de procesamiento de cola son exclusivas del rol de servicio y las consultas de usuarios están limitadas a su subsidiaria activa.

## Validación sin correo real

```text
npm run build
node scripts/test-payment-notifications.mjs
node scripts/test-payment-notifications-ui.mjs
node scripts/test-payment-notifications-db.mjs
```

El test de base de datos aplica temporalmente la migración y ejercita la cola dentro de una transacción que siempre revierte. Necesita la conexión PostgreSQL configurada, una sesión administrativa y un pago aplicado y conciliado. Los tests SMTP utilizan un transporte simulado; no envían mensajes.
