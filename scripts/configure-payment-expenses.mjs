// Retired: this entrypoint combined the migration below with inline account-group,
// account and subsidiary-assignment INSERTs outside the test savepoint, plus
// pr_save calls using a real session. The migration alone omits those writes.
// Fixed component: 20260921140000_payment_request_selected_expenses.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía inserciones de catálogo y asignaciones, además de pruebas que guardaban solicitudes de pago. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
