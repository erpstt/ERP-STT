// Retired: this entrypoint mixed the migration below with scheduled-report
// save RPCs, real-session snapshots, an inline run_general_journal_report
// replacement and optional local snapshot export. The file alone is incomplete.
// Fixed component: 20260921200000_scheduled_report_catalog.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía guardado de reportes, reemplazos temporales de funciones y exportación de datos con una sesión real. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
