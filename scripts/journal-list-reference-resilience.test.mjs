import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('journal list retains rows when a reference fails; editing still requires references',async()=>{
 const source=await readFile('public/app.js','utf8');
 const start=source.indexOf('    async loadReferenceOptions('),end=source.indexOf('    selectModule',start);
 const methods=new Function('return ({'+source.slice(start,end)+'})')();
 const catalog={apiRoot:'accounting',slug:'journals',fields:[{reference:'core/currencies'},{reference:'organization/accounting-periods'}]};
 const state={activeCatalog:catalog,rows:[{journal_id:1}],referenceOptions:{},tableNotice:''};
 const read=async path=>{if(path.includes('accounting-periods'))throw Error('Catalog unavailable');return[{currency_id:1,name:'USD'}];};
 await methods.loadReferenceOptions.call(state,{tableOnly:true,catalog,read});
 assert.equal(state.rows[0].journal_id,1);assert.equal(state.referenceOptions['core/currencies'][0].name,'USD');assert.match(state.tableNotice,/identificadores/);
 await assert.rejects(methods.loadReferenceOptions.call(state,{tableOnly:false,catalog,read}),/Catalog unavailable/);
});
