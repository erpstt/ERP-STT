import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
test('financial catalog HTTP guards deny unrelated actions before PostgREST and preserve user credentials',{timeout:60000},async t=>{
 const calls=[];
 const upstream=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer p74-','')||'denied';const resource=role.startsWith('bank')?'banking:bank-accounts':'accounting:accounting-books';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:false,grants:role==='denied'?[]:[{resourceKey:resource,canView:true,canCreate:role==='book-creator',canEdit:role==='book-editor',canDelete:role==='book-deleter'}]}}));
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,method:req.method,auth:req.headers.authorization,key:req.headers.apikey,body:Buffer.concat(chunks).toString()});res.end(JSON.stringify([{accounting_book_id:1,subsidiary_id:1,book_name:'Synthetic',bank_account_id:1,account_number:'SYNTHETIC'}]));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true'},stdio:'ignore'});t.after(()=>child.kill());const base=`http://127.0.0.1:${port}`;
 let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const send=async(role,path,method='GET',body={})=>{const r=await fetch(base+path,{method,headers:{Authorization:'Bearer p74-'+role,'X-Device-Token':'synthetic-p74-device-token-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});await r.arrayBuffer();return r.status;};
 const book='/api/accounting/accounting-books',bank='/api/banking/bank-accounts',payload={book_name:'Synthetic',subsidiary_id:1,base_currency_id:1,is_primary:false,is_active:true};
 for(const role of ['denied','bank-reader'])for(const[method,path]of [['GET',book],['POST',book],['PATCH',book+'/1'],['DELETE',book+'/1']]){const before=calls.length;assert.equal(await send(role,path,method,payload),403,role+' '+method);assert.equal(calls.length,before);}
 for(const role of ['denied','book-reader']){const before=calls.length;assert.equal(await send(role,bank),403);assert.equal(calls.length,before);}
 assert.equal(await send('bank-reader',bank),200);assert.equal(await send('book-reader',book),200);
 for(const[role,allowed]of [['book-reader','none'],['book-creator','POST'],['book-editor','PATCH'],['book-deleter','DELETE']])for(const method of ['POST','PATCH','DELETE']){const before=calls.length;const status=await send(role,book+(method==='POST'?'':'/1'),method,payload);assert.equal(status,method===allowed?(method==='POST'?201:200):403,role+' '+method);if(method!==allowed)assert.equal(calls.length,before);}
 assert.ok(calls.length>=5);assert.ok(calls.every(c=>c.key==='synthetic-public'&&c.auth.startsWith('Bearer p74-')));assert.ok(calls.every(c=>/^\/rest\/v1\/(accounting_books|bank_account)\?/.test(c.path)||c.path==='/rest/v1/accounting_books'));
});
