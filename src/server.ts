import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import { authController } from './modules/auth/auth.module.js';
import { createCountry, deleteCountry, listCountries, updateCountry } from './modules/countries/countries.module.js';
import { createCatalogRow, deleteCatalogRow, getCoreCatalog, listCatalogRows, updateCatalogRow } from './modules/core-catalogs/core-catalogs.module.js';
import { createSecurityRow, deleteSecurityRow, getSecurityCatalog, listSecurityRows, updateSecurityRow } from './modules/security-catalogs/security-catalogs.module.js';
import { createOrganizationRow, deleteOrganizationRow, getOrganizationCatalog, listOrganizationRows, updateOrganizationRow } from './modules/organization-catalogs/organization-catalogs.module.js';
import { assertExchangeRateAccess, createConfigurationRow, deleteConfigurationRow, getConfigurationCatalog, listConfigurationRows, updateConfigurationRow } from './modules/configuration-catalogs/configuration-catalogs.module.js';
import { createAccountingRow, deleteAccountingRow, getAccountingCatalog, listAccountingRows, updateAccountingRow } from './modules/accounting-catalogs/accounting-catalogs.module.js';
import { createBankingRow, deleteBankingRow, getBankingCatalog, listBankingRows, updateBankingRow } from './modules/banking-catalogs/banking-catalogs.module.js';
import { createTreasuryRow, deleteTreasuryRow, getTreasuryCatalog, listTreasuryRows, updateTreasuryRow } from './modules/treasury-catalogs/treasury-catalogs.module.js';
import { createEntityRow, deleteEntityRow, getEntityCatalog, listEntityRows, updateEntityRow } from './modules/entity-catalogs/entity-catalogs.module.js';
import { createInventoryRow, deleteInventoryRow, getInventoryCatalog, listInventoryRows, updateInventoryRow } from './modules/inventory-catalogs/inventory-catalogs.module.js';
import { createSalesRow, deleteSalesRow, getSalesCatalog, listSalesRows, updateSalesRow } from './modules/sales-catalogs/sales-catalogs.module.js';
import { createTransactionEngineRow, deleteTransactionEngineRow, getTransactionEngineCatalog, listTransactionEngineRows, updateTransactionEngineRow } from './modules/transaction-engine-catalogs/transaction-engine-catalogs.module.js';
import { createPurchasingRow, deletePurchasingRow, getPurchasingCatalog, listPurchasingRows, updatePurchasingRow } from './modules/purchasing-catalogs/purchasing-catalogs.module.js';
import { createExpenseRow, deleteExpenseRow, getExpenseCatalog, listExpenseRows, updateExpenseRow } from './modules/expense-catalogs/expense-catalogs.module.js';
import { createFixedAssetRow, deleteFixedAssetRow, getFixedAssetCatalog, listFixedAssetRows, updateFixedAssetRow } from './modules/fixed-asset-catalogs/fixed-asset-catalogs.module.js';
import { createWorkflowRow, deleteWorkflowRow, getWorkflowCatalog, listWorkflowRows, updateWorkflowRow } from './modules/workflow-catalogs/workflow-catalogs.module.js';
import { createDocumentRow, deleteDocumentRow, getDocumentCatalog, listDocumentRows, updateDocumentRow } from './modules/document-catalogs/document-catalogs.module.js';
import { createAuditRow, deleteAuditRow, getAuditCatalog, listAuditRows, updateAuditRow } from './modules/audit-catalogs/audit-catalogs.module.js';
import { createConsolidationRow, deleteConsolidationRow, getConsolidationCatalog, listConsolidationRows, updateConsolidationRow } from './modules/consolidation-catalogs/consolidation-catalogs.module.js';
import { createAiRow, deleteAiRow, getAiCatalog, listAiRows, updateAiRow } from './modules/ai-catalogs/ai-catalogs.module.js';
import { listUserCompanies, selectUserCompany } from './modules/auth/services/company-access.service.js';
import { listUserRoles, selectUserRole } from './modules/auth/services/role-access.service.js';
import { assertActiveSession, revokeCurrentSession, SessionAuthenticationError } from './modules/auth/services/session.service.js';
import { assertRegisteredDevice } from './modules/auth/services/device.service.js';
import { changePassword } from './modules/auth/services/password-history.service.js';
import { error, json } from './core/interceptors/http-response.js';
import { consultarYGuardarTipoDeCambioRD } from './modules/configuration-catalogs/services/dominican-republic-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioRD } from './modules/configuration-catalogs/services/dominican-republic-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioCR } from './modules/configuration-catalogs/services/costa-rica-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioCR } from './modules/configuration-catalogs/services/costa-rica-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioGT } from './modules/configuration-catalogs/services/guatemala-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioGT } from './modules/configuration-catalogs/services/guatemala-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioJM } from './modules/configuration-catalogs/services/jamaica-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioJM } from './modules/configuration-catalogs/services/jamaica-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioCO } from './modules/configuration-catalogs/services/colombia-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioCO } from './modules/configuration-catalogs/services/colombia-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioAR } from './modules/configuration-catalogs/services/argentina-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioAR } from './modules/configuration-catalogs/services/argentina-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioNI } from './modules/configuration-catalogs/services/nicaragua-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioNI } from './modules/configuration-catalogs/services/nicaragua-exchange-rate.scheduler.js';
import { consultarYGuardarTipoDeCambioPE } from './modules/configuration-catalogs/services/peru-exchange-rate.service.js';
import { iniciarProgramacionTipoCambioPE } from './modules/configuration-catalogs/services/peru-exchange-rate.scheduler.js';

const loadEnvFile = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
try { loadEnvFile?.('.env'); } catch { /* Las variables también pueden venir del entorno del proceso. */ }

const publicDir = join(process.cwd(), 'public');
const vueBrowserBuild = join(process.cwd(), 'node_modules', 'vue', 'dist', 'vue.esm-browser.prod.js');
const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

async function body(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw || '{}');
}

function clientIp(request: IncomingMessage) {
  const forwarded = request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return value?.trim() || request.socket.remoteAddress?.replace(/^::ffff:/, '') || null;
}

async function serveFile(pathname: string, response: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(publicDir, relative));
  if (!file.startsWith(publicDir)) return error(response, 403, 'Acceso denegado.');
  try {
    await stat(file);
    const extension = file.slice(file.lastIndexOf('.'));
    response.writeHead(200, { 'Content-Type': `${mime[extension] ?? 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': ['.html','.js'].includes(extension) ? 'no-store, max-age=0' : 'no-cache' });
    createReadStream(file).pipe(response);
  } catch { error(response, 404, 'Recurso no encontrado.'); }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url?.split('?')[0] === '/assets/vue.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      createReadStream(vueBrowserBuild).pipe(response);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/auth/login') {
      const result = await authController.signIn(await body(request) as { email: string; password: string; deviceToken?: string; deviceName?: string }, clientIp(request));
      return json(response, 200, result);
    }
    if (request.method === 'POST' && request.url === '/api/auth/logout') {
      const authorization = request.headers.authorization;
      if (authorization?.startsWith('Bearer ')) await revokeCurrentSession(authorization);
      return json(response, 200, { success: true });
    }
    if (request.url?.startsWith('/api/')) {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión.');
      await assertActiveSession(authorization);
      await assertRegisteredDevice(authorization, Array.isArray(request.headers['x-device-token']) ? request.headers['x-device-token'][0] : request.headers['x-device-token']);
    }
    if(request.method==='GET'&&request.url==='/api/auth/companies'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión.');return json(response,200,await listUserCompanies(authorization));}
    if(request.method==='POST'&&request.url==='/api/auth/select-company'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión.');const input=await body(request)as{subsidiaryId?:number};return json(response,200,await selectUserCompany(authorization,Number(input.subsidiaryId)));}
    if(request.method==='GET'&&request.url==='/api/auth/roles'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión.');return json(response,200,await listUserRoles(authorization));}
    if(request.method==='POST'&&request.url==='/api/auth/select-role'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión.');const input=await body(request)as{roleId?:number};return json(response,200,await selectUserRole(authorization,Number(input.roleId)));}
    if(request.method==='POST'&&request.url==='/api/auth/change-password'){const authorization=request.headers.authorization!;return json(response,200,await changePassword(authorization,await body(request)as{currentPassword?:string;newPassword?:string;confirmation?:string}));}
    const coreRoute = request.url?.match(/^\/api\/core\/([a-z-]+)(?:\/(\d+))?$/);
    if (coreRoute) {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión para administrar catálogos.');
      const catalog = getCoreCatalog(coreRoute[1]);
      const id = coreRoute[2] ? Number(coreRoute[2]) : null;
      if (request.method === 'GET' && id === null) return json(response, 200, await listCatalogRows(catalog, authorization));
      if (request.method === 'POST' && id === null) return json(response, 201, await createCatalogRow(catalog, authorization, await body(request) as Record<string, unknown>));
      if (request.method === 'PATCH' && id !== null) return json(response, 200, await updateCatalogRow(catalog, authorization, id, await body(request) as Record<string, unknown>));
      if (request.method === 'DELETE' && id !== null) { await deleteCatalogRow(catalog, authorization, id); return json(response, 200, { success: true }); }
    }
    const securityRoute = request.url?.match(/^\/api\/security\/([a-z-]+)(?:\/(\d+))?$/);
    if (securityRoute) {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión para administrar Seguridad.');
      const catalog = getSecurityCatalog(securityRoute[1]);
      const id = securityRoute[2] ? Number(securityRoute[2]) : null;
      if (request.method === 'GET' && id === null) return json(response, 200, await listSecurityRows(catalog, authorization));
      if (request.method === 'POST' && id === null) return json(response, 201, await createSecurityRow(catalog, authorization, await body(request) as Record<string, unknown>));
      if (request.method === 'PATCH' && id !== null) return json(response, 200, await updateSecurityRow(catalog, authorization, id, await body(request) as Record<string, unknown>));
      if (request.method === 'DELETE' && id !== null) { await deleteSecurityRow(catalog, authorization, id); return json(response, 200, { success: true }); }
    }
    const organizationRoute = request.url?.match(/^\/api\/organization\/([a-z-]+)(?:\/(\d+))?$/);
    if (organizationRoute) {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión para administrar Organización.');
      const catalog = getOrganizationCatalog(organizationRoute[1]);
      const id = organizationRoute[2] ? Number(organizationRoute[2]) : null;
      if (request.method === 'GET' && id === null) return json(response, 200, await listOrganizationRows(catalog, authorization));
      if (request.method === 'POST' && id === null) return json(response, 201, await createOrganizationRow(catalog, authorization, await body(request) as Record<string, unknown>));
      if (request.method === 'PATCH' && id !== null) return json(response, 200, await updateOrganizationRow(catalog, authorization, id, await body(request) as Record<string, unknown>));
      if (request.method === 'DELETE' && id !== null) { await deleteOrganizationRow(catalog, authorization, id); return json(response, 200, { success: true }); }
    }
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-rd'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'DOP');return json(response,200,await consultarYGuardarTipoDeCambioRD(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-cr'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'CRC');return json(response,200,await consultarYGuardarTipoDeCambioCR(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-gt'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'GTQ');return json(response,200,await consultarYGuardarTipoDeCambioGT(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-jm'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'JMD');return json(response,200,await consultarYGuardarTipoDeCambioJM(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-co'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'COP');return json(response,200,await consultarYGuardarTipoDeCambioCO(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-ar'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'ARS');return json(response,200,await consultarYGuardarTipoDeCambioAR(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-ni'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'NIO');return json(response,200,await consultarYGuardarTipoDeCambioNI(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    if(request.method==='POST'&&request.url==='/api/configuration/exchange-rates/obtener-pe'){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para consultar el tipo de cambio.');await assertExchangeRateAccess(authorization,'PEN');return json(response,200,await consultarYGuardarTipoDeCambioPE(authorization,await body(request) as {monedaOrigen?:string;monedaDestino?:string;fechaEfectiva?:Date|string}));}
    const configurationRoute=request.url?.match(/^\/api\/configuration\/([a-z-]+)(?:\/(\d+))?$/);
    if(configurationRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Configuración.');const catalog=getConfigurationCatalog(configurationRoute[1]);const id=configurationRoute[2]?Number(configurationRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listConfigurationRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createConfigurationRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateConfigurationRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteConfigurationRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const accountingRoute=request.url?.match(/^\/api\/accounting\/([a-z-]+)(?:\/(\d+))?$/);if(accountingRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Contabilidad.');const catalog=getAccountingCatalog(accountingRoute[1]);const id=accountingRoute[2]?Number(accountingRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listAccountingRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createAccountingRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateAccountingRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteAccountingRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const bankingRoute=request.url?.match(/^\/api\/banking\/([a-z-]+)(?:\/(\d+))?$/);if(bankingRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Bancos.');const catalog=getBankingCatalog(bankingRoute[1]);const id=bankingRoute[2]?Number(bankingRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listBankingRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createBankingRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateBankingRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteBankingRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const treasuryRoute=request.url?.match(/^\/api\/treasury\/([a-z-]+)(?:\/(\d+))?$/);if(treasuryRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Tesorería.');const catalog=getTreasuryCatalog(treasuryRoute[1]);const id=treasuryRoute[2]?Number(treasuryRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listTreasuryRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createTreasuryRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateTreasuryRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteTreasuryRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const entityRoute=request.url?.match(/^\/api\/entities\/([a-z-]+)(?:\/(\d+))?$/);if(entityRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Entidades.');const catalog=getEntityCatalog(entityRoute[1]);const id=entityRoute[2]?Number(entityRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listEntityRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createEntityRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateEntityRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteEntityRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const inventoryRoute=request.url?.match(/^\/api\/inventory\/([a-z-]+)(?:\/(\d+))?$/);if(inventoryRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Inventario.');const catalog=getInventoryCatalog(inventoryRoute[1]);const id=inventoryRoute[2]?Number(inventoryRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listInventoryRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createInventoryRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateInventoryRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteInventoryRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const salesRoute=request.url?.match(/^\/api\/sales\/([a-z-]+)(?:\/(\d+))?$/);if(salesRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Ventas.');const catalog=getSalesCatalog(salesRoute[1]);const id=salesRoute[2]?Number(salesRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listSalesRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createSalesRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateSalesRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteSalesRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const transactionEngineRoute=request.url?.match(/^\/api\/transaction-engine\/([a-z-]+)(?:\/(\d+))?$/);if(transactionEngineRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar el Motor de Transacciones.');const catalog=getTransactionEngineCatalog(transactionEngineRoute[1]);const id=transactionEngineRoute[2]?Number(transactionEngineRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listTransactionEngineRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createTransactionEngineRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateTransactionEngineRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteTransactionEngineRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const purchasingRoute=request.url?.match(/^\/api\/purchasing\/([a-z-]+)(?:\/(\d+))?$/);if(purchasingRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Compras.');const catalog=getPurchasingCatalog(purchasingRoute[1]);const id=purchasingRoute[2]?Number(purchasingRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listPurchasingRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createPurchasingRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updatePurchasingRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deletePurchasingRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const expenseRoute=request.url?.match(/^\/api\/expenses\/([a-z-]+)(?:\/(\d+))?$/);if(expenseRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Gastos.');const catalog=getExpenseCatalog(expenseRoute[1]);const id=expenseRoute[2]?Number(expenseRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listExpenseRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createExpenseRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateExpenseRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteExpenseRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const fixedAssetRoute=request.url?.match(/^\/api\/fixed-assets\/([a-z-]+)(?:\/(\d+))?$/);if(fixedAssetRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Activos Fijos.');const catalog=getFixedAssetCatalog(fixedAssetRoute[1]);const id=fixedAssetRoute[2]?Number(fixedAssetRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listFixedAssetRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createFixedAssetRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateFixedAssetRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteFixedAssetRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const workflowRoute=request.url?.match(/^\/api\/workflow\/([a-z-]+)(?:\/(\d+))?$/);if(workflowRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Workflow.');const catalog=getWorkflowCatalog(workflowRoute[1]);const id=workflowRoute[2]?Number(workflowRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listWorkflowRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createWorkflowRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateWorkflowRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteWorkflowRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const documentRoute=request.url?.match(/^\/api\/documents\/([a-z-]+)(?:\/(\d+))?$/);if(documentRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Documentos.');const catalog=getDocumentCatalog(documentRoute[1]);const id=documentRoute[2]?Number(documentRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listDocumentRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createDocumentRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateDocumentRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteDocumentRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const auditRoute=request.url?.match(/^\/api\/audit\/([a-z-]+)(?:\/(\d+))?$/);if(auditRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Auditoría.');const catalog=getAuditCatalog(auditRoute[1]);const id=auditRoute[2]?Number(auditRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listAuditRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createAuditRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateAuditRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteAuditRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const consolidationRoute=request.url?.match(/^\/api\/consolidation\/([a-z-]+)(?:\/(\d+))?$/);if(consolidationRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Consolidación.');const catalog=getConsolidationCatalog(consolidationRoute[1]);const id=consolidationRoute[2]?Number(consolidationRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listConsolidationRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createConsolidationRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateConsolidationRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteConsolidationRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const aiRoute=request.url?.match(/^\/api\/ai\/([a-z-]+)(?:\/(\d+))?$/);if(aiRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar IA.');const catalog=getAiCatalog(aiRoute[1]);const id=aiRoute[2]?Number(aiRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listAiRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createAiRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateAiRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteAiRow(catalog,authorization,id);return json(response,200,{success:true});}}
    if (request.method === 'GET' && request.url === '/api/countries') {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión para consultar los países.');
      return json(response, 200, await listCountries(authorization));
    }
    if (request.url === '/api/countries' && request.method === 'POST') {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión para administrar países.');
      const input = await body(request) as { name?: string };
      return json(response, 201, await createCountry(authorization, input.name?.trim() ?? ''));
    }
    const countryRoute = request.url?.match(/^\/api\/countries\/(\d+)$/);
    if (countryRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return error(response, 401, 'Debe iniciar sesión para administrar países.');
      const id = Number(countryRoute[1]);
      if (request.method === 'DELETE') { await deleteCountry(authorization, id); return json(response, 200, { success: true }); }
      const input = await body(request) as { name?: string };
      return json(response, 200, await updateCountry(authorization, id, input.name?.trim() ?? ''));
    }
    await serveFile(request.url?.split('?')[0] ?? '/', response);
  } catch (cause) {
    error(response, cause instanceof SessionAuthenticationError ? 401 : 400, cause instanceof Error ? cause.message : 'No fue posible procesar la solicitud.');
  }
});

server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {console.log(`Nexo ERP disponible en el puerto ${process.env.PORT ?? 3000}`);iniciarProgramacionTipoCambioRD();iniciarProgramacionTipoCambioCR();iniciarProgramacionTipoCambioGT();iniciarProgramacionTipoCambioJM();iniciarProgramacionTipoCambioCO();iniciarProgramacionTipoCambioAR();iniciarProgramacionTipoCambioNI();iniciarProgramacionTipoCambioPE();});
