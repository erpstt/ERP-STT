import assert from 'node:assert/strict';
import pg from 'pg';
import { consultarYGuardarTipoDeCambioPEAutomatico } from '../src/modules/configuration-catalogs/services/peru-exchange-rate.service.ts';

process.loadEnvFile?.('.env');
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const result=await consultarYGuardarTipoDeCambioPEAutomatico(date);
assert.equal(result.monedaOrigen,'USD');
assert.equal(result.monedaDestino,'PEN');
assert.equal(result.fechaEfectiva,date);
assert.ok(Number(result.tipoCambio)>0);

const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
  const stored=await db.query("select er.effective_date,er.spot_rate from exchange_rates er join currencies f on f.currency_id=er.from_currency_id join currencies t on t.currency_id=er.to_currency_id where f.currency_code='USD'and t.currency_code='PEN'and er.effective_date=$1",[date]);
  assert.equal(stored.rowCount,1);
  assert.equal(Number(stored.rows[0].spot_rate),Number(result.tipoCambio));
  const admins=await db.query("select count(distinct u.user_id)::int total from users u join user_roles ur using(user_id)join roles r using(role_id)where u.is_active and lower(r.role_name)in('administrador','administrator','admin')and u.email is not null");
  assert.ok(admins.rows[0].total>0,'No hay administradores activos para recibir alertas.');
  const incidentTable=await db.query("select to_regclass('public.exchange_rate_update_incidents') is not null ready");
  assert.equal(incidentTable.rows[0].ready,true);
  console.log(JSON.stringify({peruUpdated:true,effectiveDate:date,sourceDate:result.fechaFuente,rate:Number(result.tipoCambio),activeAdminRecipients:admins.rows[0].total,incidentRegistry:true}));
}finally{await db.end();}
