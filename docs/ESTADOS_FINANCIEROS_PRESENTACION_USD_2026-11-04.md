# Estados financieros por empresa: presentación local y USD

## Comportamiento

Estado de Situación Financiera y Estado de Resultados Integral permiten elegir moneda local o USD. La opción inicial es local. La presentación USD conserva la empresa, libro, fechas y filtros del informe; no combina sociedades ni requiere permisos de consolidación. Las otras clases de reporte conservan sus opciones actuales.

La conversión toma las tasas ya registradas en `consolidated_exchange_rates`, con coincidencia de holding, empresa de origen, moneda funcional, USD y mes. Usa cierre para activos/pasivos, histórica para patrimonio y promedio de cada mes para ingresos/costos/gastos. Una empresa funcional USD utiliza identidad. No consulta tasas actuales de documentos ni vuelve a convertir importes originales. Una tasa ausente, duplicada, cero, negativa o no finita impide generar una presentación incompleta.

El resultado del Integral corresponde a movimientos del período. El resultado anual que acompaña el balance utiliza los promedios de los meses correspondientes. La diferencia de conversión del balance se presenta mediante una fila virtual de patrimonio, sin asiento ni cuenta creada. Se conserva cualquier descuadre local anterior, convertido a cierre; la diferencia de presentación no lo oculta.

## Pantalla, archivos y navegación

Pantalla, PDF, CSV y Excel utilizan la moneda de los datos efectivamente generados. Los cambios de filtros invalidan la presentación anterior, y las respuestas tardías no sustituyen un reporte de otro contexto. La matriz conserva la precisión numérica en los archivos, aunque la pantalla redondee los importes para lectura. Los períodos sin movimiento y las dimensiones sin asignar se mantienen visibles según la vista.

El detalle de una cuenta abre el Libro Mayor en moneda local, con una indicación explícita. El Mayor conserva sus columnas locales y originales existentes. La proyección de resultados mantiene su propio alcance local.

Las opciones guardadas y los cálculos de envíos programados conservan `presentationCurrency`. Los trabajadores utilizan exclusivamente el propietario y la sociedad ya validados; una sesión de usuario utiliza su actor real. La información de tasas aplicadas acompaña los datos del informe.

## Implementación y verificación

RPC nuevo `run_financial_statement_presentation(text,jsonb)` con filtro `presentationCurrency: LOCAL|USD`. La vista local delega en los cálculos anteriores. Los calculadores privados y sus tasas están cerrados a acceso directo. La entrada pública exige permiso de lectura de reportes y la empresa solicitada debe estar autorizada. El cambio no escribe saldos, diarios ni corridas de consolidación.

Pruebas aisladas cubren tasas por categoría/mes, identidad USD, filtros, matrices y precisión, resultado de ejercicio cero o menor a un centavo, diferencia de traducción y descuadre previo, permisos por empresa/rol, envíos programados, exportaciones y carreras de carga. Se verifican además las regresiones del Libro Mayor. La evidencia productiva y las definiciones anteriores se conservan en `.local-tools`, fuera del paquete publicable.

La reversión requiere coordinar la aplicación con los calculadores y revisar las programaciones que hayan elegido USD; no se debe retirar el calculador privado mientras existan llamadas programadas que dependan de él.

## Cierre de validación

Compilación correcta y lista explícita de CI: 853/853 pruebas aprobadas, sin omisiones. La validación dirigida incluye 17 casos SQL de conversión, diez de programados, 13 Node/export y doce de interfaz; se conservaron también las regresiones del Mayor. Tras alinear los nombres de migración con el servidor se repitieron los 27 casos SQL correctamente. La comprobación auxiliar antigua de columnas por período requiere un módulo en `.tmp` y un servidor ya iniciado; no forma parte de CI ni se ejecutó contra un ERP. Su comportamiento se cubre en las nuevas pruebas aisladas de interfaz.

Migraciones aplicadas: `20261104170219_add_company_financial_statement_usd_presentation.sql` y `20261104170234_financial_statement_presentation_scheduled_delivery.sql`. Las tres funciones nuevas coinciden exactamente con los cuerpos revisados; los cálculos locales y de consolidación anteriores conservan sus definiciones. Las tres funciones de programados mantienen OID, propietario, ACL y configuración y contienen exclusivamente los reemplazos previstos.

La verificación productiva de los agregados de origen y de sus conversiones utilizó la sociedad y fechas del reporte señalado, sin simular un usuario. Los datos de diarios, impactos, tasas, programaciones y corridas de consolidación conservaron sus huellas durante la aplicación. Se probaron noviembre y octubre, con las tasas reales correspondientes; la consulta agregada de diagnóstico de octubre tardó aproximadamente 11 ms, sin escrituras temporales. Esa consulta no constituye un benchmark integral de la generación del reporte. Los avisos de seguridad y rendimiento mantienen las mismas categorías previas.

Auditoría de dependencias: cero vulnerabilidades altas y críticas; ocho moderadas previas. La publicación de la interfaz y su comprobación remota se registrarán después de la aprobación del commit correspondiente.
