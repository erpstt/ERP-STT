// Retired: this ad-hoc entrypoint wrote a specific existing proposal/asset
// allocation and proposal status, with live financial snapshots and RPCs.
// There is no migration manifest. Historical identifiers and business values
// are intentionally not repeated; no existing record is read or changed.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este operador realizaba una vinculación histórica específica y cambios de asignación y estado dependientes de datos. Su ejecución y una vista previa parcial están retiradas. Use un procedimiento revisado y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
