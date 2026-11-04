// Retired one-off installer: it contained inline DDL against a fixed project.
// Do not read credentials or connect, including when an apply/help flag is given.
process.stderr.write(JSON.stringify({
  mode:'blocked',code:'OPERATOR_RETIRED',
  message:'Este instalador de marca fue retirado. Use una migración revisada con historial para cualquier cambio de esquema.',
  appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false
})+'\n');
process.exitCode=2;
