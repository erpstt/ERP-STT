# Propuestas de capitalización de activos fijos

La entrada del menú es **Activos Fijos → Propuestas de Capitalización**. La página también está enlazada desde el listado de activos fijos.

## Instalación

Aplicar `supabase/migrations/20260917140000_fixed_asset_capitalization_proposals.sql` antes de desplegar el servidor y los archivos públicos. Depende del flujo de activos existente y del guardado de facturas con retenciones (`save_supplier_invoice_without_withholding`). La migración conserva esa implementación y su envoltorio de retenciones.

La migración detecta movimientos históricos. No enlaza automáticamente compras con fichas antiguas, porque no existe una relación verificable para hacerlo sin duplicar o atribuir costos incorrectamente. Una diferencia histórica permanece visible hasta conciliar su origen; no se genera ningún ajuste automático para ocultarla.

## Contabilización y precisión

- El indicador `es_activo_fijo` se guarda en la línea de factura y en su línea de asiento. También se detectan débitos PPE sin indicador, por la jerarquía de grupos contables, sin depender del prefijo del número de cuenta.
- Los disparadores capturan las líneas contabilizadas en la misma transacción. Los movimientos directos del mayor sin una línea contable equivalente tienen su propio origen. Las claves únicas impiden duplicar propuestas al recalcular impactos.
- Capitalizar en la cuenta original crea la ficha y sus asignaciones; no duplica el débito del mayor.
- Si la cuenta de la categoría difiere del origen, se genera una reclasificación en moneda local, dentro de un período abierto. Esto permite capitalizar líneas marcadas originalmente como gasto y agrupar costos provenientes de distintas cuentas.
- El desglose genera de 1 a 1000 fichas a partir de una propuesta. La última ficha conserva el residuo a seis decimales. La agrupación admite varias propuestas en una sola ficha y conserva los importes y monedas de cada origen.
- El descarte requiere justificación de al menos 15 caracteres y una cuenta operativa válida. Genera el débito a gasto y el crédito a la cuenta de origen; si ambas cuentas coinciden, registra la decisión sin un asiento redundante.
- Una operación es atómica: fichas, asignaciones, reclasificación y estado se confirman o se revierten juntos. Se bloquean las propuestas seleccionadas para impedir su doble procesamiento.

## Conciliación

Se compara el costo bruto PPE del **libro principal activo** con el costo de fichas no dadas de baja y las propuestas PPE pendientes, por cuenta y subsidiaria. Se excluyen las cuentas de depreciación acumulada y deterioro de la comparación bruta. Las líneas marcadas fuera de PPE se muestran aparte hasta su reclasificación.

El widget es global para la subsidiaria: los filtros de fechas, búsqueda y estado de la bandeja no alteran la conciliación. La lectura se actualiza después de procesar, al volver a la pantalla y cada 30 segundos cuando no hay selección ni formulario abierto. Solo muestra «CONCILIADO» si cada cuenta tiene diferencia exactamente cero y existe libro principal; diferencias compensadas entre cuentas no producen un falso cuadre.

Los créditos PPE sin correspondencia, altas históricas manuales y bajas sin asiento pueden producir diferencias reales. El motor las muestra; no modifica operaciones ajenas a la capitalización ni promete corregir datos históricos automáticamente.

## Acceso y trazabilidad

El permiso `fixed-assets:proposals:manage` controla capitalización y descarte. Se asigna inicialmente a roles de sistema o administradores, siguiendo el patrón del repositorio. Las tablas nuevas admiten lectura con RLS por subsidiaria; las escrituras se realizan mediante funciones autorizadas.

El documento origen queda protegido cuando se procesa una propuesta. Las fichas capitalizadas no permiten cambiar su costo, cuenta/categoría, moneda o subsidiaria por edición directa. El historial muestra fichas y reclasificaciones; el detalle del activo muestra todos sus documentos de origen y costos asignados.

## Verificación

```text
npm.cmd run build
node scripts/test-asset-proposals-ui.mjs
node scripts/test-asset-proposals-db.mjs
```

La prueba UI utiliza respuestas simuladas y Chrome local. La prueba de base usa la conexión configurada en `.env`, aplica la migración temporalmente y ejecuta todo dentro de una transacción con `ROLLBACK` en `finally`, límites de espera de bloqueos y de ejecución. No aplica permanentemente la migración. Requiere autorización para operar en la base conectada y datos de configuración de una subsidiaria de prueba. Valida captura de `FAC_PRO`, moneda extranjera, mayor directo, desglose exacto, agrupación, gasto, bloqueos, acceso y conservación de la conciliación.
