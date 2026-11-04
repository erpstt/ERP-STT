// Retired: this entrypoint combined the fixed migration below with real-session
// budget RPCs that created, edited, approved and deleted budget records. Their
// temporary writes and assertions are not represented by the SQL file alone.
// Fixed component: 20260921180000_budget_delete_draft.sql.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este configurador incluía pruebas que creaban, editaban, aprobaban y eliminaban presupuestos dependientes de datos. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
