import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEightColumnBalanceReport } from '../dist/modules/reports/eight-column-balance-report.service.js';

function row(accountNumber, accountName, classification, values) {
  return {
    account_number: accountNumber,
    account_name: accountName,
    classification,
    debit: 0,
    credit: 0,
    debtor_balance: 0,
    creditor_balance: 0,
    asset: 0,
    liability: 0,
    loss: 0,
    gain: 0,
    ...values
  };
}

function normalize(rows, extra = {}) {
  return normalizeEightColumnBalanceReport({
    header: {
      subsidiary_id: 7,
      subsidiary_name: 'Empresa de prueba',
      currency_code: 'CLP',
      date_from: '2026-01-01',
      date_to: '2026-12-31'
    },
    rows,
    ...extra
  });
}

test('calcula la utilidad y genera totales finales igualados cuando el mayor cuadra', () => {
  const report = normalize([
    row('110100', 'Efectivo', 'ACTIVO', { debit: 1_000, debtor_balance: 1_000, asset: 1_000 }),
    row('210100', 'Obligaciones', 'PASIVO', { credit: 500, creditor_balance: 500, liability: 500 }),
    row('410100', 'Ingresos', 'GANANCIA', { credit: 800, creditor_balance: 800, gain: 800 }),
    row('510100', 'Gastos', 'PERDIDA', { debit: 300, debtor_balance: 300, loss: 300 })
  ]);

  assert.deepEqual(report.summary.subtotal, {
    debit: 1_300,
    credit: 1_300,
    debtorBalance: 1_300,
    creditorBalance: 1_300,
    asset: 1_000,
    liability: 500,
    loss: 300,
    gain: 800
  });
  assert.equal(report.summary.result.liability, 500);
  assert.equal(report.summary.result.loss, 500);
  assert.equal(report.summary.result.asset, 0);
  assert.equal(report.summary.result.gain, 0);
  assert.equal(report.summary.finalTotal.asset, report.summary.finalTotal.liability);
  assert.equal(report.summary.finalTotal.loss, report.summary.finalTotal.gain);
  assert.equal(report.summary.checks.balanced, true);
});

test('lleva una perdida al activo y a ganancia para igualar ambos bloques', () => {
  const report = normalize([
    row('110100', 'Efectivo', 'ACTIVO', { debit: 1_000, debtor_balance: 1_000, asset: 1_000 }),
    row('210100', 'Obligaciones', 'PASIVO', { credit: 1_300, creditor_balance: 1_300, liability: 1_300 }),
    row('410100', 'Ingresos', 'GANANCIA', { credit: 200, creditor_balance: 200, gain: 200 }),
    row('510100', 'Gastos', 'PERDIDA', { debit: 500, debtor_balance: 500, loss: 500 })
  ]);

  assert.equal(report.summary.result.asset, 300);
  assert.equal(report.summary.result.gain, 300);
  assert.equal(report.summary.result.liability, 0);
  assert.equal(report.summary.result.loss, 0);
  assert.equal(report.summary.finalTotal.asset, 1_300);
  assert.equal(report.summary.finalTotal.liability, 1_300);
  assert.equal(report.summary.finalTotal.loss, 500);
  assert.equal(report.summary.finalTotal.gain, 500);
  assert.equal(report.summary.checks.balanced, true);
});

test('conserva un contraactivo acreedor dentro de Activo con signo negativo', () => {
  const report = normalize([
    row('110100', 'Efectivo', 'ACTIVO', { debit: 800, debtor_balance: 800, asset: 800 }),
    row('129900', 'Depreciacion acumulada', 'ACTIVO', { credit: 200, creditor_balance: 200, asset: -200 }),
    row('210100', 'Obligaciones', 'PASIVO', { credit: 600, creditor_balance: 600, liability: 600 })
  ]);

  const contraAsset = report.rows.find(item => item.accountNumber === '129900');
  assert.ok(contraAsset);
  assert.equal(contraAsset.classification, 'ACTIVO');
  assert.equal(contraAsset.asset, -200);
  assert.equal(contraAsset.liability, 0);
  assert.equal(report.summary.subtotal.asset, 600);
  assert.equal(report.summary.subtotal.liability, 600);
  assert.equal(report.summary.checks.balanced, true);
});

test('una cuenta sin clasificacion impide certificar el balance aunque los importes cuadren', () => {
  const report = normalize([
    row('999999', 'Cuenta pendiente de clasificar', 'SIN_CLASIFICAR', { debit: 100, debtor_balance: 100 }),
    row('210100', 'Obligaciones', 'PASIVO', { credit: 100, creditor_balance: 100, liability: 100 })
  ]);

  assert.deepEqual(report.summary.classificationIssues, [{
    accountNumber: '999999',
    accountName: 'Cuenta pendiente de clasificar'
  }]);
  assert.equal(report.summary.checks.balanced, false);
});

test('no acepta una certificacion balanced=true si las diferencias calculadas son materiales', () => {
  const report = normalize([
    row('110100', 'Efectivo', 'ACTIVO', { debit: 100, debtor_balance: 100, asset: 100 })
  ], {
    summary: {
      checks: {
        debit_credit: 100,
        debtor_creditor: 100,
        inventory_vs_result: 100,
        final_inventory: 100,
        final_results: 0,
        balanced: true
      }
    }
  });

  assert.equal(report.summary.checks.debitCredit, 100);
  assert.equal(report.summary.checks.debtorCreditor, 100);
  assert.equal(report.summary.checks.balanced, false);
});

test('una diferencia subcentavo tampoco se certifica como cuadrada', () => {
  const report = normalize([
    row('110100', 'Efectivo', 'ACTIVO', { debit: 100.001, debtor_balance: 100.001, asset: 100.001 }),
    row('210100', 'Obligaciones', 'PASIVO', { credit: 100, creditor_balance: 100, liability: 100 })
  ], { summary: { checks: { balanced: true } } });

  assert.ok(Math.abs(report.summary.checks.debitCredit - 0.001) < 0.0000001);
  assert.equal(report.summary.checks.balanced, false);
});

test('respeta un balanced=false del backend aun cuando las diferencias visibles sean cero', () => {
  const report = normalize([], { summary: { checks: { balanced: false } } });
  assert.equal(report.summary.checks.balanced, false);
});
