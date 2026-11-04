// Retired: this entrypoint mixed three migrations with data-dependent SQL
// writes, sequence probes and business RPC calls outside those source files.
// Fixed components were 20261027120000_payment_request_line_dimensions.sql,
// 20261027130000_payment_request_approval_routing.sql and
// 20261027140000_payment_request_number_sequence.sql; they are not a full plan.
// A file-only preview would be incomplete; no replacement execution is offered.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:'Este aplicador incluía pruebas con escrituras y operaciones dependientes de datos. Su ejecución y una vista previa parcial están retiradas. Use migraciones revisadas y pruebas aisladas.',
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
