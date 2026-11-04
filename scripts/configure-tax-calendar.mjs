// Retired: this entrypoint mixed the migration below with event/document
// metadata writes, existing event/outbox state updates, worker-state RPCs
// and a temporary membership deletion using a real session.
// Fixed component: 20260927090000_tax_calendar.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía cambios de eventos, documentos, membresías y colas de notificación con una sesión real. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
