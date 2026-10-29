# Internacionalización global de GENTIA

## Arquitectura

GENTIA utiliza un proveedor global liviano en public/i18n.js. El proveedor mantiene el idioma activo, carga los diccionarios, traduce contenido creado dinámicamente y sincroniza el cambio entre el shell principal, pestañas e iframe del espacio de trabajo.

La prioridad al iniciar sesión es:

1. Preferencia del usuario almacenada en users.language_id.
2. Idioma guardado en localStorage bajo gentia_language mientras se resuelve la sesión.
3. Español (es) como valor predeterminado.

Los idiomas seleccionables proceden de Core > Idiomas. Solo se publican opciones activas que correspondan a SPA, ENG o POR.

## Diccionarios

Los mensajes se organizan por dominio y deben conservar exactamente las mismas claves:

- public/locales/es.json
- public/locales/en.json
- public/locales/pt.json

Las vistas transaccionales extensas se reparten en fragmentos bajo
`public/locales/modules/<dominio>/{es,en,pt}.json`. El proveedor los combina con
el diccionario base al iniciar, lo que permite ampliar un módulo sin convertir
los archivos principales en un bloque inmanejable.

Ejemplo:

    {
      "core": {
        "header": {
          "activeCompany": "EMPRESA ACTIVA",
          "activeRole": "ROL ACTIVO",
          "language": "IDIOMA"
        }
      },
      "auth": {
        "submit": "Ingresar a GENTIA"
      }
    }

Para agregar un mensaje nuevo, se debe crear la misma clave en los tres archivos y ejecutar las pruebas de paridad.

## API del motor

El runtime expone window.GentiaI18n:

    await window.GentiaI18n.init();
    await window.GentiaI18n.setLocale('en');

    const title = window.GentiaI18n.t('configuration.exchangeRates.title');
    const count = window.GentiaI18n.t('common.records', { count: 25 });

El cambio actualiza document.documentElement.lang, persiste la selección y emite gentia:language-changed.

## Uso en Vue

El shell registra un método t() que conserva un texto de respaldo:

    <small>{{ t('core.header.activeCompany', {}, 'EMPRESA ACTIVA') }}</small>
    <button>{{ t('actions.saveChanges', {}, 'Guardar cambios') }}</button>

El selector global invoca chooseLanguage(). Esta función aplica el idioma inmediatamente y luego guarda la preferencia mediante:

    PATCH /api/auth/language-preference
    Content-Type: application/json

    { "locale": "pt" }

## Uso en vistas HTML independientes

El servidor inyecta automáticamente i18n.js en todas las vistas HTML secundarias. Para textos nuevos se recomienda declarar la clave explícitamente:

    <h1 data-i18n="accounting.generalLedger">Libro Mayor</h1>
    <input
      placeholder="Buscar en el catálogo"
      data-i18n-placeholder="actions.searchCatalog"
    >

El runtime también reconoce textos existentes incluidos en los diccionarios y observa contenido agregado posteriormente mediante MutationObserver. La detección automática se limita a controles inequívocos de interfaz (botones, etiquetas, encabezados, acciones y estados). No traduce opciones, valores de tablas, campos editables, notas, código ni elementos marcados con `data-i18n-ignore`; los textos fuera de esos controles deben usar una clave `data-i18n` explícita. Esta regla evita alterar nombres de clientes, departamentos, cuentas u otros datos de negocio.

## Persistencia y seguridad

La migración 20261029160000_user_language_preference.sql agrega la relación con languages y expone RPC con security definer. El usuario solo puede modificar su propia preferencia; no se conceden permisos generales de actualización sobre users.

Endpoints:

- GET /api/auth/language-preference: devuelve preferencia y opciones activas.
- PATCH /api/auth/language-preference: valida y guarda es, en o pt.

Si el idioma guardado deja de estar activo, o si un recurso secundario no puede cargarse, la interfaz utiliza Español o la primera opción compatible disponible sin impedir el ingreso al ERP.

## Plan de refactorización continua

1. Todo texto nuevo debe crearse primero en los tres diccionarios.
2. El shell y los componentes críticos deben usar t('clave') directamente.
3. Las vistas heredadas pueden migrarse progresivamente a atributos data-i18n.
4. Los mensajes de API deben evolucionar a códigos traducibles; los valores contables y textos ingresados por usuarios nunca deben traducirse.
5. Antes de publicar, ejecutar las pruebas de runtime, paridad, selector, persistencia y entrega estática.
