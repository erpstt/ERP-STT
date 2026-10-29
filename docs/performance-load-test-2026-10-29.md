# Informe de optimización y carga — GENTIA ERP

**Fecha:** 29 de octubre de 2026

**Objetivo:** certificar una experiencia estable y ágil con 120 sesiones concurrentes.

**Aplicación de producción:** `https://erp-stt-production.up.railway.app`

## Estado ejecutivo

La versión optimizada aprobó la certificación completa de cinco minutos en el
servidor local conectado al mismo Supabase de la aplicación:

- 120 sesiones Auth y dispositivos independientes;
- 6.739 solicitudes durante la fase sostenida;
- 100 % de éxito;
- cero errores y cero timeouts;
- p50 de 99,63 ms;
- p95 de 348,38 ms;
- p99 de 1.307,83 ms;
- 22,46 solicitudes por segundo;
- limpieza posterior verificada al 100 %.

Los cinco criterios automáticos fueron aprobados. La confirmación definitiva en
Railway queda pendiente de desplegar los commits `c13d9f2` y `fd03644`; no se
debe presentar el resultado local como certificación de la red o instancia de
producción hasta repetir allí el mismo escenario.

## Criterios de certificación

| Criterio | Objetivo | Resultado local optimizado | Estado |
| --- | ---: | ---: | --- |
| Tasa de éxito | >= 99 % | 100 % | Cumple |
| Tasa de error | < 1 % | 0 % | Cumple |
| Timeouts | 0 | 0 | Cumple |
| p95 sostenido | < 1.500 ms | 348,38 ms | Cumple |
| p99 sostenido | < 3.000 ms | 1.307,83 ms | Cumple |

## Resultado de la prueba optimizada

| Fase | Solicitudes | Éxito | p50 | p95 | p99 | Máxima |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bootstrap de 120 sesiones | 240 | 100 % | 667,59 ms | 1.472,17 ms | 2.893,23 ms | 4.794,99 ms |
| Rampa + sostenida + recuperación | 7.065 | 100 % | 101,08 ms | 410,38 ms | 1.635,44 ms | 2.920,14 ms |
| Sostenida, 120 sesiones/5 min | 6.739 | 100 % | 99,63 ms | 348,38 ms | 1.307,83 ms | 2.920,14 ms |

La tasa sostenida fue de 22,46 RPS. El proceso utilizó 11,62 % de CPU en el
intervalo medido, 206,41 MiB de memoria RSS y un retraso de event loop p99 de
34,41 ms. Estos valores no indican saturación del proceso Node.

## Comparación con la última ejecución de producción

La última prueba en Railway se ejecutó antes de incorporar la caché operativa.
Sirve como línea base, no como comparación pura de infraestructura porque la
ejecución optimizada de este informe fue local.

| Métrica sostenida | Railway antes de caché operativa | Local optimizado |
| --- | ---: | ---: |
| Solicitudes | 6.002 | 6.739 |
| Éxito | 100 % | 100 % |
| Errores / timeouts | 0 / 0 | 0 / 0 |
| p50 | 582,82 ms | 99,63 ms |
| p95 | 1.742,58 ms | 348,38 ms |
| p99 | 7.851,96 ms | 1.307,83 ms |
| RPS | 20,01 | 22,46 |

La prueba pendiente en Railway determinará qué parte de esta mejora se conserva
con la latencia de red e infraestructura de producción.

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
| Facturas de venta | 1.052 | 362 | 74,40 % |
| Facturas de proveedor | 1.048 | 363 | 74,27 % |
| Clientes | 581 | 360 | 61,74 % |
| Cuentas bancarias | 226 | 247 | 47,78 % |
| Extractos bancarios | 224 | 248 | 47,46 % |
| Departamentos | 226 | 249 | 47,58 % |
| Centros de costos | 220 | 248 | 47,01 % |
| Activos | 222 | 248 | 47,23 % |
| Categorías de activos | 229 | 240 | 48,83 % |
| Opciones contables | 224 | 248 | 47,46 % |

Los catálogos de mayor frecuencia redujeron aproximadamente entre 59 % y 64 %
sus viajes promedio a Supabase. La caché de permisos alcanzó 82,20 %.

## Verificación automatizada

- Rendimiento y compatibilidad: 64/64 pruebas.
- Seguridad y autenticación: 91/91 pruebas.
- Entrega estática, compresión y timeouts: 6/6 pruebas.
- Internacionalización: 27/27 pruebas.
- Prueba corta de 15 sesiones: aprobada, p95 450,90 ms y p99 557,07 ms.
- Prueba completa de 120 sesiones: aprobada, limpieza verificada.

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

## Paso final para producción

1. Rotar las credenciales administrativas que estuvieron presentes en dos
   scripts temporales antiguos y actualizar Railway/Supabase.
2. Publicar los commits saneados y confirmar el despliegue de Railway.
3. Ejecutar nuevamente el arnés de 120 sesiones durante cinco minutos contra
   la URL HTTPS de producción.
4. Certificar solamente si vuelve a cumplir los cinco criterios automáticos.
5. Para una certificación extendida, repetir durante 30 minutos y revisar las
   métricas de Supabase y Railway durante toda la ventana.
