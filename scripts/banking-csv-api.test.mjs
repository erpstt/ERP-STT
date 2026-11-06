import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {test,afterEach} from 'node:test';
import {parseBankingCsv,bankingCsvHeaders,previewBankingCsv,importBankingCsv} from '../dist/modules/banking-catalogs/banking-csv.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const originalFetch=globalThis.fetch,env={...process.env};
afterEach(()=>{globalThis.fetch=originalFetch;invalidateRoleAccessCaches();for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);});
const template=kind=>readFile(new URL('../public/'+(kind==='CHECKS'?'plantilla-cheques-transferencias.csv':'plantilla-depositos-bancarios.csv'),import.meta.url),'utf8');
const csv=(kind,overrides={},headers=bankingCsvHeaders[kind])=>{const row=Object.fromEntries(headers.map(key=>[key,'']));Object.assign(row,{documento_referencia:'SYN-1',tipo_movimiento:'CHEQUE',fecha:'2026-11-05',cuenta_bancaria:'SYN-BANK',moneda:'USD',tipo_cambio:'1',referencia_bancaria:'SYN-REF',beneficiario:'Synthetic',numero_cuenta:'103',importe:'1.000001'},overrides);const quote=v=>/[;"\r\n]/.test(v)?'"'+v.replaceAll('"','""')+'"':v;return headers.join(';')+'\r\n'+headers.map(k=>quote(row[k])).join(';');};
const legacyCheckHeaders=()=>[...bankingCsvHeaders.CHECKS.slice(0,5),'tipo_cambio',...bankingCsvHeaders.CHECKS.slice(5)];
const grant=async(auth,canView=true,canCreate=true)=>primeRoleAccessCache(auth,{isAdmin:false,grants:['banking:bank-checks','banking:bank-deposits'].map(resourceKey=>({resourceKey,canView,canCreate,canEdit:false,canDelete:false}))});
const setup=()=>{process.env.SUPABASE_URL='https://banking-csv.invalid';process.env.SUPABASE_ANON_KEY='public-csv-fixture';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-server-proof-key';};
const base=()=>({valid:true,created:0,alreadyImported:false,entries:[],errors:[],totals:[],context:{userId:1,roleId:2,subsidiaryId:1,sessionId:'synthetic-session',revision:'synthetic-revision'},fingerprint:'a'.repeat(64),validationDigest:'b'.repeat(64)});
test('both downloadable assets use the exact parser contract and retain decimal text',async()=>{
 for(const kind of['CHECKS','DEPOSITS']){const data=parseBankingCsv(await template(kind),kind);assert.equal(data.length,3);assert.equal(data[0].documento_referencia,data[1].documento_referencia);assert.equal(data[2].importe,kind==='CHECKS'?'300.123456':'100.123456');assert.equal(Object.keys(data[0]).length,19);assert.equal(Object.hasOwn(data[0],'tipo_cambio'),kind==='DEPOSITS');}
});

test('new and legacy check headers produce identical canonical rows while every legacy rate value is ignored',()=>{
 const expected=parseBankingCsv(csv('CHECKS'),'CHECKS');assert.equal(bankingCsvHeaders.CHECKS.length,19);assert.equal(bankingCsvHeaders.CHECKS.includes('tipo_cambio'),false);
 for(const tipo_cambio of ['','0','-1','160.1234567890','999999999999999999','NaN','Infinity','not a rate','quoted; ignored\nvalue'])assert.deepEqual(parseBankingCsv(csv('CHECKS',{tipo_cambio},legacyCheckHeaders()),'CHECKS'),expected);
 const reversed=legacyCheckHeaders().reverse();assert.deepEqual(parseBankingCsv(csv('CHECKS',{tipo_cambio:'not authoritative'},reversed),'CHECKS'),expected);assert.deepEqual(Object.keys(expected[0]),bankingCsvHeaders.CHECKS);
});

test('deposit headers and explicit rate text remain unchanged and cannot omit or duplicate the rate column',()=>{
 const text=csv('DEPOSITS',{tipo_cambio:'160.1234567890'}),row=parseBankingCsv(text,'DEPOSITS')[0];assert.equal(bankingCsvHeaders.DEPOSITS.length,19);assert.equal(row.tipo_cambio,'160.1234567890');assert.deepEqual(Object.keys(row),bankingCsvHeaders.DEPOSITS);
 assert.throws(()=>parseBankingCsv(csv('DEPOSITS',{},bankingCsvHeaders.DEPOSITS.filter(key=>key!=='tipo_cambio')),'DEPOSITS'),error=>error.status===400);assert.throws(()=>parseBankingCsv(text.replace('metodo_pago','tipo_cambio'),'DEPOSITS'),error=>error.status===400);
});

test('legacy check compatibility never accepts unknown/duplicate columns or bypasses CSV quoting and field limits',()=>{
 const headers=legacyCheckHeaders(),valid=csv('CHECKS',{},headers);
 for(const value of [valid.replace('tipo_cambio','unknown_rate'),valid.replace('moneda','tipo_cambio'),csv('CHECKS',{},[...headers,'unknown']),csv('CHECKS',{},headers.filter(key=>key!=='moneda')),csv('CHECKS',{tipo_cambio:'x'.repeat(2049)},headers),csv('CHECKS',{tipo_cambio:'x\u0000'},headers),valid.replace(';1;SYN-REF;',';"unterminated;SYN-REF;')])assert.throws(()=>parseBankingCsv(value,'CHECKS'),error=>error.status===400);
});
test('RFC4180 quotes, BOM, CRLF, embedded delimiters/newlines and flexible header order are supported',()=>{
 const text='\uFEFF'+csv('CHECKS',{nota_linea:'Descripción; "citada"\r\nsegunda línea',importe:'12,345678'}),data=parseBankingCsv(text,'CHECKS');assert.equal(data[0].nota_linea,'Descripción; "citada"\nsegunda línea');assert.equal(data[0].importe,'12,345678');const headers=bankingCsvHeaders.CHECKS.slice().reverse();const reordered=headers.join(';')+'\n'+headers.map(k=>data[0][k].includes('\n')?'"'+data[0][k].replaceAll('"','""')+'"':data[0][k]).join(';');assert.deepEqual(parseBankingCsv(reordered,'CHECKS'),data);
});
test('malformed quotes, duplicate/unknown columns, controls and field/row/byte limits are rejected',()=>{
 const good=csv('CHECKS'),head=good.split('\r\n')[0];for(const bad of[head+'\n"unfinished',good.replace('SYN-1','x"y'),good.replace('documento_referencia','unknown'),good.replace('tipo_movimiento','documento_referencia'),good+';extra',good.replace('Synthetic','x\u0000'),csv('CHECKS',{nota_linea:'x'.repeat(2049)}),'x'.repeat(2*1024*1024+1)])assert.throws(()=>parseBankingCsv(bad,'CHECKS'),e=>e.status===400);
 const line=good.split('\r\n')[1];assert.equal(parseBankingCsv(head+'\n'+Array(2000).fill(line).join('\n'),'CHECKS').length,2000);assert.throws(()=>parseBankingCsv(head+'\n'+Array(2001).fill(line).join('\n'),'CHECKS'),e=>e.status===400);
});
test('view and create are both required before parsing or invoking any banking RPC',async()=>{
 setup();let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not connect');};for(const [view,create]of[[false,false],[true,false],[false,true]]){const auth=`Bearer permission-${view}-${create}`;await grant(auth,view,create);for(const fn of[previewBankingCsv,importBankingCsv])await assert.rejects(fn(auth,'checks',{csv:'invalid',subsidiaryId:1}),e=>e.status===403);}await assert.rejects(previewBankingCsv('','checks',{}),e=>e.status===401);assert.equal(calls,0);
});
test('preview proof binds only validated file/context and import keeps the caller JWT/public key',async()=>{
 setup();const auth='Bearer csv-proof-fixture';await grant(auth);const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),headers:new Headers(init.headers),body:JSON.parse(init.body)});return Response.json(base());};const input={csv:csv('CHECKS'),subsidiaryId:1},p=await previewBankingCsv(auth,'checks',input);assert.ok(p.previewToken);assert.ok(Date.parse(p.expiresAt)>Date.now());assert.ok(Date.parse(p.expiresAt)<=Date.now()+900001);assert.doesNotMatch(p.previewToken,/synthetic-server-proof-key/);await importBankingCsv(auth,'checks',{...input,previewToken:p.previewToken});assert.equal(calls.length,2);assert.equal(calls[1].headers.get('authorization'),auth);assert.equal(calls[1].headers.get('apikey'),'public-csv-fixture');assert.equal(calls[1].body.p_fingerprint,'a'.repeat(64));assert.equal(calls[1].body.p_validation_digest,'b'.repeat(64));assert.deepEqual(calls[1].body.p_expected_context,base().context);assert.equal(calls[1].body.p_rows[0].importe,'1.000001');
 const before=calls.length;for(const payload of[{...input,previewToken:p.previewToken+'x'},{...input,subsidiaryId:2,previewToken:p.previewToken},{...input,previewToken:null}])await assert.rejects(importBankingCsv(auth,'checks',payload),e=>e.status===409);await assert.rejects(importBankingCsv(auth,'deposits',{csv:csv('DEPOSITS'),subsidiaryId:1,previewToken:p.previewToken}),e=>e.status===409);assert.equal(calls.length,before);
});
test('expired signed confirmation proofs fail before an import RPC',async()=>{
 setup();const auth='Bearer csv-expired-fixture';await grant(auth);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(base());};const payload={version:1,kind:'CHECKS',context:base().context,fingerprint:'a'.repeat(64),validationDigest:'b'.repeat(64),expiresAt:Date.now()-1},encoded=Buffer.from(JSON.stringify(payload)).toString('base64url'),key=createHmac('sha256',process.env.SUPABASE_SERVICE_ROLE_KEY).update('gentia/banking-csv-preview/v1').digest(),previewToken=encoded+'.'+createHmac('sha256',key).update(encoded).digest('base64url');await assert.rejects(importBankingCsv(auth,'checks',{csv:csv('CHECKS'),subsidiaryId:1,previewToken}),e=>e.status===409);assert.equal(calls,0);
});

test('preview and import bind legacy/new checks to canonical rows while preserving database rate metadata and deposit rates',async()=>{
 setup();const auth='Bearer csv-canonical-rate-fixture';await grant(auth);const calls=[],metadata={reference:'SYN-1',exchangeRate:'160.1234567890',rateDate:'2026-11-04',rateSource:'DIRECT'};
 globalThis.fetch=async(url,init)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(init.body)});return Response.json({...base(),entries:[metadata]});};
 const preview=await previewBankingCsv(auth,'checks',{csv:csv('CHECKS',{tipo_cambio:'ignored legacy value'},legacyCheckHeaders()),subsidiaryId:1});assert.deepEqual(preview.entries,[metadata]);
 await importBankingCsv(auth,'checks',{csv:csv('CHECKS'),subsidiaryId:1,previewToken:preview.previewToken});assert.deepEqual(calls[1].body.p_rows,calls[0].body.p_rows);assert.equal(Object.hasOwn(calls[0].body.p_rows[0],'tipo_cambio'),false);assert.equal(calls[1].body.p_validation_digest,base().validationDigest);
 await importBankingCsv(auth,'checks',{csv:csv('CHECKS',{tipo_cambio:'a completely different ignored value'},legacyCheckHeaders()),subsidiaryId:1,previewToken:preview.previewToken});assert.deepEqual(calls[2].body.p_rows,calls[0].body.p_rows);
 await previewBankingCsv(auth,'deposits',{csv:csv('DEPOSITS',{tipo_cambio:'1.2345678901'}),subsidiaryId:1});assert.equal(calls[3].body.p_kind,'DEPOSITS');assert.equal(calls[3].body.p_rows[0].tipo_cambio,'1.2345678901');
});
test('invalid or already imported previews have no capability and malformed inputs never reach SQL',async()=>{
 setup();const auth='Bearer csv-invalid-fixture';await grant(auth);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({...base(),valid:false,errors:[{row:2,message:'Synthetic error'}]});};assert.equal((await previewBankingCsv(auth,'checks',{csv:csv('CHECKS'),subsidiaryId:1})).previewToken,undefined);globalThis.fetch=async()=>{calls++;return Response.json({...base(),alreadyImported:true});};assert.equal((await previewBankingCsv(auth,'checks',{csv:csv('CHECKS'),subsidiaryId:1})).previewToken,undefined);const before=calls;for(const input of[null,[],{}, {csv:csv('CHECKS'),subsidiaryId:0},{csv:csv('CHECKS'),subsidiaryId:1.5}])await assert.rejects(previewBankingCsv(auth,'checks',input),e=>e.status===400);assert.equal(calls,before);
});
test('transient provider failures and SQL denials are sanitized without mutation retries',async()=>{
 setup();const auth='Bearer csv-errors-fixture';await grant(auth);const input={csv:csv('CHECKS'),subsidiaryId:1};let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(base());};const p=await previewBankingCsv(auth,'checks',input);for(const [http,code,status]of[[403,'42501',403],[409,'PT409',409],[400,'22023',400],[500,'XX000',503],[408,'',503],[429,'',429]]){calls=0;globalThis.fetch=async()=>{calls++;return Response.json({code,message:'private-db-host-secret'},{status:http});};await assert.rejects(importBankingCsv(auth,'checks',{...input,previewToken:p.previewToken}),e=>e.status===status&&!e.message.includes('private-db-host-secret'));assert.equal(calls,1);}calls=0;globalThis.fetch=async()=>{calls++;throw Error('private-network-host');};await assert.rejects(importBankingCsv(auth,'checks',{...input,previewToken:p.previewToken}),e=>e.status===503&&!e.message.includes('private-network-host'));assert.equal(calls,1);
});
