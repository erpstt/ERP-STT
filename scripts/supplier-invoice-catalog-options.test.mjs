import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('supplier invoice labels require view, stay within the active company and omit private supplier fields',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema entity_master_private;
 create function entity_master_private.identity()returns bigint language plpgsql as $$begin if current_setting('test.sid',true) is null then raise exception using errcode='42501',message='No session';end if;return current_setting('test.sid')::bigint;end$$;
 create function supplier_invoice_access()returns jsonb language sql as $$select jsonb_build_object('canView',current_setting('test.view',true)='yes')$$;
 create table supplier_invoice(supplier_id bigint,transaction_id bigint,po_id bigint,payment_term_id bigint,subsidiary_id bigint);
 insert into supplier_invoice values(1,10,11,12,1),(2,20,21,22,2);
 create table suppliers(supplier_id bigint,company_name text,private_bank text);insert into suppliers values(1,'Proveedor visible','secret'),(2,'Otro proveedor','secret');
 create table subsidiaries(subsidiary_id bigint,name text);insert into subsidiaries values(1,'Empresa visible'),(2,'Empresa ajena');
 create table "transaction"(transaction_id bigint,tran_number text,subsidiary_id bigint);insert into "transaction" values(10,'TR-10',1),(20,'TR-20',2);
 create table purchase_order(po_id bigint,po_number text,subsidiary_id bigint);insert into purchase_order values(11,'PO-11',1),(21,'PO-21',2);
 create table payment_terms(term_id bigint,term_name text);insert into payment_terms values(12,'30 días'),(22,'60 días');
 `);
 await db.exec(await readFile('scripts/supplier-invoice-catalog-options.sql','utf8'));
 await db.exec("select set_config('test.sid','1',false),set_config('test.view','yes',false);set role authenticated");
 const result=(await db.query('select supplier_invoice_catalog_options() r')).rows[0].r;
 assert.deepEqual(result['entities/suppliers'],[{supplier_id:1,company_name:'Proveedor visible'}]);assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('Otro proveedor'));assert.equal(result['purchasing/orders'][0].po_number,'PO-11');
 await db.exec("select set_config('test.view','no',false)");await assert.rejects(db.query('select supplier_invoice_catalog_options()'),/permiso/);
 await db.exec('reset role;set role anon');await assert.rejects(db.query('select supplier_invoice_catalog_options()'),/permission denied/);
 }finally{await db.close();}
});
