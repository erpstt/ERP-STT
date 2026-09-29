import assert from 'node:assert/strict';
import { renderTaxCalendarEmail } from '../dist/modules/tax-calendar/tax-calendar.service.js';

const rendered = renderTaxCalendarEmail({
  id: 'test-job',
  lease: 'test-lease',
  recipient_email: 'tax@example.com',
  priority: 'normal',
  payload: {
    taxTypeCode: 'IVA_MENSUAL',
    taxTypeName: 'Declaración mensual de IVA',
    period: '2026-09',
    dueDate: '2026-09-30',
    daysBeforeDue: 3,
    status: 'pending',
    subsidiaryName: 'Empresa de Pruebas',
    assignedUserName: 'Ana Contadora',
    deepLink: '/tax-calendar.html?event=demo',
    templateSubject: 'Aviso · {{obligacion}} · {{empresa}} · {{mensaje_vencimiento}}',
    templateBody: 'Hola {{responsable}}.\nRevise {{codigo}} del período {{periodo}}.\n<script>alert(1)</script>'
  }
});

assert.equal(rendered.subject, 'Aviso · Declaración mensual de IVA · Empresa de Pruebas · Vence en 3 días');
assert.match(rendered.text, /Hola Ana Contadora\./);
assert.match(rendered.text, /IVA_MENSUAL del período 2026-09/);
assert.doesNotMatch(rendered.html, /<script>/i);
assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/i);
assert.match(rendered.html, /Declaración mensual de IVA/);

const fallback = renderTaxCalendarEmail({
  id: 'legacy-job', lease: 'legacy-lease', recipient_email: 'tax@example.com', priority: 'high',
  payload: { taxTypeCode: 'RENTA', period: '2026-FY', dueDate: '2027-03-31', status: 'overdue', subsidiaryName: 'Empresa' }
});
assert.match(fallback.subject, /^URGENTE/);
assert.match(fallback.html, /PRIORIDAD ALTA/);

console.log(JSON.stringify({templateSubstitution:true,plainTextEscaping:true,professionalWrapper:true,legacyFallback:true}));
