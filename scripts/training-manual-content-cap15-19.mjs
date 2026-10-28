const step = (title, detail, verification) => ({ title, detail, verification });
const error = (message, cause, solution) => ({ message, cause, solution });
const image = (file, caption, alt = caption) => ({ file, caption, alt });

export const trainingManualsCap15To19 = [
  {
    id: 'CAP-15',
    title: 'Consolidación e intercompany',
    audience: 'Contabilidad corporativa, contadores regionales, responsables de consolidación y contraloría',
    objective: 'Preparar y ejecutar una consolidación trazable por período, moneda y subsidiaria, conciliando operaciones intercompany y documentando las eliminaciones antes de emitir cifras corporativas.',
    prerequisites: [
      'Períodos de las subsidiarias cerrados o bloqueados para cambios no autorizados.',
      'Plan de cuentas y monedas homologados para el grupo.',
      'Dimensión Compañía relacionada informada en todas las operaciones intercompany.',
      'Tasas de cierre, promedio e históricas cargadas según la política contable.',
      'Usuario con acceso a todas las subsidiarias incluidas en el perímetro.'
    ],
    routes: [
      '/consolidation.html',
      '/intercompany-loans-report.html',
      '/intercompany-commercial-report.html',
      'Informes > Contabilidad > Balanza de comprobación'
    ],
    flow: ['Definir perímetro', 'Validar cierres', 'Revisar monedas', 'Conciliar intercompany', 'Proponer eliminaciones', 'Ejecutar', 'Analizar diferencias', 'Emitir evidencia'],
    steps: [
      step('Confirmar el período corporativo', 'Abra Consolidación, seleccione año, mes, libro contable y moneda de presentación. Compruebe que la fecha de corte coincida con el calendario de cierre aprobado.', 'El encabezado muestra el período y la moneda corporativa correctos.'),
      step('Definir el perímetro de consolidación', 'Seleccione únicamente las subsidiarias que forman parte del grupo para el período. Revise porcentajes, fecha de incorporación y método de consolidación cuando aplique.', 'La lista no contiene empresas fuera del alcance ni omite filiales vigentes.'),
      step('Validar el estado de cada subsidiaria', 'Revise que cada filial tenga su balanza cuadrada, períodos cerrados y procesos de revaluación, depreciación e impuestos completados. Abra el detalle de las alertas antes de continuar.', 'Todas las subsidiarias aparecen listas o con una excepción formalmente documentada.'),
      step('Revisar las tasas de conversión', 'Confirme las tasas de cierre para activos y pasivos, promedio para resultados e históricas para patrimonio y partidas que así lo requieran. No sustituya una tasa histórica por la tasa del día.', 'Cada moneda utilizada posee la tasa y el método de conversión correspondiente.'),
      step('Ejecutar el reporte de préstamos intercompany', 'Genere el informe por cuenta del grupo Cuentas por Cobrar/Pagar Compañías Relacionadas, moneda y dimensión Compañía relacionada. Compare saldos recíprocos por pareja de empresas.', 'Cada saldo por cobrar tiene una contraparte por pagar identificable en la misma moneda.'),
      step('Ejecutar el reporte comercial intercompany', 'Consulte las cuentas 113002 y 211002 separadas por cliente, proveedor, moneda y compañía relacionada. Investigue documentos abiertos, notas de crédito y pagos en tránsito.', 'Las diferencias quedan explicadas por documento y responsable, no solo por cuenta.'),
      step('Corregir o clasificar diferencias', 'Corrija en la subsidiaria de origen los errores de tercero, moneda o dimensión. Para diferencias temporales, registre responsable, causa, importe y fecha prevista de resolución.', 'No quedan diferencias sin dueño ni explicación antes de las eliminaciones.'),
      step('Preparar las eliminaciones', 'Genere o revise los asientos de eliminación de saldos, transacciones, ingresos, gastos, préstamos, intereses y dividendos intercompany. Mantenga referencias a ambas transacciones de origen.', 'Cada eliminación está balanceada y conserva trazabilidad hacia las dos filiales.'),
      step('Ejecutar la consolidación', 'Inicie el proceso únicamente cuando los controles previos estén conformes. No cierre el navegador durante la ejecución; si aparece un tiempo de espera, verifique el estado antes de volver a lanzar.', 'La corrida finaliza una sola vez, con identificador, usuario, fecha y estado Exitoso.'),
      step('Analizar la conversión y el patrimonio', 'Revise el ajuste acumulado por conversión, resultados del período, participaciones y movimientos patrimoniales. Compare contra el mes anterior y explique variaciones materiales.', 'El movimiento del patrimonio se reconcilia con resultados, aportes y diferencias de conversión.'),
      step('Conciliar los estados consolidados', 'Compare balance, resultados, flujo de efectivo y balanza consolidada. Abra el detalle de cualquier diferencia hasta llegar al asiento y subsidiaria que la originan.', 'Activo = Pasivo + Patrimonio y el resultado coincide entre los informes al centavo.'),
      step('Exportar y archivar la evidencia', 'Descargue Excel o PDF de los reportes, matriz de diferencias, asientos de eliminación y resumen de la corrida. Guarde el paquete en el repositorio autorizado con versión y aprobador.', 'El expediente permite reproducir el resultado sin depender de explicaciones verbales.')
    ],
    controls: [
      'Mismo período, libro y moneda de presentación en todas las validaciones.',
      'Compañía relacionada obligatoria en cuentas intercompany.',
      'Tasas de conversión aplicadas según la naturaleza de cada cuenta.',
      'Diferencias intercompany resueltas o documentadas antes de eliminar.',
      'Asientos de eliminación balanceados y reversables cuando corresponda.',
      'Una sola corrida final aprobada por período y versión.',
      'Paquete de evidencia con trazabilidad por subsidiaria y documento.'
    ],
    commonErrors: [
      error('El reporte intercompany no cuadra', 'Una filial usó otra moneda, tercero o compañía relacionada, o registró el documento en un período distinto.', 'Compare por pareja de empresas, moneda y documento; corrija el origen o documente la diferencia temporal.'),
      error('La consolidación duplica cifras', 'Se repitió una corrida o se incluyó una subsidiaria más de una vez.', 'Revise el identificador y perímetro; anule la versión duplicada y ejecute una sola corrida controlada.'),
      error('Diferencia de conversión inesperada', 'Falta una tasa o se aplicó tasa de cierre a una partida histórica.', 'Revise la política por cuenta, restaure la tasa histórica y vuelva a calcular desde la fuente.'),
      error('El proceso excede el tiempo de espera', 'Volumen alto o consulta sin optimizar; la tarea puede haber continuado en servidor.', 'Consulte primero el estado de la corrida. No la repita hasta confirmar que no fue creada.'),
      error('No se puede abrir el detalle de una filial', 'El rol no tiene acceso a esa subsidiaria.', 'Solicite la asignación de empresa y permiso de consulta; no exporte datos desde una cuenta ajena.')
    ],
    exercise: {
      title: 'Cierre consolidado de prueba',
      scenario: 'Consolidar tres subsidiarias, dos monedas y una diferencia temporal en una factura intercompany.',
      tasks: ['Definir período y perímetro', 'Validar tasas', 'Conciliar préstamos y cuentas comerciales', 'Documentar la diferencia temporal', 'Revisar eliminaciones', 'Ejecutar la corrida', 'Conciliar estados', 'Exportar evidencia'],
      expected: 'La consolidación queda balanceada, la diferencia temporal está identificada y las eliminaciones tienen trazabilidad completa.'
    },
    checklist: ['Perímetro aprobado', 'Filiales cerradas', 'Balanzas cuadradas', 'Tasas completas', 'Intercompany conciliado', 'Diferencias documentadas', 'Eliminaciones balanceadas', 'Conversión revisada', 'Estados conciliados', 'Evidencia archivada'],
    images: [
      image('CAP-15-01-consolidation.png', 'Parámetros y perímetro de consolidación'),
      image('CAP-15-02-intercompany-loans.png', 'Conciliación de préstamos intercompany'),
      image('CAP-15-03-eliminations.png', 'Asientos y diferencias de eliminación'),
      image('CAP-15-04-consolidated-results.png', 'Resumen de resultados consolidados')
    ]
  },
  {
    id: 'CAP-16',
    title: 'Reportes y análisis',
    audience: 'Contabilidad, finanzas, gerencia, analistas y usuarios responsables de control',
    objective: 'Generar reportes consistentes, comprender sus filtros, navegar al detalle y exportar evidencia profesional sin confundir moneda, período, libro o alcance de subsidiarias.',
    prerequisites: [
      'Período y libro contable definidos para el análisis.',
      'Permisos de consulta sobre las subsidiarias y reportes requeridos.',
      'Catálogos y dimensiones contables actualizados.',
      'Conocimiento de la moneda funcional y de presentación.'
    ],
    routes: ['/informes/contabilidad', '/income-forecast.html', '/payment-request-report.html', '/audit-change-report.html'],
    flow: ['Objetivo', 'Reporte', 'Filtros', 'Generación', 'Conciliación', 'Drill-down', 'Exportación', 'Distribución'],
    steps: [
      step('Definir la pregunta del análisis', 'Antes de abrir un informe, indique qué decisión debe soportar, período, empresa, libro, moneda, dimensión y nivel de detalle. Evite generar cifras sin un propósito verificable.', 'Existe una definición breve del alcance y del resultado esperado.'),
      step('Seleccionar el reporte correcto', 'Ingrese al centro de Informes de Contabilidad y elija el reporte según la pregunta: mayor, diario, balance, resultados, cartera, bancos, fiscal, intercompany u otro especializado.', 'El título y descripción del reporte corresponden al análisis solicitado.'),
      step('Configurar subsidiaria y libro', 'Seleccione la empresa activa y el libro Fiscal local u otro autorizado. En reportes consolidados, revise explícitamente el grupo de empresas.', 'El reporte no mezcla libros ni subsidiarias fuera del alcance.'),
      step('Definir período y fecha de corte', 'Use un período contable o rango personalizado coherente. En auxiliares y antigüedad, la fecha de corte determina los documentos y pagos incluidos.', 'Desde, Hasta y Fecha de corte coinciden con la solicitud.'),
      step('Elegir la presentación de moneda', 'Seleccione moneda local, original o consolidada según el objetivo. Lea la nota de conversión y no compare importes de monedas distintas sin una base común.', 'La moneda y el símbolo mostrados coinciden con el criterio elegido.'),
      step('Aplicar filtros analíticos', 'Seleccione tipo de departamento, departamento, centro de costos, ubicación, clase, tercero o estado. Mantenga Todos solo cuando el análisis realmente requiera el universo completo.', 'Los filtros visibles reflejan exactamente el alcance definido.'),
      step('Generar y leer los indicadores', 'Pulse Generar reporte y espere la confirmación. Revise primero tarjetas de totales, cantidad de registros, estado de conciliación y alertas antes de examinar filas individuales.', 'Los indicadores cargan sin error y explican el universo consultado.'),
      step('Validar la conciliación', 'Compare el total del reporte con el Mayor General o cuenta de control que indique la pantalla. Una diferencia debe investigarse por filtros, moneda y documentos; no se oculta.', 'La conciliación coincide al centavo o tiene una explicación documentada.'),
      step('Usar el detalle operativo', 'Abra valores subrayados, filas expandibles o acciones de detalle para llegar a transacciones, asientos y líneas. Confirme que la suma del detalle reproduce el total.', 'El drill-down conserva los filtros y permite rastrear cada saldo.'),
      step('Comparar tendencias y variaciones', 'Contraste contra mes anterior, presupuesto o proyección cuando aplique. Clasifique variaciones por monto, porcentaje, departamento y naturaleza contable.', 'Las variaciones materiales tienen causa, responsable y acción.'),
      step('Exportar al formato apropiado', 'Use Excel para análisis y conciliación, CSV para integración y PDF para distribución formal. Compruebe que el archivo conserve filtros, moneda, fecha y totales.', 'El archivo abre correctamente y reproduce las cifras de pantalla.'),
      step('Distribuir y conservar la versión', 'Nombre el archivo con reporte, empresa, período y fecha de emisión. Comparta solo por canales autorizados y archive la versión aprobada junto con sus soportes.', 'El destinatario identifica el alcance y existe una única versión oficial.')
    ],
    controls: [
      'Definir alcance antes de generar el reporte.',
      'Confirmar empresa, libro, período y moneda en pantalla y exportación.',
      'Conciliar reportes contables contra el Mayor General.',
      'Investigar diferencias mediante drill-down, no mediante ajustes sin soporte.',
      'Distinguir fecha de transacción, período contable y fecha de corte.',
      'Proteger datos sensibles en las exportaciones.',
      'Conservar una versión aprobada e identificable.'
    ],
    commonErrors: [
      error('El total cambia al agrupar por departamento', 'La vista Total usa filtros o asignaciones diferentes, o incluye líneas sin dimensión.', 'Compare los filtros y la columna Sin asignar; verifique que Total sea la suma exacta de los grupos.'),
      error('El auxiliar no coincide con el Mayor', 'Se usó otra moneda, fecha de corte, libro o estado de documento.', 'Alinee parámetros y abra la conciliación por cuenta/documento antes de corregir datos.'),
      error('La exportación aparece vacía', 'El reporte no fue generado o el rol no tiene acceso a los datos.', 'Genere primero la consulta, confirme registros y revise permisos de exportación.'),
      error('La consulta excede el tiempo de espera', 'Rango amplio o filtros no selectivos.', 'Reduzca período o subsidiarias y ejecute por segmentos; escale si un mes específico también falla.'),
      error('Los importes parecen multiplicados', 'Se mezclaron moneda local, original o conversión consolidada.', 'Revise el selector de presentación y la nota de tasa antes de comparar.')
    ],
    exercise: {
      title: 'Paquete mensual de análisis',
      scenario: 'Preparar resultados, balance, cartera y bancos para una subsidiaria y explicar dos variaciones materiales.',
      tasks: ['Definir alcance', 'Generar cada reporte', 'Revisar moneda y filtros', 'Conciliar con el Mayor', 'Abrir el detalle', 'Documentar variaciones', 'Exportar Excel y PDF', 'Archivar la versión'],
      expected: 'Los reportes concilian, las variaciones tienen explicación y el paquete conserva parámetros y fecha de emisión.'
    },
    checklist: ['Objetivo definido', 'Reporte correcto', 'Empresa y libro', 'Período/corte', 'Moneda', 'Filtros', 'Totales revisados', 'Conciliación', 'Drill-down', 'Exportación validada', 'Versión archivada'],
    images: [
      image('CAP-16-01-report-center.png', 'Centro de informes y selección de reporte'),
      image('CAP-16-02-report-filters.png', 'Filtros contables y analíticos'),
      image('CAP-16-03-drilldown.png', 'Detalle y conciliación de cifras'),
      image('CAP-16-04-export.png', 'Opciones de exportación profesional')
    ]
  },
  {
    id: 'CAP-17',
    title: 'Auditoría y control de calidad',
    audience: 'Auditoría interna, control de calidad, administradores, contraloría y responsables de proceso',
    objective: 'Consultar quién creó, modificó o eliminó registros, comprender valores anteriores y nuevos, medir indicadores de calidad y conservar evidencia íntegra sin ampliar indebidamente el acceso.',
    prerequisites: [
      'Rol con permiso de auditoría para los módulos dentro de su alcance.',
      'Mes y subsidiarias objeto de revisión definidos.',
      'Política de retención y tratamiento de datos sensibles conocida.',
      'Acceso al reporte y a la auditoría de registros individuales.'
    ],
    routes: ['/audit-change-report.html', 'Acción Auditoría en los catálogos', 'Seguridad > Actividad y sesiones', 'Auditoría > Registros del sistema'],
    flow: ['Alcance', 'Filtros', 'Indicadores', 'Agrupación', 'Detalle', 'Evidencia', 'Hallazgo', 'Seguimiento'],
    steps: [
      step('Definir el alcance de revisión', 'Determine mes, subsidiaria, usuario, tipo de transacción y acciones a revisar. El objetivo debe distinguir control rutinario, investigación o indicador de calidad.', 'El alcance está escrito y evita consultar información innecesaria.'),
      step('Abrir el reporte de cambios', 'Ingrese a Registros modificados y eliminados. Confirme que la pantalla indique el alcance autorizado del usuario conectado.', 'El encabezado corresponde al reporte de Auditoría y control de calidad.'),
      step('Seleccionar el mes', 'Elija el mes de actividad, no el período contable del documento. Un cambio realizado en octubre sobre una factura de septiembre se reporta en octubre.', 'El filtro muestra el mes en que ocurrió la acción.'),
      step('Filtrar por responsable', 'Seleccione un usuario específico o Todos los usuarios. Use correo y nombre para evitar confundir personas con nombres similares.', 'La selección identifica inequívocamente al responsable.'),
      step('Elegir acción y módulo', 'Seleccione Modificados, Eliminados o ambos, y limite el módulo cuando el análisis sea específico. Para calidad operativa, priorice transacciones como facturas, asientos y pagos.', 'Los filtros excluyen catálogos técnicos ajenos al objetivo.'),
      step('Generar y leer los indicadores', 'Pulse Generar reporte y revise cantidad de cambios, registros afectados, usuarios, eliminaciones y módulos. Compare contra períodos anteriores solo con el mismo alcance.', 'Los indicadores cargan sin tiempo de espera y corresponden a los filtros.'),
      step('Revisar la agrupación por transacción', 'Expanda Facturas de venta, Facturas de proveedor, Asientos de diario u otra categoría. Analice primero los grupos con eliminaciones o volumen inusual.', 'El usuario entiende qué documento fue afectado antes de leer campos técnicos.'),
      step('Examinar el detalle del cambio', 'Abra el registro y revise fecha/hora, usuario, acción, campo, valor anterior y valor nuevo. Diferencie correcciones legítimas de cambios sin soporte.', 'Cada cambio material puede explicarse con una secuencia cronológica.'),
      step('Contrastar con la auditoría del registro', 'Desde la transacción use Auditoría y compare su historial con el reporte mensual. Revise también creador, último modificador y origen de la operación.', 'El detalle mensual y la bitácora individual son consistentes.'),
      step('Proteger datos sensibles', 'No copie contraseñas, tokens, credenciales ni datos personales innecesarios. Respete los campos ocultos por política y el alcance de subsidiarias.', 'La evidencia conserva trazabilidad sin revelar secretos ni exceder permisos.'),
      step('Documentar el hallazgo', 'Registre condición, criterio, causa, impacto, evidencia, responsable y fecha de respuesta. Adjunte el identificador de auditoría, no solo una captura recortada.', 'El hallazgo puede reproducirse y asignarse a un responsable.'),
      step('Exportar y dar seguimiento', 'Descargue Excel para análisis o PDF para el expediente. Verifique que la corrección posterior también quede registrada y cierre el indicador con evidencia.', 'El expediente contiene consulta, respuesta, corrección y validación final.')
    ],
    controls: [
      'Acceso de auditoría limitado por rol y subsidiaria.',
      'Diferenciar fecha del cambio de fecha contable del documento.',
      'Presentar lenguaje de negocio y agrupación por transacción.',
      'Conservar valor anterior, valor nuevo, usuario y marca de tiempo.',
      'No permitir edición de la bitácora desde la interfaz.',
      'Enmascarar credenciales y datos sensibles.',
      'Cerrar hallazgos únicamente con evidencia de corrección.'
    ],
    commonErrors: [
      error('El reporte excede el tiempo de espera', 'Consulta demasiado amplia o falta de filtros selectivos.', 'Seleccione un mes, módulo o usuario; ejecute por segmentos y preserve el mismo criterio al consolidar.'),
      error('No aparece un cambio conocido', 'Se filtró por período contable en lugar de mes de actividad o por otra subsidiaria.', 'Busque por fecha real del cambio, usuario y contexto activo.'),
      error('No fue posible consultar la autoría', 'El rol carece de permiso o la política no reconoce al administrador dentro del alcance.', 'Revise el permiso de auditoría y la política de acceso sin desactivar la protección general.'),
      error('El detalle es difícil de interpretar', 'Se muestran nombres técnicos sin contexto del documento.', 'Use la agrupación por transacción y consulte número, tercero y campo legible.'),
      error('Una eliminación no tiene motivo', 'La transacción se eliminó sin justificación registrada.', 'Abra un hallazgo, identifique al responsable y exija soporte según la política de calidad.')
    ],
    exercise: {
      title: 'Revisión mensual de cambios',
      scenario: 'Analizar las modificaciones y eliminaciones de un mes para facturas y asientos de diario.',
      tasks: ['Definir alcance', 'Filtrar mes y módulos', 'Generar indicadores', 'Expandir transacciones', 'Revisar valores anteriores/nuevos', 'Contrastar auditoría individual', 'Documentar dos casos', 'Exportar evidencia'],
      expected: 'Cada caso identifica responsable, cambio, motivo, impacto y seguimiento sin exponer datos sensibles.'
    },
    checklist: ['Alcance autorizado', 'Mes de actividad', 'Usuario', 'Acción', 'Módulo', 'Indicadores revisados', 'Detalle comprensible', 'Bitácora contrastada', 'Datos protegidos', 'Hallazgo documentado', 'Seguimiento cerrado'],
    images: [
      image('CAP-17-01-audit-filters.png', 'Parámetros del reporte de cambios'),
      image('CAP-17-02-audit-groups.png', 'Cambios agrupados por tipo de transacción'),
      image('CAP-17-03-audit-detail.png', 'Valores anteriores, nuevos y responsable'),
      image('CAP-17-04-record-authorship.png', 'Autoría e historial del registro')
    ]
  },
  {
    id: 'CAP-18',
    title: 'Documentos, adjuntos y plantillas PDF',
    audience: 'Usuarios operativos, administradores funcionales, responsables de marca y control documental',
    objective: 'Adjuntar soportes, administrar documentos y configurar plantillas PDF controladas, garantizando legibilidad, seguridad, versión aprobada y asociación correcta con cada transacción.',
    prerequisites: [
      'Permiso para consultar o administrar documentos según el rol.',
      'Archivos en formato y tamaño permitidos, libres de malware.',
      'Logotipo, datos legales y textos corporativos aprobados.',
      'Ambiente de prueba para validar plantillas antes de publicarlas.'
    ],
    routes: ['Documentos > Catálogos', '/pdf-templates.html', '/pdf-template-builder.html', 'Pestaña Archivos de respaldo en transacciones'],
    flow: ['Preparar', 'Cargar', 'Clasificar', 'Vincular', 'Validar', 'Diseñar', 'Probar', 'Publicar', 'Conservar'],
    steps: [
      step('Preparar el archivo', 'Nombre el soporte con tipo, referencia y fecha. Verifique que sea legible, no contenga macros no autorizadas ni credenciales y cumpla el límite de tamaño.', 'El archivo abre localmente y su nombre permite identificarlo.'),
      step('Abrir la transacción correcta', 'Ingrese a la factura, cobro, solicitud, activo u otra transacción y confirme número, subsidiaria y tercero antes de adjuntar.', 'El encabezado corresponde al documento que respalda el archivo.'),
      step('Usar Archivos de respaldo', 'Abra la pestaña y seleccione Cargar archivo. Para documentos externos autorizados, registre un enlace HTTPS y una descripción clara.', 'El archivo o enlace aparece asociado a la transacción.'),
      step('Clasificar y describir', 'Indique categoría, título, fecha y comentario cuando estén disponibles. Evite descripciones genéricas como soporte o documento.', 'Un revisor puede comprender el contenido sin descargarlo.'),
      step('Comprobar acceso y persistencia', 'Guarde la transacción, vuelva a abrirla y descargue el adjunto. En documentos pagados o bloqueados, confirme que aún sea posible agregar respaldo sin recalcular importes.', 'El adjunto persiste y abre con permisos correctos.'),
      step('Consultar el catálogo documental', 'Use búsqueda y filtros para localizar documentos por referencia, módulo, tercero o fecha. Revise autoría y versión antes de utilizar un archivo como evidencia.', 'El documento recuperado coincide con la transacción y versión esperadas.'),
      step('Seleccionar una plantilla PDF', 'Abra Plantillas PDF, elija el tipo documental y duplique una versión aprobada para editar. No modifique directamente una plantilla productiva sin control de cambios.', 'La nueva versión conserva el original y queda en estado borrador.'),
      step('Configurar encabezado y pie', 'Ingrese logotipo, razón social, identificación fiscal, dirección, datos de contacto, numeración de página y textos legales. Utilice variables permitidas.', 'La vista previa muestra identidad y datos legales correctos.'),
      step('Diseñar secciones y columnas', 'Configure datos del tercero, fechas, moneda, líneas, impuestos, retenciones, totales y notas. En facturas unificadas, respete la descripción y agrupación configuradas en el documento.', 'Las columnas caben en la página y los totales no se cortan.'),
      step('Generar una vista previa', 'Pruebe documentos con una línea, múltiples líneas, impuestos distintos, montos grandes, caracteres especiales y varias páginas.', 'La plantilla es legible en todos los escenarios de prueba.'),
      step('Aprobar y publicar la versión', 'Registre responsable, fecha, motivo y aprobación. Active la plantilla para la subsidiaria y tipo documental correctos, conservando la versión anterior para trazabilidad.', 'Solo una versión aprobada queda activa para el alcance definido.'),
      step('Descargar y verificar el PDF final', 'Desde una transacción de prueba descargue directamente el PDF y revise nombre del archivo, contenido, paginación y metadatos. Evite depender del diálogo Imprimir del navegador.', 'El PDF descargado coincide con la vista previa y abre fuera de GENTIA.'),
      step('Administrar retención y eliminación', 'Aplique la política documental. La eliminación debe requerir permiso, motivo y auditoría; si existe obligación legal, inhabilite en lugar de borrar.', 'La evidencia se conserva durante el plazo y toda eliminación es trazable.')
    ],
    controls: [
      'Adjuntos vinculados a la transacción y subsidiaria correctas.',
      'Formatos, tamaño y contenido permitidos.',
      'Enlaces externos HTTPS con acceso controlado.',
      'Plantillas con borrador, prueba, aprobación y publicación.',
      'Una versión activa por tipo documental y alcance.',
      'Pruebas con impuestos, varias páginas y caracteres especiales.',
      'Eliminación restringida, justificada y auditada.'
    ],
    commonErrors: [
      error('No se puede cargar el archivo', 'Excede el tamaño, el formato no está permitido o la sesión perdió permiso.', 'Comprima o convierta el archivo, confirme límites y vuelva a autenticar si corresponde.'),
      error('El enlace no abre para el aprobador', 'El repositorio externo exige permisos que el destinatario no posee.', 'Conceda acceso mínimo autorizado o cargue el archivo directamente en GENTIA.'),
      error('El adjunto desaparece al guardar', 'La carga no terminó o el vínculo no se persistió.', 'Espere la confirmación, guarde y verifique reabriendo la transacción; registre evidencia si falla.'),
      error('El PDF corta columnas o totales', 'Ancho, fuente o saltos de página no fueron probados con datos reales.', 'Ajuste el diseñador y pruebe casos extremos antes de publicar.'),
      error('Se modificó una plantilla productiva', 'No se usó control de versiones.', 'Restaure la versión aprobada, cree un borrador nuevo y documente el cambio.')
    ],
    exercise: {
      title: 'Expediente y PDF controlado',
      scenario: 'Adjuntar dos soportes a una transacción y publicar una nueva versión de su plantilla PDF.',
      tasks: ['Preparar archivos', 'Confirmar transacción', 'Cargar y describir', 'Verificar persistencia', 'Duplicar plantilla', 'Editar secciones', 'Probar casos extremos', 'Aprobar y publicar', 'Descargar PDF final'],
      expected: 'Los soportes quedan accesibles y el PDF aprobado se descarga correctamente con versión y trazabilidad.'
    },
    checklist: ['Archivo legible', 'Nombre claro', 'Transacción correcta', 'Descripción', 'Persistencia', 'Acceso controlado', 'Plantilla en borrador', 'Datos legales', 'Pruebas completas', 'Aprobación', 'Versión activa', 'PDF descargado'],
    images: [
      image('CAP-18-01-attachments.png', 'Carga de archivos de respaldo'),
      image('CAP-18-02-document-catalog.png', 'Consulta y autoría de documentos'),
      image('CAP-18-03-pdf-builder.png', 'Diseñador de plantillas PDF'),
      image('CAP-18-04-pdf-preview.png', 'Vista previa y descarga del PDF')
    ]
  },
  {
    id: 'CAP-19',
    title: 'Soporte, incidencias y continuidad operativa',
    audience: 'Todos los usuarios, mesa de ayuda, administradores funcionales y responsables técnicos',
    objective: 'Diagnosticar incidencias de forma segura, distinguir configuración de falla técnica, recopilar evidencia útil y restablecer el servicio sin duplicar transacciones ni exponer datos sensibles.',
    prerequisites: [
      'Canal oficial de soporte y niveles de severidad definidos.',
      'Correo, usuario, empresa, rol y módulo afectados identificados.',
      'Conocimiento de los responsables funcionales por proceso.',
      'Acceso a la actividad, auditoría y estado del sistema según el rol.'
    ],
    routes: ['/', 'Seguridad > Sesiones y actividad', '/audit-change-report.html', 'Acciones Auditoría y Reintentar', 'Centro interno de soporte'],
    flow: ['Proteger', 'Clasificar', 'Reproducir', 'Verificar contexto', 'Capturar evidencia', 'Contener', 'Escalar', 'Validar', 'Cerrar'],
    steps: [
      step('Proteger la información', 'Nunca envíe contraseñas, claves de servicio, tokens, cadenas de conexión ni datos bancarios completos. Oculte datos personales que no sean necesarios para investigar.', 'La evidencia no contiene secretos ni información fuera del caso.'),
      step('Clasificar la severidad', 'Determine si el caso bloquea toda la aplicación, un proceso crítico, un usuario o una función no crítica. Registre impacto, cantidad de usuarios y plazo operativo.', 'La prioridad se basa en impacto y urgencia, no solo en quién reporta.'),
      step('Registrar el contexto', 'Anote URL, ambiente, fecha y hora con zona horaria, usuario, subsidiaria activa, rol, módulo, documento y acción ejecutada.', 'Otra persona puede recrear el mismo contexto sin pedir datos básicos.'),
      step('Reproducir de forma controlada', 'Repita una vez la operación con los mismos filtros y anote el mensaje exacto. No pulse Guardar o Importar repetidamente cuando el estado sea incierto.', 'Se confirma si el caso es consistente, intermitente o ya se resolvió.'),
      step('Revisar empresa, rol y permisos', 'Confirme Empresa activa, Rol activo y permiso de Ver/Crear/Editar/Eliminar. Un mensaje de acceso denegado no se corrige desactivando políticas de seguridad.', 'El usuario tiene únicamente el permiso necesario para su tarea.'),
      step('Validar datos y configuración', 'Revise campos obligatorios, período abierto, catálogos activos, cuentas, dimensiones, tasa de cambio, secuencia y aprobadores. Compare con una operación exitosa del mismo tipo.', 'Se identifica si la causa es dato, configuración o tecnología.'),
      step('Capturar evidencia útil', 'Tome una captura completa con encabezado, filtros y mensaje; copie el texto del error; registre identificadores y pasos. No recorte información que explique el contexto.', 'El ticket contiene pasos, esperado, obtenido y evidencia legible.'),
      step('Atender fallas de conexión', 'Si localhost o producción rechaza la conexión, verifique la URL y el estado del servicio. No cambie firewall, DNS ni variables productivas sin autorización.', 'Se determina si el problema es local, de red o del servidor.'),
      step('Atender tiempos de espera', 'Ante canceling statement due to statement timeout, reduzca filtros y confirme si la operación pudo completarse. En importaciones o contabilizaciones, busque el lote antes de reintentar.', 'No se crea un segundo lote ni una transacción duplicada.'),
      step('Atender errores de correo o autenticación', 'Verifique que la administración de usuarios, URL de producción y proveedor de correo estén configurados. Use recuperación de contraseña; nunca solicite la contraseña actual.', 'El usuario recibe un enlace seguro y de un solo uso o una explicación accionable.'),
      step('Aplicar contención segura', 'Si existe riesgo de duplicación o impacto contable, suspenda esa operación, informe a los responsables y permita otros procesos no afectados. No elimine datos para ocultar el síntoma.', 'El impacto queda limitado sin perder evidencia.'),
      step('Escalar con información completa', 'Asigne el caso a soporte funcional, técnico, base de datos o proveedor externo según la causa. Incluya severidad, contexto, evidencia, consultas realizadas y resultado.', 'El receptor puede iniciar el diagnóstico sin devolver el ticket por información faltante.'),
      step('Validar la corrección', 'Repita el escenario en ambiente autorizado, revise impacto contable y auditoría y confirme con el usuario. Para fallas críticas, ejecute pruebas de regresión relacionadas.', 'La función opera y no se introdujo una diferencia contable o de seguridad.'),
      step('Cerrar y prevenir', 'Documente causa raíz, solución, versión, evidencia y acción preventiva. Actualice el conocimiento o la capacitación cuando el caso pueda repetirse.', 'El ticket tiene aceptación del usuario y una medida preventiva verificable.')
    ],
    controls: [
      'Nunca compartir secretos ni credenciales en tickets o capturas.',
      'Severidad definida por impacto y urgencia.',
      'Contexto completo: ambiente, hora, empresa, rol, módulo y documento.',
      'No repetir operaciones de resultado incierto sin verificar el estado.',
      'No desactivar controles de seguridad para resolver permisos.',
      'Correcciones contables y técnicas probadas antes de producción.',
      'Causa raíz y prevención documentadas al cerrar.'
    ],
    commonErrors: [
      error('ERR_CONNECTION_REFUSED', 'El servidor no está iniciado, la URL es incorrecta o existe un bloqueo de red.', 'Confirme URL y estado del servicio; escale con hora, ambiente y resultado de la verificación.'),
      error('No fue posible conectar con Supabase', 'Red, credenciales de aplicación, límites o servicio no disponible.', 'Verifique estado y configuración del servidor sin exponer claves; no pegue service-role en el ticket.'),
      error('canceling statement due to statement timeout', 'Consulta o transacción supera el límite configurado.', 'Reduzca alcance, confirme si terminó y escale el identificador para optimización o proceso asíncrono.'),
      error('El rol activo no tiene permiso', 'Falta asignación o se eligió otro rol/empresa.', 'Revise la matriz de acceso y asigne solo el permiso requerido.'),
      error('Recurso no encontrado', 'Ruta, endpoint o registro no existe en el contexto seleccionado.', 'Confirme URL, identificador, empresa y despliegue; adjunte la solicitud fallida sin sus tokens.'),
      error('No existe un flujo de aprobación activo', 'No hay regla o aprobador compatible con el documento.', 'Revise tipo de tercero, departamento, centro de costos y aprobadores por defecto antes de escalar.')
    ],
    exercise: {
      title: 'Simulación de incidente crítico',
      scenario: 'Una importación muestra tiempo de espera y no se sabe si el lote fue contabilizado.',
      tasks: ['Clasificar severidad', 'Registrar contexto', 'No reintentar', 'Buscar lote y auditoría', 'Capturar evidencia', 'Contener', 'Escalar al responsable', 'Validar la corrección', 'Cerrar con causa raíz'],
      expected: 'Se confirma el estado sin duplicar asientos y el ticket queda completo, seguro y reutilizable como conocimiento.'
    },
    checklist: ['Sin secretos', 'Severidad', 'Fecha/hora/zona', 'Ambiente', 'Empresa y rol', 'Módulo/documento', 'Pasos reproducibles', 'Mensaje exacto', 'Evidencia completa', 'Estado verificado', 'Responsable', 'Validación', 'Causa raíz', 'Prevención'],
    images: [
      image('CAP-19-01-login-support.png', 'Acceso y recuperación segura'),
      image('CAP-19-02-error-evidence.png', 'Evidencia completa de una incidencia'),
      image('CAP-19-03-session-activity.png', 'Revisión de sesiones y actividad'),
      image('CAP-19-04-audit-validation.png', 'Validación mediante auditoría')
    ]
  }
];

export default trainingManualsCap15To19;
