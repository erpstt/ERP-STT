import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const security=await import('../dist/modules/security-catalogs/security-catalogs.module.js');
const originalFetch=globalThis.fetch;
const originalEnvironment={...process.env};

test.beforeEach(()=>{
  process.env.SUPABASE_URL='https://project.example.test';
  process.env.SUPABASE_ANON_KEY='anon-key';
});
test.afterEach(()=>{
  globalThis.fetch=originalFetch;
  process.env={...originalEnvironment};
});

function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

test('el catálogo usa una fila por usuario y una selección múltiple de subsidiarias',()=>{
  const catalog=security.getSecurityCatalog('user-subsidiaries');
  assert.equal(catalog.primaryKey,'user_id');
  assert.deepEqual(catalog.fields.map(field=>field.key),['user_id','subsidiary_ids']);
  assert.equal(catalog.fields[1].type,'multi-reference');
  assert.equal(catalog.fields[1].reference,'organization/subsidiaries');
});

test('la lista agregada y las opciones completas usan RPC protegidas',async()=>{
  const calls=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input));
    calls.push({url,init});
    assert.equal(init.method,'POST');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer actor');
    if(url.pathname.endsWith('/security_user_subsidiary_assignments'))return response([{user_id:7,subsidiary_ids:[1,2]}]);
    if(url.pathname.endsWith('/security_user_subsidiary_options'))return response([{id:1,name:'Empresa A',legal_name:'Empresa A, S.A.',is_active:true}]);
    throw new Error(`RPC inesperada: ${url.pathname}`);
  };

  const rows=await security.listSecurityRows(security.getSecurityCatalog('user-subsidiaries'),'Bearer actor');
  const options=await security.listUserSubsidiaryOptions('Bearer actor');
  assert.deepEqual(rows,[{user_id:7,subsidiary_ids:[1,2]}]);
  assert.equal(options[0].name,'Empresa A');
  assert.deepEqual(calls.map(call=>call.url.pathname),[
    '/rest/v1/rpc/security_user_subsidiary_assignments',
    '/rest/v1/rpc/security_user_subsidiary_options'
  ]);
});

test('POST y PATCH sincronizan toda la selección en una sola llamada',async()=>{
  const bodies=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input));
    assert.equal(url.pathname,'/rest/v1/rpc/security_sync_user_subsidiaries');
    bodies.push(JSON.parse(String(init.body)));
    return response({user_id:bodies.at(-1).p_user_id,subsidiary_ids:bodies.at(-1).p_subsidiary_ids});
  };
  const catalog=security.getSecurityCatalog('user-subsidiaries');

  await security.createSecurityRow(catalog,'Bearer actor',{user_id:21,subsidiary_ids:[3,'2',3]});
  await security.updateSecurityRow(catalog,'Bearer actor',21,{user_id:21,subsidiary_ids:[4,2]});

  assert.deepEqual(bodies,[
    {p_user_id:21,p_subsidiary_ids:[3,2]},
    {p_user_id:21,p_subsidiary_ids:[4,2]}
  ]);
});

test('la edición no permite sustituir el usuario de la URL desde el cuerpo',async()=>{
  let called=false;
  globalThis.fetch=async()=>{called=true;return response({});};
  await assert.rejects(
    ()=>security.updateSecurityRow(security.getSecurityCatalog('user-subsidiaries'),'Bearer actor',10,{user_id:11,subsidiary_ids:[1]}),
    /no coincide/
  );
  assert.equal(called,false);
});

test('rechaza identificadores inválidos y conserva bloqueada la eliminación individual',async()=>{
  const catalog=security.getSecurityCatalog('user-subsidiaries');
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:0,subsidiary_ids:[1]}),/usuario válido/);
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:true,subsidiary_ids:[1]}),/usuario válido/);
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:1,subsidiary_ids:[]}),/al menos una subsidiaria/);
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:1,subsidiary_ids:null}),/al menos una subsidiaria/);
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:1,subsidiary_ids:[1,'abc']}),/valor inválido/);
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:1,subsidiary_ids:[true]}),/valor inválido/);
  await assert.rejects(()=>security.createSecurityRow(catalog,'Bearer actor',{user_id:1,subsidiary_ids:[{id:1}]}),/valor inválido/);
  assert.throws(()=>security.deleteSecurityRow(catalog,'Bearer actor',1),/empresas marcadas/);
});

test('la ruta HTTP exige edit para POST y view para las opciones',async()=>{
  const source=await readFile(new URL('../src/server.ts',import.meta.url),'utf8');
  assert.match(source,/request\.method==='POST'&&resourceKey==='security:user-subsidiaries'\)\?'edit'/);
  assert.match(source,/user-subsidiaries\/options'[\s\S]{0,500}assertRoleAccess\(authorization,'security:user-subsidiaries','view'\)/);
});
