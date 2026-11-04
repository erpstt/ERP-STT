# Libro Mayor: moneda e importes originales

El reporte conserva sus diez columnas actuales y agrega al final:

| Columna nueva | Contenido |
| --- | --- |
| Moneda original | Código de la moneda del registro, por ejemplo USD o CRC. |
| Tipo de cambio utilizado | Unidades de moneda local por una unidad original, según la información histórica contabilizada. |
| Débito original | Débito almacenado en moneda original. |
| Crédito original | Crédito almacenado en moneda original. |

Por ejemplo, un débito de USD 100 registrado con tasa 500 conserva 50.000 en la columna local y muestra USD 100 en Débito original. No se usa una tasa de cambio actual ni se reconstruye el importe original dividiendo un importe local redondeado.

Los saldos iniciales con varias monedas utilizan la moneda y tasa históricas de su línea exacta. Los movimientos ordinarios usan una tasa histórica o de cabecera que concuerde con la contabilización; cuando ésta incorpora una tasa ponderada diferente, se presenta la tasa efectiva del impacto. Los ajustes de revaluación mantienen la moneda funcional, tasa 1 y los importes originales cero guardados por el motor. Un dato desconocido se presenta como guion; un cero conocido permanece como cero.

Las columnas se conservan en CSV, Excel, impresión PDF y exportación programada. Excel conserva valores numéricos, con hasta doce decimales de tasa y seis de importe original. Los importes nuevos no se totalizan mezclando monedas. Los débitos, créditos, saldos y totales locales permanecen sin cambios.

## Validación

- 60 pruebas dirigidas aprobadas en la copia de publicación aislada: SQL, pantalla Chromium, CSV/XLSX reales, exportación programada, integridad, terceros y permisos.
- La lista de 83 archivos de CI cubrió 801 casos: 779 pasaron inicialmente y los 22 de SQL pasaron tras normalizar CRLF en los fixtures de Windows. El log conserva el fallo inicial y su repetición correcta; no son 801 aprobaciones en una única ejecución local.
- Los cuerpos aplicados en Supabase coinciden con el SQL revisado. Las huellas completas de los registros del levantamiento, sus asientos y su mayor permanecen idénticas; también sus permisos y configuración.
- Se conserva la corrección previa que relaciona cada línea de apertura con su tercero y centro de costos originales.

Pruebas reproducibles:

```powershell
npm.cmd run build
node --test scripts/general-ledger-original-currency-sql.test.mjs scripts/general-ledger-original-currency-ui.test.mjs scripts/general-ledger-original-currency-exports.test.mjs scripts/general-ledger-opening-entities-sql.test.mjs scripts/spreadsheet-security.test.mjs scripts/xss-report-security.test.mjs scripts/xss-report-ui.test.mjs scripts/statement-ledger-sql-security.test.mjs
```

Los tests utilizan datos sintéticos; no cargan `.env` ni envían documentos o correos reales.
