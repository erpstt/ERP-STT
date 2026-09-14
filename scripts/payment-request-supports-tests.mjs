import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const apply=process.argv.includes('--apply'),q=(sql,params)=>db.query(sql,params);
async function rejects(sql,params,pattern){await q('savepoint expected_error');try{await assert.rejects(q(sql,params),pattern)}finally{await q('rollback to savepoint expected_error')}}
try{
 await db.connect();await q('begin');
 await q(await readFile(new URL('../supabase/migrations/20260913150000_payment_request_supports.sql',import.meta.url),'utf8'));
 const fixture=(await q(`select s.id,s.estado,s.id_solicitante,s.id_subsidiaria,u.email,a.id auth_id,ucs.session_id
  from solicitudes_pago s join users u on u.user_id=s.id_solicitante join auth.users a on lower(a.email)=lower(u.email)
  join user_company_sessions ucs on ucs.user_id=u.user_id and ucs.subsidiary_id=s.id_subsidiaria
  order by s.id desc limit 1`)).rows[0];
 assert.ok(fixture,'Se requiere una solicitud y sesión existentes para la prueba reversible.');
 await q(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:fixture.auth_id,email:fixture.email,role:'authenticated',session_id:fixture.session_id})]);
 await q(`select set_config('request.headers',$1,true)`,[JSON.stringify({'x-audit-execution-context-id':'payment-request-support-test'})]);
 await q('savepoint fixtures');await q(`update solicitudes_pago set estado='BORRADOR' where id=$1`,[fixture.id]);
 const link=(await q(`select pr_support_save($1) result`,[{id:fixture.id,type:'Enlace',displayName:'Orden aprobada',url:'https://example.com/respaldo'}])).rows[0].result;
 const fileData='data:application/pdf;base64,JVBERi0xLjQ=';
 const file=(await q(`select pr_support_save($1) result`,[{id:fixture.id,type:'Archivo',displayName:'Comprobante.pdf',fileName:'comprobante.pdf',mimeType:'application/pdf',fileSize:13,fileData}])).rows[0].result;
 const supports=(await q(`select pr_supports($1) result`,[{id:fixture.id}])).rows[0].result;
 assert.equal(supports.length,2);assert.deepEqual(supports.map(x=>x.type),['Enlace','Archivo']);
 assert.equal(supports[1].fileData,fileData);assert.equal(supports[0].createdByEmail,fixture.email);
 assert.equal(Object.hasOwn(supports[0],'created_by_id'),false);
 await rejects(`select pr_support_save($1)`,[{id:fixture.id,type:'Enlace',displayName:'Inválido',url:'javascript:alert(1)'}],/enlace válido/);
 await rejects(`select pr_support_save($1)`,[{id:fixture.id,type:'Archivo',displayName:'Grande',fileName:'x.pdf',mimeType:'application/pdf',fileSize:5242881,fileData}],/supera 5 MB/);
 await q(`select pr_support_delete($1)`,[{id:fixture.id,supportId:link.id}]);
 assert.equal((await q(`select jsonb_array_length(pr_supports($1)) count`,[{id:fixture.id}])).rows[0].count,1);
 const audit=(await q(`select action from audit_log where entity_type='solicitudes_pago_respaldos' and execution_context_id='payment-request-support-test' order by log_id`)).rows;
 assert.deepEqual(audit.map(x=>x.action),['CREACION','CREACION','ELIMINACION']);
 await q(`update solicitudes_pago set estado='APROBADO' where id=$1`,[fixture.id]);
 await rejects(`select pr_support_save($1)`,[{id:fixture.id,type:'Enlace',displayName:'Bloqueado',url:'https://example.com'}],/No puede modificar/);
 await rejects(`select pr_support_delete($1)`,[{id:fixture.id,supportId:file.id}],/No puede eliminar/);
 await q('rollback to savepoint fixtures');
 assert.equal((await q(`select count(*)::int count from solicitudes_pago_respaldos where id_solicitud=$1`,[fixture.id])).rows[0].count,0);
 await q(apply?'commit':'rollback');
 console.log(JSON.stringify({passed:true,applied:apply,fileAndLink:true,maxSizeBytes:5242880,workflowLock:true,auditTrail:true,fixturesRolledBack:true}));
}catch(error){await q('rollback').catch(()=>{});console.error(error.message);process.exitCode=1}finally{await db.end()}
