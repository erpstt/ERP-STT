# Envíos programados de reportes

Acceso: **Informes > Envíos programados**. Cada programación pertenece a la sociedad activa y admite Cuentas por Cobrar o Cuentas por Pagar, con documentos pendientes en moneda local.

Configure el nombre, el reporte, los destinatarios (hasta 20), el formato PDF/CSV/ambos y una frecuencia semanal o mensual. Las horas corresponden a Costa Rica, UTC−6. Para días 29, 30 o 31 inexistentes se utiliza el último día del mes. El corte puede ser el día anterior, el cierre del mes anterior o la fecha de envío. La muestra utiliza hoy como fecha de envío y no manda correos.

Las programaciones pueden editarse, pausarse o eliminarse. La eliminación conserva el historial. Cambiar una programación cancela trabajos pendientes y en preparación; un mensaje ya en transmisión puede completar su entrega. Cada destinatario recibe un mensaje separado.

El proceso Node del ERP ejecuta el planificador cada minuto y atiende la cola cada diez segundos, cuando SMTP está habilitado. Si el proceso estuvo detenido, procesa la ocurrencia vencida más reciente, sin generar una ráfaga de todas las semanas/meses omitidos. La fecha de corte corresponde a esa ocurrencia. No hay envíos mientras `EMAIL_NOTIFICATIONS_ENABLED` y la configuración SMTP no estén activos.

Se reutilizan `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, y opcionalmente `SMTP_USER`/`SMTP_PASSWORD`. Las credenciales se configuran en el servidor; no se almacenan en las programaciones ni se muestran en pantalla. Reinicie el servicio después de cambiar su entorno SMTP.

Estados: PENDIENTE, PREPARANDO, ENVIANDO, ENVIADO, ERROR, INCIERTO y CANCELADO. ENVIADO significa aceptación por SMTP, no lectura ni entrega final garantizada. Un resultado incierto o una interrupción durante el envío no se reintenta automáticamente. El historial muestra los últimos 100 trabajos de la sociedad.

Seguridad: permiso `REPORT_SCHEDULE_MANAGE`, otorgado inicialmente a administradores y roles 2 y 5. Los datos se limitan a la sociedad activa; el trabajador utiliza funciones exclusivas de servicio y comprueba la pertenencia y permisos del propietario. Las tablas no aceptan escrituras directas del usuario. Clave única por programación, ocurrencia y destinatario; las reservas de trabajos impiden consumo concurrente del mismo correo.

El cálculo reutiliza `run_aging_report`, incluyendo todas sus páginas. Por encima de 20.000 documentos el trabajo falla sin enviar un reporte incompleto. Los archivos se generan al procesar cada destinatario, por lo que correcciones contables registradas entre procesamientos pueden reflejarse en sus respectivas copias.

Validación realizada sin correos reales: fechas semanales y fin de mes, cortes, destinatarios, permisos, deduplicación, paginación, pausa antes de envío, historial tras eliminación, PDF real, CSV y simulaciones de aceptación/rechazo/incertidumbre SMTP. La pantalla se probó dentro del iframe del ERP. Scripts: `configure-scheduled-reports.mjs` (migración y prueba con rollback), `test-scheduled-reports.mjs` (transporte simulado y archivos), `test-scheduled-reports-ui.mjs` (interfaz con API simulada).
