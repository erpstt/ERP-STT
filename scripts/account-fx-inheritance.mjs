// Retired: the default branch ran data-dependent UPDATE assertions on real
// account_group/chart_accounts in addition to the migration below. Although
// those assertions rolled back, a file-only preview would omit those writes.
// Fixed component: 20260909120000_account_fx_inheritance.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:'Este operador incluía pruebas con escrituras en cuentas y grupos dependientes de datos. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.',
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
