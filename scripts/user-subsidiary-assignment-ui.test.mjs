import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const css = read('public/dashboard.css');
const server = read('src/server.ts');
const security = read('src/modules/security-catalogs/security-catalogs.module.ts');

const syntax = spawnSync(process.execPath, ['--check', 'public/app.js'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8'
});
assert.equal(syntax.status, 0, syntax.stderr || 'public/app.js no tiene sintaxis válida.');

const catalog = app.match(/\{slug:'user-subsidiaries'.*?\}\]},/s)?.[0] ?? '';
assert.ok(catalog, 'Falta el catálogo frontend Empresas por usuario.');
assert.match(catalog, /primaryKey:'user_id'/, 'La vista debe consolidarse por usuario.');
assert.match(catalog, /allowDelete:false/, 'La asignación no debe eliminarse fila por fila.');
assert.match(catalog, /allowAudit:false/, 'La fila agregada no debe usar la auditoría de un vínculo individual.');
assert.match(catalog, /key:'user_id'.*reference:'security\/users'.*readOnlyOnEdit:true/s);
assert.match(catalog, /key:'subsidiary_ids'.*type:'multi-reference'.*reference:'organization\/subsidiaries'/s);
assert.doesNotMatch(catalog, /key:'subsidiary_id'/, 'No debe conservarse el selector de una sola empresa.');

assert.match(app, /slug==='user-subsidiaries'\)this\.referenceOptions\['security\/users'\]=this\.rows/,
  'Los usuarios agregados deben alimentar el selector sin una consulta duplicada.');
assert.match(app, /isUserSubsidiaryOptions.*\/api\/security\/user-subsidiaries\/options/s,
  'La lista completa de filiales debe provenir del endpoint protegido de opciones.');
assert.match(app, /handleReferenceFieldChange\(field\).*selected\?\.subsidiary_ids/s,
  'Al escoger un usuario deben precargarse sus filiales actuales.');
assert.match(app, /field\.type==='multi-reference'\?\[\.\.\.\(Array\.isArray\(value\)\?value:\[\]\)\]/,
  'La selección del formulario debe clonarse para que Cancelar no modifique la fila original.');
assert.match(app, /validateUserSubsidiaries\(\).*Seleccione al menos una subsidiaria/s,
  'El formulario debe impedir una asignación accidentalmente vacía.');
assert.match(app, /const result=await this\.api\(`\$\{this\.catalogPath\(\)\}.*body:JSON\.stringify\(payload\)/s,
  'El formulario debe guardar la selección completa en una sola solicitud.');
assert.doesNotMatch(app, /user-subsidiaries[\s\S]{0,500}(forEach|Promise\.all)[\s\S]{0,250}(POST|PATCH|DELETE)/,
  'La UI no debe sincronizar cada vínculo con solicitudes separadas.');

assert.match(html, /Asignar empresas/);
assert.match(html, /'user-company-access-modal':activeCatalog\.slug==='user-subsidiaries'/);
assert.match(html, /\['chart-accounts','user-subsidiaries'\]\.includes\(activeCatalog\.slug\).*field\.key==='subsidiary_ids'/s);
assert.match(html, /v-model\.trim="accountSubsidiarySearch"[^>]+placeholder="Buscar subsidiaria"/);
assert.match(html, /'Seleccionar todas'/);
assert.match(html, /'filiales asignadas'/);
assert.match(html, /'Acceso completo'/);
assert.match(html, /field\.readOnlyOnEdit.*recordDialog\.id/);
assert.match(html, /activeCatalog\.allowAudit !== false/);
assert.match(html, /'Guardar asignación'/);

assert.match(css, /\.modal\.user-company-access-modal:has\(\.form-grid\)/);
assert.match(css, /\.user-company-access-modal \.multi-select/);
assert.match(css, /\[data-field-key="user_id"\]/);

assert.match(security, /security_user_subsidiary_assignments/,
  'El backend debe listar una fila agregada por usuario.');
assert.match(security, /security_sync_user_subsidiaries/,
  'El backend debe sincronizar la selección de forma atómica.');
assert.match(server, /\/api\/security\/user-subsidiaries\/options/,
  'Falta la ruta que devuelve la lista completa de subsidiarias.');

console.log('PASS: selector de usuario, lista completa con checks, precarga, guardado único y protecciones visuales.');
