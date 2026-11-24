import {assertRoleAccess,myRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
import {reportCatalog,reportResource} from './report-catalog.js';
import {fetchSupabase} from '../../core/database/supabase.client.js';

export async function fetchReportSupabase(...args:Parameters<typeof fetchSupabase>){
 const response=await fetchSupabase(...args);
 if(response.status===401||response.status===403)throw Object.assign(Error(response.status===401?'Debe iniciar sesión.':'El rol activo no puede consultar este informe.'),{status:response.status});
 return response;
}

export async function requireReportAccess(auth:string,reportKey?:string){
  if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
  await assertRoleAccess(auth,'reports:accounting-reports','view');
  if(reportKey)await assertRoleAccess(auth,reportResource(reportKey),'view');
}

export async function availableReports(auth:string){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 const access=await myRoleAccess(auth);
 return reportCatalog.filter(report=>access.isAdmin||access.grants.some(grant=>grant.resourceKey===reportResource(report.key)&&grant.canView));
}

export function reportForRoute(path:string){
 const url=path.split('?')[0]||'';
 const match=reportCatalog.filter(report=>report.path&&(url===report.path||url.startsWith(report.path+'/'))).sort((a,b)=>b.path!.length-a.path!.length)[0];
 if(match)return match.key;
 if(url==='/api/sales/customer-payments/fees/pdf')return 'customer-payment-fees';
 // Retained aliases and downloads use the same permission as their report.
 const legacy=/^\/api\/reports\/accounting\/([^/]+)/.exec(url);
 if(legacy&&reportCatalog.some(report=>report.key===legacy[1]))return legacy[1];
 return undefined;
}

const accounting=new Set(['options','balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','pending-invoice-control','receivables-aging','payables-aging','supplier-advances','accrued-payroll-payables','payroll-journals','bank-reconciliation','bank-balances','sales-transactions','purchase-transactions','intercompany-loans','intercompany-commercial']);
const families=new Set(['sales/settled-invoices','purchases/settled-invoices','treasury/payment-requests','tax/vat-declaration','accounting/eight-column-balance','accounting/intercompany-loans','accounting/intercompany-commercial']);
export function isFinancialReportRoute(method:string,path:string){
 const url=path.split('?')[0]||'';
 const specialized=/^\/api\/v1\/reports\/(.+?)(?:\/(options|pdf|excel))?$/.exec(url);
 if(specialized&&families.has(specialized[1]!))return method===(specialized[2]==='options'?'GET':'POST');
 const legacy=/^\/api\/reports\/accounting\/([^/]+)$/.exec(url);
 if(legacy&&accounting.has(legacy[1]!))return method===(legacy[1]==='options'?'GET':'POST');
 if(method==='POST'&&/^\/api\/reports\/income-forecast\/(options|generate|save|pdf)$/.test(url))return true;
 if(method==='POST'&&url==='/api/reports/accounting/general-ledger/export')return true;
 if(method==='POST'&&/^\/api\/reports\/accounting\/(bank-reconciliation\/(pdf|close-report)|pending-invoice-control\/pdf)$/.test(url))return true;
 return method==='GET'&&/^\/api\/reports\/accounting\/purchase-transactions\/supports\/\d+$/.test(url);
}
