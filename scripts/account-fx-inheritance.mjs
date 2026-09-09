import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:6543,database:'postgres',user:`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();try{
 await db.query('begin');
 await db.query(await readFile('supabase/migrations/20260909120000_account_fx_inheritance.sql','utf8'));
 if(process.argv.includes('--apply')){await db.query('commit');console.log('Herencia aplicada y cuentas existentes sincronizadas.');}
 else{
 const a=(await db.query("select a.account_id,a.account_group_id from chart_accounts a join account_group g on g.group_id=a.account_group_id where a.category in ('Activo','Pasivo') and g.category in ('Activo','Pasivo') limit 1")).rows[0];assert.ok(a);
 for(const flag of [true,false,true]){
 await db.query('update account_group set pending_fx_revaluation=$1 where group_id=$2',[flag,a.account_group_id]);
 const rows=(await db.query("select pending_fx_revaluation from chart_accounts where account_group_id=$1 and category in ('Activo','Pasivo')",[a.account_group_id])).rows;
 assert.ok(rows.length);assert.ok(rows.every(r=>r.pending_fx_revaluation===flag));
 await db.query('update chart_accounts set pending_fx_revaluation=$1 where account_id=$2',[!flag,a.account_id]);
 assert.equal((await db.query('select pending_fx_revaluation from chart_accounts where account_id=$1',[a.account_id])).rows[0].pending_fx_revaluation,flag);
 }
 assert.equal(Number((await db.query("select count(*) n from chart_accounts a join account_group g on a.account_group_id=g.group_id where a.pending_fx_revaluation is distinct from (g.pending_fx_revaluation and coalesce(a.category in ('Activo','Pasivo'),false))")).rows[0].n),0);
 await db.query('rollback');console.log('PASS: propagacion al activar/desactivar, proteccion de herencia y sincronizacion completa. Prueba revertida.');
 }
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
