# Composition Brief — GENTIA

## Objetivo

Crear un video promocional breve que demuestre, no solo enumere, cómo GENTIA conecta una operación financiera multiempresa: selección de empresa, solicitud y aprobación de pago, conciliación bancaria y reporte ejecutivo.

## Formato y ritmo

- 1920 × 1080, 16:9.
- 22,93 segundos.
- Movimiento sobrio, entradas de 150–300 ms, pausas suficientes para leer la interfaz.
- Tres revelaciones principales alineadas a pulsos fuertes de la música.
- Sin capturas de producción ni información real; la UI se recrea con datos ficticios.

## Identidad visual

- Fondo general: `#F4F6FA`.
- Azul principal: `#042E72`.
- Azul profundo: `#03255C`.
- Azul suave: `#E8EEF8`.
- Naranja: `#F26938`.
- Naranja suave: `#FFF0EA`.
- Texto: `#17233B`.
- Texto secundario: `#6B7280`.
- Bordes: `#DDE3EE`.
- Éxito semántico: `#087451` sobre `#E9F7F0`.
- Títulos: Manrope 600–800.
- Interfaz y cuerpo: DM Sans 400–700.
- Tarjetas blancas con radios de 12–18 px, borde fino y sombra discreta.

## Tratamiento de interfaz

- Barra lateral azul de GENTIA con navegación de módulos.
- Encabezado blanco con empresa y rol activos.
- Tablas con cabeceras gris claro y cifras alineadas.
- Botones principales azules; naranja reservado para acentos y progresión.
- Estados como píldoras: `BORRADOR`, `APROBADO`, `APLICADO` y `CONCILIACIÓN CUADRADA`.
- El punto naranja funciona como hilo visual entre escenas.

## Movimiento

- Entrada de texto con desenfoque suave y elevación, inspirada en `soft-blur-in`.
- Acercamientos controlados a regiones de la UI, inspirados en `ui-focus-zoom`.
- Progresión determinista de estados, inspirada en `state-chip-rail`.
- Transiciones por barrido luminoso azul/naranja, sin rebotes excesivos.
- Comentarios `// beat-locked` en revelaciones mayores y `// beat-grid` en secuencias de estados.
- El halo del punto naranja reaccionará sutilmente a la energía musical; si la extracción de amplitud local no está disponible, se usará una respiración determinista alineada al pulso.

## Audio

- Voz: Kokoro `ef_dora`, idioma `es`, velocidad 1,08.
- Música: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`.
- SFX: clic de interfaz, impacto suave de conciliación y confirmación breve de marca.
- Música al 12–15 % bajo voz, con pequeños aumentos en intro y outro.
- Todos los audios se incorporarán por rutas relativas y con roles de timeline explícitos.

## Privacidad y veracidad

- Empresas: `NOVA SERVICIOS S.A.` y `AURORA LATAM S.A.`.
- Terceros: `Cliente Atlas` y `Proveedor Horizonte`.
- Documentos: `SOL-PAG-000057` y `FAC-000104`.
- Cuenta bancaria: `Banco Horizonte · •••• 4821`.
- Los importes son demostrativos y no representan datos de producción.
- No se afirmarán funciones de IA predictiva que no tengan un flujo visible y verificable en la aplicación.

