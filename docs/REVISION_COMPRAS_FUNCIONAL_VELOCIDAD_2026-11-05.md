# Revisión funcional y de velocidad de Compras

Fecha: 5 de noviembre de 2026, America/Costa_Rica. Base revisada: `5cee629ef0ad911780c8e4a7d10543f2b005adad`.

Se revisaron consultas, captura, edición, referencias, cálculos, permisos, contabilización y exportación. Las escrituras de prueba se ejecutaron en PGlite y las pantallas en un navegador con API simulada. No se crearon ni aplicaron documentos, pagos o correos reales para probar el módulo.

## Cobertura

| Área | Comprobación |
| --- | --- |
| Solicitudes y cotizaciones actuales | Crear y editar con el motor real, sin asientos ni existencias anticipados; permisos y referencias. Los catálogos heredados conservan su consulta sin escrituras directas. |
| Órdenes | Fuente, proveedor, moneda, términos, cantidades, costos, impuestos, dimensiones y aprobación. |
| Recepciones | Orden aprobada, líneas y cantidades exactas, existencias, repetición sin duplicados y saldo por recibir. |
| Facturas | Cuatro rutas de CxP, ubicación normal o heredada, recepción, impuestos y retenciones, cuentas y dimensiones, presupuesto, edición y asientos. |
| Notas de crédito y débito | Factura y moneda de origen, saldo, impuesto histórico, precisión de seis decimales, edición protegida y CxP. |
| Pagos | Banco, tipo de cambio, aplicaciones, notas, anticipos, retenciones, reservas, Tesorería, edición/anulación y diferencias realizadas. |
| Reportes | Facturas liquidadas, grupos y detalle de medios, filtros/paginación de pantalla, XLSX real, fechas, cifras originales y diferencia local. |

La cadena continua probada es solicitud real → cotización real → orden aprobada → recepción idempotente → factura única. Conserva fuentes, líneas, cantidades, costo, dimensiones y total; no duplica inventario ni facturación. Se comprueba también con la optimización de sincronización aplicada.

## Errores corregidos

1. **Total multiplicado por cien:** los documentos sumaban importes leyendo texto formateado en español. El total usa los números originales.
2. **Respuestas fuera de orden:** abrir dos documentos o cambiar de origen rápidamente podía mezclar datos y editar otro identificador. La pantalla descarta respuestas antiguas y bloquea acciones incompatibles durante carga y guardado.
3. **Término de pago anterior:** cambiar a un proveedor sin términos ya no conserva el término del proveedor previo.
4. **Ubicación ignorada:** la factura conserva la ubicación elegida, la histórica al editar y la exacta de la recepción. Se valida subsidiaria y se conserva en encabezado, asiento y líneas, incluida la retención.
5. **Repetición después de guardar:** un fallo de respaldo no vuelve a crear la factura o nota que ya quedó registrada. Los fallos de lectura de archivos muestran un mensaje y liberan los controles.
6. **Impuestos y precisión históricos:** la nota carga y conserva seis decimales. Una nota editable puede conservar su tasa exacta ya registrada para el mismo impuesto y fecha original, aunque cambie el catálogo. Una nota nueva, una tasa arbitraria o un cambio de fecha conserva la validación de configuración vigente.
7. **Opciones incorrectas:** en documentos nuevos se filtran proveedores y dimensiones inactivos o ajenos y períodos cerrados/inactivos; las referencias originales de documentos históricos se mantienen visibles y no se asignan automáticamente a otras líneas.
8. **CxP extranjera residual:** el pago liquida el valor contable atribuible de factura y notas, utiliza el cambio del pago para el banco y registra la diferencia realizada en su cuenta configurada. Conserva la moneda original y precisión local. No transforma cualquier descuadre en diferencia cambiaria.
9. **Notas de débito limitadas al original:** la capacidad pendiente y las opciones incluyen la deuda adicional válida, descontando aplicaciones y reservas y manteniendo las guardas contra sobrepago.

Ejemplos sintéticos del motor real:

- Factura USD 100 a 160 y pago USD 100 a 170: antes quedaban 1.000 locales en CxP; ahora CxP queda en cero y se registra pérdida realizada de 1.000.
- Factura USD 100 a 160, NC USD 20 a 165 y pago USD 80 a 170: CxP queda en cero y la diferencia realizada es 900.
- Factura de 100 más ND de 20: la deuda de 120 aparece y se puede liquidar una sola vez; sobrepagos y reservas siguen protegidos.

## Velocidad

Las dos mediciones comparativas siguientes son locales y sintéticas; no representan tiempo completo de navegación en producción.

| Caso | Antes | Después |
| --- | ---: | ---: |
| Sincronizaciones completas del mayor, factura de 50 líneas | 55 | 3 |
| Inserciones GL durante el guardado, mismo caso | 1.581 | 204 |
| Mediana de tres guardados, mismo caso | 757 ms | 333 ms |
| Opciones de cuenta en una factura de 50 líneas y catálogo de 500 | 25.000 | 500 |
| Markup de esos datalists | 1.398.550 bytes | 27.971 bytes |

La sincronización se difiere únicamente durante el escritor protegido de la factura. Se conservan sus sincronizaciones explícitas finales y se restaura el contexto al terminar o fallar. Las pruebas comparan asientos y mayor exactos, retenciones, rutas, recepción, presupuesto y propuestas de activos. No se modifica el trigger global. En casos pequeños hubo ruido o sobrecosto de medición: 1 línea 62→69 ms y 10 líneas 114→141 ms; no se afirma una mejora uniforme.

La muestra reciente de respuestas exitosas de Supabase tuvo medias de 78 ms para el catálogo de facturas (3 llamadas), 246 ms para opciones de pagos (3) y 23 ms para su reporte (4). Son tiempos del servicio de origen, sin red completa ni renderizado, y la muestra es pequeña. Las consultas de auditoría de huellas que demoraron 1–2 segundos no se atribuyeron al uso del módulo.

## Verificación y límites

- Batería general: **1.108/1.108 pruebas en 119 archivos, sin fallos ni omitidos**. La compatibilidad adicional de aperturas se comprobó con **3/3 pruebas** en un archivo adicional.
- Los motores reales se ejercitaron con pagos parciales, varias tasas/cuentas, NC/ND, anticipos, retenciones completas, Tesorería e idempotencia; se verificaron permisos, subsidiaria, atributos de funciones y ausencia de cambios históricos durante las migraciones.
- La diferencia cambiaria requiere un origen contable inequívoco. Aperturas sin vínculo exacto, revaluaciones no atribuibles y pagos anteriores incompatibles se rechazan antes de guardar y requieren revisión. No se reparan ni se reescriben documentos anteriores automáticamente.
- El importador de aperturas puede guardar asiento, corrida y línea exacta sin repetir la transacción en cada factura. En ese caso se obtiene la transacción del asiento sólo en memoria. Las pruebas usan el INSERT real del importador y dos facturas con asiento compartido; comprueban pago local y extranjero, conservación de la cabecera vacía y rechazo de referencias incorrectas o de otra empresa.
- Los controles de adjuntos de documentos de compra y pagos que no tenían persistencia implementada quedan deshabilitados con un mensaje explícito. Los respaldos ya soportados de facturas/notas conservan su flujo.
- No se certificó la latencia de una sesión autenticada completa: el host del navegador no estuvo disponible y el acceso nativo expiró. La verificación de pantallas fue aislada; la telemetría de servidor es real y de sólo lectura.
- El filtro de calendario del período usa ese identificador cuando el DTO lo expone. Cuando sólo expone el año, se validan empresa, fechas y estados en pantalla; la regla de calendario permanece en el servidor.
- Las pruebas de XLSX utilizan archivos reales. La generación final de PDF con el servicio desplegado no se ejecutó durante esta revisión.
