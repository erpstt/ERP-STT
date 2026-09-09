export async function loadSubsidiaryApprovers(api) {
  try {
    return await api('/api/organization/approver-options');
  } catch (error) {
    // Older running servers may still serve the updated public files.
    if (error.message !== 'El catálogo de Organización no existe.') throw error;
  }
  const [employees, users] = await Promise.all([
    api('/api/entities/employees'), api('/api/security/users')
  ]);
  const fullName = row => [row.first_name, row.last_name].filter(Boolean).join(' ');
  return [
    ...employees.map(row => ({
      approver_id: `employee:${row.employee_id}`,
      name: `${fullName(row)} · Empleado · ${row.employee_number || row.employee_id}`,
      is_active: row.is_active === true
    })),
    ...users.map(row => ({
      approver_id: `user:${row.user_id}`,
      name: `${fullName(row)} · Usuario · ${row.email}`,
      is_active: row.is_active === true
    }))
  ];
}
