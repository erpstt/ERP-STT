// Retired: this entrypoint combined two migrations with a temporary UPDATE of
// an existing journal, scenario-save RPCs using a real session and optional
// source/options snapshot output. A file-only preview would be incomplete.
// Fixed components, in order: 20260922020000_income_forecast.sql and
// 20260922030000_scope_income_forecast.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía cambios temporales de un asiento, guardado de escenarios y exportación de datos de origen. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
