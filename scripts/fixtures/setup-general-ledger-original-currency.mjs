import {readFile} from 'node:fs/promises';
import {setupGeneralLedgerOpeningEntities,applyLedgerEntityMigration} from './setup-general-ledger-opening-entities.mjs';

export const ledgerOriginalCurrencyMigration='20261104152614_add_general_ledger_original_currency_columns.sql';
export async function setupGeneralLedgerOriginalCurrency(db){
 await setupGeneralLedgerOpeningEntities(db);await applyLedgerEntityMigration(db);
 await db.exec(`
 create table currencies(currency_id bigint primary key,currency_code text);
 insert into currencies values(1,'CRC'),(2,'USD'),(3,'EUR');
 alter table subsidiaries add column currency_id bigint default 1;
 alter table "transaction"add column currency_id bigint default 1,add column exchange_rate numeric default 1;
 alter table journal add column currency_id bigint default 1,add column exchange_rate numeric default 1,
  add column reversed_from_journal_id bigint,add column fx_revaluation_run_id bigint;
 alter table journal_line add column original_currency_id bigint,add column historical_exchange_rate numeric;
 alter table opening_balance_lines add column currency_id bigint,add column historical_rate numeric;
 update journal_line set original_currency_id=2,historical_exchange_rate=5;
 update opening_balance_lines set currency_id=2,historical_rate=5;
 `);
 const add=async({id,label,currency=2,rate=5,journalRate=rate,originalCurrency=null,debit=0,credit=100,originalDebit=0,originalCredit=20,lineRate=null,lineCurrency=null,fxRun=null})=>{
  await db.query('insert into "transaction"(transaction_id,tran_number,transaction_type_id,currency_id,exchange_rate)values($1,$2,1,$3,$4)',[id,'SYN-'+label,currency,rate]);
  await db.query("insert into journal(journal_id,transaction_id,journal_number,subsidiary_id,memo,is_opening_balance,currency_id,exchange_rate,fx_revaluation_run_id)values($1,$1,$2,1,$2,false,$3,$4,$5)",[id,'SYN-'+label,currency,journalRate,fxRun]);
  await db.query('insert into journal_line(journal_line_id,journal_id,account_id,note,debit,credit,debit_fx,credit_fx,original_currency_id,historical_exchange_rate)values($1,$1,1,$2,$3,$4,$5,$6,$7,$8)',[id,label,debit,credit,originalDebit,originalCredit,lineCurrency,lineRate]);
  await db.query("insert into gl_impact values($1,$1,1,1,1,1,$2,$3,$4,$5,'2026-09-30',$6,null)",[id,debit,credit,originalDebit,originalCredit,originalCurrency]);
 };
 await add({id:200,label:'ORDINARY-USD'});
 await add({id:201,label:'PRECISION',rate:3.123456789012,credit:3.855280,originalCredit:1.234299});
 await add({id:202,label:'HISTORICAL-PAYMENT',rate:5,credit:400,originalCredit:100,lineRate:4,lineCurrency:2});
 await add({id:203,label:'EFFECTIVE-PAYMENT',rate:5,credit:400,originalCredit:100});
 await add({id:204,label:'LOCAL',currency:1,rate:1,credit:88,originalCredit:88});
 await add({id:205,label:'FOREIGN-ZERO',credit:100,originalCredit:0});
 await add({id:206,label:'FOREIGN-NULL',credit:100,originalCredit:null});
 await add({id:207,label:'LOCAL-NULL',currency:1,rate:1,credit:100,originalDebit:null,originalCredit:null});
 await add({id:208,label:'FX-REVALUATION',currency:1,rate:1,credit:37.25,originalCredit:0,fxRun:88});
 await add({id:209,label:'FX-REVERSAL',currency:1,rate:1,debit:37.25,credit:0,originalDebit:0,originalCredit:0,fxRun:88});
 await add({id:210,label:'NO-HEADER-RATE',rate:null,journalRate:null,credit:400,originalCredit:100});
 await add({id:211,label:'AMBIGUOUS-HISTORICAL',rate:5,credit:400,originalCredit:100,lineRate:3,lineCurrency:2});
 await db.exec("insert into journal_line(journal_line_id,journal_id,account_id,note,credit,credit_fx,original_currency_id,historical_exchange_rate)values(1211,211,1,'Another same-account line',400,100,2,6)");
 await add({id:212,label:'JOURNAL-RATE',rate:null,journalRate:4.123456789012,credit:4.123457,originalCredit:1});
 await add({id:213,label:'ORIGINAL-CURRENCY-OVERRIDE',currency:1,rate:1,originalCurrency:3,credit:240,originalCredit:100});
 // Opening reversals carry the same source key, historical rate and original
 // currency, and reverse the stored original sides independently of the header.
 await db.exec(`insert into "transaction"values(300,'SYN-OPENING-REVERSAL',1,null,null,1,1);
 insert into journal values(300,300,'SYN-OPENING-REVERSAL',1,'Synthetic opening reversal',false,1,1,100,null);
 insert into journal_line(journal_line_id,journal_id,account_id,note,opening_balance_line_id,debit,debit_fx,original_currency_id,historical_exchange_rate)
  values(300,300,1,'Reversed opening line',1,100,20,2,5);
 insert into gl_impact values(300,300,1,1,1,1,100,0,20,0,'2026-09-30',2,1);`);
}

export async function applyLedgerOriginalCurrencyMigration(db){
 const sql=(await readFile(new URL('../../supabase/migrations/'+ledgerOriginalCurrencyMigration,import.meta.url),'utf8')).replaceAll('\r\n','\n');
 await db.exec('begin');try{await db.exec(sql);await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
