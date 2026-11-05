# Renovación de la sesión de GENTIA

## Causa y comportamiento

El registro seguro del ERP limita cada autorización técnica a 15 minutos. El login anterior conservaba el JWT, pero descartaba la credencial de renovación de Supabase. Al vencer la autorización técnica, el usuario perdía acceso aunque el JWT siguiera vigente.

El login entrega las fechas de vencimiento del JWT y del ERP. El navegador renueva un minuto antes del menor vencimiento y vuelve a comprobarlo al recuperar el foco o enviar una solicitud. Una pestaña suspendida puede renovar su autorización técnica cuando regresa, siempre que Supabase, el usuario y el dispositivo sigan autorizados.

Las pantallas abiertas usan el token vigente sin recargar el formulario. La renovación conserva la sesión, el rol y la subsidiaria. Las operaciones de guardar, aprobar, ejecutar pagos y eliminar se envían una sola vez; un error posterior no provoca su repetición automática. Las fallas temporales de red, límites de solicitudes o indisponibilidad del proveedor conservan la sesión local y permiten reintentar la renovación.

## Protección del acceso

- La credencial de renovación queda en una cookie firmada, HttpOnly, Secure y SameSite=Strict, asociada al usuario, la sesión de Supabase y el dispositivo. No se devuelve en JSON ni se almacena en JavaScript.
- Login, renovación y logout verifican el origen canónico configurado de GENTIA. El acceso HTTP local requiere NODE_ENV=test y una habilitación explícita para las pruebas aisladas.
- Los tres RPC nuevos sólo son ejecutables por service_role. El servidor verifica la cookie firmada y la respuesta fresca del proveedor antes de completar la renovación o el cierre por esa vía.
- La base de datos conserva los identificadores existentes y cambia únicamente el hash del JWT y su vencimiento técnico. La comparación atómica del vínculo evita que una respuesta atrasada reemplace una renovación concurrente.
- El JWT anterior deja de autorizar solicitudes al rotar el hash. Las revocaciones de sesión, dispositivo, usuario y acceso a empresas/roles siguen siendo efectivas. La renovación comprueba que la sesión de Supabase exista y respeta su not_after, además del vencimiento del JWT y del límite técnico de 15 minutos.
- Cada cookie identifica su propia sesión. Un logout o una respuesta de una sesión anterior no borra la cookie de otro login. La coordinación del navegador descarta resultados de generaciones anteriores.

«Recordarme» conserva la cookie hasta un máximo absoluto de 30 días desde el login, sujeto a los límites del proveedor. Sin esa opción se usa una cookie de sesión del navegador. Renovar no desplaza ese límite absoluto.

## Puesta en funcionamiento

Se aplica primero la migración aditiva `renew_trusted_erp_session_lease` y después se publica la aplicación. La migración incorpora tres funciones sin modificar los datos o las funciones existentes. Las sesiones creadas antes de esta versión necesitan iniciar sesión una vez para obtener su cookie de renovación; su JWT anterior no contiene esa credencial.

La URL canónica procede de GENTIA_APP_URL, APP_BASE_URL, NEXO_APP_URL o RAILWAY_PUBLIC_DOMAIN, en ese orden. Debe coincidir con el origen desde el que se utiliza el ERP.

## Verificación

Las pruebas SQL ejecutan los controles reales de sesión en una base aislada. La integración conecta los servicios compilados con esos RPC y simula exclusivamente al proveedor de identidad. Comprueba renovación después del vencimiento técnico, respuesta perdida, cambio de hash, conservación del contexto y cierre definitivo.

Las pruebas de navegador cubren pestañas e iframes, un campo sin guardar, tokens capturados por módulos ya abiertos y ausencia de repetición de operaciones. Las pruebas HTTP comprueban la emisión y privacidad de cookies, origen, límites y errores. La batería existente de acceso y permisos se ejecuta junto con las nuevas pruebas en CI.

No se utilizan credenciales reales ni se generan documentos, pagos o correos reales durante estas pruebas.

Referencias: [sesiones de Supabase](https://supabase.com/docs/guides/auth/sessions) y [renovación de sesión](https://supabase.com/docs/reference/javascript/auth-refreshsession).
