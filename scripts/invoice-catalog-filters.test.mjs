import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {expect} from '@playwright/test';
import {filterInvoiceRows,invoiceFilterError} from '../public/invoice-catalog-tools.js';
import {workspaceShellLayoutFixture} from './lib/workspace-shell-layout-fixture.mjs';

test('inclusive issue dates, customer/supplier and partial invoice number combine',()=>{
 const rows=[{invoice_date:'2026-11-01',invoice_number:'INV-001',customer_id:1,supplier_id:2},{invoice_date:'2026-11-30',invoice_number:'INV-002',customer_id:2,supplier_id:1},{invoice_date:'2026-12-01',invoice_number:'OTHER',customer_id:1,supplier_id:2}];
 assert.equal(filterInvoiceRows(rows,{from:'2026-11-01',to:'2026-11-30'}).length,2);
 assert.deepEqual(filterInvoiceRows(rows,{from:'2026-11-01',to:'2026-11-30',entity:'2',number:'inv-'},true),[rows[0]]);
 assert.deepEqual(filterInvoiceRows(rows,{entity:'2'}),[rows[1]]);
 assert.ok(invoiceFilterError({from:'2026-12-01',to:'2026-11-01'}));
});

test('both invoice lists filter and export all matching rows with numeric amounts',{timeout:60000},async t=>{
 const {page,openInvoices}=await workspaceShellLayoutFixture(t);
 const docs=Array.from({length:31},(_,i)=>({invoice_id:i+1,invoice_number:'INV-'+String(i+1).padStart(4,'0'),invoice_date:i===30?'2026-12-01':'2026-11-15',customer_id:i%2+1,supplier_id:i%2+1,subsidiary_id:1,total_amount:100.25,due_date:'2026-12-30'}));
 const customers=[{customer_id:1,company_name:'Cliente A'},{customer_id:2,company_name:'Cliente B'}];
 const suppliers=[{supplier_id:1,company_name:'Proveedor A'},{supplier_id:2,company_name:'Proveedor B'}];
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;
  if(p==='/api/sales/invoices'||p==='/api/purchasing/supplier-invoices')return route.fulfill({json:docs});
  if(p==='/api/sales/invoice-catalog-options')return route.fulfill({json:{'entities/customers':customers,'organization/subsidiaries':[{subsidiary_id:1,name:'Empresa'}],'sales/sales-orders':[]}});
  if(p==='/api/entities/suppliers')return route.fulfill({json:suppliers});
  if(p==='/api/purchasing/orders'||p==='/api/configuration/payment-terms')return route.fulfill({json:[]});
  return route.fallback();
 });
 await openInvoices();
 for(const kind of ['sales','purchasing']){
  if(kind==='purchasing')await page.evaluate(()=>{const vm=document.getElementById('app').__vue_app__._container._vnode.component.proxy;vm.navigateChild('Compras','Facturas de proveedores');});
  const controls=page.locator('.invoice-catalog-filters');await expect(controls).toBeVisible();await expect(page.locator('.record-count')).toHaveText('31 registros');
  await controls.locator('input[type=date]').nth(0).fill('2026-11-01');await controls.locator('input[type=date]').nth(1).fill('2026-11-30');await expect(page.locator('.record-count')).toHaveText('30 registros');
  const waiting=page.waitForEvent('download');await controls.getByRole('button',{name:/Descargar Excel/}).click();const file=await waiting;const wb=new ExcelJS.Workbook();await wb.xlsx.load(await readFile(await file.path()));
  const values=wb.worksheets[0].getSheetValues();assert.equal(values.filter(r=>Array.isArray(r)&&r.includes('INV-0030')).length,1);assert.equal(values.filter(r=>Array.isArray(r)&&r.some(v=>typeof v==='string'&&v.startsWith('INV-'))).length,30);assert.ok(values.some(r=>Array.isArray(r)&&r.includes(100.25)));
  await controls.locator('select').selectOption('1');await expect(page.locator('.record-count')).toHaveText('15 registros');
  await controls.getByPlaceholder('Número completo o parcial').fill('0001');await expect(page.locator('.record-count')).toHaveText('1 registro');
  await mkdir('.task-tmp',{recursive:true});await page.screenshot({path:`.task-tmp/invoice-filters-${kind}.png`,fullPage:true});
  await controls.getByRole('button',{name:'Limpiar filtros'}).click();await expect(page.locator('.record-count')).toHaveText('31 registros');
 }
});
