import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

assert.deepEqual(process.argv.slice(2),[],'Synthetic fixture accepts no arguments');
const marker='SYNTHETIC_PRIVATE_CONTEXT';
const config={url:'https://provider.example.invalid',anonKey:'fake-public'};
const authorization='Bearer synthetic-actor';
const definitions=[
 {name:'account',file:'bank-account.service.ts',resource:'banking:bank-accounts',message:'La cuenta tiene movimientos o saldo.',permission:'No tiene permiso para administrar esta cuenta bancaria.',validation:'Revise los datos de la cuenta. El saldo se modifica mediante procesos contables.',fallback:'No fue posible administrar la cuenta bancaria.',operation:'deleteBankAccount',rpc:'delete_bank_account',payload:{p_bank_account_id:7}},
 {name:'check',file:'bank-check.service.ts',resource:'banking:bank-checks',message:'El egreso no puede modificarse en su estado actual.',permission:'No tiene permiso para operar este egreso bancario.',validation:'Revise los datos del cheque o transferencia.',fallback:'No fue posible procesar el cheque o transferencia.',operation:'deleteBankCheck',rpc:'delete_bank_check_transfer',payload:{p_check_id:7}},
 {name:'fee',file:'bank-fee.service.ts',resource:'banking:bank-fees',message:'El egreso no puede modificarse en su estado actual.',permission:'No tiene permiso para operar este comisión bancaria.',validation:'Revise los datos del comisión bancaria.',fallback:'No fue posible procesar el comisión bancaria.',operation:'deleteBankFee',rpc:'delete_bank_fee',payload:{p_fee_id:7}},
];
for(const definition of definitions){
 const path=new URL('../src/modules/banking-catalogs/'+definition.file,import.meta.url);
 const source=await readFile(path,'utf8');
 const ast=ts.createSourceFile(path.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 // Preserve the actual module and all its wrappers; replace only imports with
 // controlled collaborators. No application module, environment or IO is loaded.
 const transformed=ts.transform(ast,[context=>{
  const visit=node=>{
   if(ts.isImportDeclaration(node))return undefined;
   if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){
    assert.equal(node.arguments.length,1);
    assert.equal(node.arguments[0].text,'../security-catalogs/role-access-matrix.module.js');
    return ts.factory.createCallExpression(ts.factory.createIdentifier('roleAccessModule'),undefined,[]);
   }
   return ts.visitEachChild(node,visit,context);
  };
  return node=>ts.visitNode(node,visit);
 }]);
 const compiled=ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 transformed.dispose();
 function fixture(response,{denied=false}={}){
  const calls=[],guards=[],unexpected=[],exports={};
  const assertRoleAccess=async(...args)=>{guards.push(args);if(denied)throw Object.assign(Error('Synthetic permission denied.'),{status:403});};
  const context=vm.createContext({exports,URL,Error,JSON,Number,String,Object,Array,
   assertRoleAccess,roleAccessModule:async()=>({assertRoleAccess}),getSupabaseConfig:()=>config,
   fetchSupabase:async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,config.url);assert.equal(url.pathname,'/rest/v1/rpc/'+definition.rpc);
    assert.equal(init.method,'POST');assert.equal(init.headers.apikey,config.anonKey);assert.equal(init.headers.Authorization,authorization);
    assert.equal(init.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(init.body),definition.payload);
    calls.push({path:url.pathname});return response;
   },
   fetch(){unexpected.push('fetch');throw Error('No native fetch');},
   console:{log(){unexpected.push('log');},error(){unexpected.push('log');},warn(){unexpected.push('log');}}
  });
  new vm.Script(compiled,{filename:'synthetic-'+definition.name+'.cjs'}).runInContext(context,{timeout:1000});
  return{calls,guards,unexpected,run:(auth=authorization)=>exports[definition.operation](auth,7)};
 }
 function errorIs(status,message){return error=>{assert.equal(error.status,status);assert.equal(error.message,message);for(const value of[error.message,error.stack,JSON.stringify(error)])assert.equal(String(value).includes(marker),false);for(const key of['cause','details','hint','response','payload'])assert.equal(error[key],undefined);return true;};}
 test(definition.name+': 55000 provider message/details/hint never become public, preserving409',async()=>{
  for(const message of[marker,'',null,4,{value:marker}]){
   const f=fixture(Response.json({code:'55000',message,details:marker,hint:marker},{status:400}));
   await assert.rejects(f.run(),errorIs(409,definition.message));
   assert.deepEqual(f.guards,[[authorization,definition.resource,'delete']]);assert.equal(f.calls.length,1);assert.deepEqual(f.unexpected,[]);
  }
 });
 test(definition.name+': authentication/permission precede provider and existing error precedence remains',async()=>{
  const denied=fixture(null,{denied:true});await assert.rejects(denied.run(),error=>error.status===403);assert.equal(denied.calls.length,0);
  const anonymous=fixture(null);await assert.rejects(anonymous.run(''),errorIs(401,'Debe iniciar sesión.'));assert.equal(anonymous.guards.length,0);assert.equal(anonymous.calls.length,0);
  for(const[http,code,status,message]of[[401,'55000',401,'La sesión no es válida.'],[403,'55000',403,definition.permission],[400,'42501',403,definition.permission],[400,'22023',400,definition.validation],[400,'22P02',400,definition.validation],[500,undefined,undefined,definition.fallback],[400,55000,undefined,definition.fallback]]){
   const f=fixture(Response.json({code,message:marker},{status:http}));await assert.rejects(f.run(),errorIs(status,message));assert.equal(f.calls.length,1);
  }
 });
 test(definition.name+': successful JSON/null responses retain payload and credentials',async()=>{
  for(const expected of[{synthetic:true},[{synthetic:true}],null]){
   const f=fixture(expected===null?new Response(null,{status:204}):Response.json(expected));assert.deepEqual(await f.run(),expected);assert.equal(f.calls.length,1);assert.deepEqual(f.unexpected,[]);
  }
 });
}
