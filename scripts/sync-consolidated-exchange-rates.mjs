// Retired: this standalone CLI called the mutating sync_consolidated_exchange_rates
// RPC and queried live consolidated_exchange_rates aggregates/rules without
// a fixed SQL file manifest. The RPC, services and scheduled jobs are unchanged.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este operador ejecutaba una sincronización de tasas y verificaciones dependientes de datos sin manifiesto SQL fijo. Su ejecución y una vista previa parcial están retiradas. Use un flujo operativo revisado y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
