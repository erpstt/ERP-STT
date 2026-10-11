import assert from 'node:assert/strict';

const values = new Map();
globalThis.location = new URL('http://localhost:3000/');
globalThis.sessionStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};

const navigation = await import('../public/workspace-navigation.js');
assert.equal(navigation.normalizeWorkspacePath('/payment-requests.html?id=42&company=7'), '/payment-requests.html?id=42&subsidiaryId=7');
assert.equal(navigation.normalizeWorkspacePath('https://example.com/payment-requests.html?id=42'), null);
assert.equal(navigation.normalizeWorkspacePath('/api/treasury/payment-requests/detail?id=42'), null);
assert.equal(navigation.normalizeWorkspacePath('/payment-requests.html?id=invalid&subsidiaryId=7'), null);

sessionStorage.setItem('nexo_workspace_redirect', JSON.stringify({
  path: '/payment-requests.html?id=42&subsidiaryId=7',
  createdAt: Date.now()
}));
assert.deepEqual(navigation.getPendingWorkspace(), {
  path: '/payment-requests.html?id=42&subsidiaryId=7',
  subsidiaryId: '7'
});
assert.ok(sessionStorage.getItem('nexo_workspace_redirect'), 'La consulta no debe consumir el destino antes del inicio de sesión.');
assert.equal(navigation.consumePendingWorkspace()?.path, '/payment-requests.html?id=42&subsidiaryId=7');
assert.equal(sessionStorage.getItem('nexo_workspace_redirect'), null);

console.log(JSON.stringify({sameOrigin:true,allowedRoute:true,companyAlias:true,preservedUntilLogin:true,consumedOnce:true}));
