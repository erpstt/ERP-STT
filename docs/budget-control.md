# Control presupuestario

Acceso: **Contabilidad > Presupuestos**. La matriz también está disponible desde **Líneas de presupuesto**.

La instalación no crea presupuestos ni activa límites. Cree una versión anual, complete o importe las partidas y apruébela. Solo una versión por subsidiaria y año puede estar vigente. Aprobar una nueva revisión conserva la anterior como histórica. Cerrar una versión bloquea incrementos del consumo hasta aprobar una nueva revisión.

El presupuesto es general por sociedad y año. Las partidas se definen por cuenta y mes, sin centro de costo ni proyecto. La ejecución y los compromisos de todos los centros se acumulan en el mismo saldo. Los importes se expresan en moneda funcional de la sociedad.

Disponible = inicial + modificaciones aprobadas - compromisos - ejecución del libro mayor principal. Las órdenes reservan su importe neto desde el guardado; las facturas vinculadas a sus recepciones liberan la reserva correspondiente. Los movimientos del mayor se distribuyen por centro usando las líneas de diario cuando existen.

Tipos de control:

- Estricto: rechaza incrementos que exceden el saldo, con HTTP 422.
- Permisivo: conserva una solicitud de sobreaprobación; el documento financiero se genera al aplicar la autorización. Otra persona autorizada debe aprobarla. La autorización pertenece al solicitante y al contenido y versión presupuestaria revisados.
- Informativo: guarda el documento, muestra la advertencia y registra la desviación.

Los traslados, adiciones y reducciones utilizan el workflow de modificaciones presupuestarias. La aprobación financiera requiere rol 2 o 5 y permiso presupuestario. El saldo de origen se comprueba tanto al solicitar como al aprobar. Los traslados conservan el total y no modifican el presupuesto inicial.

Las solicitudes de pago Otros permiten Activo/Pasivo y exclusivamente las cuentas de Costo/Gasto marcadas en el plan de cuentas mediante payment_request_enabled. Se habilitaron inicialmente 614014, 614015 y 622005 por solicitud del usuario. Las demás permanecen restringidas. Los pagos de CxP no duplican la ejecución de sus facturas.

Importación: CSV o primera hoja XLSX con columnas `cuenta`, `mes`, `monto` sin centro de costo. Mes `YYYY-MM`, importe sin separadores de miles y decimal con punto. La importación reemplaza las partidas del borrador y exige su revisión vigente.

Validación realizada: compilación TypeScript; matriz, reparto anual, filtros y ancho móvil en navegador; CSV y XLSX; pruebas de base de datos con rollback para bloqueos, liberación de reservas al editar y facturar, autoaprobación rechazada, consumo de autorización, advertencias y aprobación de traslados. La autorización consumida se preparó como fixture en la prueba; no representa una prueba completa de aprobación entre dos sesiones de usuarios distintos.

Scripts: `scripts/test-budget-control-db.mjs`, `scripts/test-budget-ui.mjs`, `scripts/test-budget-import.mjs`. El primero usa la base conectada y revierte la transacción; puede mantener bloqueos durante la ejecución. La prueba de interfaz utiliza datos simulados.

Las plantillas actuales CSV/XLSX incluyen cuenta, nombre, categoria, mes y monto. Una plantilla anterior solo es compatible si centro_id está vacío; no se ignoran centros con valor. La migración general comprobó que las partidas existentes no tenían dimensiones y conservó todos sus importes.
