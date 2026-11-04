// Retired: this entrypoint mixed the migration below with schedule writes,
// job scheduling/claim/send/finish state RPCs and an inline run_aging_report
// replacement under a real session. The file alone omits these operations.
// Fixed component: 20260921190000_scheduled_reports.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía cambios de programación, procesamiento de trabajos y reemplazos temporales de funciones. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
