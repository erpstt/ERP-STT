import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import { authController } from './modules/auth/auth.module.js';
import { createCountry, deleteCountry, listCountries, updateCountry } from './modules/countries/countries.module.js';
import { createCatalogRow, deleteCatalogRow, getCoreCatalog, listCatalogRows, updateCatalogRow } from './modules/core-catalogs/core-catalogs.module.js';
import { createSecurityRow, deleteSecurityRow, getSecurityCatalog, listSecurityRows, updateSecurityRow } from './modules/security-catalogs/security-catalogs.module.js';
import { createOrganizationRow, deleteOrganizationRow, getOrganizationCatalog, listOrganizationRows, updateOrganizationRow } from './modules/organization-catalogs/organization-catalogs.module.js';
import { createConfigurationRow, deleteConfigurationRow, getConfigurationCatalog, listConfigurationRows, updateConfigurationRow } from './modules/configuration-catalogs/configuration-catalogs.module.js';
import { createAccountingRow, deleteAccountingRow, getAccountingCatalog, listAccountingRows, updateAccountingRow } from './modules/accounting-catalogs/accounting-catalogs.module.js';
import { createBankingRow, deleteBankingRow, getBankingCatalog, listBankingRows, updateBankingRow } from './modules/banking-catalogs/banking-catalogs.module.js';
import { createTreasuryRow, deleteTreasuryRow, getTreasuryCatalog, listTreasuryRows, updateTreasuryRow } from './modules/treasury-catalogs/treasury-catalogs.module.js';
import { createEntityRow, deleteEntityRow, getEntityCatalog, listEntityRows, updateEntityRow } from './modules/entity-catalogs/entity-catalogs.module.js';
import { createInventoryRow, deleteInventoryRow, getInventoryCatalog, listInventoryRows, updateInventoryRow } from './modules/inventory-catalogs/inventory-catalogs.module.js';
import { error, json } from './core/interceptors/http-response.js';

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

async function serveFile(pathname: string, response: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(publicDir, relative));
  if (!file.startsWith(publicDir)) return error(response, 403, 'Acceso denegado.');
  try {
    await stat(file);
    const extension = file.slice(file.lastIndexOf('.'));
    response.writeHead(200, { 'Content-Type': `${mime[extension] ?? 'application/octet-stream'}; charset=utf-8` });
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
      const result = await authController.signIn(await body(request) as { email: string; password: string });
      return json(response, 200, result);
    }
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
    const configurationRoute=request.url?.match(/^\/api\/configuration\/([a-z-]+)(?:\/(\d+))?$/);
    if(configurationRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Configuración.');const catalog=getConfigurationCatalog(configurationRoute[1]);const id=configurationRoute[2]?Number(configurationRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listConfigurationRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createConfigurationRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateConfigurationRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteConfigurationRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const accountingRoute=request.url?.match(/^\/api\/accounting\/([a-z-]+)(?:\/(\d+))?$/);if(accountingRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Contabilidad.');const catalog=getAccountingCatalog(accountingRoute[1]);const id=accountingRoute[2]?Number(accountingRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listAccountingRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createAccountingRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateAccountingRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteAccountingRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const bankingRoute=request.url?.match(/^\/api\/banking\/([a-z-]+)(?:\/(\d+))?$/);if(bankingRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Bancos.');const catalog=getBankingCatalog(bankingRoute[1]);const id=bankingRoute[2]?Number(bankingRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listBankingRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createBankingRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateBankingRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteBankingRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const treasuryRoute=request.url?.match(/^\/api\/treasury\/([a-z-]+)(?:\/(\d+))?$/);if(treasuryRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Tesorería.');const catalog=getTreasuryCatalog(treasuryRoute[1]);const id=treasuryRoute[2]?Number(treasuryRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listTreasuryRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createTreasuryRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateTreasuryRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteTreasuryRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const entityRoute=request.url?.match(/^\/api\/entities\/([a-z-]+)(?:\/(\d+))?$/);if(entityRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Entidades.');const catalog=getEntityCatalog(entityRoute[1]);const id=entityRoute[2]?Number(entityRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listEntityRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createEntityRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateEntityRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteEntityRow(catalog,authorization,id);return json(response,200,{success:true});}}
    const inventoryRoute=request.url?.match(/^\/api\/inventory\/([a-z-]+)(?:\/(\d+))?$/);if(inventoryRoute){const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))return error(response,401,'Debe iniciar sesión para administrar Inventario.');const catalog=getInventoryCatalog(inventoryRoute[1]);const id=inventoryRoute[2]?Number(inventoryRoute[2]):null;if(request.method==='GET'&&id===null)return json(response,200,await listInventoryRows(catalog,authorization));if(request.method==='POST'&&id===null)return json(response,201,await createInventoryRow(catalog,authorization,await body(request)as Record<string,unknown>));if(request.method==='PATCH'&&id!==null)return json(response,200,await updateInventoryRow(catalog,authorization,id,await body(request)as Record<string,unknown>));if(request.method==='DELETE'&&id!==null){await deleteInventoryRow(catalog,authorization,id);return json(response,200,{success:true});}}
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
    error(response, 400, cause instanceof Error ? cause.message : 'No fue posible procesar la solicitud.');
  }
});

server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log(`Nexo ERP disponible en el puerto ${process.env.PORT ?? 3000}`));
