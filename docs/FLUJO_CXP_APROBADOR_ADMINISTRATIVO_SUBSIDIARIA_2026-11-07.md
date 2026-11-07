# Aprobación de Cuentas por Pagar por subsidiaria

Las solicitudes de pago de tipo CxP se envían al **Aprobador Administrativo** configurado en la subsidiaria de la solicitud. La regla se aplica a todas las subsidiarias, incluidas las que se creen después; no requiere crear un flujo genérico independiente por empresa.

El responsable se configura en **Subsidiarias → Aprobadores → Aprobador Administrativo**. Se utilizan las referencias existentes de usuario ERP (`user:<id>`) y, por compatibilidad, de empleado (`employee:<id>`) vinculado a un usuario ERP. El usuario debe estar activo, pertenecer a la subsidiaria y tener al menos un rol con acceso de consulta a Solicitudes de Pago.

Al enviar una solicitud válida, el servidor resuelve ese campo y crea un único nivel obligatorio con el responsable elegido. La solicitud queda pendiente de aprobación. El cliente no determina al aprobador ni puede omitir ese nivel.

Si el campo está vacío, es inválido o no corresponde a un usuario activo y autorizado, el envío se bloquea antes de crear una aprobación. El código `PRA01` se traduce en un mensaje fijo que pide configurar el Aprobador Administrativo. Se mantienen los controles de versión, subsidiaria, permisos, factura, saldo y reservas; otros conflictos conservan sus mensajes protegidos.

Las subsidiarias que todavía no tienen responsable quedan pendientes de esa asignación. No se les copia el aprobador de otra empresa ni se asigna automáticamente un administrador alternativo.

El responsable se toma al enviar cada solicitud. Cambiar posteriormente la configuración afecta a los próximos envíos; las instancias ya iniciadas, sus decisiones y sus responsables se conservan. Tampoco se modifican las solicitudes aprobadas, ejecutadas ni el historial de los flujos genéricos existentes.

Las rutas actuales de Otros Pagos —incluidos centros de costo, agencias tributarias y aprobaciones internas— mantienen su comportamiento. Esta configuración no aprueba ni ejecuta pagos por sí misma y no modifica las cargas de saldos iniciales.

La validación se realiza con solicitudes sintéticas de distintas subsidiarias, configuraciones ausentes e inválidas, usuarios y empleados, cambios de responsable, flujos históricos y rechazos por permisos, versión y saldo.
