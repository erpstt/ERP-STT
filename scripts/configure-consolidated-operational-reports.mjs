// Retired: this entrypoint combined the migration below with a temporary UPDATE
// of a real permission identifier and report checks using an existing session.
// The file alone does not represent that data-dependent permission mutation.
// Fixed component: 20260922040000_consolidated_operational_reports.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía una modificación temporal de permisos y verificaciones con una sesión real. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
