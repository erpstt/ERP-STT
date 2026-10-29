import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  listUserCompanies,
  selectUserCompany,
} from '../dist/modules/auth/services/company-access.service.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL = 'https://companies.test';
process.env.SUPABASE_ANON_KEY = 'test-key';

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

test('el selector inicial omite logos y la empresa activa conserva logo y monedas permitidas', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: init.method || 'GET' });
    if (url.pathname.endsWith('/users')) return Response.json([{ user_id: 4 }]);
    if (url.pathname.endsWith('/user_subsidiaries')) return Response.json([{ subsidiary_id: 7 }]);
    if (url.pathname.endsWith('/user_company_sessions')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/subsidiaries')) {
      if (url.searchParams.get('subsidiary_id') === 'eq.7') {
        return Response.json([{
          subsidiary_id: 7,
          name: 'Empresa activa',
          legal_name: 'Empresa activa S.A.',
          logo_url: 'data:image/png;base64,LOGO',
          currency_id: 2,
        }]);
      }
      return Response.json([{
        subsidiary_id: 7,
        name: 'Empresa activa',
        legal_name: 'Empresa activa S.A.',
        ...(url.searchParams.get('select')?.includes('logo_url') ? { logo_url: 'data:image/png;base64,LIST-LOGO' } : {}),
        currency_id: 2,
      }]);
    }
    if (url.pathname.endsWith('/subsidiary_currencies')) {
      return Response.json([{ currency_id: 2 }, { currency_id: 3 }, { currency_id: 3 }]);
    }
    if (url.pathname.endsWith('/currencies')) {
      return url.searchParams.get('currency_id') === 'eq.2'
        ? Response.json([{ currency_code: 'USD' }])
        : Response.json([{ currency_id: 2, currency_code: 'USD' }]);
    }
    throw new Error(`Solicitud inesperada: ${init.method || 'GET'} ${url}`);
  };

  const payload = Buffer.from(JSON.stringify({ email: 'user@example.com', session_id: 'session-1' }))
    .toString('base64url');
  const authorization = `Bearer header.${payload}.signature`;
  const completeCompanies = await listUserCompanies(authorization);
  const companies = await listUserCompanies(authorization, true);
  const active = await selectUserCompany(authorization, 7);

  const completeListQuery = calls.find(call =>
    call.url.pathname.endsWith('/subsidiaries') && call.url.searchParams.has('subsidiary_id') &&
    call.url.searchParams.get('subsidiary_id')?.startsWith('in.') && call.url.searchParams.get('select')?.includes('logo_url'),
  )?.url;
  const listQuery = calls.find(call =>
    call.url.pathname.endsWith('/subsidiaries') && call.url.searchParams.has('subsidiary_id') &&
    call.url.searchParams.get('subsidiary_id')?.startsWith('in.') && !call.url.searchParams.get('select')?.includes('logo_url'),
  )?.url;
  const activeQuery = calls.find(call =>
    call.url.pathname.endsWith('/subsidiaries') && call.url.searchParams.get('subsidiary_id') === 'eq.7',
  )?.url;
  assert.ok(completeListQuery);
  assert.equal(completeCompanies[0].logoUrl, 'data:image/png;base64,LIST-LOGO');
  assert.ok(listQuery);
  assert.equal(listQuery.searchParams.get('select').includes('logo_url'), false);
  assert.equal(companies[0].logoUrl, null);
  assert.equal(activeQuery.searchParams.get('select').includes('logo_url'), true);
  assert.equal(active.logoUrl, 'data:image/png;base64,LOGO');
  assert.deepEqual(active.allowedCurrencyIds, [2, 3]);
});

test('el cliente usa el detalle solo donde necesita el logo o editar la subsidiaria', async () => {
  const [app, accountStatement, invoice, note] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/account-statement.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/sales-invoice-view.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/sales-note-view.js', import.meta.url), 'utf8'),
  ]);
  const selectCompany = app.slice(app.indexOf('async selectCompany(company)'), app.indexOf('async chooseCompany'));
  const applyActiveCompany = app.slice(app.indexOf('async applyActiveCompanyContext'), app.indexOf('async applyBootstrapContext'));
  assert.match(applyActiveCompany, /company\.allowedCurrencyIds/);
  assert.match(selectCompany, /applyActiveCompanyContext\(selected\)/);
  assert.doesNotMatch(selectCompany, /\/api\/organization\/subsidiaries/);
  assert.match(app, /\/api\/auth\/companies\?view=summary/);
  assert.match(app, /slug==='subsidiaries'\?`\$\{this\.catalogPath\(\)\}\?view=summary`/);
  assert.match(app, /slug==='subsidiaries'[\s\S]*catalogPath\(\)\}\/\$\{encodeURIComponent/);
  assert.match(accountStatement, /\/api\/organization\/subsidiaries\/\$\{encodeURIComponent\(state\.subsidiary\.id\)\}/);
  assert.match(invoice, /\/api\/organization\/subsidiaries\/\$\{encodeURIComponent\(invoice\.subsidiary_id\)\}/);
  assert.match(note, /\/api\/organization\/subsidiaries\/\$\{invoice\.subsidiary_id\}/);
  assert.doesNotMatch(note, /['"]\/api\/organization\/subsidiaries['"]/);
});
