# Estado de Resultados Proyectado

Acceso: **Informes > Reportes de Contabilidad > Estado de Resultados Proyectado**. El Estado de Resultados Integral incluye **Proyectar resultados**, que transfiere sus filtros analíticos. Un corte intermedio se lleva al último mes completo anterior; la pantalla muestra el corte aplicado.

Seleccione ejercicio fiscal (12 meses completos), mes de corte, sociedades, libro, moneda, columna, tipo de departamento, departamento, ubicación, clase, centro de costo/proyecto y nivel de detalle. Proyecto comparte catálogo y dimensión con Centro de Costo, según la configuración vigente; seleccionar identificadores diferentes se rechaza.

Los reales proceden de `gl_impact` del libro principal de cada sociedad o del libro elegido. Las dimensiones se atribuyen según los débitos y créditos de las líneas contabilizadas del mismo documento y cuenta; los movimientos sin dimensión se conservan como sin asignar. El total sin filtros concilia con el Mayor. Se excluyen cierres `ASI_CIE`, tipos equivalentes y diarios marcados `is_year_end_closing` cuando está seleccionado Excluir cierres.

Métodos:

- **Promedio YTD:** suma real dividida por todos los meses transcurridos, incluidos meses sin movimientos; aplica el promedio a los meses restantes.
- **Año anterior:** mismo mes del ejercicio anterior, con el porcentaje de ajuste seleccionado. Mes sin movimientos = cero.
- **Presupuesto aprobado:** importes generales aprobados más modificaciones aprobadas. Requiere una versión aprobada por sociedad y año de los meses futuros. Una partida no presupuestada vale cero. No se habilita con filtros ni columnas dimensionales, por decisión del usuario. Utilice Promedio YTD o Año anterior para esos desgloses.

El importe anual es la suma de reales y futuros. Los importes se redondean a centavos por celda; por ello la suma de promedios redondeados por cuenta puede diferir unos centavos del promedio del resultado agregado.

Seleccione nivel 4 y una vista mensual para editar celdas futuras. Cada ajuste guarda importe y motivo, incluyendo ajustes a cero. Los meses reales son inmutables. Cambiar filtros con ajustes pendientes requiere guardar/restablecer antes; no se transfieren ajustes a otras cuentas o dimensiones inadvertidamente. Los escenarios pertenecen a su usuario y sociedad activa, conservan parámetros y ajustes, y utilizan revisión para evitar sobrescribir cambios concurrentes. Cargar un escenario recalcula los reales con la contabilidad vigente. Ninguna operación de proyección crea asientos ni modifica presupuestos.

Moneda: se usa el promedio consolidado disponible para el mes y holding cuando la presentación es USD; de lo contrario, el último tipo de cambio directo/inverso disponible al cierre mensual. Los futuros mantienen el cambio conocido al corte. Una tasa ausente detiene el cálculo. El informe muestra todas las tasas utilizadas.

**Agregado** suma sociedades autorizadas en una moneda común, sin eliminaciones. **Consolidado** utiliza USD, el Mayor vigente y las eliminaciones publicadas de la holding; exige consolidaciones publicadas de los meses reales y de los meses anteriores necesarios para la metodología Año anterior. Se debe seleccionar todo el perímetro de las hojas publicadas correspondientes. Las eliminaciones sin dimensión aparecen en Sin asignar (o Eliminaciones para columna Subsidiaria); un filtro dimensional las excluye y muestra esa advertencia. Este informe no publica ni modifica consolidaciones. Con presupuesto, los meses futuros siguen los presupuestos generales y pueden ajustarse manualmente.

CSV presenta columnas uniformes, importes con dos decimales, filas de resumen, filtros y motivos legibles. PDF incluye resumen ejecutivo anual, detalle mensual por semestres en A4 horizontal, filtros y ajustes, con colores para reales, futuros y ajustes. Ambas descargas incluyen todas las dimensiones del informe generado, incluso cuando la pantalla muestra solo una columna seleccionada. Al desglosar columnas puede elegirse una dimensión para ver y editar su detalle mensual.

Activación: `20260922020000_income_forecast.sql`, compilación y reinicio del servicio. `configure-income-forecast.mjs` prueba usando `SET LOCAL ROLE authenticated`, valida filtros, sociedad, conciliación contra Mayor, exclusión de cierre y revisión de escenario, revirtiendo todos los datos de prueba. `--apply` conserva solo la migración. `--snapshot` genera temporalmente `.tmp/income-forecast-source.json` para `test-income-forecast-ui.mjs`; elimínelo después de las pruebas. `test-income-forecast.mjs` valida metodologías, redondeo, inflación, meses vacíos, moneda, consolidado y protección de ajustes. La prueba de navegador verifica escenarios, CSV y PDF real con API simulada.
