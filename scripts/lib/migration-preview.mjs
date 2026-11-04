import {readFile,realpath,stat,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultRoot=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
const migrationName=/^\d{14}_[a-z0-9_-]+\.sql$/;
const maximumBytes=10*1024*1024;

export class MigrationPreviewError extends Error{
  constructor(code,message){super(message);this.name='MigrationPreviewError';this.code=code;}
}
function blocked(code,message){throw new MigrationPreviewError(code,message);}
function argumentsFor(config,args){
  if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))
    blocked('INVALID_ARGUMENTS','Argumentos de vista previa inválidos.');
  // These legacy installers must not replay historical SQL, even with opt-in.
  if(args.some(value=>value==='--apply'||value.startsWith('--apply=')))
    blocked('APPLY_DISABLED','La aplicación está deshabilitada en este script heredado. Use el flujo de migraciones con historial y revisión del SQL.');
  const seen=new Set(),files=[];
  for(const value of args){
    const flag=value==='-h'?'--help':value;
    if(flag==='--help'||flag==='--dry-run'){
      if(seen.has(flag))blocked('INVALID_ARGUMENTS','No repita opciones de vista previa.');
      seen.add(flag);
    }else if(value.startsWith('-'))blocked('INVALID_ARGUMENTS','Opción no admitida. Solo se permite vista previa; no se aceptan destinos ni credenciales.');
    else files.push(value);
  }
  if(files.length>1||(!config.allowFileArgument&&files.length))
    blocked('INVALID_ARGUMENTS','Cantidad de archivos no admitida para esta entrada.');
  if(seen.has('--help'))return{help:true,files:[]};
  const selected=files.length?files:(config.defaultFiles??[]);
  if(!Array.isArray(selected)||selected.some(value=>typeof value!=='string'))
    blocked('INVALID_ARGUMENTS','La lista de migraciones de vista previa no es válida.');
  if(config.requireFile&&!selected.length)
    blocked('MIGRATION_REQUIRED','Indique un archivo SQL del directorio de migraciones para ver su huella.');
  return{help:false,files:selected};
}
async function filePreview(input,root,cwd){
  // Reject control characters and traversal before touching the filesystem.
  if(/[\x00-\x1f\x7f]/.test(input)||input.split(/[\\/]/).includes('..'))
    blocked('INVALID_MIGRATION_PATH','Ruta de migración no permitida.');
  const name=basename(input);
  if(!migrationName.test(name))blocked('INVALID_MIGRATION_PATH','El archivo debe tener el nombre de una migración SQL del repositorio.');
  const candidate=input===name?join(root,name):resolve(cwd,input);
  if(relative(root,candidate)!==name)blocked('INVALID_MIGRATION_PATH','El archivo debe pertenecer directamente al directorio de migraciones.');
  let canonical,metadata,bytes;
  // Do not follow a file link (including a Windows junction) before checking it.
  try{metadata=await lstat(candidate);}
  catch{blocked('MIGRATION_UNAVAILABLE','No se pudo leer la migración solicitada.');}
  if(metadata.isSymbolicLink())blocked('INVALID_MIGRATION_PATH','No se permiten enlaces de archivos en la vista previa.');
  try{canonical=await realpath(candidate);}
  catch{blocked('MIGRATION_UNAVAILABLE','No se pudo leer la migración solicitada.');}
  if(relative(root,canonical)!==name)blocked('INVALID_MIGRATION_PATH','No se permiten enlaces que cambien la migración o salgan de su directorio.');
  try{metadata=await stat(canonical);}
  catch{blocked('MIGRATION_UNAVAILABLE','No se pudo leer la migración solicitada.');}
  if(!metadata.isFile()||metadata.size>maximumBytes)
    blocked('INVALID_MIGRATION_PATH','La migración debe ser un archivo regular dentro del límite de vista previa.');
  try{bytes=await readFile(canonical);}
  catch{blocked('MIGRATION_UNAVAILABLE','No se pudo leer la migración solicitada.');}
  if(bytes.length>maximumBytes)blocked('INVALID_MIGRATION_PATH','La migración supera el límite de vista previa.');
  return{name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}

/** Read-only manifest: never loads environment files, imports a DB client or opens a connection. */
export async function createMigrationPreview(config,args=[],options={}){
  const parsed=argumentsFor(config,args);
  const result={mode:parsed.help?'help':'preview',entrypoint:config.entrypoint,
    appliesSql:false,loadsEnvironment:false,opensConnections:false,executionSupported:false,files:[],
    usage:`node ${config.entrypoint}${config.allowFileArgument?(config.requireFile?' <archivo.sql>':' [archivo.sql]'):''} [--dry-run] [--help]`,
    note:'Esta entrada solo calcula archivos y huellas. Para aplicar, use migraciones con historial y revisión del SQL.'};
  if(parsed.help)return result;
  let root;
  try{root=await realpath(options.migrationsRoot??defaultRoot);}
  catch{blocked('MIGRATION_UNAVAILABLE','No se pudo acceder al directorio de migraciones.');}
  for(const file of parsed.files)result.files.push(await filePreview(file,root,options.cwd??process.cwd()));
  return result;
}

export async function runMigrationPreview(config,args=process.argv.slice(2)){
  try{const plan=await createMigrationPreview(config,args);console.log(JSON.stringify(plan));return plan;}
  catch(error){
    const known=error instanceof MigrationPreviewError;
    console.error(JSON.stringify({mode:'blocked',code:known?error.code:'MIGRATION_UNAVAILABLE',
      message:known?error.message:'No fue posible preparar la vista previa.',appliesSql:false,loadsEnvironment:false,opensConnections:false}));
    process.exitCode=2;return null;
  }
}

export function assertIsolatedTestArgs(args=process.argv.slice(2)){
  if(!Array.isArray(args)||args.length)
    blocked('INVALID_ARGUMENTS','Esta prueba solo admite fixtures aisladas, sin destino, credenciales ni opciones de aplicación.');
}
