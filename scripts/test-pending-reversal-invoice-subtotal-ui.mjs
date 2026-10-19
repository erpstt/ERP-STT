import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pendingReversalLimit} from '../public/pending-reversal-limit.js';

const invoice={subtotal:800,applied:150,available:650};
assert.deepEqual(pendingReversalLimit(1000,invoice),{
  maximum:650,subtotal:800,applied:150,available:650
});
assert.equal(pendingReversalLimit(500,invoice).maximum,500,'El saldo del pendiente también debe limitar el monto.');
assert.deepEqual(pendingReversalLimit(1000,null),{
  maximum:1000,subtotal:null,applied:0,available:null
});
assert.equal(pendingReversalLimit(1000,{subtotal:800,applied:800,available:0}).maximum,0);

const [html,script]=await Promise.all([
  readFile(new URL('../public/accounting-reports.html',import.meta.url),'utf8'),
  readFile(new URL('../public/accounting-reports.js',import.meta.url),'utf8')
]);
assert.match(html,/id="pendingReversalAmountHelp"/);
assert.match(script,/Sin impuestos:/);
assert.match(script,/supera el importe disponible de la factura sin impuestos/);
assert.match(script,/pendingReversalLimit\(pendingReversalBalance,invoice\)/);

console.log(JSON.stringify({subtotalLimit:true,priorUseDeducted:true,pendingBalanceLimit:true,zeroAvailability:true,uiIntegrated:true}));
