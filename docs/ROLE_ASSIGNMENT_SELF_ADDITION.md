# Alta adicional de un rol propio

Un usuario activo que tenga seleccionado el rol de Administrador central y una subsidiaria autorizada puede crear una asignación adicional de un rol no administrativo para su propia cuenta. La operación conserva sus asignaciones existentes y el rol activo de la sesión.

La excepción se limita al alta: continúan bloqueadas la edición y eliminación de asignaciones propias, el cambio de filiales propias y la asignación propia de un rol de administrador. Pertenecer a un rol administrador sin tenerlo seleccionado, o disponer de concesiones de mantenimiento en otro rol, no habilita esta operación. Los duplicados siguen sujetos a la restricción única de usuario y rol.

La autorización se verifica en SQL con identidad, rol activo y pertenencia a la subsidiaria vigentes. La interfaz mantiene las acciones de edición y eliminación propias deshabilitadas según la respuesta del servidor. Las pruebas de esta corrección utilizan identidades y asignaciones sintéticas; no requieren modificar accesos reales.
