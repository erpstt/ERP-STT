# Notificaciones de pagos a proveedores

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
