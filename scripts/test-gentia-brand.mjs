import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const [index,theme,brandScript,server,packageJson,...logos]=await Promise.all([
  read('public/index.html'),read('public/gentia-theme.css'),read('public/gentia-brand.js'),read('src/server.ts'),read('package.json'),
  read('public/gentia-logo.svg'),read('public/gentia-logo-reversed.svg'),read('public/gentia-wordmark.svg'),read('public/gentia-wordmark-reversed.svg')
]);

for(const color of ['#042E72','#F26938','#F4F6FA','#FFFFFF'])assert.match(theme,new RegExp(color,'i'));
assert.equal((theme.match(/{/g)||[]).length,(theme.match(/}/g)||[]).length,'Las llaves del tema no están balanceadas.');
assert.doesNotMatch(theme,/linear-gradient\(|radial-gradient\(/i,'El tema GENTIA no debe introducir degradados.');
assert.match(index,/gentia-logo-reversed\.svg/);
assert.match(index,/gentia-wordmark-reversed\.svg/);
assert.match(index,/Tu gente\. Tus agentes\. Un solo sistema\./);
assert.equal(JSON.parse(packageJson).name,'gentia-erp');
assert.match(server,/gentia-theme\.css/);
assert.match(server,/gentia-brand\.js/);
assert.match(brandScript,/gentia-wordmark-reversed\.svg/);

for(const [position,logo] of logos.entries()){
  assert.match(logo,/viewBox=/,`El SVG ${position+1} no tiene viewBox.`);
  assert.match(logo,/#f26938/i,`El SVG ${position+1} no conserva el naranja oficial.`);
  assert.doesNotMatch(logo,/<script|(?:href|src)=["']https?:\/\//i,`El SVG ${position+1} debe ser autocontenido.`);
}
assert.match(logos[0],/prefers-reduced-motion:\s*reduce/);
assert.match(logos[0],/<animateMotion/);
assert.match(logos[1],/fill="#fff"/i);

const htmlNames=(await readdir(new URL('../public/',import.meta.url))).filter(name=>name.endsWith('.html'));
for(const name of htmlNames){
  const html=await read(`public/${name}`);
  assert.doesNotMatch(html,/\b(?:NEXO|Nexo)\b/,`${name} conserva marca visible anterior.`);
}

for(const path of [
  'public/accounting-reports.js','public/income-forecast-export.js','public/pending-invoice-pdf.js',
  'public/tax-obligations.js','src/modules/notifications/sales-invoice-delivery.service.ts',
  'src/modules/reports/scheduled-report-renderer.ts','src/modules/reports/scheduled-reports.service.ts',
  'src/modules/tax-calendar/tax-calendar.service.ts'
]){
  const source=await read(path);
  const compatible=source.replaceAll('NEXO_APP_URL','').replaceAll("/\\bNEXO\\b/gi",'').replaceAll('/NEXO ERP/gi','');
  assert.doesNotMatch(compatible,/\bNEXO\b/,`${path} conserva marca anterior en una salida.`);
}

console.log(JSON.stringify({passed:true,htmlPages:htmlNames.length,logos:logos.length,palette:['#042E72','#F26938','#F4F6FA','#FFFFFF'],reducedMotion:true}));
