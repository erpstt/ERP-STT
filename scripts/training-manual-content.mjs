import { trainingManualsCap15To19 } from './training-manual-content-cap15-19.mjs';

const step = (title, detail, verification) => ({ title, detail, verification });
const error = (message, cause, solution) => ({ message, cause, solution });
const image = (file, caption, alt = caption) => ({ file, caption, alt });

export const trainingManuals = [
  {
    id: 'CAP-01',
    title: 'Acceso y navegación en GENTIA',
    audience: 'Todos los usuarios',
    objective: 'Ingresar de forma segura, seleccionar la empresa y el rol correctos, recorrer el espacio de trabajo y reconocer las acciones disponibles en los catálogos.',
    prerequisites: [
      'Usuario activo con correo corporativo verificado.',
      'Al menos una subsidiaria y un rol asignados.',
      'Navegador actualizado y acceso a la URL HTTPS de GENTIA.',
      'Conocer qué empresa y rol deben utilizarse para la operación que se realizará.'
    ],
    routes: ['/', '¿Olvidaste tu contraseña?', 'Selector de empresa', 'Selector de rol', 'Menú lateral'],
    flow: ['Autenticación', 'Selección de empresa', 'Selección de rol', 'Navegación', 'Operación', 'Cierre seguro'],
    steps: [
      step('Abrir el portal', 'Ingrese a la URL oficial HTTPS de GENTIA y confirme que el dominio y el candado del navegador sean correctos. No utilice enlaces recibidos desde remitentes desconocidos.', 'La pantalla muestra el logotipo GENTIA y el formulario de acceso.'),
      step('Iniciar sesión', 'Escriba el correo corporativo y su contraseña personal. Active Recordarme únicamente en un equipo administrado y de uso exclusivo.', 'El sistema valida la identidad sin mostrar ni almacenar la contraseña en pantalla.'),
      step('Recuperar el acceso', 'Si olvidó la contraseña, seleccione ¿Olvidaste tu contraseña?, ingrese el correo y utilice el enlace de un solo uso recibido. Defina una contraseña nueva y no reutilizada.', 'Se presenta una confirmación neutra y el enlace abre el formulario seguro de cambio.'),
      step('Seleccionar la empresa', 'En la lista de empresas autorizadas elija la subsidiaria sobre la cual trabajará. Revise nombre legal y moneda funcional antes de continuar.', 'El encabezado muestra Empresa activa con la subsidiaria seleccionada.'),
      step('Seleccionar el rol', 'Elija el rol correspondiente a la tarea. Un usuario puede tener funciones diferentes por rol; no utilice un rol administrativo para operaciones ordinarias.', 'El encabezado muestra Rol activo y el menú se ajusta a sus permisos.'),
      step('Abrir un módulo', 'Use el menú lateral para expandir el módulo y seleccione la opción deseada. Las pantallas especializadas se abren en el espacio de trabajo sin perder el contexto activo.', 'El título y la ruta de navegación corresponden al módulo seleccionado.'),
      step('Trabajar con un catálogo', 'Utilice la búsqueda, los encabezados ordenables y las acciones Ver, Editar o Auditoría. Crear y Eliminar solo aparecen cuando el rol tiene permiso.', 'La cantidad de registros y los resultados cambian conforme a los filtros.'),
      step('Cambiar de contexto', 'Antes de registrar información de otra filial o función, cambie explícitamente la empresa o el rol y vuelva a confirmar los indicadores del encabezado.', 'Empresa activa y Rol activo coinciden con el nuevo contexto.'),
      step('Cerrar la sesión', 'Finalice el trabajo mediante Cerrar sesión. No cierre únicamente la pestaña cuando utilice un equipo compartido.', 'El sistema regresa al formulario de acceso y la sesión deja de estar disponible.')
    ],
    controls: [
      'Nunca compartir contraseña, enlaces de recuperación ni códigos de acceso.',
      'Confirmar Empresa activa y Rol activo antes de guardar una transacción.',
      'Distinguir un mensaje de permiso insuficiente de un error técnico.',
      'Cerrar sesión al terminar y no almacenar credenciales en equipos compartidos.'
    ],
    commonErrors: [
      error('Credenciales inválidas', 'Correo incorrecto, contraseña vencida o cuenta inactiva.', 'Verifique el correo; si no recuerda la clave utilice la recuperación. Si persiste, contacte al administrador sin enviar su contraseña.'),
      error('El rol activo no tiene permiso', 'La acción no está autorizada para el rol seleccionado.', 'Cambie al rol correcto o solicite una revisión formal de permisos; no intente evadir el control.'),
      error('No aparece una empresa', 'La filial no está asignada al usuario o está inactiva.', 'Solicite al administrador revisar Empresas por usuario y el estado de la subsidiaria.'),
      error('La pantalla conserva información anterior', 'Se cambió de empresa sin recargar el proceso abierto.', 'Cierre la pantalla especializada, confirme la empresa activa y vuelva a abrirla.')
    ],
    exercise: {
      title: 'Recorrido seguro por el espacio de trabajo',
      scenario: 'El usuario debe consultar un catálogo de la empresa de capacitación con su rol operativo.',
      tasks: ['Ingresar al portal', 'Seleccionar empresa y rol', 'Abrir un módulo', 'Buscar un registro', 'Abrir Auditoría sin modificar información', 'Cerrar sesión'],
      expected: 'El usuario completa el recorrido y puede explicar qué empresa y rol estaban activos.'
    },
    checklist: ['Ingresé desde HTTPS', 'Confirmé empresa activa', 'Confirmé rol activo', 'Identifiqué las acciones permitidas', 'No compartí credenciales', 'Cerré la sesión'],
    images: [image('CAP-01-01-login.png', 'Pantalla segura de ingreso a GENTIA'), image('CAP-01-02-workspace.png', 'Espacio de trabajo con empresa y rol activos'), image('CAP-01-03-catalog.png', 'Catálogo con búsqueda y acciones')]
  },
  {
    id: 'CAP-07',
    title: 'Compras y Cuentas por Pagar',
    audience: 'Compras, Cuentas por Pagar, Contabilidad y Tesorería',
    objective: 'Ejecutar el ciclo desde el requerimiento hasta el pago, registrando facturas, retenciones, anticipos y notas con la cuenta de control correcta.',
    prerequisites: [
      'Proveedores activos, autorizados para la subsidiaria y la moneda de operación.',
      'Términos de pago, impuestos, retenciones y períodos contables configurados.',
      'Plan de cuentas, dimensiones y límites de aprobación disponibles.'
    ],
    routes: ['/purchase-documents.html?type=REQUISITION', '/purchase-documents.html?type=QUOTE', '/purchase-documents.html?type=ORDER', '/purchase-documents.html?type=RECEIPT', '/supplier-invoice-entry.html', '/supplier-note-entry.html', '/supplier-payments.html', '/informes/contabilidad?reporte=payables-aging'],
    flow: ['Requisición', 'Cotización', 'Orden', 'Recepción', 'Factura', 'Retención', 'Pago o anticipo', 'Conciliación CxP'],
    steps: [
      step('Crear la requisición', 'Registre necesidad, solicitante, subsidiaria, moneda, fecha requerida, artículos o servicios, cantidades, estimación y dimensiones. Adjunte la justificación.', 'La requisición tiene líneas, soporte y estado listo para aprobación.'),
      step('Comparar cotizaciones', 'Vincule ofertas y evalúe precio, impuesto, plazo, moneda, garantía y condiciones. Documente la selección si no elige la oferta más económica.', 'La decisión conserva evidencia y referencia a la requisición.'),
      step('Emitir la orden de compra', 'Convierta la oferta aprobada, confirme proveedor, términos, impuestos, cantidades y presupuesto, y envíe el documento autorizado.', 'La orden tiene consecutivo y no supera lo aprobado.'),
      step('Registrar la recepción', 'Registre solo bienes o servicios recibidos e informe diferencias de cantidad, calidad o fecha antes de aceptar el total.', 'La recepción queda vinculada a la orden y muestra el saldo pendiente.'),
      step('Crear la factura de proveedor', 'Seleccione proveedor, tipo, número externo, fecha, período, moneda y tasa. Cargue líneas desde la orden o registre cuenta, impuesto y dimensiones.', 'El número externo no está duplicado y el importe coincide con el documento.'),
      step('Seleccionar la cuenta de control', 'Use Factura estándar para CxP normal o intercompany, Factura Expense para gastos reembolsables y Factura Caja Chica para reposiciones.', 'El impacto usa 211001, 211002, 211003 o 211004 según corresponda.'),
      step('Revisar retenciones y soportes', 'Confirme retenciones por subsidiaria, base, tarifa y monto. Adjunte factura, recepción y aprobación; permita agregar respaldos aun con pagos aplicados.', 'Retenciones y soportes quedan visibles en sus pestañas.'),
      step('Validar y contabilizar', 'Revise gasto o activo, impuesto acreditable, retenciones, CxP, moneda y dimensiones en Impacto contable.', 'Débitos y créditos cuadran y el auxiliar refleja la factura.'),
      step('Registrar pago o anticipo', 'Seleccione banco, moneda, fecha y facturas. Aplique hasta el saldo disponible o registre un anticipo identificable.', 'El pago no excede el pendiente y actualiza banco y CxP.'),
      step('Procesar notas', 'Registre nota de crédito o débito referida a la factura y distribuya base e impuesto por línea; no edite una factura contabilizada para simularla.', 'Saldo e impuestos se ajustan con trazabilidad.'),
      step('Conciliar el auxiliar', 'Genere antigüedad de CxP a la fecha de corte y compare saldos, anticipos y moneda con las cuentas de control del Mayor.', 'El auxiliar coincide al centavo con el Mayor General.')
    ],
    controls: ['Número externo único por proveedor y subsidiaria.', 'Coincidencia requisición–orden–recepción–factura.', '211001 normal, 211002 intercompany, 211003 Expense y 211004 Caja Chica.', 'Impuestos y retenciones por línea.', 'Pago no superior al saldo.', 'CxP conciliada con el Mayor en la misma moneda y fecha.'],
    commonErrors: [
      error('La edición abre una factura nueva', 'La ruta no recuperó el identificador.', 'Regrese al listado, use Editar y confirme título y número antes de guardar.'),
      error('Factura duplicada', 'El número externo ya existe para el proveedor.', 'Busque el documento previo y corrija solo con evidencia.'),
      error('Las retenciones no se recalculan', 'La factura tiene pagos aplicados.', 'Mantenga el histórico y use un ajuste autorizado; agregue soportes sin recalcular.'),
      error('Diferencia CxP vs. Mayor', 'Cuenta, fecha, moneda o apertura inconsistente.', 'Compare el detalle por factura y corrija el origen, no el total del reporte.')
    ],
    exercise: { title: 'Compra con retención y pago parcial', scenario: 'Registrar una compra de servicios en moneda extranjera con retención, soporte y pago parcial.', tasks: ['Crear requisición', 'Emitir orden', 'Registrar recepción', 'Crear factura', 'Verificar cuenta', 'Adjuntar soporte', 'Contabilizar', 'Aplicar pago parcial', 'Consultar antigüedad'], expected: 'La factura conserva saldo pendiente, el pago no excede lo aplicado y CxP concilia.' },
    checklist: ['Proveedor y subsidiaria correctos', 'Número externo único', 'Tipo correcto', 'Tasa revisada', 'Orden y recepción conciliadas', 'Retenciones revisadas', 'Soportes completos', 'Asiento balanceado', 'Pago dentro del saldo', 'CxP conciliada'],
    images: [image('CAP-07-01-purchase-order.png', 'Orden de compra y trazabilidad'), image('CAP-07-02-supplier-invoice.png', 'Factura de proveedor y tipo'), image('CAP-07-03-withholdings.png', 'Retenciones y respaldos'), image('CAP-07-04-ap-report.png', 'Antigüedad y conciliación CxP')]
  },
  {
    id: 'CAP-02',
    title: 'Administración de usuarios, roles y filiales',
    audience: 'Administradores de seguridad',
    objective: 'Configurar el acceso de un usuario aplicando permisos mínimos, segregación de funciones, asignación de filiales y recuperación segura de credenciales.',
    prerequisites: ['Rol con permisos de administración de Seguridad.', 'Matriz de segregación de funciones aprobada.', 'Subsidiarias activas y roles corporativos definidos.', 'SMTP y URL pública configurados para notificaciones.'],
    routes: ['Seguridad > Usuarios', 'Seguridad > Roles', 'Seguridad > Permisos por rol', 'Seguridad > Roles por usuario', 'Seguridad > Empresas por usuario', '/role-access-matrix.html'],
    flow: ['Diseñar rol', 'Asignar permisos', 'Crear usuario', 'Asignar rol y filiales', 'Notificar', 'Probar', 'Auditar'],
    steps: [
      step('Revisar la solicitud de acceso', 'Confirme nombre, correo, puesto, rol requerido, filiales y aprobación del responsable. Verifique posibles conflictos de segregación.', 'La solicitud identifica aprobador, vigencia y alcance.'),
      step('Crear o revisar el rol', 'Abra Roles y confirme que la descripción refleje la función real. Reutilice un rol aprobado antes de crear uno nuevo.', 'No existen roles duplicados con permisos equivalentes.'),
      step('Configurar la matriz de permisos', 'En Permisos por rol seleccione el rol y marque Ver, Crear, Editar o Eliminar para cada opción de módulo según corresponda.', 'Toda opción tiene una decisión explícita y Eliminar está restringido.'),
      step('Crear el usuario', 'Abra Usuarios, registre correo, nombre, apellidos, zona horaria y estado activo. Marque Notificar usuario por correo si el entorno de correo está operativo.', 'El usuario se crea sin que el administrador conozca ni envíe una contraseña.'),
      step('Asignar el rol', 'En Roles por usuario relacione el usuario con el rol aprobado. Evite combinaciones incompatibles, por ejemplo preparar y aprobar la misma operación.', 'La asignación coincide con la solicitud aprobada.'),
      step('Asignar filiales', 'En Empresas por usuario seleccione el usuario y marque mediante checks todas y solo las subsidiarias autorizadas; guarde la selección completa.', 'El contador de filiales coincide con la solicitud.'),
      step('Probar acceso permitido', 'Inicie una prueba controlada con el usuario o solicite confirmación: debe ver las empresas, módulos y acciones autorizadas.', 'Los casos positivos funcionan con el rol esperado.'),
      step('Probar acceso denegado', 'Intente un caso negativo documentado, como otra filial o una acción Eliminar no concedida.', 'GENTIA bloquea la acción y no expone datos ajenos.'),
      step('Reenviar recuperación si se solicita', 'Edite el usuario, marque Notificar usuario por correo y guarde. El enlace es de un solo uso; si falla, revise la advertencia sin duplicar el usuario.', 'El correo se registra como enviado o queda una advertencia auditable.'),
      step('Revisar auditoría', 'Abra Auditoría sobre el usuario y compruebe creador, última modificación y cambios de asignación.', 'Cada cambio identifica actor, fecha y origen.')
    ],
    controls: ['Aplicar mínimo privilegio.', 'Mantener un único aprobador responsable por alta.', 'No comunicar contraseñas en texto claro.', 'Revisar filiales y roles al cambiar de puesto o finalizar relación.', 'Registrar y aprobar excepciones de segregación.'],
    commonErrors: [
      error('La notificación no se envía', 'Falta configuración administrativa de Supabase, SMTP o URL pública.', 'El usuario queda guardado; corrija la variable indicada en el servidor y reintente desde Editar sin recrear la cuenta.'),
      error('El usuario ve el módulo pero no la acción', 'El rol tiene permiso de consulta, pero no Crear/Editar/Eliminar.', 'Ajuste la matriz solo si existe aprobación del dueño del proceso.'),
      error('El usuario no ve una filial', 'Empresas por usuario no incluye la subsidiaria.', 'Abra la asignación múltiple, marque la filial correcta y guarde el conjunto completo.'),
      error('Acceso excesivo', 'Se asignó rol administrativo o filiales adicionales.', 'Retire inmediatamente el acceso, documente el incidente y revise auditoría.')
    ],
    exercise: {title:'Alta controlada de usuario',scenario:'Crear un usuario de capacitación para Contabilidad Regional con acceso a dos filiales.',tasks:['Revisar solicitud','Crear o seleccionar rol','Configurar permisos','Crear usuario sin contraseña','Asignar dos filiales','Probar permiso permitido y denegado','Revisar auditoría'],expected:'El usuario accede únicamente a las dos filiales y acciones aprobadas.'},
    checklist: ['Solicitud aprobada', 'Rol correcto', 'Permisos mínimos', 'Filiales exactas', 'Notificación segura', 'Prueba positiva', 'Prueba negativa', 'Auditoría revisada'],
    images: [image('CAP-02-01-users.png','Catálogo y edición de usuarios'), image('CAP-02-02-role-matrix.png','Matriz de permisos por rol'), image('CAP-02-03-subsidiaries.png','Asignación múltiple de filiales')]
  },
  {
    id: 'CAP-03',
    title: 'Configuración de CORE y Organización',
    audience: 'Administradores funcionales',
    objective: 'Construir la base corporativa, fiscal y analítica sobre la cual operan todos los módulos de GENTIA.',
    prerequisites: ['Estructura legal y organigrama aprobados.', 'Catálogo corporativo de monedas y países.', 'Calendarios fiscales y políticas de dimensiones.', 'Listado de aprobadores y compañías relacionadas.'],
    routes: ['CORE', 'Organización', '/up-approvers.html', '/notification-templates.html'],
    flow: ['CORE global', 'Estructura legal', 'Calendario fiscal', 'Dimensiones', 'Aprobadores', 'Prueba transversal'],
    steps: [
      step('Cargar catálogos CORE', 'Revise Países, Idiomas, Zonas horarias y Monedas. Use códigos ISO y precisión cambiaria aprobada.', 'Los valores son únicos, activos y utilizables.'),
      step('Configurar estados y tipos de transacción', 'Valide código, abreviación, módulo y descripción de los documentos que generará el ERP.', 'Cada tipo tiene un propósito y módulo inequívocos.'),
      step('Definir secuencias', 'Configure secuencias por subsidiaria y transacción: prefijo, sufijo, número actual y longitud. Reserve rangos migrados si aplica.', 'Una prueba genera el consecutivo siguiente sin duplicados.'),
      step('Crear calendarios y períodos', 'Registre año fiscal, calendario y períodos mensuales. Asigne fechas y estados de cierre por subsidiaria.', 'No existen solapamientos ni meses omitidos.'),
      step('Crear subsidiarias', 'Registre razón social, país, moneda funcional, monedas secundarias, zona horaria, calendario, identificación y datos de contacto.', 'La empresa aparece en los selectores con moneda correcta.'),
      step('Crear ubicaciones y sucursales', 'Configure únicamente las estructuras vigentes. Mantenga las sucursales futuras inactivas o vacías según la política aprobada.', 'Cada ubicación pertenece a la filial correcta.'),
      step('Configurar departamentos', 'Defina tipo Cliente o Interno, nombre en mayúsculas, departamento padre y subsidiarias autorizadas.', 'Los departamentos regionales y compartidos aparecen en las filiales definidas.'),
      step('Configurar clases y centros de costos', 'Relacione centro de costo con tipo, cliente, departamento, clase y filial. Compruebe el filtrado Departamento → Centro de costo.', 'Solo se muestran centros compatibles con el departamento seleccionado.'),
      step('Registrar acreedores y relacionadas', 'Cargue acreedores financieros y compañías relacionadas con códigos uniformes para reporting y consolidación.', 'Las dimensiones se seleccionan sin ambigüedad.'),
      step('Asignar aprobadores', 'Configure UP por centro de costo, UP por defecto, Aprobador Administrativo y Supervisor tributario por subsidiaria.', 'Cada escenario de prueba devuelve al aprobador esperado.'),
      step('Ejecutar prueba transversal', 'Cree una transacción de prueba y confirme secuencia, período, moneda, dimensiones y aprobador.', 'La configuración se integra sin errores entre módulos.')
    ],
    controls: ['Códigos únicos y nombres normalizados.', 'Departamentos en mayúsculas.', 'No cambiar moneda funcional con operaciones registradas.', 'Toda dimensión debe tener alcance de subsidiaria.', 'Secuencias no deben retroceder.'],
    commonErrors: [
      error('Valor ambiguo o no pertenece a la subsidiaria', 'Nombre duplicado, registro inactivo o alcance incorrecto.', 'Use código o ID inequívoco y corrija la asignación de filiales.'),
      error('No se guarda la subsidiaria del departamento', 'La selección múltiple no fue enviada o se reemplazó.', 'Edite, marque el conjunto completo de filiales y verifique después de guardar.'),
      error('Consecutivo inesperado', 'Número actual o secuencia por transacción/filial incorrectos.', 'Revise la secuencia antes de emitir nuevos documentos; no renumere transacciones contabilizadas.'),
      error('Centro de costo no aparece', 'El departamento o filial no coinciden.', 'Revise la relación del centro con departamento, tipo y subsidiaria.')
    ],
    exercise: {title:'Configurar una filial de capacitación',scenario:'Preparar una filial con moneda, período, departamento Administrativo y centro de costo.',tasks:['Validar CORE','Crear calendario y período','Crear filial','Crear departamento','Crear centro de costo','Definir secuencia','Asignar aprobador','Probar una selección encadenada'],expected:'La filial puede iniciar una transacción con período, dimensiones y consecutivo correctos.'},
    checklist: ['CORE depurado', 'Calendario completo', 'Filial correcta', 'Dimensiones asignadas', 'Secuencias probadas', 'Aprobadores configurados', 'Prueba transversal aprobada'],
    images: [image('CAP-03-01-core.png','Catálogos maestros de CORE'), image('CAP-03-02-organization.png','Departamentos y centros de costos'), image('CAP-03-03-subsidiary.png','Configuración de subsidiaria')]
  },
  {
    id: 'CAP-04',
    title: 'Contabilidad, asientos y cierre de período',
    audience: 'Contadores',
    objective: 'Registrar, importar, revisar y cerrar movimientos contables garantizando partida doble, dimensiones, monedas y conciliación de reportes.',
    prerequisites: ['Plan de cuentas y libros aprobados.', 'Período abierto.', 'Dimensiones y tipos de cambio configurados.', 'Cuentas de control y reglas contables validadas.'],
    routes: ['Contabilidad', '/journal-entry.html', '/journal-import.html', '/fx-revaluation.html', '/informes/contabilidad', '/apps/budget/dashboard'],
    flow: ['Configuración contable', 'Registro', 'Validación', 'Contabilización', 'Conciliación', 'Cierre'],
    steps: [
      step('Revisar libros y períodos', 'Confirme el libro local/fiscal, fechas y estado AP, AR y GL del período.', 'El período permite el tipo de movimiento requerido.'),
      step('Revisar el plan de cuentas', 'Compruebe naturaleza, moneda, filiales, dimensiones obligatorias, revaluación y actividad de flujo.', 'La cuenta admite la combinación de filial y dimensión.'),
      step('Crear un asiento', 'Seleccione fecha, tipo, moneda, referencia y nota. Agregue líneas de débito/crédito con dimensiones y tercero cuando corresponda.', 'Débitos y créditos coinciden al centavo.'),
      step('Revisar monedas', 'Para moneda extranjera registre importe original y tipo de cambio indicado. En importaciones use la tasa contenida en la plantilla según la política.', 'Equivalencia local y original son coherentes.'),
      step('Adjuntar evidencia', 'Cargue archivos o enlaces HTTPS en Archivos de respaldo antes de contabilizar.', 'La evidencia se puede consultar desde el asiento.'),
      step('Importar asientos', 'Descargue la plantilla CSV, agrupe líneas por referencia, complete un solo débito o crédito por línea y valide el lote.', 'La validación identifica registro y campo; ningún asiento se guarda si el lote tiene errores.'),
      step('Validar asientos especiales', 'Para ASI_NOM, ASI_LIQ y ASI_DIA confirme que el mes de servicio se asigne desde la fecha; país de servicio solo aplica a ASI_PEN.', 'Las reglas especiales se aplican sin intervención manual.'),
      step('Ejecutar revaluación', 'Revise cuentas marcadas, saldos en moneda original y tasas de cierre. Previsualice antes de generar diferencias.', 'No se revalúan cuentas ni monedas fuera de alcance.'),
      step('Conciliar reportes', 'Compare Libro Diario, Libro Mayor, Balance de Comprobación y estados financieros con los auxiliares.', 'No existen descuadres ni diferencias no explicadas.'),
      step('Cerrar el período', 'Complete checklist, cierre submódulos AP y AR, luego GL. Documente aprobación y verifique que una fecha cerrada rechace nuevos movimientos.', 'El período queda cerrado y el control de bloqueo funciona.')
    ],
    controls: ['Partida doble al centavo.', 'No contabilizar en período cerrado.', 'Departamento obligatorio para gastos; centro de costo para ingresos/costos según política.', 'Ingresos financieros aplican excepción definida.', 'Toda reapertura requiere aprobación y auditoría.'],
    commonErrors: [
      error('Asiento descuadrado', 'Débito y crédito difieren o una línea tiene ambos importes.', 'Revise el resumen y corrija la línea exacta antes de importar o contabilizar.'),
      error('Dimensión obligatoria', 'La cuenta exige departamento o centro de costo.', 'Complete la dimensión conforme a la política de la cuenta; no use valores genéricos para evadir el control.'),
      error('Timeout al importar', 'Lote grande o proceso ya ejecutándose.', 'No repita inmediatamente. Consulte si el lote fue creado, reduzca volumen y reintente solo lo pendiente.'),
      error('Reporte total no coincide por columna', 'Agrupación o saldos sin dimensión tratados incorrectamente.', 'Revise Total versus Departamento y la columna Sin asignar; investigue el drill-down.')
    ],
    exercise: {title:'Ciclo contable controlado',scenario:'Registrar un asiento multimoneda, consultar el Mayor y ejecutar una validación de cierre.',tasks:['Revisar cuenta y período','Crear asiento','Adjuntar evidencia','Confirmar partida doble','Consultar Diario y Mayor','Revisar revaluación','Probar bloqueo de cierre en ambiente de capacitación'],expected:'El asiento aparece en ambos reportes, conserva moneda original y el período aplica el control esperado.'},
    checklist: ['Libro y período correctos', 'Cuenta autorizada', 'Dimensiones completas', 'Débitos=créditos', 'Tasa revisada', 'Evidencia adjunta', 'Reportes conciliados', 'Cierre aprobado'],
    images: [image('CAP-04-01-chart-accounts.png','Plan de cuentas y dimensiones'), image('CAP-04-02-journal.png','Registro de asiento de diario'), image('CAP-04-03-import.png','Importación y validación de asientos'), image('CAP-04-04-reports.png','Reportes y conciliación contable')]
  },
  {
    id: 'CAP-05',
    title: 'Carga y conciliación de saldos iniciales',
    audience: 'Equipo de migración y Contabilidad',
    objective: 'Preparar, validar y contabilizar la apertura con sus auxiliares sin duplicar cuentas de control y conservando moneda y tasa histórica.',
    prerequisites: ['Maestros aprobados.', 'Fecha de apertura y cuenta transitoria definidas.', 'Plantillas extraídas del sistema fuente.', 'Usuarios con permiso y respaldo del corte.'],
    routes: ['/opening-balances.html'],
    flow: ['Parámetros', 'Plantillas', 'Carga', 'Validación', 'Conciliación', 'Contabilización', 'Verificación'],
    steps: [
      step('Definir parámetros', 'Seleccione filial, fecha de apertura, tipo de carga y cuenta transitoria.', 'Moneda funcional y período corresponden al corte.'),
      step('Descargar plantillas', 'Descargue CSV o Excel desde cada tarjeta; no reutilice versiones antiguas sin comparar encabezados.', 'Se usan las seis plantillas vigentes.'),
      step('Preparar Libro Mayor', 'Complete cuenta, débitos/créditos locales, moneda e importes originales, tasa implícita, dimensiones y banco/cuenta bancaria cuando aplique.', 'Cada fila tiene solo débito o crédito y no hay encabezados vacíos.'),
      step('Preparar CxC y CxP', 'Cargue documentos abiertos por identificación fiscal, número, fecha, vencimiento, moneda, tasa y saldo.', 'El tercero existe en la filial y la suma concilia con la cuenta de control.'),
      step('Preparar Activos Fijos', 'Registre categoría, ficha, fecha en servicio, costo, depreciación acumulada, vida útil, moneda y dimensiones.', 'Costo y depreciación concilian con el Mayor.'),
      step('Preparar Pendientes de Facturar', 'Clasifique ACTUAL 113003/413001 o ANTERIOR 113004/413002, con dos líneas por referencia y tasa histórica.', 'Cada referencia conserva pareja contable y saldo vivo.'),
      step('Preparar Bancos', 'Registre saldo conciliado y, si existen, depósitos y cheques en tránsito por banco, cuenta y moneda.', 'La cuenta bancaria pertenece a la filial y se vincula con la cuenta contable.'),
      step('Seleccionar archivos', 'Adjunte cada archivo en su tarjeta; confirme que el nombre visible corresponde al auxiliar correcto.', 'La pantalla muestra exactamente los archivos que serán validados.'),
      step('Validar y corregir', 'Seleccione Validar y previsualizar. Corrija errores por archivo, fila y campo: fechas, encabezados, dimensiones, categorías y cuentas.', 'La validación indica correcta y no quedan archivos en rojo.'),
      step('Revisar conciliaciones', 'Compruebe débitos=créditos, Mayor versus CxC/CxP, activos, pendientes y bancos. Toda diferencia debe ser 0,00.', 'Cada sección muestra Conciliado con el Mayor.'),
      step('Contabilizar', 'Abra el modal final, revise filial, fecha, líneas, auxiliares y totales. Confirme una sola vez y espere el resultado.', 'Se genera el asiento de apertura y los auxiliares sin timeout ni duplicidad.'),
      step('Verificar después de la carga', 'Genere Balance, Mayor, CxC, CxP, activos y bancos a la fecha de apertura.', 'Los saldos coinciden con las actas firmadas.')
    ],
    controls: ['No duplicar cuentas de control cargando Mayor y auxiliar dos veces.', 'Débitos y créditos iguales.', 'Auxiliares con diferencia 0,00.', 'Conservar tasa histórica.', 'No repetir contabilización después de un timeout sin consultar el estado.'],
    commonErrors: [
      error('Columna sin encabezado', 'CSV con separador adicional o columna vacía.', 'Revise el archivo identificado, elimine columnas sobrantes y conserve encabezados exactos.'),
      error('Fecha fuera de rango', 'Formato DD/MM/AAAA no interpretado.', 'Utilice AAAA-MM-DD o el formato documentado en la plantilla.'),
      error('Dimensión no existe o es ambigua', 'Nombre no exacto, inactivo o fuera de filial.', 'Use código, nombre exacto o ID y corrija el maestro antes de cargar.'),
      error('Diferencia del Mayor', 'Falta una línea o se duplicó una cuenta de control.', 'Use el detalle por cuenta/moneda; corrija únicamente el archivo origen y vuelva a validar.'),
      error('Timeout al contabilizar', 'Proceso de carga prolongado.', 'Consulte si el asiento y auxiliares ya fueron creados antes de reintentar.')
    ],
    exercise: {title:'Ensayo de apertura',scenario:'Cargar un lote pequeño con Mayor, dos facturas CxC, un activo y una cuenta bancaria.',tasks:['Descargar plantillas','Preparar datos','Provocar y corregir un error','Validar','Conciliar','Abrir el modal final sin confirmar','Generar reportes de comprobación'],expected:'La previsualización queda cuadrada y todos los auxiliares muestran diferencia 0,00.'},
    checklist: ['Plantillas vigentes', 'Archivos correctos', 'Fechas válidas', 'Maestros existentes', 'Partida doble', 'Auxiliares conciliados', 'Tasas históricas', 'Acta firmada', 'Contabilización única', 'Reportes verificados'],
    images: [image('CAP-05-01-opening.png','Parámetros y seis plantillas de apertura'), image('CAP-05-02-validation.png','Validación detallada por archivo y fila'), image('CAP-05-03-preview.png','Conciliación Mayor versus auxiliares'), image('CAP-05-04-confirmation.png','Confirmación profesional de contabilización')]
  },
  {
    id: 'CAP-06',
    title: 'Ventas y Cuentas por Cobrar',
    audience: 'Ventas y Cuentas por Cobrar',
    objective: 'Ejecutar el ciclo de venta y cobro con numeración, impuestos, monedas, documentos, cuentas de control y comisiones bancarias correctas.',
    prerequisites: ['Clientes, productos, precios, términos e impuestos configurados.', 'Período AR abierto.', 'Secuencias de venta aprobadas.', 'Bancos y tipos de cambio disponibles.'],
    routes: ['/sales-documents.html', '/sales-invoice-entry.html', '/sales-note-entry.html', '/customer-payments.html', '/customer-statement-notifications.html', '/informes/contabilidad?reporte=receivables-aging'],
    flow: ['Cotización', 'Orden', 'Despacho', 'Factura', 'Cobro/anticipo', 'Nota', 'Estado de cuenta'],
    steps: [
      step('Confirmar cliente', 'Revise filial, moneda, término, límite, retenciones e indicador intercompany.', 'El cliente está activo y autorizado para la empresa/moneda.'),
      step('Preparar cotización', 'Registre productos, cantidades, precios, impuestos, país/mes de servicio y dimensiones.', 'Subtotal, impuestos y total son correctos.'),
      step('Convertir a orden y despacho', 'Mantenga referencias y valide cantidades entregadas antes de facturar.', 'No se factura más de lo ordenado/despachado.'),
      step('Crear la factura', 'Seleccione cliente, fecha, período, moneda y términos. La numeración se asigna al guardar.', 'El consecutivo continúa la secuencia de la filial.'),
      step('Completar líneas', 'Registre descripción, cantidad, precio, impuesto, departamento, centro de costo y soportes.', 'Cada línea calcula base, impuesto y bruto.'),
      step('Definir presentación PDF', 'Mantenga detalle normal o active Unificar líneas por impuesto y escriba la descripción que se repetirá en el PDF.', 'El PDF conserva el total al centavo y no altera líneas contables.'),
      step('Revisar impacto', 'Valide CxC 113001 o 113002 intercompany, ingresos, impuestos y dimensiones antes de contabilizar.', 'El asiento está balanceado y usa la cuenta de control correcta.'),
      step('Registrar cobro', 'Seleccione cliente, moneda, banco, fecha, tipo de cambio y facturas. Aplique importes totales o parciales.', 'El cobro no excede saldos y el ingreso bancario se calcula.'),
      step('Registrar comisión bancaria', 'Cuando el banco recibe menos que las facturas, registre la diferencia en la cuenta de comisiones.', 'Facturas aplicadas = ingreso bancario neto + comisión.'),
      step('Aplicar anticipos o notas', 'Use anticipos disponibles o emita nota con referencia e impuesto correspondiente.', 'El saldo del cliente y la cuenta de control se actualizan.'),
      step('Emitir estado de cuenta', 'Genere antigüedad/estado, revise saldo neto y envíe desde la plantilla autorizada.', 'Auxiliar CxC coincide con el Mayor.')
    ],
    controls: ['113001 para cliente normal y 113002 para intercompany.', 'Tasa de fecha o anterior más cercana con advertencia.', 'Impuesto calculado por línea.', 'PDF igual al total contable.', 'Cobro no superior al saldo.'],
    commonErrors: [
      error('Tipo de cambio 1 en moneda extranjera', 'No se recuperó tasa para la fecha.', 'Configure la tasa o use la anterior más cercana indicada; revise antes de guardar.'),
      error('Numeración con timestamp', 'Secuencia faltante o mal configurada.', 'Corrija la secuencia de FAC_VEN por filial; no modifique facturas ya emitidas.'),
      error('Factura no aparece para cobro', 'Cliente, moneda, filial o saldo no coinciden.', 'Confirme el contexto y que la factura esté contabilizada y pendiente.'),
      error('Diferencia CxC vs Mayor', 'Cuenta de control, apertura o filtros de moneda incorrectos.', 'Revise moneda local/original y drill-down por factura antes de ajustar.')
    ],
    exercise: {title:'Venta y cobro con comisión',scenario:'Facturar dos servicios en USD y cobrar el total menos una comisión bancaria.',tasks:['Crear factura','Revisar tasa','Configurar PDF unificado','Contabilizar','Registrar cobro','Registrar comisión','Descargar PDF','Consultar antigüedad'],expected:'Las facturas quedan saldadas; banco + comisión = CxC y el auxiliar concilia.'},
    checklist: ['Cliente/filial correctos', 'Secuencia correcta', 'Tasa revisada', 'Impuestos por línea', 'Dimensiones completas', 'Impacto balanceado', 'PDF validado', 'Cobro aplicado', 'Comisión registrada', 'CxC conciliada'],
    images: [image('CAP-06-01-sales-invoice.png','Creación de factura de venta'), image('CAP-06-02-sales-lines.png','Líneas, impuestos y dimensiones'), image('CAP-06-03-customer-payment.png','Cobro con comisión bancaria'), image('CAP-06-04-ar-report.png','Antigüedad y conciliación de CxC')]
  },
  {
    id: 'CAP-08',
    title: 'Solicitudes de pago',
    audience: 'Solicitantes, responsables de presupuesto, Cuentas por Pagar y Tesorería',
    objective: 'Preparar solicitudes completas, correctamente imputadas y listas para aprobación sin contabilizar ni descontar fondos antes de su ejecución.',
    prerequisites: ['Usuario autorizado para la subsidiaria.', 'Terceros y agencias tributarias activos.', 'Cuentas y dimensiones configuradas.', 'Flujos y aprobadores definidos.'],
    routes: ['/payment-requests.html', '/payment-request-report.html', 'Nueva solicitud', 'Detalle y archivos de respaldo'],
    flow: ['Tipo', 'Encabezado', 'Imputaciones', 'Dimensiones', 'Soportes', 'Envío', 'Aprobación', 'Ejecución'],
    steps: [
      step('Abrir una nueva solicitud', 'Desde Solicitudes de pago seleccione Crear y confirme la subsidiaria activa. El número SOL_PAG se asigna al guardar.', 'La pantalla inicia sin un número temporal basado en fecha y hora.'),
      step('Elegir el tipo', 'Seleccione Pago de CxP para cancelar documentos registrados u Otros pagos – Imputación directa para obligaciones sin factura.', 'El formulario muestra solo los campos compatibles con el tipo.'),
      step('Completar el encabezado', 'Indique moneda, fecha estimada, concepto y referencia. La descripción debe explicar beneficiario, razón y período.', 'El propósito se entiende sin depender del adjunto.'),
      step('Seleccionar tercero', 'Elija proveedor, empleado, cliente, otro tercero o Agencia Tributaria. Esta última lista se filtra por subsidiaria.', 'El tercero está activo y coincide con el beneficiario real.'),
      step('Agregar imputaciones', 'Seleccione cuenta, concepto y monto. Use una línea por naturaleza contable o dimensión; el monto se presenta con separadores y decimales.', 'Cada línea tiene cuenta, concepto y monto mayor que cero.'),
      step('Asignar dimensiones', 'Seleccione Tipo de departamento, Departamento y Centro de costos en ese orden para aplicar el filtro en cascada.', 'Departamento y centro son válidos para la cuenta y empresa.'),
      step('Propagar el tercero', 'Después de elegir tipo y tercero, replique la selección en las líneas activas relacionadas y revise cualquier excepción.', 'Las líneas conservan el mismo beneficiario sin recaptura inconsistente.'),
      step('Adjuntar respaldos', 'Cargue factura, cálculo, formulario fiscal, contrato o aprobación. Use enlace HTTPS para repositorios autorizados.', 'El aprobador puede abrir cada soporte.'),
      step('Revisar totales', 'Compare la suma de imputaciones con el solicitado y revise moneda, cuentas y dimensiones. Guardar no genera asiento ni reduce fondos.', 'El total de líneas coincide con el total del documento.'),
      step('Guardar y enviar', 'Guarde el borrador, corrija alertas y seleccione Enviar. Confirme la ruta según tercero y departamento.', 'Cambia a Pendiente de aprobación y muestra responsable.'),
      step('Dar seguimiento', 'Consulte estado, comentarios e historial. Si se devuelve, corrija y reenvíe; si se cancela, documente el motivo.', 'Existe una sola solicitud con historial completo.')
    ],
    controls: ['Secuencia SOL_PAG por subsidiaria.', 'Agencia tributaria filtrada por empresa.', 'Tercero y dimensiones consistentes por línea.', 'Monto positivo con precisión de moneda.', 'Soportes antes del envío.', 'Guardar o aprobar no contabiliza; el impacto ocurre al ejecutar.'],
    commonErrors: [
      error('Número con fecha y hora', 'La secuencia SOL_PAG no está configurada.', 'Configure la secuencia antes de crear documentos nuevos.'),
      error('No aparece la agencia tributaria', 'No está activa o vinculada a la empresa.', 'Revise su catálogo y asignación.'),
      error('Centro de costos incorrecto', 'No se eligió primero tipo y departamento.', 'Seleccione dimensiones en orden y use centros vinculados.'),
      error('No existe flujo activo', 'Falta configuración o ninguna regla coincide.', 'Revise CAP-09 y los aprobadores de empresa/centro.')
    ],
    exercise: { title: 'Pago directo tributario', scenario: 'Crear una solicitud con tres imputaciones para una agencia tributaria.', tasks: ['Elegir Imputación directa', 'Seleccionar Agencia Tributaria', 'Agregar tres líneas', 'Filtrar dimensiones', 'Revisar montos', 'Adjuntar soporte', 'Enviar', 'Consultar reporte'], expected: 'Queda pendiente del Supervisor tributario, con secuencia, total y soportes correctos.' },
    checklist: ['Tipo correcto', 'Beneficiario válido', 'Moneda y fecha', 'Concepto suficiente', 'Cuentas permitidas', 'Dimensiones filtradas', 'Montos formateados', 'Total conciliado', 'Soportes adjuntos', 'Ruta visible'],
    images: [image('CAP-08-01-request.png', 'Encabezado de solicitud'), image('CAP-08-02-allocation.png', 'Imputaciones y dimensiones'), image('CAP-08-03-supports.png', 'Archivos de respaldo'), image('CAP-08-04-report.png', 'Seguimiento de solicitudes')]
  },
  {
    id: 'CAP-09',
    title: 'Aprobaciones y bandeja de trabajo',
    audience: 'Aprobadores de proyectos, administrativos, tributarios y administradores',
    objective: 'Configurar y ejecutar decisiones trazables, con enrutamiento por naturaleza del gasto y sustitución controlada cuando falte un aprobador.',
    prerequisites: ['Roles y permisos de aprobación activos.', 'Usuarios vinculados a las subsidiarias.', 'Aprobadores configurados en centros de costos y empresas.', 'Documentos de prueba listos.'],
    routes: ['/approval-inbox.html', '/approval-workflows.html', '/up-approvers.html', 'Auditoría del documento'],
    flow: ['Configuración', 'Enrutamiento', 'Notificación', 'Revisión', 'Decisión', 'Siguiente nivel', 'Ejecución', 'Auditoría'],
    steps: [
      step('Definir documento y alcance', 'Seleccione tipo, subsidiaria, moneda, rango de monto y condiciones. Evite reglas superpuestas sin prioridad.', 'La regla tiene vigencia, prioridad y alcance inequívocos.'),
      step('Configurar niveles', 'Agregue pasos en orden, indicando rol o usuario, aprobación individual o conjunta y límites.', 'La simulación muestra una secuencia completa.'),
      step('Configurar responsables', 'Asigne Aprobador Proyectos en centros de costos y, en subsidiaria, UP por defecto, Administrativo y Supervisor tributario.', 'Cada función tiene un usuario activo y autorizado.'),
      step('Enviar el documento', 'El solicitante revisa soportes y envía. El sistema evalúa tercero, tipo de departamento, centro, monto y empresa.', 'El documento queda pendiente y registra aprobador actual.'),
      step('Recibir la notificación', 'Abra correo o bandeja. El mensaje indica número, solicitante, departamento, centro, monto y enlace seguro.', 'El enlace exige autenticación y abre el documento vigente.'),
      step('Revisar el expediente', 'Examine encabezado, líneas, presupuesto, cuenta, tercero, impuestos, soportes e historial.', 'La decisión puede justificarse con evidencia visible.'),
      step('Aprobar, devolver o rechazar', 'Aprobar continúa; Devolver solicita corrección; Rechazar cierra. Añada comentario específico.', 'Acción, fecha, usuario y comentario quedan registrados.'),
      step('Aplicar ruta por departamento', 'Para Cliente use UP del centro o UP por defecto; para Interno use Aprobador Administrativo.', 'La bandeja correcta recibe la tarea.'),
      step('Aplicar ruta tributaria', 'Si el tercero es Agencia Tributaria, enrute al Supervisor tributario aunque existan otras dimensiones.', 'El supervisor figura como responsable.'),
      step('Usar fallback controlado', 'Si falta el aprobador, permita a un administrador autorizado decidir y muestre alerta de configuración pendiente.', 'La sustitución no bloquea y queda auditada.'),
      step('Cerrar y auditar', 'Tras la aprobación final, confirme el paso a ejecución y revise el historial completo.', 'No hay saltos de nivel ni acciones sin responsable.')
    ],
    controls: ['Cliente: UP del centro y, si falta, UP por defecto.', 'Interno: Aprobador Administrativo.', 'Agencia Tributaria: Supervisor tributario.', 'Fallback solo para administrador y auditado.', 'Límites y filiales restringen al aprobador.', 'El botón de correo valida sesión y estado.'],
    commonErrors: [
      error('No existe flujo activo', 'No hay regla vigente o coincidente.', 'Active y revise tipo, empresa, moneda, monto y fecha.'),
      error('Llegó al aprobador equivocado', 'Tipo o centro mal seleccionado.', 'Corrija dimensiones y reinicie el flujo con trazabilidad.'),
      error('El botón del correo no permite aprobar', 'Sesión expirada o estado cambió.', 'Inicie sesión, abra bandeja y confirme estado.'),
      error('Aprobador sin acceso', 'Carece de filial o permiso.', 'Asigne solo la empresa y permisos mínimos necesarios.')
    ],
    exercise: { title: 'Probar tres rutas', scenario: 'Enviar una solicitud Cliente, una Interna y una Tributaria.', tasks: ['Configurar responsables', 'Enviar tres solicitudes', 'Verificar bandejas', 'Devolver una', 'Corregir y reenviar', 'Aprobar', 'Consultar auditoría', 'Documentar fallback'], expected: 'Cada solicitud llega al responsable definido y las decisiones quedan trazables.' },
    checklist: ['Flujo vigente', 'Reglas sin conflicto', 'Niveles ordenados', 'Aprobadores activos', 'Filiales asignadas', 'Correo seguro', 'Soportes revisados', 'Comentarios registrados', 'Fallback auditado', 'Historial completo'],
    images: [image('CAP-09-01-inbox.png', 'Bandeja de aprobaciones'), image('CAP-09-02-detail.png', 'Detalle y decisión'), image('CAP-09-03-workflow.png', 'Configuración del flujo'), image('CAP-09-04-approvers.png', 'Aprobadores configurados')]
  },
  {
    id: 'CAP-10',
    title: 'Bancos y conciliación bancaria',
    audience: 'Tesorería, Contabilidad y supervisores financieros',
    objective: 'Importar extractos, conciliar ERP contra banco, registrar cargos no contabilizados y cerrar con diferencia cero.',
    prerequisites: ['Bancos, cuentas y monedas vinculados a la subsidiaria.', 'Saldo de apertura o auxiliar bancario cargado.', 'Extracto admitido disponible.', 'Fecha de conciliación definida.'],
    routes: ['Catálogo de extractos bancarios', 'Informe Bancos y Conciliación', '/bank-fees.html', '/quadratic-bank-reconciliation.html', 'Transferencias, depósitos y cheques'],
    flow: ['Cuenta y fecha', 'Extracto', 'Movimientos ERP', 'Coincidencias', 'Ajustes', 'Tránsitos', 'Cierre', 'Prueba de efectivo'],
    steps: [
      step('Seleccionar contexto', 'Elija subsidiaria, banco, moneda, cuenta y fecha. La cuenta se presenta como Banco – número – moneda.', 'El saldo según libros corresponde a esa cuenta y fecha.'),
      step('Registrar el extracto', 'Cree o elija fecha, cuenta, saldo inicial y final con formato numérico; confirme que pertenece a la empresa activa.', 'La lista muestra cuenta completa y saldos legibles.'),
      step('Importar movimientos', 'Valide fecha, referencia, descripción, signo y monto del archivo antes de confirmar.', 'Los movimientos aparecen una vez y reconstruyen el saldo final.'),
      step('Revisar movimientos ERP', 'Compruebe depósitos, cobros, pagos, cheques, transferencias y asientos hasta el corte.', 'El panel ERP muestra cantidad y total esperados.'),
      step('Conciliar automáticamente', 'Ejecute coincidencia por monto, moneda, fecha y referencia; revise propuestas con montos repetidos.', 'Los pares confiables cambian a Conciliado.'),
      step('Conciliar manualmente', 'Seleccione un movimiento ERP y uno bancario, compare notas y confirme el vínculo.', 'Ambos quedan enlazados y salen de pendientes.'),
      step('Registrar comisiones', 'Marque cargos no registrados y use Registrar comisiones; confirme 631002, departamento Administrativo y referencia.', 'Se crean asientos sin duplicar movimientos.'),
      step('Gestionar tránsitos', 'Clasifique cheques pendientes y depósitos en tránsito con fecha y referencia hasta que aparezcan en banco.', 'Los totales alimentan la ecuación y tienen detalle.'),
      step('Registrar ajustes', 'Use ajustes solo para cargos, intereses o errores soportados; corrija el origen cuando sea posible.', 'Cada ajuste tiene cuenta, dimensión y asiento balanceado.'),
      step('Validar y finalizar', 'Compare ERP ± tránsitos ± ajustes con el saldo final y cierre solo con diferencia cero.', 'Muestra Conciliación cuadrada y genera PDF auditable.'),
      step('Preparar prueba de efectivo', 'Compare cuatro columnas: saldo inicial, ingresos, egresos y saldo final entre libros y banco.', 'Toda diferencia se explica con partidas identificadas.')
    ],
    controls: ['Cuenta filtrada por empresa y moneda.', 'Archivo no duplicado.', 'Coincidencias repetidas revisadas.', 'Comisiones una sola vez en 631002 y Administrativo.', 'Tránsitos con referencia y antigüedad.', 'Cierre con cero o excepción aprobada.'],
    commonErrors: [error('No aparecen movimientos ERP', 'Cuenta, moneda, filial, fecha o apertura no coincide.', 'Revise filtros, auxiliar y Mayor de la cuenta.'), error('Extracto de otra empresa', 'Cuenta sin filtro de subsidiaria.', 'Elimine mediante procedimiento autorizado y cargue en la empresa correcta.'), error('Saldo ilegible', 'Monto no normalizado.', 'Edite con dos decimales y confirme moneda.'), error('Comisión duplicada', 'Movimiento procesado dos veces.', 'Revise estado y referencia; anule el duplicado con trazabilidad.')],
    exercise: { title: 'Conciliación con comisión', scenario: 'Importar cobros, pagos, una comisión y un cheque en tránsito.', tasks: ['Elegir cuenta', 'Importar', 'Coincidir automáticamente', 'Revisar', 'Conciliar manual', 'Registrar comisión', 'Clasificar tránsito', 'Cerrar', 'Descargar PDF'], expected: 'Diferencia cero, comisión única y cheque identificado en tránsito.' },
    checklist: ['Contexto correcto', 'Saldos revisados', 'Archivo único', 'ERP completo', 'Coincidencias verificadas', 'Comisiones registradas', 'Tránsitos soportados', 'Ajustes aprobados', 'Diferencia cero', 'PDF archivado'],
    images: [image('CAP-10-01-bank-filters.png', 'Filtros y saldos'), image('CAP-10-02-reconciliation.png', 'Movimientos ERP y banco'), image('CAP-10-03-bank-fees.png', 'Comisiones masivas'), image('CAP-10-04-cash-proof.png', 'Prueba de efectivo')]
  },
  {
    id: 'CAP-11',
    title: 'Tesorería, pagos y archivos bancarios',
    audience: 'Tesorería, Cuentas por Pagar, Contabilidad y aprobadores de pagos',
    objective: 'Programar, ejecutar, agrupar y exportar pagos con control de banco, moneda, beneficiario, aprobación y trazabilidad.',
    prerequisites: ['Solicitudes o facturas aprobadas.', 'Cuentas bancarias activas.', 'Datos bancarios de beneficiarios validados.', 'Formato de pago masivo configurado.'],
    routes: ['/treasury.html', '/supplier-payments.html', '/payment-batches.html?view=generator', 'Historial de lotes', 'Transferencias, depósitos y cheques'],
    flow: ['Programación', 'Selección', 'Aplicación', 'Validación bancaria', 'Lote', 'Aprobación', 'Archivo', 'Contabilización y seguimiento'],
    steps: [
      step('Revisar obligaciones', 'Abra Tesorería y filtre por empresa, fecha, moneda, beneficiario, vencimiento y prioridad.', 'Solo aparecen documentos aprobados y pendientes.'),
      step('Preparar el calendario', 'Ordene pagos según vencimiento, descuentos, liquidez y política; documente cualquier retención.', 'El total programado cabe en el disponible autorizado.'),
      step('Crear el pago', 'Seleccione beneficiario, banco, cuenta, moneda, fecha, referencia y tasa; no mezcle monedas incompatibles.', 'La cuenta pertenece a la subsidiaria y moneda.'),
      step('Aplicar documentos', 'Marque facturas, notas y anticipos e indique importes totales o parciales sin exceder saldos.', 'Aplicaciones más retenciones coinciden con el pago.'),
      step('Revisar impacto', 'Compruebe banco, CxP, anticipos, retenciones, diferencias cambiarias y dimensiones.', 'El asiento preliminar está balanceado.'),
      step('Guardar y aprobar', 'Guarde el pago o lote y envíelo al flujo definido; el preparador no debe aprobar cuando haya segregación.', 'Estado e historial muestran preparador y aprobador.'),
      step('Agrupar el lote', 'En el generador seleccione pagos homogéneos por banco, cuenta, moneda, fecha y formato.', 'El lote no contiene duplicados ni pagos ya ejecutados.'),
      step('Validar datos bancarios', 'Revise cuenta del beneficiario, identificador, país, banco, tipo de transferencia y longitud de campos.', 'El sistema no reporta campos obligatorios faltantes.'),
      step('Generar el archivo', 'Cree el archivo según el layout bancario, compare cantidad y total con la hoja de control y descargue una sola versión aprobada.', 'Totales del archivo y lote coinciden al centavo.'),
      step('Confirmar ejecución', 'Registre la aceptación o rechazo bancario, contabilice pagos ejecutados y conserve el comprobante.', 'Cada pago tiene referencia bancaria y estado final.'),
      step('Consultar historial', 'Revise archivos, versiones, usuario, fecha, total, rechazos y reintentos desde el historial.', 'No existen reenvíos sin evidencia ni pagos duplicados.')
    ],
    controls: ['Segregación entre preparación, aprobación y ejecución.', 'Cuenta bancaria de la empresa y moneda correctas.', 'Aplicación no superior al saldo.', 'Datos bancarios validados antes del archivo.', 'Cantidad y total archivo=lote.', 'Rechazos no se contabilizan como ejecutados.'],
    commonErrors: [error('Pago no aparece en el lote', 'Estado, banco, moneda o fecha no coincide.', 'Revise filtros y aprobación del pago.'), error('Banco rechaza el archivo', 'Layout o dato bancario inválido.', 'Corrija la fuente maestra, regenere versión y conserve el rechazo.'), error('Pago duplicado', 'Se reprocesó una versión ya aceptada.', 'Verifique referencia e historial antes de reenviar.'), error('Diferencia de lote', 'Aplicaciones o retenciones cambiaron.', 'Regrese a los pagos, revalide y genere un lote nuevo.')],
    exercise: { title: 'Lote de pagos a proveedores', scenario: 'Programar tres facturas, aplicar un anticipo y generar archivo bancario.', tasks: ['Filtrar obligaciones', 'Crear pagos', 'Aplicar anticipo', 'Revisar asientos', 'Aprobar', 'Agrupar', 'Validar beneficiarios', 'Generar archivo', 'Confirmar ejecución'], expected: 'Lote y archivo coinciden; pagos quedan referenciados y sin duplicación.' },
    checklist: ['Obligaciones aprobadas', 'Liquidez revisada', 'Cuenta y moneda', 'Aplicaciones correctas', 'Impacto balanceado', 'Segregación aplicada', 'Datos bancarios completos', 'Totales coinciden', 'Archivo versionado', 'Respuesta bancaria archivada'],
    images: [image('CAP-11-01-treasury.png', 'Programación de tesorería'), image('CAP-11-02-supplier-payment.png', 'Pago y aplicaciones'), image('CAP-11-03-payment-batch.png', 'Generador de archivos'), image('CAP-11-04-batch-history.png', 'Historial de lotes')]
  },
  {
    id: 'CAP-12',
    title: 'Activos Fijos',
    audience: 'Contabilidad, custodios de activos, Compras y responsables de inventario físico',
    objective: 'Administrar el ciclo de vida del activo desde la categoría y capitalización hasta depreciación, traslado, deterioro, baja y conciliación.',
    prerequisites: ['Categorías activas y asociadas a subsidiarias.', 'Cuentas de costo, depreciación acumulada y gasto configuradas.', 'Ubicaciones, custodios y dimensiones disponibles.', 'Políticas de capitalización y vida útil aprobadas.'],
    routes: ['Categorías de activos', 'Activos fijos', 'Propuestas de capitalización', 'Depreciaciones', 'Transferencias, mantenimientos y bajas', 'Reportes de activos'],
    flow: ['Categoría', 'Adquisición', 'Capitalización', 'Puesta en servicio', 'Depreciación', 'Operaciones', 'Baja', 'Conciliación'],
    steps: [
      step('Configurar la categoría', 'Defina código, descripción, vida útil, método, valor residual, cuentas y subsidiarias aplicables.', 'La categoría está activa y las cuentas corresponden a su naturaleza.'),
      step('Registrar la adquisición', 'Desde factura o propuesta identifique costo, moneda, proveedor, fecha, descripción y cantidad capitalizable.', 'El importe coincide con el soporte de compra.'),
      step('Crear la ficha', 'Asigne número, categoría, ubicación, custodio, serie, marca, dimensiones y evidencia.', 'La ficha es única y localizable físicamente.'),
      step('Definir Fecha en servicio', 'Indique la fecha en que el activo está disponible y listo para operar; no confundir con compra o pago.', 'El inicio de depreciación sigue la política desde esa fecha.'),
      step('Validar costo histórico', 'Revise costo local/original, tasa histórica, valor residual, vida útil y depreciación inicial cuando provenga de apertura.', 'Costo y depreciación concilian con documentos o plantilla.'),
      step('Ejecutar depreciación', 'Genere el período, revise días o meses, altas, bajas y activos totalmente depreciados antes de contabilizar.', 'El lote no supera base depreciable ni duplica períodos.'),
      step('Registrar traslado o custodia', 'Use Transferencia para cambiar ubicación, custodio o dimensiones con fecha y autorización; no edite el histórico.', 'La ficha muestra situación actual e historial anterior.'),
      step('Registrar mantenimiento', 'Documente preventivo/correctivo, proveedor, costo, fecha, parada y soporte sin capitalizar automáticamente.', 'El evento queda vinculado al activo.'),
      step('Procesar deterioro, baja o venta', 'Calcule valor neto, contraprestación y resultado; obtenga aprobación y contabilice la operación formal.', 'El activo cambia de estado y deja de depreciarse cuando corresponde.'),
      step('Conciliar el módulo', 'Compare costo, depreciación acumulada, adiciones, retiros y gasto con el Mayor por categoría y subsidiaria.', 'Submayor y Mayor coinciden al centavo.'),
      step('Exportar y auditar', 'Descargue CSV, Excel o PDF de activos y categorías y revise auditoría de cambios relevantes.', 'El archivo reproduce filtros y totales de pantalla.')
    ],
    controls: ['Categorías disponibles para la subsidiaria.', 'Fecha en servicio define depreciación.', 'Tasa histórica preservada en aperturas.', 'No depreciar más que costo menos residual.', 'Operaciones mediante transacciones, no edición del histórico.', 'Submayor conciliado con cuentas de activo y depreciación.'],
    commonErrors: [error('Categoría no existe o está inactiva', 'No aplica a la empresa.', 'Active/asigne la categoría o use un código vigente.'), error('Depreciación duplicada', 'El período ya fue contabilizado.', 'Revise historial y no regenere el lote.'), error('Valor neto negativo', 'Vida, residual o depreciación inicial incorrectos.', 'Corrija la ficha antes de contabilizar.'), error('Auxiliar no concilia', 'Alta, baja o apertura no vinculada.', 'Revise control por cuenta y ficha; corrija el origen.')],
    exercise: { title: 'Ciclo de un equipo', scenario: 'Capitalizar un equipo, ponerlo en servicio, depreciar, trasladar y consultar su ficha.', tasks: ['Revisar categoría', 'Crear ficha', 'Definir fecha en servicio', 'Adjuntar soporte', 'Depreciar un período', 'Trasladar', 'Exportar reporte', 'Conciliar Mayor'], expected: 'Costo, depreciación y ubicación quedan trazables y el auxiliar concilia.' },
    checklist: ['Categoría válida', 'Cuentas correctas', 'Costo soportado', 'Fecha en servicio', 'Vida y residual', 'Custodio/ubicación', 'Dimensiones', 'Depreciación revisada', 'Operaciones auditadas', 'Mayor conciliado'],
    images: [image('CAP-12-01-assets.png', 'Ficha de activo fijo'), image('CAP-12-02-depreciation.png', 'Lote de depreciación'), image('CAP-12-03-operations.png', 'Transferencias y bajas'), image('CAP-12-04-asset-report.png', 'Reporte y conciliación')]
  },
  {
    id: 'CAP-13',
    title: 'Inventario y control de existencias',
    audience: 'Almacén, Compras, Ventas, Costos y Contabilidad',
    objective: 'Configurar productos y ubicaciones, registrar movimientos con lotes o series y conciliar cantidades y valor de inventario.',
    prerequisites: ['Categorías, unidades de medida y cuentas configuradas.', 'Almacenes, zonas y ubicaciones activos.', 'Productos asignados a subsidiarias.', 'Política de costo, lotes y series definida.'],
    routes: ['Productos y categorías', 'Productos por subsidiaria', 'Almacenes, zonas y bins', 'Existencias', 'Lotes y series', 'Movimientos, transferencias, ajustes y reservas'],
    flow: ['Maestros', 'Asignación', 'Ubicaciones', 'Entrada', 'Existencia', 'Reserva', 'Salida/transferencia', 'Ajuste', 'Conciliación'],
    steps: [
      step('Configurar catálogos base', 'Cree categorías, marcas, grupos, tipos y unidades evitando códigos duplicados o descripciones ambiguas.', 'Cada catálogo tiene código único y estado activo.'),
      step('Crear el producto', 'Defina código, nombre, tipo, unidad, control de lote/serie, impuestos y cuentas de inventario, costo y variación.', 'La configuración coincide con la naturaleza del artículo.'),
      step('Asignar a subsidiarias', 'Habilite el producto por empresa con moneda, política de costo, disponibilidad y proveedores autorizados.', 'Solo las subsidiarias marcadas pueden usarlo.'),
      step('Configurar almacenamiento', 'Cree almacén, zona y bin en jerarquía, indicando responsable, capacidad y restricciones.', 'La ubicación pertenece a la subsidiaria y acepta el producto.'),
      step('Cargar o recibir existencias', 'Registre apertura o recepción con fecha, cantidad, costo, moneda, documento y ubicación.', 'Cantidad por costo explica el valor de entrada.'),
      step('Asignar lotes o series', 'Para artículos controlados capture lote, vencimiento o un número de serie único por unidad.', 'No existen series duplicadas ni lotes sin trazabilidad.'),
      step('Reservar inventario', 'Vincule cantidades a una orden o solicitud sin exceder disponible; libere reservas canceladas.', 'Disponible = existencia menos reservas vigentes.'),
      step('Registrar salida', 'Seleccione documento origen, producto, ubicación, lote/serie y cantidad despachada.', 'No se genera inventario negativo salvo política autorizada.'),
      step('Transferir entre ubicaciones', 'Use una transferencia para mover existencias; registre salida, tránsito y recepción cuando aplique.', 'La cantidad total se conserva entre origen y destino.'),
      step('Ajustar con conteo', 'Compare conteo físico con sistema, investigue diferencias y registre ajuste aprobado con motivo.', 'El ajuste conserva evidencia y asiento balanceado.'),
      step('Revisar kardex y valor', 'Consulte movimientos cronológicos, existencias por ubicación y valoración; compare cuentas con el Mayor.', 'Cantidad y valor concilian con submayor y contabilidad.')
    ],
    controls: ['Código y unidad únicos.', 'Producto autorizado por subsidiaria.', 'Lote/serie obligatorio cuando aplique.', 'No salida mayor al disponible.', 'Transferencias conservan cantidad.', 'Ajustes requieren motivo y aprobación.', 'Valor de inventario conciliado con Mayor.'],
    commonErrors: [error('Producto no aparece', 'No está activo o asignado a la empresa.', 'Revise Producto por subsidiaria.'), error('Serie duplicada', 'La serie ya fue recibida.', 'Busque su historial y corrija el documento origen.'), error('Disponible insuficiente', 'Existe reserva o ubicación incorrecta.', 'Revise existencias y reservas antes de ajustar.'), error('Valor difiere del Mayor', 'Costo, fecha o cuenta de movimiento incorrectos.', 'Compare kardex por transacción y corrija el origen.')],
    exercise: { title: 'Recepción y transferencia con series', scenario: 'Recibir cinco equipos seriados, reservar dos y transferir tres a otra ubicación.', tasks: ['Crear producto', 'Asignar empresa', 'Configurar bins', 'Recibir', 'Capturar series', 'Reservar', 'Transferir', 'Consultar kardex', 'Conciliar valor'], expected: 'Las cinco series conservan ubicación/estado y el valor total concilia.' },
    checklist: ['Maestros válidos', 'Producto configurado', 'Empresa asignada', 'Ubicación correcta', 'Costo soportado', 'Lotes/series completos', 'Reservas vigentes', 'Movimientos referenciados', 'Ajustes aprobados', 'Kardex conciliado'],
    images: [image('CAP-13-01-products.png', 'Maestro de productos'), image('CAP-13-02-locations.png', 'Almacenes, zonas y bins'), image('CAP-13-03-stock.png', 'Existencias, lotes y series'), image('CAP-13-04-movements.png', 'Kardex y movimientos')]
  },
  {
    id: 'CAP-14',
    title: 'Gestión fiscal e impuestos indirectos',
    audience: 'Impuestos, Contabilidad, Cuentas por Cobrar y Cuentas por Pagar',
    objective: 'Configurar obligaciones y códigos fiscales, controlar vencimientos y preparar una liquidación auditable de IVA/GCT por tarifa.',
    prerequisites: ['País y régimen de la subsidiaria configurados.', 'Agencias, impuestos, tasas y cuentas fiscales activos.', 'Documentos de ventas y compras contabilizados.', 'Calendario y responsables fiscales definidos.'],
    routes: ['Agencias y catálogos fiscales', 'Obligaciones tributarias', 'Calendario fiscal', 'Reporte de declaración IVA/GCT', 'Balance General de ocho columnas'],
    flow: ['Configuración', 'Obligación', 'Calendario', 'Documentos', 'Liquidación', 'Drill-down', 'Conciliación', 'Exportación y declaración'],
    steps: [
      step('Configurar la agencia', 'Registre la autoridad tributaria por país y subsidiaria con identificación, contacto y medios de pago.', 'La agencia aparece solo en las empresas vinculadas.'),
      step('Configurar códigos y tarifas', 'Defina código, descripción, porcentaje, tipo débito/crédito, vigencia y cuentas. Separe estándar, reducida, cero, exenta e importación.', 'Cada código tiene vigencia no superpuesta y cuenta correcta.'),
      step('Crear la obligación', 'Indique impuesto, formulario, frecuencia, período, fecha límite, responsable y documentos requeridos.', 'La obligación genera eventos para los períodos aplicables.'),
      step('Revisar el calendario', 'Consulte vencimientos por mes, empresa, país y responsable; configure alertas y registre estados de preparación, presentación y pago.', 'No hay obligaciones vencidas sin responsable o comentario.'),
      step('Validar documentos fuente', 'Compruebe que facturas y notas estén contabilizadas, tengan período fiscal, estado admitido y código por línea.', 'No se incluyen borradores ni anulados.'),
      step('Generar IVA/GCT', 'Seleccione subsidiaria, año, mes, ajustes y estados. El reporte agrupa base e impuesto de ventas y compras por código y tasa.', 'Débito y crédito se construyen desde líneas, no encabezados.'),
      step('Revisar notas y ajustes', 'Confirme que notas de crédito resten base/impuesto y notas de débito sumen dentro de su tarifa y período.', 'El signo y documento origen son trazables.'),
      step('Abrir el detalle', 'Seleccione una tarifa para ver número, fecha, tercero, identificación fiscal, base, impuesto y total de cada documento.', 'La suma del detalle coincide con la fila resumen.'),
      step('Calcular la posición neta', 'Revise débito menos crédito deducible, retenciones sufridas/practicadas y saldo anterior para determinar pago o saldo a favor.', 'La fórmula final se explica con componentes visibles.'),
      step('Conciliar con contabilidad', 'Compare bases e impuestos con Mayor, auxiliares y cuentas fiscales; investigue códigos sin cuenta o diferencias de período.', 'La declaración concilia al centavo con saldos soportados.'),
      step('Exportar y archivar', 'Descargue Excel con Resumen, Detalle Ventas y Detalle Compras y PDF ejecutivo; conserve acuse y pago.', 'Los archivos reproducen filtros, moneda, período y totales.'),
      step('Revisar balance fiscal de ocho columnas', 'Use el reporte para analizar saldo inicial, débitos, créditos y saldo final por cuenta y verificar movimientos del período.', 'Las columnas cuadran con el Mayor y la balanza.')
    ],
    controls: ['Cálculo por línea y tarifa.', 'Solo estados y períodos autorizados.', 'Notas con signo fiscal correcto.', 'Vigencias de tasas sin solapamiento.', 'Drill-down suma igual al resumen.', 'Posición neta conciliada con Mayor y auxiliares.', 'Vencimientos con responsable y evidencia.'],
    commonErrors: [error('Tarifa no aparece', 'Código inactivo, sin vigencia o sin líneas.', 'Revise fecha, país y configuración del impuesto.'), error('Base no coincide con factura', 'Se comparó encabezado con líneas mixtas.', 'Revise el drill-down por código y línea.'), error('Nota suma en vez de restar', 'Tipo o referencia fiscal incorrecta.', 'Corrija documento origen antes de declarar.'), error('Diferencia con Mayor', 'Período, estado, cuenta o redondeo inconsistente.', 'Conciliación por cuenta/documento y corrección en origen.')],
    exercise: { title: 'Liquidación mensual IVA/GCT', scenario: 'Preparar el impuesto de un mes con ventas a dos tarifas, compras, nota de crédito y retención.', tasks: ['Revisar códigos', 'Confirmar obligación', 'Generar reporte', 'Abrir tarifas', 'Validar nota', 'Calcular posición', 'Conciliar cuentas', 'Exportar Excel/PDF', 'Actualizar calendario'], expected: 'La posición fiscal queda sustentada por documento, conciliada y lista para presentar.' },
    checklist: ['Agencia correcta', 'Tasas vigentes', 'Obligación y plazo', 'Documentos contabilizados', 'Período correcto', 'Notas con signo', 'Detalle revisado', 'Retenciones conciliadas', 'Posición neta validada', 'Archivos y acuse archivados'],
    images: [image('CAP-14-01-obligations.png', 'Obligaciones tributarias'), image('CAP-14-02-calendar.png', 'Calendario fiscal'), image('CAP-14-03-vat.png', 'Declaración IVA/GCT'), image('CAP-14-04-tax-detail.png', 'Detalle por tarifa y documento')]
  },
];

trainingManuals.push(...trainingManualsCap15To19);

// Mantiene el orden pedagógico aun cuando los bloques se hayan incorporado por etapas.
trainingManuals.sort((left, right) => left.id.localeCompare(right.id, 'es', { numeric: true }));

// Campo explícito solicitado para el generador; evita duplicar el texto ya definido en el ejercicio.
for (const manual of trainingManuals) {
  manual.resultExpected ??= manual.exercise?.expected ?? '';
}

export const trainingManualById = Object.fromEntries(
  trainingManuals.map((manual) => [manual.id, manual])
);

export const manuals = trainingManuals;

export function getTrainingManual(id) {
  return trainingManualById[id] ?? null;
}

export default trainingManuals;
