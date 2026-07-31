# Nexo ERP

Base inicial para un ERP multiempresa. La API se organiza por módulos y capas; el cliente de Supabase se conecta mediante el adaptador de `core/database`.

## Inicio rápido

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`. Para la demostración use cualquier correo corporativo y una contraseña de 6 o más caracteres.

## Estructura

- `core`: infraestructura transversal, guardas y manejo de errores.
- `modules`: lógica de negocio aislada por dominio.
- `shared`: contratos y utilidades reutilizables.

La autenticación actual es un adaptador de demostración. Sustituya `DemoAuthRepository` por el repositorio de Supabase al configurar las credenciales y políticas RLS.
