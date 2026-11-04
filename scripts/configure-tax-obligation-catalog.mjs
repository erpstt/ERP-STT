// Retired: this entrypoint mixed the migration below with real-session
// obligation/template/event mutations and an email-outbox enqueue test.
// The file alone does not represent those additional data-dependent writes.
// Fixed component: 20260928090000_tax_obligation_catalog_and_templates.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía cambios de obligaciones, plantillas, eventos y encolado de notificaciones con una sesión real. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
