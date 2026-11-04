import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {expenseCatalogs,listExpenseRows,createExpenseRow,updateExpenseRow,deleteExpenseRow} from '../dist/modules/expense-catalogs/expense-catalogs.module.js';
import {treasuryCatalogs,listTreasuryRows,createTreasuryRow,updateTreasuryRow,deleteTreasuryRow} from '../dist/modules/treasury-catalogs/treasury-catalogs.module.js';
const groups=[{root:'expenses',catalogs:expenseCatalogs,list:listExpenseRows,create:createExpenseRow,update:updateExpenseRow,remove:deleteExpenseRow},{root:'treasury',catalogs:treasuryCatalogs,list:listTreasuryRows,create:createTreasuryRow,update:updateTreasuryRow,remove:deleteTreasuryRow}];
const input=c=>Object.fromEntries(c.fields.map(f=>[f.key,f.key==='to_cashbox_id'?3:f.type==='number'?1:f.type==='boolean'?false:f.type==='date'?'2026-11-03':'Synthetic']));
test('direct services deny before IO and global type maintenance is administrative',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});const auth='Bearer p76-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const g of groups)for(const c of g.catalogs){for(const fn of [()=>g.list(c,auth),()=>g.create(c,auth,{}),()=>g.update(c,auth,1,{}),()=>g.remove(c,auth,1)])await assert.rejects(fn(),e=>e.status===403);await assert.rejects(g.list(c,''),e=>e.status===401);}
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'expenses:expense-types',canView:true,canCreate:true}]});await assert.rejects(createExpenseRow(expenseCatalogs[0],auth,input(expenseCatalogs[0])),e=>e.status===403);assert.equal(calls,0);
});
test('eleven HTTP catalogs enforce action/resource matrix and return safe SQL denials',{timeout:90000},async t=>{
 let resource='expenses:expenses';const calls=[];
 const upstream=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer p76-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:role==='denied'?[]:[{resourceKey:role==='unrelated'?'inventory:products':resource,canView:true,canCreate:role==='creator',canEdit:role==='editor',canDelete:role==='deleter'}]}}));
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,method:req.method,key:req.headers.apikey,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});if(role==='sql-denied'){res.writeHead(403);return res.end(JSON.stringify({code:'42501',message:'PRIVATE_SQL_DETAILS'}));}if(req.method==='DELETE'){res.writeHead(204);return res.end();}res.end(JSON.stringify([{synthetic:true}]));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:['ignore','pipe','pipe']});let diagnostic='';child.stdout.on('data',c=>diagnostic+=c);child.stderr.on('data',c=>diagnostic+=c);t.after(()=>child.kill());const base=`http://127.0.0.1:${port}`;let ready=false,lastHealth;for(let n=0;n<100;n++){try{const h=await fetch(base+'/api/health');lastHealth='status='+h.status;if(h.ok){ready=true;break;}}catch(e){lastHealth=e.message+':'+e.cause?.code;}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,diagnostic+lastHealth);
 for(const g of groups)for(const c of g.catalogs){resource=g.root+':'+c.slug;for(const role of ['denied','unrelated','reader','creator','editor','deleter','admin','sql-denied'])for(const method of ['GET','POST','PATCH','DELETE']){
  const before=calls.length,path='/api/'+g.root+'/'+c.slug+(['PATCH','DELETE'].includes(method)?'/1':'');const r=await fetch(base+path,{method,headers:{Authorization:'Bearer p76-'+role,'X-Device-Token':'synthetic-p76-device-token-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(input(c))})});const body=await r.text();
  const allowed=role==='admin'||!['denied','unrelated'].includes(role)&&(method==='GET'||method==={creator:'POST',editor:'PATCH',deleter:'DELETE'}[role])&&(c.slug!=='expense-types'||method==='GET');const expected=allowed?(role==='sql-denied'?403:method==='POST'?201:200):403;
  assert.equal(r.status,expected,[resource,role,method,body].join(' '));assert.equal(calls.length,before+Number(allowed));assert.ok(!body.includes('PRIVATE_SQL_DETAILS'));
 }}
 assert.ok(calls.length>40);assert.ok(calls.every(c=>c.key==='synthetic-public'&&c.auth.startsWith('Bearer p76-')));assert.ok(calls.every(c=>!c.path.includes('/rpc/')));
});
