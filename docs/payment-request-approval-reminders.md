# Recordatorios de aprobación de solicitudes de pago

El recordatorio se dirige al aprobador vigente de una solicitud que sigue pendiente de aprobación. El plazo es de **48 horas de lunes a viernes**: cada día hábil aporta hasta 24 horas; los sábados y domingos completos no cuentan. No se aplica una jornada de ocho horas ni un calendario de feriados.

Por ejemplo, una etapa pendiente desde el viernes a las 10:00 cumple el plazo el martes a las 10:00, en la zona horaria configurada para la subsidiaria. El tiempo de las etapas anteriores y el tiempo transcurrido antes de que la etapa actual estuviera disponible no se suman.

Se envía un recordatorio por asignación vigente. Al avanzar de etapa o reasignar el aprobador comienza un plazo nuevo, aunque posteriormente se vuelva a asignar a la misma persona. Si el vencimiento coincide con el inicio de un sábado, el aviso queda para el lunes; los envíos también respetan la exclusión del fin de semana.

Las solicitudes que ya estaban pendientes al instalar la función comienzan su plazo al activar el recordatorio. El sistema anterior no guardaba una fecha que permita comprobar el inicio de la asignación vigente y sus posibles cambios de aprobador; la fecha de creación de la solicitud no sustituye ese dato.

## Plantilla editable

En **Configuración → Plantillas de Notificación**, seleccione **Solicitud de pago pendiente · Recordatorio al aprobador**. La plantilla pertenece a la subsidiaria activa. Un rol con permiso **Ver** puede consultar la configuración y su vista previa; **Editar** permite cambiar el asunto, el mensaje y la activación.

El mensaje identifica el número de solicitud y la subsidiaria. Incluye el aprobador, solicitante, beneficiario, concepto, moneda, importe, fecha de solicitud, pago programado e inicio y vencimiento del plazo de aprobación. Las variables disponibles aparecen en el editor. La vista previa utiliza datos de ejemplo y no envía correos.

El enlace abre la solicitud con su subsidiaria y requiere una sesión autorizada. La persona debe revisar el documento y usar las acciones de aprobación habituales.

## Operación

El servidor revisa periódicamente los vencimientos y procesa una cola de correo. Debe estar habilitado el envío SMTP del ERP y la plantilla de la subsidiaria. El destinatario es la dirección registrada en la cuenta del usuario aprobador. El campo Correo electrónico Tesorería corresponde al aviso de aprobación final.

El cálculo utiliza el desplazamiento UTC configurado en el catálogo de zonas horarias de la subsidiaria. Una zona sin desplazamiento válido impide el envío hasta corregir la configuración; el sistema no sustituye silenciosamente la zona por UTC.

Antes de reservar un envío se comprueban nuevamente la solicitud, etapa, destinatario, permisos y activación de la plantilla. Se conserva el resultado del envío y una reserva temporal para coordinar varios procesos. Si el resultado SMTP es incierto, se deja para revisión en lugar de reenviarlo automáticamente.

## Validación

Las pruebas usan datos sintéticos, correo desactivado y una base PostgreSQL aislada. Cubren el cálculo de fines de semana y límites horarios, asignación y avance de etapas, permisos y subsidiarias, idempotencia, reservas, cambios de estado y configuración, renderizado seguro y edición de la plantilla en escritorio y móvil.
