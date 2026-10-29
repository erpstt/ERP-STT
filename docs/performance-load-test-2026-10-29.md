# Informe de optimización y carga — GENTIA ERP

**Fecha:** 29 de octubre de 2026

**Objetivo:** certificar una experiencia estable y ágil con 120 sesiones concurrentes.

**Aplicación de producción:** `https://erp-stt-production.up.railway.app`

## Estado ejecutivo

La versión optimizada aprobó la certificación completa de cinco minutos en
Railway contra la URL HTTPS de producción:

- 120 sesiones Auth y dispositivos independientes;
- 6.335 solicitudes durante la fase sostenida;
- 100 % de éxito;
- cero errores y cero timeouts;
- p50 de 427,73 ms;
- p95 de 751,94 ms;
- p99 de 2.368,68 ms;
- 21,12 solicitudes por segundo;
- limpieza posterior verificada al 100 %.

Los cinco criterios automáticos fueron aprobados. Los commits `c13d9f2`,
`fd03644` y `db8825a` fueron desplegados y la verificación se realizó sobre la
instancia nueva de producción.

## Criterios de certificación

| Criterio | Objetivo | Resultado en producción | Estado |
| --- | ---: | ---: | --- |
| Tasa de éxito | >= 99 % | 100 % | Cumple |
| Tasa de error | < 1 % | 0 % | Cumple |
| Timeouts | 0 | 0 | Cumple |
| p95 sostenido | < 1.500 ms | 751,94 ms | Cumple |
| p99 sostenido | < 3.000 ms | 2.368,68 ms | Cumple |

## Resultado de la prueba optimizada

**Run ID de producción:** `1793317079785-56a811b3`

| Fase | Solicitudes | Éxito | p50 | p95 | p99 | Máxima |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bootstrap de 120 sesiones | 240 | 100 % | 1.026,58 ms | 1.368,57 ms | 1.735,08 ms | 2.965,63 ms |
| Rampa + sostenida + recuperación | 6.661 | 100 % | 429,11 ms | 874,18 ms | 2.320,57 ms | 3.825,91 ms |
| Sostenida, 120 sesiones/5 min | 6.335 | 100 % | 427,73 ms | 751,94 ms | 2.368,68 ms | 3.825,91 ms |

La tasa sostenida fue de 21,12 RPS. El proceso de Railway utilizó 8,07 % de CPU
en el intervalo medido, 117,24 MiB de memoria RSS y un retraso de event loop
p99 de 21,35 ms. Estos valores no indican saturación del proceso Node.

## Comparación de producción antes y después

Ambas ejecuciones se realizaron contra Railway con 120 sesiones, cinco minutos
de navegación y la misma mezcla funcional.

| Métrica sostenida | Antes de caché operativa | Producción optimizada |
| --- | ---: | ---: |
| Solicitudes | 6.002 | 6.335 |
| Éxito | 100 % | 100 % |
| Errores / timeouts | 0 / 0 | 0 / 0 |
| p50 | 582,82 ms | 427,73 ms |
| p95 | 1.742,58 ms | 751,94 ms |
| p99 | 7.851,96 ms | 2.368,68 ms |
| RPS | 20,01 | 21,12 |

La mejora redujo el p50 en 26,6 %, el p95 en 56,8 % y el p99 en 69,8 %, a la vez
que aumentó el rendimiento sostenido en 5,5 %.

## Optimizaciones ejecutadas

1. Se consolidó el arranque autenticado en `/api/auth/bootstrap` y una sola RPC.
2. La validación de sesión, dispositivo y permisos comparte resultados positivos
   por un intervalo breve, con expiraciones distribuidas para evitar estampidas.
3. Las solicitudes simultáneas hacia Supabase se limitan y la cola es cancelable.
4. Las opciones de reportes contables se obtienen mediante una RPC agrupada.
5. Los listados de facturas de venta y proveedor, clientes, departamentos,
   centros de costos, cuentas y extractos bancarios, activos y categorías usan
   caché operativa por usuario y sesión.
6. La caché operativa usa un TTL base de 90 segundos con una dispersión
   determinista de 0 % a 15 %.
7. Crear, editar, eliminar o ejecutar servicios especializados invalida el
   catálogo afectado. Cambiar empresa, rol o bootstrap invalida solamente el
   contexto de la sesión.
8. No se implementó `stale-while-revalidate`: al expirar la entrada se consulta
   nuevamente el origen para evitar entregar datos vencidos.
9. Departamentos incluye sus relaciones de subsidiarias en la consulta principal,
   eliminando la paginación adicional del camino caliente.
10. Se agregó telemetría de rutas, llamadas a Supabase, caché, CPU, memoria y
    event loop.

## Efecto de la caché operativa

| Catálogo | Aciertos | Fallos | Tasa de acierto |
| --- | ---: | ---: | ---: |
| Facturas de venta | 970 | 361 | 72,88 % |
| Facturas de proveedor | 968 | 360 | 72,89 % |
| Clientes | 528 | 357 | 59,66 % |
| Cuentas bancarias | 199 | 249 | 44,42 % |
| Extractos bancarios | 194 | 248 | 43,89 % |
| Departamentos | 205 | 241 | 45,96 % |
| Centros de costos | 199 | 248 | 44,52 % |
| Activos | 201 | 241 | 45,48 % |
| Categorías de activos | 204 | 240 | 45,95 % |
| Opciones contables | 201 | 247 | 44,87 % |

Los catálogos de mayor frecuencia redujeron aproximadamente entre 59 % y 64 %
sus viajes promedio a Supabase. La caché de permisos alcanzó 81,52 %.

## Verificación automatizada

- Rendimiento y compatibilidad: 64/64 pruebas.
- Seguridad y autenticación: 91/91 pruebas.
- Entrega estática, compresión y timeouts: 6/6 pruebas.
- Internacionalización: 27/27 pruebas.
- Prueba local de 120 sesiones: aprobada, p95 348,38 ms y p99 1.307,83 ms.
- Prueba corta de producción: aprobada, p95 942,24 ms y p99 1.170,78 ms.
- Prueba completa de producción: aprobada, limpieza verificada.

## Metodología y alcance

El arnés utiliza una identidad técnica inactiva y crea 120 sesiones Auth y
dispositivos independientes. Después del bootstrap, cada sesión navega durante
cinco minutos por una mezcla ponderada de ventas, compras, entidades,
organización, bancos, activos fijos y opciones contables.

Las operaciones funcionales son exclusivamente de lectura. No se crean
facturas, pagos, asientos ni solicitudes. En `finally`, el proceso elimina la
identidad Auth temporal y restaura exactamente el estado anterior del usuario
técnico.

Esta prueba valida concurrencia de sesiones, API, caché y Supabase. No equivale
a 120 identidades distintas ejecutando simultáneamente reportes pesados o
transacciones de escritura. Ese escenario debe ser una fase separada con datos
de prueba y una ventana controlada.

## Recomendaciones posteriores

1. Ejecutar una certificación extendida de 30 minutos durante una ventana
   controlada y conservar las métricas de Railway y Supabase.
2. Preparar un escenario separado para reportes pesados y escrituras con una
   base de datos de prueba; no debe ejecutarse sobre transacciones reales.
3. Mantener alertas para p95 superior a 1.500 ms, p99 superior a 3.000 ms,
   timeouts o tasa de error igual o superior a 1 %.
4. Repetir la prueba después de cambios importantes en autenticación, RLS,
   reportes, catálogos o capacidad de Supabase/Railway.
