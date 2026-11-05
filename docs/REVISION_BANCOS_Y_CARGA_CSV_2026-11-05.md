# Bancos: revisión funcional y carga por CSV

La revisión cubre cuentas bancarias, cheques o transferencias a beneficiarios, depósitos, transferencias entre cuentas, comisiones y conciliación. Las pruebas utilizan datos sintéticos y motores contables reales en una base aislada. La consulta de producción fue de sólo lectura.

## Correcciones

- Los listados y formularios conservan el contexto de subsidiaria, rol y sesión. Una respuesta atrasada no reemplaza los datos de una selección posterior. Renovar el token conserva el contexto vigente.
- Las cuentas bancarias se consultan con su saldo actual. Se retiró su caché de 90 segundos porque también reciben movimientos desde Ventas, Compras, Tesorería y otros procesos.
- Cancelar una edición de comisión limpia el identificador anterior. Crear una comisión nueva genera un documento nuevo. Las acciones se vinculan al identificador del registro y se evitan consultas duplicadas del listado.
- Los botones respetan permisos y estado del documento. Los controles se bloquean durante el guardado; los respaldos fallidos se pueden reintentar conservando el documento principal ya creado.
- Los importes editables conservan seis decimales y las tasas, diez. Se mantienen las referencias históricas seleccionadas, aun cuando ya no estén disponibles para registros nuevos. Los importes inválidos no se convierten en cero ni se eliminan silenciosamente del documento.
- Editar el concepto conserva la ubicación y el período contable originales. Si cambia la fecha, se vuelve a determinar el período; la validación del servidor sigue exigiendo un período abierto y autorizado.
- La moneda local exige tipo de cambio 1. Las validaciones rechazan precisiones incompatibles y conversiones cuya suma por línea no coincide con la contrapartida bancaria, antes de guardar.
- Las ubicaciones compartidas se reconocen por su asignación explícita a la empresa. La ubicación predeterminada del egreso conserva la propia y usa una compartida autorizada cuando corresponde.
- La importación del extracto conserva su comprobante tras el éxito. La conciliación cuadrática conserva la precisión de los saldos y descarta respuestas de aperturas anteriores.

## Uso de las plantillas

En **Cheques o Transferencias** y **Depósitos bancarios**, abra **Importar CSV**, descargue la plantilla correspondiente y reemplace los ejemplos por los datos de la subsidiaria activa. Seleccione el archivo, pulse **Validar y ver vista previa** y revise los documentos, importes y errores antes de **Confirmar importación**.

Archivos:

- `plantilla-cheques-transferencias.csv`: cheques y transferencias a beneficiarios, con 20 columnas.
- `plantilla-depositos-bancarios.csv`: depósitos con sus métodos de pago, con 19 columnas.

Las plantillas usan UTF-8, encabezado y separador `;`. También se acepta un CSV separado por comas con los campos correctamente entrecomillados. Los importes admiten punto o coma decimal, sin separadores de miles, hasta seis decimales; el tipo de cambio admite diez. Guarde los números de cuenta e identificaciones como texto para conservar los ceros iniciales.

Cada documento se identifica con `documento_referencia`. Repita esa referencia y sus datos de encabezado en todas sus líneas. Use otra referencia para el siguiente documento. El límite es 2 MB, 2.000 filas y 200 documentos por archivo.

| Campo | Contenido |
|---|---|
| `documento_referencia` | Referencia única de la carga para ese documento. |
| `tipo_movimiento` | En egresos: `CHEQUE` o `TRANSFERENCIA`. |
| `fecha` | Fecha en formato `AAAA-MM-DD`, dentro de un período abierto de la empresa. |
| `cuenta_bancaria` | Número exacto de la cuenta bancaria de la subsidiaria activa. |
| `moneda` | Código de la moneda de esa cuenta. |
| `tipo_cambio` | Unidades de moneda local por una unidad de la moneda del documento; 1 para moneda local. |
| `referencia_bancaria` | Número del cheque o referencia bancaria del movimiento. |
| `beneficiario` | Nombre del beneficiario del egreso. |
| `ubicacion` | Nombre de una ubicación propia o compartida autorizada. Es opcional; si se omite, no se asigna ubicación. |
| `nota_documento`, `nota_linea` | Concepto general y detalle de cada aplicación. |
| `numero_cuenta` | Número de la cuenta contable de contrapartida. |
| `importe` | Importe positivo de la línea, en la moneda original del documento. |
| `metodo_pago` | En depósitos: código del método de pago. |
| `tipo_entidad` | `CLIENTE`, `PROVEEDOR` o `EMPLEADO`. Los egresos también admiten `AGENCIA_TRIBUTARIA`. |
| `identificacion_entidad` | Identificación fiscal del tercero; para empleados, su número de empleado. |
| `departamento`, `centro_costos`, `clase`, `acreedor_financiero`, `compania_relacionada` | Nombres exactos de referencias habilitadas para la empresa. Se rechazan coincidencias ambiguas. |

Los datos de ejemplo contienen campos `REEMPLAZAR_...` y deben completarse antes de validar. La moneda y la fecha del ejemplo también deben corresponder al movimiento real.

## Validación y confirmación

La vista previa comprueba datos maestros, permisos, empresa, período, moneda, saldo acumulado de egresos, referencias y redondeo. No crea documentos, recibos o asientos ni consume números de documento. Un error indica el registro, el documento y el campo que debe revisarse.

La validación queda vinculada al archivo, usuario, sesión, rol, empresa y datos vigentes durante 15 minutos. Cambiar el archivo o contexto requiere validarlo de nuevo. La confirmación vuelve a comprobar esos datos y utiliza los mismos escritores protegidos de la carga manual.

La importación financiera es atómica: un fallo no deja documentos parciales. Los comprobantes y las referencias evitan volver a contabilizar la misma carga, incluso cuando se pierde la respuesta y el usuario reintenta. No se modifican registros históricos automáticamente.

## Velocidad y evidencia

En PGlite, una carga de 50 líneas pasó de 51 sincronizaciones y 1.326 inserciones GL a una sincronización y 51 inserciones GL. Los resultados contables fueron iguales. La carga CSV de 2.000 líneas completó el registro en 2,84 segundos; el control directo sin diferimiento se detuvo al alcanzar el límite de 25 segundos. Son mediciones aisladas, sin latencia de red ni renderizado de producción.

Las estadísticas del servicio de base de datos para las opciones bancarias tuvieron medias acumuladas de 28 ms en egresos, 40 ms en depósitos, 17 ms en comisiones y 52 ms en transferencias. El contador se reinició el 27 de julio de 2026; estos datos no representan el tiempo completo de apertura de una pantalla.

La revisión de producción incluyó 19 cuentas, 4 egresos, 4 depósitos, 20 comisiones y 7 transferencias. Las comprobaciones de moneda, subsidiaria, suma de líneas y tasa de moneda local no detectaron diferencias en esas reglas. No se ejecutaron pagos, depósitos, conciliaciones o correos reales como prueba.
