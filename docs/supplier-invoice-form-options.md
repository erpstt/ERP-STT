# Carga de opciones de facturas de proveedor

El formulario de facturas consultaba por separado los maestros de proveedores, cuentas, monedas y otras referencias. Cada maestro exigía sus propios permisos de mantenimiento. Si una consulta fallaba, la carga se interrumpía antes de poblar los proveedores y el resto de campos.

La pantalla consulta ahora sus referencias mediante una única operación protegida de opciones de facturas. Para una factura nueva se exige permiso de creación de facturas y su permiso técnico. Para consultar una factura existente se exige lectura y se comprueba el identificador de la factura y su subsidiaria activa.

La respuesta contiene los datos mínimos necesarios para los campos del formulario. Los proveedores y las demás referencias respetan su asignación a la subsidiaria. Las referencias históricas se limitan a la factura seleccionada.

El formulario permanece bloqueado mientras carga. Una respuesta incompleta, un error de autorización o una discrepancia de subsidiaria se muestra en la parte superior y mantiene deshabilitado el guardado. Los identificadores de ruta y los datos de una recepción conservan sus validaciones.

Las pruebas usan proveedores, facturas y permisos sintéticos. Cubren el rol creador sin acceso a maestros, filtrado por subsidiaria, referencias históricas, campos de retención y contabilidad, errores de carga, lectura y edición, e inicialización desde una recepción.
