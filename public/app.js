import { createApp } from '/assets/vue.js';

const tables = {
  Empresa: {
    title: 'Empresas', copy: 'Administra la información de tus empresas.', add: '+ Nueva empresa',
    headers: ['Empresa', 'Identificación', 'País', 'Estado', ''],
    rows: [['Nexo Demo S.A.', '3-101-928472', 'Costa Rica', 'Activa'], ['Comercial Horizonte S.R.L.', '3-102-736291', 'Costa Rica', 'Activa']]
  },
  Clientes: {
    title: 'Clientes', copy: 'Gestiona los clientes de tu empresa.', add: '+ Nuevo cliente',
    headers: ['Cliente', 'Identificación', 'Correo', 'Estado', ''],
    rows: [['Distribuidora Central S.A.', '3-101-230451', 'ventas@central.co.cr', 'Activo'], ['Tecnología Prisma S.R.L.', '3-102-619845', 'compras@prisma.co.cr', 'Activo']]
  },
  Proveedores: {
    title: 'Proveedores', copy: 'Administra los proveedores y sus datos comerciales.', add: '+ Nuevo proveedor',
    headers: ['Proveedor', 'Identificación', 'Contacto', 'Estado', ''],
    rows: [['Suministros del Valle S.A.', '3-101-847201', 'Ana Ramírez', 'Activo'], ['Logística Atlas S.R.L.', '3-102-593017', 'Carlos Mora', 'Activo']]
  }
};

createApp({
  data: () => ({
    email: '', password: '', remember: true, showPassword: false, isSubmitting: false,
    formError: '', authenticated: false, sidebarOpen: false, currentSection: 'Inicio',
    userName: 'equipo', search: ''
  }),
  computed: {
    activeTable() { return tables[this.currentSection] ?? null; },
    filteredRows() {
      if (!this.activeTable) return [];
      const term = this.search.trim().toLocaleLowerCase();
      return term ? this.activeTable.rows.filter(row => row.some(cell => cell.toLocaleLowerCase().includes(term))) : this.activeTable.rows;
    },
    userInitial() { return this.userName.charAt(0).toUpperCase(); }
  },
  methods: {
    async signIn() {
      this.formError = '';
      this.isSubmitting = true;
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.email, password: this.password })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'No fue posible iniciar sesión.');
        sessionStorage.setItem('nexo_token', data.accessToken);
        this.userName = data.user.name;
        this.authenticated = true;
      } catch (cause) {
        this.formError = cause instanceof Error ? cause.message : 'No fue posible iniciar sesión.';
      } finally { this.isSubmitting = false; }
    },
    navigate(section) { this.currentSection = section; this.search = ''; this.sidebarOpen = false; },
    logout() {
      sessionStorage.removeItem('nexo_token');
      this.authenticated = false; this.password = ''; this.formError = ''; this.currentSection = 'Inicio';
    }
  }
}).mount('#app');
