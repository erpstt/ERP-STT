import assert from 'node:assert/strict';import {test} from 'node:test';
import {importSupplierInvoices} from '../dist/modules/purchasing-catalogs/supplier-invoice-bulk.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
test('bulk calls preserve caller authorization, enforce create permissions and bound the request',async t=>{
 const fetchBefore=globalThis.fetch,env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_ANON_KEY:process.env.SUPABASE_ANON_KEY};t.after(()=>{globalThis.fetch=fetchBefore;invalidateRoleAccessCaches();for(const[k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;});process.env.SUPABASE_URL='https://synthetic.example.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';
 const input={action:'VALIDATE',rows:[{Factura:'TEST'}],subsidiaryId:1},auth='Bearer bulk-create',calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),headers:new Headers(init.headers),body:JSON.parse(init.body)});return Response.json({valid:true,invoices:[]});};
 await assert.rejects(importSupplierInvoices('',input),e=>e.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'purchasing:supplier-invoices',canView:true,canCreate:false,canEdit:true,canDelete:false}]});await assert.rejects(importSupplierInvoices(auth,input),e=>e.status===403);assert.equal(calls.length,0);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'purchasing:supplier-invoices',canView:true,canCreate:true,canEdit:false,canDelete:false}]});await importSupplierInvoices(auth,input);assert.equal(calls.length,1);assert.equal(calls[0].headers.get('authorization'),auth);assert.equal(calls[0].headers.get('apikey'),'synthetic-public');assert.deepEqual(calls[0].body,{p_action:'VALIDATE',p_rows:input.rows,p_subsidiary_id:1,p_request_id:null});
 for(const bad of [{...input,rows:Array(501).fill({})},{...input,subsidiaryId:'1'},{...input,action:'IMPORT',requestId:'invalid'}])await assert.rejects(importSupplierInvoices(auth,bad),e=>e.status===400);assert.equal(calls.length,1);
});
