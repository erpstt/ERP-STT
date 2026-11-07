# Tipos de cambio automáticos en cargas operativas

Las plantillas operativas de Asientos de Diario, Cheques o Transferencias y Depósitos bancarios no solicitan un tipo de cambio manual. El servidor obtiene la cotización según la moneda del documento, la moneda funcional de la subsidiaria autorizada y la fecha aplicable. En estas cargas, las columnas antiguas de tasa se aceptan por compatibilidad y sus valores se ignoran.

Todas las cargas de saldos iniciales quedan fuera de este ajuste por indicación del usuario. Conservan exactamente las plantillas, importadores y validaciones utilizados en la carga de Jamaica.

## Alcance y fecha

| Carga | Fecha utilizada | Tratamiento |
|---|---|---|
| Asientos de Diario | `fecha` de cada asiento | CSV nuevo de 18 columnas; anterior de 19 admitido. |
| Cheques o Transferencias | `fecha` del movimiento | CSV nuevo de 19 columnas; anterior de 20 admitido. |
| Depósitos bancarios | `fecha` del depósito | CSV nuevo de 18 columnas; anterior de 19 admitido. |
| Todas las cargas de saldos iniciales | Reglas existentes | Sin cambios, incluidos Mayor, CxC, CxP, Bancos, Pendientes de Facturar y Activos Fijos. |
| Comisiones bancarias | Fecha de cada comisión | Ya obtiene la tasa del catálogo; la plantilla no solicita tasa. |
| Extractos y respuestas de bancos | Datos nativos del banco | No solicitan tasa ni realizan una conversión adicional al importar la respuesta o el extracto. |
| Presupuestos | Moneda del presupuesto seleccionado | La plantilla no solicita tasa. |

El catálogo de tipos de cambio es la fuente de cotizaciones de las cargas operativas y conserva sus campos de mantenimiento. Las plantillas de saldos iniciales, tanto CSV como Excel, se mantienen en su versión anterior a este ajuste.

## Cotización y vista previa

Para moneda funcional se utiliza 1. Asientos, cheques, transferencias y depósitos buscan la última tasa directa vigente en la fecha solicitada o antes de ella. Sólo cuando no existe directa se utiliza la última inversa vigente y se calcula su recíproco con diez decimales. No se utilizan cotizaciones posteriores a la fecha solicitada. Una tasa ausente, ambigua, no positiva o no finita impide continuar.

La vista previa muestra la tasa aplicada y la fecha de cotización. El servidor comprueba nuevamente los datos al confirmar. Una cotización modificada, aunque mantenga el mismo valor numérico con otra fecha u origen, exige validar de nuevo. Cambiar el contenido canónico, empresa, rol o sesión también invalida la confirmación.

## Saldos iniciales sin cambios

Se conserva el procedimiento utilizado en Jamaica: los archivos contienen los importes locales y, donde corresponde, los valores en dólares u otra moneda original con su equivalencia local informada. Este ajuste no introduce nuevas consultas de cotización, comparaciones contra tasas del catálogo, campos, cambios de importes ni requisitos de revalidación en saldos iniciales. También se conserva el tratamiento histórico y la conciliación existentes.

## Confirmación y comprobantes

Asientos y Bancos vinculan la validación al archivo canónico, contexto y datos resueltos mediante una confirmación firmada de quince minutos. Se mantienen los permisos publicados: Asientos permite validar con permiso de consulta y exige creación para importar; Bancos mantiene su permiso de creación para ambas operaciones.

Las referencias nuevas de Asientos son únicas por subsidiaria. También se reservan las referencias presentes en comprobantes históricos, sin modificarlos. Para una operación nueva se debe utilizar una referencia nueva. Los comprobantes de cargas confirmadas permiten recuperar una respuesta perdida sin volver a contabilizar; no dependen de que la cotización siga disponible posteriormente.

Las pruebas se ejecutan con datos sintéticos. La preparación y verificación de esta funcionalidad no requiere importar archivos financieros reales.
