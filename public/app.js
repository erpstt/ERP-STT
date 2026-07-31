const form = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const toggle = document.querySelector('.toggle-pass');
const error = document.querySelector('#formError');
const button = document.querySelector('#submitButton');
const tables = {
  Empresa: { title: 'Empresas', copy: 'Administra la información de tus empresas.', add: '+ Nueva empresa', headers: ['Empresa', 'Identificación', 'País', 'Estado', ''], rows: [['Nexo Demo S.A.', '3-101-928472', 'Costa Rica', 'Activa'], ['Comercial Horizonte S.R.L.', '3-102-736291', 'Costa Rica', 'Activa']] },
  Clientes: { title: 'Clientes', copy: 'Gestiona los clientes de tu empresa.', add: '+ Nuevo cliente', headers: ['Cliente', 'Identificación', 'Correo', 'Estado', ''], rows: [['Distribuidora Central S.A.', '3-101-230451', 'ventas@central.co.cr', 'Activo'], ['Tecnología Prisma S.R.L.', '3-102-619845', 'compras@prisma.co.cr', 'Activo']] },
  Proveedores: { title: 'Proveedores', copy: 'Administra los proveedores y sus datos comerciales.', add: '+ Nuevo proveedor', headers: ['Proveedor', 'Identificación', 'Contacto', 'Estado', ''], rows: [['Suministros del Valle S.A.', '3-101-847201', 'Ana Ramírez', 'Activo'], ['Logística Atlas S.R.L.', '3-102-593017', 'Carlos Mora', 'Activo']] }
};
function showTable(section) { const table = tables[section]; if (!table) return; document.querySelector('#dashboardView').hidden = true; document.querySelector('#recordsView').hidden = false; document.querySelector('#recordsTitle').textContent = table.title; document.querySelector('#recordsCopy').textContent = table.copy; document.querySelector('#newRecord').textContent = table.add; document.querySelector('#recordsHead').innerHTML = `<tr>${table.headers.map(h => `<th>${h}</th>`).join('')}</tr>`; document.querySelector('#recordsBody').innerHTML = table.rows.map(row => `<tr>${row.map((cell, index) => `<td>${index === 3 ? `<span class="status">${cell}</span>` : cell}</td>`).join('')}<td>•••</td></tr>`).join(''); document.querySelector('#recordsCount').textContent = `${table.rows.length} registros`; }

toggle.addEventListener('click', () => {
  const reveal = password.type === 'password';
  password.type = reveal ? 'text' : 'password';
  toggle.textContent = reveal ? '◌' : '◉';
  toggle.setAttribute('aria-label', reveal ? 'Ocultar contraseña' : 'Mostrar contraseña');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault(); error.textContent = '';
  const values = Object.fromEntries(new FormData(form));
  button.disabled = true; button.querySelector('span').textContent = 'Verificando acceso…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'No fue posible iniciar sesión.');
    sessionStorage.setItem('nexo_token', data.accessToken);
    document.querySelector('#dashboardName').textContent = data.user.name;
    document.querySelector('#userInitial').textContent = data.user.name.charAt(0).toUpperCase();
    document.querySelector('.page-shell').hidden = true;
    document.querySelector('#workspace').hidden = false;
  } catch (cause) { error.textContent = cause.message; }
  finally { button.disabled = false; button.querySelector('span').textContent = 'Ingresar a Nexo'; }
});
document.querySelector('#backButton').addEventListener('click', () => { document.querySelector('#successView').hidden = true; document.querySelector('#authView').hidden = false; });
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active'));
  link.classList.add('active'); document.querySelector('#pageTitle').textContent = link.dataset.section;
  if (tables[link.dataset.section]) showTable(link.dataset.section); else { document.querySelector('#recordsView').hidden = true; document.querySelector('#dashboardView').hidden = false; }
  document.querySelector('.sidebar').classList.remove('open');
}));
document.querySelector('#menuButton').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
document.querySelector('#logoutButton').addEventListener('click', () => { sessionStorage.removeItem('nexo_token'); document.querySelector('#workspace').hidden = true; document.querySelector('.page-shell').hidden = false; form.reset(); });
