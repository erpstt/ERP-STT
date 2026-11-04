// Retired: this ad-hoc importer read a caller-supplied XLSX and committed
// UPSERTs into public.permissions through DATABASE_URL. Its contents were
// variable input, not a fixed reviewed SQL manifest. No workbook is opened.
// No replacement execution or incomplete preview is offered by this entrypoint.
process.stderr.write(JSON.stringify({
 mode:'blocked',code:'OPERATOR_RETIRED',
 message:"Este importador realizaba cambios de permisos a partir de un XLSX indicado por el usuario y no tiene un manifiesto SQL fijo. Su ejecución y una vista previa parcial están retiradas. Use un flujo de importación revisado y pruebas aisladas.",
 appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
