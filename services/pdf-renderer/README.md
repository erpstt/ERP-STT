# Renderer PDF aislado

Servicio privado para el HTML generado por el backend GENTIA. No es una API pública para navegadores.

## Construcción

Desde la raíz del repositorio:

```sh
docker build -f services/pdf-renderer/Dockerfile -t gentia-pdf-renderer:security .
```

El contenedor final incluye solamente Node, Chromium, fuentes, saneamiento HTML, el módulo de renderizado y el servidor HTTP. No copia el ERP, sus plantillas, `.env`, documentos o credenciales. La imagen de Node está fijada por digest; las dependencias npm tienen lockfile. Actualizar Chromium mediante reconstrucciones regulares de la imagen.

## Requisitos del host

- Usuario sin privilegios: la imagen usa `node` y el arranque rechaza root.
- Runtime que permita las operaciones de namespace necesarias para el sandbox de Chromium. Un Dockerfile no puede conceder permisos que el host deniega.
- No usar `--no-sandbox`, modo privilegiado, `SYS_ADMIN` ni `seccomp=unconfined` para superar fallos.
- `/tmp` escribible para perfiles temporales; límites de CPU/memoria definidos por operación.
- Healthcheck `/health`: devuelve 200 solo después de generar un PDF sintético con el sandbox activo. Si falla, devuelve 503 y `/render` permanece bloqueado.

La prueba de arranque de Chromium es el criterio definitivo de disponibilidad; una prueba exitosa en otro sistema operativo no certifica el sandbox del host.

## Railway

Crear un servicio independiente con este repositorio y `RAILWAY_DOCKERFILE_PATH=services/pdf-renderer/Dockerfile`. Configurar healthcheck `/health`, un timeout de arranque suficiente y límites de recursos. No generar dominio público.

Único secreto del servicio: `PDF_RENDERER_TOKEN`, un valor aleatorio de 32 a 128 caracteres base64url. No compartir variables del ERP ni usar sus claves como token. El arranque rechaza variables Supabase, SMTP, BCCR o PostgreSQL.

Variables opcionales: `PORT` (8080 por defecto), `PDF_RENDER_CONCURRENCY` (1 en la imagen), `CHROME_PATH` (incluido en la imagen).

Solo después de que `/health` sea 200 desde la red privada, configurar en ERP:

```text
PDF_RENDERER_URL=http://<nombre-servicio>.railway.internal:8080
PDF_RENDERER_TOKEN=<mismo secreto independiente>
```

Los valores son marcadores, no credenciales. El cliente ERP rechaza destinos ajenos a `.railway.internal`, redirecciones, URL con credenciales y respuestas que no sean PDF. No hace fallback al navegador local ante un fallo remoto.

## API privada

- `GET /health`: estado operativo sin documentos ni secretos.
- `POST /render`: `Authorization: Bearer <token>` y JSON con un único campo `html`. Respuesta binaria PDF con `Cache-Control: no-store`.
- Autenticación independiente con comparación en tiempo constante; cuerpo máximo 6 MiB, HTML máximo 4 MB y PDF máximo 24 MiB. La cola y el timeout pertenecen al renderizador común.

No registrar cuerpos, documentos, cabeceras de autorización, errores internos de Chrome o valores del entorno. El hijo Chrome recibe un entorno mínimo y nunca hereda el token del servicio.

## Validación

```sh
npm run build
node --test scripts/pdf-worker.test.mjs
```

Para probar la generación real con Chrome disponible, establecer `PDF_SECURITY_BROWSER_TESTS=true`. Las pruebas usan documentos ficticios y un HTTP local; no requieren credenciales del ERP.

Esta preparación no acredita despliegue ni compatibilidad del host. No activar las variables del ERP antes de tener un worker saludable.
