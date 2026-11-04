// Retired: this entrypoint combined the fixed migration below with real-session
// budget creation/approval and inline dynamic replacements of budget_actuals
// and budget_commitments. These temporary operations are not a file-only plan.
// Fixed component: 20260921170000_general_company_budget.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía escrituras de presupuestos y reemplazos temporales de funciones mediante SQL dinámico. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
