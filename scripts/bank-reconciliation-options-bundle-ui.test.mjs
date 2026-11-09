import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {generateReconciliationOptionsBundleFixtures} from './fixtures/setup-bank-reconciliation-options-bundle.mjs';

// Bank metadata is returned unchanged from real PGlite RPCs. No browser fixture
// invents the capability flag, version marker or preview result.
const fixtures=await generateReconciliationOptionsBundleFixtures();
const server=await readFile('src/server.ts','utf8'),branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);assert.ok(branding&&renewal);
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const previewPath='/api/reports/accounting/bank-reconciliation/draft-delete-preview',writePath='/api/reports/accounting/bank-reconciliation/draft-delete';
const selected=fixtures.selection;
function bankRow(bundle){return bundle.bankOptions.reconciliations.find(row=>row.id===selected.reconciliationId);}

async function fixture(t,{width=1536,phase='before'}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],state={phase};
 const bundles={before:fixtures.before,after:fixtures.allowed,denied:fixtures.denied};
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({subsidiaryId})=>{localStorage.setItem('nexo_token','synthetic-bundle-transport-token');localStorage.setItem('nexo_device_token','synthetic-bundle-transport-device');localStorage.setItem('nexo_company',String(subsidiaryId));localStorage.setItem('nexo_role','2');window.NexoSessionRenewal={current:()=>({generation:'synthetic-bundle-transport-generation'})};},{subsidiaryId:selected.subsidiaryId});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL)return route.fallback();
  if(url.pathname==='/accounting-reports.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/accounting-reports.html','utf8'))});
  if(!url.pathname.startsWith('/api/'))return route.fallback();
  calls.push({path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null});
  if(url.pathname==='/api/reports/accounting/options')return route.fulfill({json:bundles[state.phase]});
  if(url.pathname==='/api/reports/accounting/bank-reconciliation')return route.fulfill({json:fixtures.report});
  if(url.pathname===previewPath)return route.fulfill({json:{result:fixtures.preview}});
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:501,json:{error:{message:'Unmocked API blocked'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/accounting-reports.html?reporte=bank-reconciliation"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await expect(frame.locator('#bankView')).toBeVisible();await frame.locator('#bankAccount').selectOption(String(selected.bankAccountId));await frame.locator('#bankCutoff').fill(selected.cutoff);await frame.locator('#bankCutoff').dispatchEvent('change');await settled(frame);await frame.locator('#bankView').selectOption('HISTORY');await settled(frame);await expect(frame.locator('#tbody')).toContainText(selected.cutoff);
 assert.equal(await frame.locator('html').evaluate(node=>node.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(calls.filter(call=>call.path===writePath).length,0);});return{frame,calls,state};
}
async function settled(frame){await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));}

for(const width of[1536,390])test(`bundle SQL ${width}: antes omite metadata y oculta acción; wrapper público la conserva y permite revisar sin eliminar`,{timeout:45000},async t=>{
 assert.equal(bankRow(fixtures.before)?._actions?.canDeleteDraft,undefined);assert.equal(fixtures.before.bankOptions.closingContextVersion,undefined);assert.equal(bankRow(fixtures.allowed)._actions.canDeleteDraft,true);assert.equal(fixtures.allowed.bankOptions.closingContextVersion,1);assert.equal(fixtures.preview.canDelete,true);assert.equal(fixtures.preview.matchCount,0);
 const{frame,calls,state}=await fixture(t,{width});await expect(frame.locator(`[data-delete-bank-draft="${selected.reconciliationId}"]`)).toHaveCount(0);assert.equal(calls.filter(call=>call.path===previewPath).length,0);
 state.phase='after';await frame.locator('#bankView').selectOption('AUXILIARY');await settled(frame);await frame.locator('#bankView').selectOption('HISTORY');await settled(frame);const button=frame.locator(`[data-delete-bank-draft="${selected.reconciliationId}"]`);await expect(button).toBeVisible();await expect(button).toBeEnabled();
 await button.click();await expect(frame.locator('#bankDeleteDraftDialog')).toBeVisible();await expect(frame.locator('#bankDeleteDraftAcknowledgement')).toBeEnabled();await expect(frame.locator('#bankDeleteDraftAcknowledgement')).not.toBeChecked();await expect(frame.locator('#confirmBankDeleteDraft')).toBeDisabled();await expect(frame.locator('#bankDeleteDraftStatus')).toHaveText('ABIERTA');await expect(frame.locator('#bankDeleteDraftCount')).toHaveText('0');await expect(frame.locator('#bankDeleteDraftCutoff')).toHaveText(selected.cutoff.split('-').reverse().join('/'));
 assert.deepEqual(calls.filter(call=>call.path===previewPath).map(call=>call.body),[{p_bank_account_id:selected.bankAccountId,p_cutoff:selected.cutoff,p_reconciliation_id:selected.reconciliationId}]);await frame.locator('#cancelBankDeleteDraft').click();await expect(frame.locator('#bankDeleteDraftDialog')).toBeHidden();assert.equal(calls.filter(call=>call.path===writePath).length,0);
});

test('bundle SQL con VIEW sin DELETE conserva marker pero no ofrece eliminación ni modifica los cierres históricos',{timeout:30000},async t=>{
 assert.equal(bankRow(fixtures.denied)._actions.canDeleteDraft,false);assert.equal(fixtures.denied.bankOptions.closingContextVersion,1);const{frame,calls}=await fixture(t,{phase:'denied'});await expect(frame.locator('[data-delete-bank-draft]')).toHaveCount(0);assert.equal(calls.filter(call=>call.path===previewPath||call.path===writePath).length,0);
 for(const row of fixtures.denied.bankOptions.reconciliations.filter(row=>row.status==='CERRADA'))assert.equal(await frame.locator(`[data-delete-bank-draft="${row.id}"]`).count(),0);
 await frame.locator('#bankView').selectOption('CLOSED');await settled(frame);await expect(frame.locator('[data-delete-bank-draft]')).toHaveCount(0);
});
