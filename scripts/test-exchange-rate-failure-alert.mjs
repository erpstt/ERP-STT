import assert from 'node:assert/strict';
import pg from 'pg';
import { reportExchangeRateFailure } from '../src/modules/configuration-catalogs/services/exchange-rate-alert.service.ts';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const test={countryCode:'ZZ',countryName:'País de prueba',currencyPair:'USD/ZZZ',effectiveDate:'2099-12-31',cause:new Error('Fallo simulado; no se envía correo real.')};
try{
  await db.query("delete from exchange_rate_update_incidents where country_code='ZZ'and effective_date='2099-12-31'");
  let sends=0,lastMessage;
  const fakeSend=async message=>{sends++;lastMessage=message;return{accepted:Array.isArray(message.bcc)?message.bcc:['admin'],messageId:'simulated'};};
  const first=await reportExchangeRateFailure(test,fakeSend);
  const second=await reportExchangeRateFailure(test,fakeSend);
  assert.equal(first.sent,true);
  assert.equal(second.sent,false);
  assert.equal(second.reason,'already-notified');
  assert.equal(sends,1);
  assert.ok(Array.isArray(lastMessage.bcc)&&lastMessage.bcc.length>0);
  assert.match(String(lastMessage.subject),/USD\/ZZZ/);
  assert.match(String(lastMessage.html),/GENTIA/);
  console.log(JSON.stringify({template:true,activeAdminRecipients:lastMessage.bcc.length,deduplicated:true,realEmailSent:false}));
}finally{
  await db.query("delete from exchange_rate_update_incidents where country_code='ZZ'and effective_date='2099-12-31'");
  await db.end();
}
