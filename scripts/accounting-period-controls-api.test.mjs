import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {createServer} from 'node:http';
import {primeRoleAccessCache} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {organizationMasterRpc} from '../dist/modules/organization-catalogs/organization-master.service.js';

const auth='Bearer synthetic-fiscal-controls';
let response={status:400,code:'22023',message:'Synthetic'},calls=[];
const old={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}'),authorization:req.headers.authorization,key:req.headers.apikey});res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify({code:response.code,message:response.message,details:'PRIVATE DETAIL MUST NOT LEAK'}));});
before(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.SUPABASE_URL=`http://127.0.0.1:${server.address().port}`;process.env.SUPABASE_ANON_KEY='synthetic-public-key';
 await primeRoleAccessCache(auth,{isAdmin:false,grants:['accounting-periods','fiscal-years','departments'].map(k=>({resourceKey:'organization:'+k,canView:true,canCreate:true,canEdit:true,canDelete:true}))});
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const[k,v]of Object.entries({SUPABASE_URL:old.url,SUPABASE_ANON_KEY:old.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;});
const edit=(catalog='accounting-periods')=>organizationMasterRpc(auth,catalog,'edit',{_revision:'synthetic-revision',ap_closed:true},71);
async function rejectsWith(fn,status,message){await assert.rejects(fn,e=>e.status===status&&e.message===message&&!e.message.includes('PRIVATE'));}

test('missing exact closure permission returns fixed clear text for current and historical encoded literals',async()=>{
 const message='Requiere permiso específico de cierre fiscal.';
 for(const variant of[message,Buffer.from(message,'utf8').toString('latin1')]){response={status:403,code:'42501',message:variant};await rejectsWith(edit,403,'El rol activo necesita el permiso específico para cerrar y reabrir períodos fiscales.');assert.deepEqual(calls.at(-1).payload,{p_catalog:'accounting-periods',p_payload:{_revision:'synthetic-revision',ap_closed:true},p_id:71});assert.equal(calls.at(-1).key,'synthetic-public-key');assert.equal(calls.at(-1).authorization,auth);}
});
test('fiscal sequencing, fiscal-year reopening and referenced-period errors retain status and fixed actionable text',async()=>{
 for(const[code,message,status,expected]of[
  ['22023','Respete la secuencia de cierre AP, AR y GL.',400,'Bloquee Cuentas por Pagar y Cuentas por Cobrar antes del Mayor; bloquee los tres antes de cerrar el período.'],
  ['55000','Reabra el año antes de modificar el cierre del período.',409,'Reabra el año fiscal antes de cambiar el cierre del período.'],
  ['55000','El período utilizado conserva fechas, año y estado activo.',409,'Un período con referencias conserva sus fechas, año y estado activo.']
 ]){response={status:400,code,message};await rejectsWith(edit,status,expected);response.message=Buffer.from(message,'utf8').toString('latin1');await rejectsWith(edit,status,expected);}
});
test('unknown errors, other catalogs, other SQLSTATE and transport authorization never reuse fiscal business guidance',async()=>{
 response={status:400,code:'55000',message:'PRIVATE SQL INTERNAL'};await rejectsWith(edit,409,'El catálogo cambió o tiene dependencias. Consúltelo nuevamente.');
 response={status:400,code:'22023',message:'Respete la secuencia de cierre AP, AR y GL.'};await rejectsWith(()=>edit('departments'),400,'Revise nombre, tipo, jerarquía y asignaciones.');
 response={status:403,code:'22023',message:'Respete la secuencia de cierre AP, AR y GL.'};await rejectsWith(edit,403,'Catálogo, filiales o referencias no autorizados.');
 response={status:400,code:'23505',message:'Reabra el año antes de modificar el cierre del período.'};await rejectsWith(edit,409,'El catálogo cambió o tiene dependencias. Consúltelo nuevamente.');
 response={status:500,code:'XX000',message:'PRIVATE SQL INTERNAL'};await rejectsWith(edit,500,'No fue posible procesar el catálogo.');
});
test('authentication and exact catalog EDIT gates still reject before any RPC; 401 takes priority over a fiscal SQLSTATE',async()=>{
 const before=calls.length;await assert.rejects(()=>organizationMasterRpc('','accounting-periods','edit',{},71),e=>e.status===401);await primeRoleAccessCache('Bearer synthetic-fiscal-readonly-admin',{isAdmin:true,grants:[]});await assert.rejects(()=>organizationMasterRpc('Bearer synthetic-fiscal-readonly-admin','accounting-periods','edit',{},71),e=>e.status===403);assert.equal(calls.length,before);
 response={status:401,code:'55000',message:'Reabra el año antes de modificar el cierre del período.'};await rejectsWith(edit,401,'No fue posible procesar el catálogo.');
});
