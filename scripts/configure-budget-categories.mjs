// Retired: this entrypoint combined the migration below with a real selected
// session and business RPCs that created, edited, approved and copied budgets.
// Temporary fixtures rolled back, but the file alone is not the full operation.
// Fixed component: 20260921160000_budget_result_categories.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:'Este operador incluía pruebas que creaban, editaban, aprobaban y copiaban presupuestos dependientes de datos. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.',
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
