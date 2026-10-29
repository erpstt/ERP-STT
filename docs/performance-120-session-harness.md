# Prueba certificable de 120 sesiones

El arnés `scripts/production-120-session-load.mjs` valida el inicio de sesión consolidado y la navegación de lectura con **120 sesiones y dispositivos independientes**. Utiliza una sola identidad técnica inactiva para no crear 120 registros permanentes en el catálogo de usuarios.

## Medidas de seguridad

- Solo acepta una identidad inactiva, sin acceso, sin sesiones, sin vínculo Auth y con correo `@example.invalid`.
- Exige `--confirm-production-load` y un destino HTTPS.
- Nunca escribe facturas, pagos, asientos ni solicitudes.
- Después del bootstrap no vuelve a consultar por separado los endpoints legacy de idiomas, roles, empresas o acceso del rol, porque esa información ya forma parte del bootstrap de la interfaz.
- Las credenciales se leen del entorno y no aparecen en el resultado.
- En `finally` elimina la identidad temporal de Supabase Auth, sesiones, dispositivos y asignaciones, y restaura el registro técnico.
- Si la restauración no coincide con el estado inicial, la ejecución termina con error.

## Preparación

Use una ventana controlada. Deben estar disponibles en `.env` o en el entorno:

```text
GENTIA_LOAD_BASE_URL=https://erp-stt-production.up.railway.app
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_PASSWORD=...
```

Opcionalmente, `LOAD_TEST_EMAIL` selecciona el registro técnico. Si se omite, se usa el último registro inactivo `gentia-load-*@example.invalid` que no tenga identidad Auth.

## Ejecución recomendada

```powershell
node scripts/production-120-session-load.mjs --confirm-production-load --sessions=120 --duration-seconds=300 --login-rate=1 --login-interval-ms=2100 --think-time-ms=4500 --output=.local-tools/performance/load-120.json
```

Para la certificación extendida, cambie `--duration-seconds=1800`. El resultado incluye p50, p95, p99, errores, timeouts, detalle por fase y ruta, además de las métricas internas de Node/Supabase.

Los criterios automáticos son: éxito >= 99%, error < 1%, cero timeouts, p95 < 1,5 s y p99 < 3 s durante la fase sostenida.

Las validaciones positivas de sesión y dispositivo se distribuyen de forma
determinista entre 80 % y 100 % de 27 segundos; la matriz de permisos se
conserva como máximo 30 segundos y se renueva con la validación. Cerrar sesión
o cambiar rol, empresa o permisos invalida el contexto inmediatamente.

El proceso limita por defecto a 16 las solicitudes simultáneas hacia Supabase;
las adicionales esperan en una cola cancelable. Este límite conserva margen
suficiente para la carga media y evita trasladar ráfagas completas a PostgREST.

Los catálogos operativos incluidos en el perfil usan una caché aislada por
usuario y sesión con base de 90 segundos y dispersión determinista de hasta
15 %. Las mutaciones invalidan todo el catálogo afectado; cambiar empresa, rol
o ejecutar nuevamente el bootstrap invalida solamente el contexto de esa
sesión. No se sirven entradas vencidas en segundo plano.

El aprovisionamiento se limita por defecto a una sesión cada 2,1 segundos y
reintenta con espera progresiva si Supabase activa su protección del endpoint
de tokens. La carga sostenida comienza solo después de crear las 120 sesiones.

## Perfil funcional posterior al bootstrap

La fase de navegación usa una mezcla ponderada de 15 posiciones y solamente
solicitudes `GET`. La distribución representa recorridos habituales de la UI:

| Área | Vistas consultadas | Peso aproximado |
| --- | --- | ---: |
| Ventas | Facturas de venta | 20,0 % |
| Compras | Facturas de proveedores | 20,0 % |
| Entidades | Clientes | 13,3 % |
| Organización | Departamentos y centros de costos | 13,3 % |
| Bancos | Cuentas y extractos bancarios | 13,3 % |
| Activos fijos | Activos y categorías | 13,3 % |
| Reportes | Opciones de reportes contables (consulta pesada) | 6,7 % |

Las posiciones repetidas están intercaladas para evitar que una sesión abra
la misma vista varias veces seguidas. Los 120 usuarios virtuales se desplazan
por la mezcla desde offsets distintos, conservando la proporción global.
