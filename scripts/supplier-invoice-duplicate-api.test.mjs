import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {saveSupplierInvoice} from '../dist/modules/purchasing-catalogs/supplier-invoice.service.js';
import {supplierInvoiceRpc,SupplierInvoiceDuplicateError} from '../dist/modules/purchasing-catalogs/supplier-invoice-security.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-invoice-duplicate',origin='https://invoice-duplicate.example.invalid';
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const duplicate={code:'23505',message:'duplicate key value violates unique constraint "supplier_invoice_invoice_number_supplier_id_key"',details:'PRIVATE supplier and invoice identifiers',hint:'PRIVATE hint'};
const safeMessage='El número de factura ya se encuentra registrado para este proveedor. Revise el número antes de guardar.';
const payload={invoice_number:'SYN-DUPLICATE',supplier_id:10,invoice_type:'Factura Expense',lines:[]};
let calls;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY='synthetic-public';calls=[];invalidateRoleAccessCaches();
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'purchasing:supplier-invoices',canView:true,canCreate:true,canEdit:true}]});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(duplicate,{status:409});};
});
afterEach(()=>{globalThis.fetch=original.fetch;invalidateRoleAccessCaches();});
after(()=>{for(const [name,key]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[key]===undefined)delete process.env[name];else process.env[name]=original[key];});

test('create and edit recognize only the published supplier/number collision and keep caller identity and input intact',async()=>{
 for(const id of[null,31]){
  const before=structuredClone(payload);
  await assert.rejects(saveSupplierInvoice(auth,payload,id),error=>error instanceof SupplierInvoiceDuplicateError&&error.status===409&&error.code==='SUPPLIER_INVOICE_DUPLICATE'&&error.field==='invoice_number'&&error.message===safeMessage);
  assert.deepEqual(payload,before);const call=calls.at(-1),headers=new Headers(call.init.headers);
  assert.equal(call.url,origin+'/rest/v1/rpc/save_supplier_invoice');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),'synthetic-public');assert.deepEqual(JSON.parse(call.init.body),{payload:before,target_invoice_id:id});
 }
 assert.equal(calls.length,2);
});

test('unrelated constraints, protected records and denied access keep generic safe errors without false duplicate classification',async()=>{
 const variants=[
  [409,{...duplicate,message:'duplicate key value violates unique constraint "supplier_invoice_one_per_purchase_receipt_idx"'},409],
  [409,{...duplicate,message:'prefix '+duplicate.message},409],
  [409,{...duplicate,message:duplicate.message+' PRIVATE extra'},409],
  [409,{code:'23505',details:duplicate.message},409],
  [409,{...duplicate,code:'55000'},409],
  [409,{...duplicate,code:'PT422'},409],
  [403,duplicate,403],[401,duplicate,401],
 ];
 for(const[status,result,expected]of variants){
  globalThis.fetch=async()=>Response.json(result,{status});
  await assert.rejects(saveSupplierInvoice(auth,payload),error=>!(error instanceof SupplierInvoiceDuplicateError)&&error.status===expected&&!/PRIVATE|supplier_invoice|ya se encuentra registrado/.test(error.message)&&!error.code);
 }
 globalThis.fetch=async()=>Response.json(duplicate,{status:409});
 await assert.rejects(supplierInvoiceRpc(auth,'supplier_invoice_form_options',{},'view'),error=>!(error instanceof SupplierInvoiceDuplicateError)&&error.status===409);
});

test('authorization still runs before duplicate detection and successful budget and invoice responses remain unchanged',async()=>{
 await assert.rejects(saveSupplierInvoice('',payload),error=>error.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});await assert.rejects(saveSupplierInvoice(auth,payload),error=>error.status===403);assert.equal(calls.length,0);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'purchasing:supplier-invoices',canView:true,canCreate:true}]});
 for(const result of[{invoiceId:31,total:113},{budgetPending:true,budgetRequestId:32}]){globalThis.fetch=async()=>Response.json(result);assert.deepEqual(await saveSupplierInvoice(auth,payload),result);}
});

test('POST and PUT expose the typed safe alert over HTTP while other conflicts and permission errors retain their original contract',{timeout:30000},async t=>{
 globalThis.fetch=original.fetch;
 const writes=[],stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:false,grants:[{resourceKey:'purchasing:supplier-invoices',canView:true,canCreate:true,canEdit:true,canDelete:false}]}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString()||'{}');writes.push({path:req.url,auth:req.headers.authorization,input});
  const mode=input.payload?.invoice_number;
  if(mode==='OK'){res.end(JSON.stringify({invoiceId:31,total:113}));return;}
  const result=mode==='RECEIPT'?{...duplicate,message:'duplicate key value violates unique constraint "supplier_invoice_one_per_purchase_receipt_idx"'}:mode==='DENIED'?{...duplicate,code:'42501'}:duplicate;
  res.writeHead(mode==='DENIED'?403:409);res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-server',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const server=`http://127.0.0.1:${port}`;let ready=false;
 for(let n=0;n<100;n++){try{if((await original.fetch(server+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready,'Synthetic API started');
 for(const[method,path]of[['POST','/api/purchasing/supplier-invoice-entry'],['PUT','/api/purchasing/supplier-invoice-entry/31']]){
  for(const number of['SYN-DUPLICATE','RECEIPT','DENIED','OK']){
   const response=await original.fetch(server+path,{method,headers:{Authorization:auth,'X-Device-Token':'synthetic-invoice-duplicate-device','Content-Type':'application/json'},body:JSON.stringify({...payload,invoice_number:number})});
   const result=await response.json();assert.equal(response.status,number==='DENIED'?403:number==='OK'?(method==='POST'?201:200):409,JSON.stringify({method,number,result,writes:writes.length}));
   if(number==='SYN-DUPLICATE')assert.deepEqual(result,{error:{message:safeMessage,code:'SUPPLIER_INVOICE_DUPLICATE',field:'invoice_number'}});
   else if(number==='OK')assert.equal(result.invoiceId,31);
   else{assert.equal(result.code,undefined);assert.equal(result.field,undefined);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|supplier_invoice|ya se encuentra registrado/);}
  }
 }
 assert.equal(writes.length,8);assert.ok(writes.every(write=>write.path==='/rest/v1/rpc/save_supplier_invoice'&&write.auth===auth));
});
