# Informe de prueba de carga — GENTIA ERP

**Fecha:** 29 de octubre de 2026  
**Entorno:** Producción en Railway  
**Objetivo:** evaluar estabilidad, latencia y recuperación con hasta 120 usuarios virtuales concurrentes.

## Conclusión ejecutiva después de optimizar

**Resultado actual: Aprobado para 120 usuarios concurrentes, con una mejora adicional recomendada en la inicialización de sesión.**

La versión optimizada `f4468e9` procesó 1.348 solicitudes autenticadas y 640 públicas con **100% de éxito**, sin timeouts ni respuestas HTTP 5xx. En la fase sostenida de 120 usuarios, el p95 bajó de 2.361,0 ms a 1.373,4 ms y el p99 de 3.407,0 ms a 1.575,4 ms. Esta fase ya cumple holgadamente los objetivos de p95 menor de 1,5 segundos y p99 menor de 3 segundos.

El mayor cambio fue la eliminación de logos y campos pesados de la respuesta resumida de subsidiarias. El cuerpo promedio pasó de 737,7 KB a 15,4 KB y, con gzip, el tráfico real quedó en aproximadamente 1,8 KB por respuesta. Los contratos existentes se conservaron: las rutas completas siguen devolviendo el mismo modelo y la interfaz solicita expresamente `view=summary`.

La rampa global todavía registró p95 de 2.711,1 ms y p99 de 3.076,1 ms porque las ráfagas simultáneas siguen generando varias consultas funcionales a Supabase. No afecta la estabilidad, pero justifica como siguiente mejora un endpoint consolidado de arranque (`/api/auth/bootstrap`) y caché breve de catálogos de lectura con aislamiento por usuario y empresa.

## Comparación antes y después

| Métrica autenticada | Antes | Después | Variación |
|---|---:|---:|---:|
| Solicitudes | 1.280 | 1.348 | +5,3% de carga |
| Éxito | 100% | 100% | Se mantiene |
| HTTP 5xx / timeouts | 0 / 0 | 0 / 0 | Se mantiene |
| p50 global | 925,0 ms | 831,3 ms | -10,1% |
| p95 global | 3.075,7 ms | 2.711,1 ms | -11,9% |
| p99 global | 3.862,0 ms | 3.076,1 ms | -20,3% |
| Latencia máxima | 5.466,0 ms | 3.255,6 ms | -40,4% |
| Tráfico autenticado estimado | 165,1 MB | 1,41 MB reales | -99,1% |

### Fase sostenida de 120 usuarios

| Métrica | Antes | Después | Variación |
|---|---:|---:|---:|
| Solicitudes en 30 s | 628 | 696 | +10,8% |
| RPS | 17,11 | 22,67 | +32,5% |
| p50 | 849,8 ms | 649,0 ms | -23,6% |
| p95 | 2.361,0 ms | 1.373,4 ms | -41,8% |
| p99 | 3.407,0 ms | 1.575,4 ms | -53,8% |
| Máxima | 3.812,5 ms | 1.671,0 ms | -56,2% |

### Segunda ejecución por nivel de concurrencia

| Fase | Solicitudes | Éxito | RPS | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|
| Base, 1 usuario | 6 | 100% | 7,34 | 663,9 ms | 816,5 ms | 816,5 ms |
| 10 usuarios | 20 | 100% | 19,88 | 698,8 ms | 993,9 ms | 1.005,7 ms |
| 30 usuarios | 60 | 100% | 48,87 | 856,4 ms | 1.205,9 ms | 1.226,3 ms |
| 60 usuarios | 120 | 100% | 43,29 | 2.203,3 ms | 2.616,8 ms | 2.732,2 ms |
| 100 usuarios | 200 | 100% | 70,81 | 1.902,8 ms | 2.622,9 ms | 2.747,9 ms |
| 120 usuarios, ráfaga | 240 | 100% | 73,51 | 2.194,7 ms | 3.080,6 ms | 3.207,2 ms |
| 120 usuarios, sostenido | 696 | 100% | 22,67 | 649,0 ms | 1.373,4 ms | 1.575,4 ms |
| Recuperación, 1 usuario | 6 | 100% | 5,34 | 908,7 ms | 1.120,4 ms | 1.120,4 ms |

La ráfaga de 120 usuarios duplicó el rendimiento frente a la línea base, de 34,57 a 73,51 RPS. Su mediana fue más alta, pero la cola mejoró: p95 bajó 20,2%, p99 35,3% y máxima 40,4%. Esto indica mayor procesamiento simultáneo y menos solicitudes rezagadas.

### Segunda ejecución por endpoint

| Endpoint | Solicitudes | p50 | p95 | p99 | Cuerpo promedio | Transferencia promedio |
|---|---:|---:|---:|---:|---:|---:|
| Preferencia de idioma | 231 | 583,0 ms | 1.860,0 ms | 2.473,4 ms | 318 B | 318 B |
| Roles | 226 | 1.017,2 ms | 2.600,9 ms | 3.021,2 ms | 121 B | 121 B |
| Empresas resumidas | 220 | 1.237,8 ms | 3.004,6 ms | 3.121,3 ms | 171 B | 171 B |
| Idiomas | 227 | 822,2 ms | 2.582,6 ms | 2.921,3 ms | 1,4 KB | 320 B |
| Permisos del rol | 224 | 608,2 ms | 1.822,5 ms | 2.398,4 ms | 28,8 KB | 3,6 KB |
| Subsidiarias resumidas | 220 | 1.217,1 ms | 2.980,7 ms | 3.188,3 ms | 15,4 KB | 1,8 KB |

## Optimizaciones aplicadas

1. Se agregó un modelo resumido optativo para subsidiarias y empresas, sin logos codificados ni campos innecesarios.
2. Se creó una consulta individual de detalle para edición y documentos que sí necesitan el logo.
3. Se incorporó caché positiva de 15 segundos para validar sesión y dispositivo, limitada a 5.000 entradas, sin almacenar tokens y respetando la expiración del JWT.
4. Las validaciones simultáneas de una misma sesión se agrupan en una sola llamada, evitando una estampida hacia Supabase.
5. Se agregó compresión gzip asíncrona para JSON desde 1 KB, sin bloquear el event loop y respetando `gzip;q=0`.
6. El cierre de sesión invalida la caché local inmediatamente; una revocación externa puede tardar como máximo 15 segundos, valor configurable o desactivable.
7. Se conservaron los contratos completos por defecto para no romper consumidores existentes.

## Verificación técnica de la optimización

- Compilación TypeScript: correcta.
- Pruebas focales de rendimiento y compatibilidad: 24/24.
- Pruebas de seguridad: 81/81.
- Pruebas de entrega estática y compresión: 6/6.
- Pruebas de internacionalización ejecutadas durante la preparación: 27/27.
- Limpieza posterior a la carga: correcta; cero sesiones, dispositivos, roles, subsidiarias o historiales técnicos activos y la identidad temporal de Supabase Auth fue eliminada.

## Conclusión de la línea base inicial

**Resultado: Aprobado con mejoras prioritarias.**

GENTIA se mantuvo disponible durante toda la prueba autenticada: procesó 1.280 solicitudes con 100% de éxito, sin timeouts y sin respuestas HTTP 5xx. La aplicación soporta la concurrencia probada desde el punto de vista de estabilidad, pero la latencia excede los objetivos definidos para una experiencia fluida.

El principal cuello de botella observado es `GET /api/organization/subsidiaries`. Su respuesta promedio fue de aproximadamente 738 KB, concentró cerca del 96% del volumen transferido durante la fase autenticada y alcanzó una latencia p95 de 3,88 segundos.

## Metodología

La validación utilizó una rampa de 10, 30, 60, 100 y 120 usuarios virtuales. Después se mantuvieron 120 usuarios durante 30 segundos y se ejecutó una medición de recuperación.

- Las operaciones funcionales fueron de solo lectura.
- No se crearon facturas, pagos, solicitudes ni asientos contables.
- Los 120 usuarios virtuales compartieron una identidad y un dispositivo técnicos temporales.
- Se probaron preferencias de idioma, roles, empresas, idiomas, permisos del rol y subsidiarias.
- Se ejecutó un inicio de sesión real antes de la carga, pero no 120 autenticaciones independientes.

Esta metodología mide la concurrencia de Railway, el servidor Node, la validación de sesión y Supabase. No representa todavía 120 perfiles distintos ejecutando procesos transaccionales pesados.

## Resultados de la capa pública

La capa pública fue validada dos veces. En ambas ejecuciones completó 640 solicitudes con 100% de éxito y sin errores del servidor.

| Métrica de la ejecución base | Resultado |
|---|---:|
| Solicitudes | 640 |
| Éxito | 100% |
| HTTP 5xx | 0 |
| Timeouts | 0 |
| p50 | 376,3 ms |
| p95 | 768,0 ms |
| p99 | 847,7 ms |
| Máxima | 1.040,7 ms |

En la repetición, el pico de 120 usuarios procesó 240 solicitudes a 160,99 solicitudes por segundo, con p95 de 659,2 ms y 100% de éxito.

## Resultados de API autenticada

| Métrica global | Resultado | Objetivo | Estado |
|---|---:|---:|---|
| Solicitudes | 1.280 | — | — |
| Éxito | 100% | >= 99% | Cumple |
| Errores | 0 | < 1% | Cumple |
| HTTP 5xx | 0 | < 0,2% | Cumple |
| Timeouts | 0 | 0 | Cumple |
| p50 | 925,0 ms | < 600 ms | No cumple |
| p95 | 3.075,7 ms | < 1.500 ms | No cumple |
| p99 | 3.862,0 ms | < 3.000 ms | No cumple |
| Máxima | 5.466,0 ms | — | Revisar |

### Comportamiento por nivel de concurrencia

| Fase | Solicitudes | Éxito | RPS | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|
| 10 usuarios | 20 | 100% | 4,64 | 985,7 ms | 2.100,9 ms | 2.814,5 ms |
| 30 usuarios | 60 | 100% | 13,26 | 920,5 ms | 2.257,8 ms | 2.626,6 ms |
| 60 usuarios | 120 | 100% | 24,88 | 921,9 ms | 2.436,2 ms | 2.677,1 ms |
| 100 usuarios | 200 | 100% | 37,76 | 1.049,0 ms | 2.896,7 ms | 3.439,9 ms |
| 120 usuarios, ráfaga | 240 | 100% | 34,57 | 1.343,3 ms | 3.862,0 ms | 4.959,6 ms |
| 120 usuarios, sostenido | 628 | 100% | 17,11 | 849,8 ms | 2.361,0 ms | 3.407,0 ms |
| Recuperación, 1 usuario | 6 | 100% | 0,71 | 944,6 ms | 2.258,5 ms | 2.258,5 ms |

La ráfaga de 120 usuarios incrementó la latencia, pero no produjo errores ni pérdida de disponibilidad. Después de diez segundos, la aplicación continuó respondiendo correctamente; la muestra de recuperación fue pequeña y debe complementarse con métricas de infraestructura.

### Resultados por endpoint

| Endpoint | Solicitudes | p50 | p95 | p99 | Promedio de respuesta |
|---|---:|---:|---:|---:|---:|
| Preferencia de idioma | 211 | 565,1 ms | 1.984,9 ms | 2.613,4 ms | 318 B |
| Roles | 213 | 931,4 ms | 2.526,3 ms | 2.993,8 ms | 121 B |
| Empresas | 214 | 1.048,1 ms | 2.825,8 ms | 3.046,1 ms | 171 B |
| Idiomas | 218 | 749,0 ms | 2.126,8 ms | 2.832,5 ms | 1,4 KB |
| Permisos del rol | 209 | 843,9 ms | 1.808,3 ms | 2.813,2 ms | 28,8 KB |
| Subsidiarias | 215 | 2.246,1 ms | 3.881,9 ms | 4.959,6 ms | 737,7 KB |

## Cuellos de botella confirmados

### 1. Respuesta excesiva del catálogo de subsidiarias

La ruta lista las subsidiarias con `select=*`, incluyendo campos que no son necesarios para un selector o listado. El campo `logo_url` puede contener imágenes codificadas y amplía sustancialmente la respuesta. Las 215 consultas de esta ruta transfirieron 158,6 MB de los 165,1 MB observados en la prueba autenticada.

**Mejora recomendada:** devolver en el listado únicamente identificador, nombre, razón social, país, moneda y estado. El logo y el resto del detalle deben consultarse en una ruta individual o almacenarse como URL de objeto, no como contenido base64 repetido.

### 2. Demasiados viajes a Supabase durante el arranque

El ingreso completo del usuario carga idioma, roles, permisos, empresas, empresa activa y otros catálogos mediante múltiples llamadas sucesivas. Además, cada API autenticada ejecuta primero `assert_request_access`.

**Mejora recomendada:** crear `/api/auth/bootstrap` respaldado por un RPC que entregue el contexto inicial en una sola operación. Aplicar una caché corta, de 10 a 30 segundos, a validaciones exitosas de sesión y dispositivo, con un TTL configurable.

### 3. Falta de telemetría de infraestructura

La prueba midió tiempos desde el cliente, pero no tuvo acceso a CPU, memoria, event-loop lag, conexiones ni tiempos internos de Supabase.

**Mejora recomendada:** incorporar métricas por ruta y por llamada upstream, además de `/health` y `/ready`. Los timeouts o fallos de Supabase deben clasificarse como 503/504 y no como errores funcionales 400.

## Plan de mejora priorizado

1. Reducir la respuesta de subsidiarias y separar la descarga de logos.
2. Incorporar compresión gzip/Brotli y ETag para JSON de lectura.
3. Crear el endpoint consolidado `/api/auth/bootstrap`.
4. Cachear brevemente la validación positiva de sesión/dispositivo.
5. Agregar paginación, búsqueda del lado servidor y proyección de columnas a catálogos grandes.
6. Añadir métricas de Railway/Supabase y trazabilidad de latencia por endpoint.
7. Permitir reintentos únicamente para RPC de lectura idempotentes.
8. Separar tareas programadas y conectores de tipos de cambio del proceso web.
9. Evaluar aumento de recursos o réplicas en Railway después de optimizar payloads y consultas.

## Criterio para la segunda prueba

Después de las mejoras se debe repetir una prueba de al menos cinco minutos con 120 usuarios y exigir:

- éxito >= 99%;
- errores < 1%;
- cero timeouts;
- p95 API < 1,5 segundos;
- p99 API < 3 segundos;
- recuperación al baseline en menos de dos minutos.

Como fase adicional, conviene utilizar un grupo de usuarios técnicos independientes y ejecutar escenarios controlados de reportes, facturas y consultas contables, sin afectar información real.

## Limpieza y seguridad

La identidad creada en Supabase Auth fue eliminada y su consulta posterior devolvió HTTP 404. No quedaron sesiones, dispositivos, roles, subsidiarias ni historial de ingreso asociados. El catálogo conserva un registro técnico inactivo, sin vínculo Auth y sin permisos, porque la bitácora de auditoría impide eliminar usuarios referenciados. Se preservaron cuatro eventos de auditoría de la prueba; el registro residual no puede iniciar sesión y no representa acceso activo.

No se expusieron credenciales ni se modificaron transacciones de negocio durante la prueba.
