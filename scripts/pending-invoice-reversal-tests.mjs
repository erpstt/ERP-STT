import pg from 'pg';
import { readFile } from 'node:fs/promises';
process.loadEnvFile?.('.env');
const reference=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${reference}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();
try{
 await db.query('begin');
 await db.query(await readFile(new URL('../supabase/migrations/20260914090000_pending_invoice_reversals.sql',import.meta.url),'utf8'));
 if(process.argv.includes('--apply')){await db.query('commit');console.log(JSON.stringify({applied:true,testDataCreated:false}));await db.end();process.exit(0)}
 const context=(await db.query(`select u.email,au.id auth_id,s.session_id,s.subsidiary_id,j.journal_id,j.pending_balance_local
  from user_company_sessions s join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)join journal j on j.subsidiary_id=s.subsidiary_id
  where(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')and j.status='CONTABILIZADO'and j.pending_balance_local>0
  and exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=u.user_id and p.code='accounting:journal:reverse')
  order by s.selected_at desc,j.journal_id limit 1`)).rows[0];
 if(!context)throw Error('No existe un ASI_PEN disponible con usuario autorizado para la prueba.');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:context.auth_id,email:context.email,session_id:context.session_id,role:'authenticated'})]);
 const date=(await db.query("select start_date from fiscal_periods where subsidiary_id=$1 and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)order by start_date desc limit 1",[context.subsidiary_id])).rows[0]?.start_date;
 if(!date)throw Error('No existe período abierto para probar la reversión.');
 const initial=Number(context.pending_balance_local),first=Math.round(initial/2*100)/100;
 await db.query('savepoint before_generic_reversal');let genericBlocked=false;try{await db.query('select reverse_journal_entry($1)',[context.journal_id])}catch(error){genericBlocked=String(error.message).includes('Reversar Pendiente');await db.query('rollback to savepoint before_generic_reversal')}
 if(!genericBlocked)throw Error('La reversión genérica no fue bloqueada para ASI_PEN.');
 const one=(await db.query('select reverse_pending_invoice_journal($1,$2::jsonb)value',[context.journal_id,JSON.stringify({reversalDate:date,amount:first,type:'ERROR_CORRECCION',errorDescription:'Prueba parcial controlada de pendiente'})])).rows[0].value;
 const parent=(await db.query('select*from pending_invoice_reversal_options($1)',[context.journal_id])).rows[0].pending_invoice_reversal_options;
 if(parent.journal.status!=='REVERSADO_PARCIAL'||parent.reversals.length!==1)throw Error('La primera reversión no dejó el estado parcial esperado.');
 await db.query('savepoint before_over_reversal');let blocked=false;try{await db.query('select reverse_pending_invoice_journal($1,$2::jsonb)',[context.journal_id,JSON.stringify({reversalDate:date,amount:initial+1,type:'ERROR_CORRECCION',errorDescription:'Intento de sobre reversión controlada'})])}catch(error){blocked=String(error.message).includes('supera el saldo disponible');await db.query('rollback to savepoint before_over_reversal');}
 if(!blocked)throw Error('La sobre-reversión no fue bloqueada.');
 const remaining=Number(parent.journal.balanceLocal);
 const two=(await db.query('select reverse_pending_invoice_journal($1,$2::jsonb)value',[context.journal_id,JSON.stringify({reversalDate:date,amount:remaining,type:'ERROR_CORRECCION',errorDescription:'Liquidación final controlada del pendiente'})])).rows[0].value;
 const final=(await db.query('select*from pending_invoice_reversal_options($1)',[context.journal_id])).rows[0].pending_invoice_reversal_options;
 if(final.journal.status!=='REVERSADO_TOTAL'||Number(final.journal.balanceLocal)!==0||final.reversals.length!==2)throw Error('La liquidación total no actualizó saldo, estado e historial.');
 const report=(await db.query('select run_pending_invoice_control_report($1::jsonb)value',[JSON.stringify({subsidiaryIds:[context.subsidiary_id],dateFrom:'1900-01-01',dateTo:'2099-12-31'})])).rows[0].value;
 if(!(report.rows||[]).some(row=>String(row.journal_id)===String(context.journal_id)&&row.reversals.length===2))throw Error('El reporte no muestra el historial de reversiones.');
 console.log(JSON.stringify({partial:one.number,total:two.number,genericBlocked:true,overReversalBlocked:true,history:2,finalStatus:final.journal.status,rollback:true}));
 await db.query('rollback');
}catch(error){await db.query('rollback');throw error}finally{await db.end()}
