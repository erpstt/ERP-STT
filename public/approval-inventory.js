// Operational routes are informational. Only configured workflows determine
// the status of the three document types managed on this screen.
const configurable = [
  { id: 'PURCHASE_ORDER', name: 'Órdenes de compra', module: 'Compras', detail: 'Aprueba la orden por niveles de usuario o rol antes de la recepción.' },
  { id: 'SALES_ORDER', name: 'Órdenes de venta', module: 'Ventas', detail: 'Aprueba la orden por niveles de usuario o rol antes del despacho.' },
  { id: 'BUDGET_TRANSFER', name: 'Modificaciones presupuestarias', module: 'Presupuestos', detail: 'Requiere un flujo financiero activo con niveles de aprobación.' }
];

export function approvalInventory(options = {}, workflows = []) {
  const configured = configurable.map(type => {
    const matches = workflows.filter(flow => flow.entity_type === type.id);
    const active = matches.find(flow => flow.estado_activo === true);
    const workflow = active || matches[0];
    const levels = Array.isArray(active?.rules) ? active.rules.length : 0;
    const state = active ? (levels ? 'active' : 'incomplete') : workflow ? 'inactive' : 'missing';
    const label = { active: 'Flujo activo', incomplete: 'Sin niveles', inactive: 'Flujo inactivo', missing: 'Sin flujo configurado' }[state];
    return {
      ...type, entityType: type.id, mode: 'Flujo configurable', state, label,
      statusDetail: active && levels ? `${levels} ${levels === 1 ? 'nivel de aprobación' : 'niveles de aprobación'}` : 'Requiere configuración en esta subsidiaria.',
      location: 'WORKFLOW → Flujos configurados', workflow,
      canCreate: !workflow && options.access?.canCreate === true && (options.entityTypes || []).some(entity => entity.id === type.id)
    };
  });
  return [
    {
      id: 'PAYMENT_REQUEST_CXP', name: 'Solicitudes de pago CxP', module: 'Cuentas por pagar', mode: 'Ruta automática', state: 'automatic', label: 'Ruta por subsidiaria',
      detail: 'Cada solicitud nueva utiliza el Aprobador Administrativo de la subsidiaria. Debe estar activo y autorizado.',
      statusDetail: 'El responsable se valida al enviar.', location: 'Organización → Subsidiarias → Aprobadores'
    },
    {
      id: 'PAYMENT_REQUEST_OTROS', name: 'Otros pagos', module: 'Solicitudes de pago', mode: 'Ruta automática', state: 'automatic', label: 'Ruta según solicitud',
      detail: 'Cuando requiere aprobación UP, primero aprueban los responsables UP del centro de costos o de la subsidiaria y después, obligatoriamente, el Aprobador Administrativo de la subsidiaria. Las solicitudes tributarias siguen la ruta del Supervisor tributario; las demás utilizan la ruta administrativa o su respaldo autorizado, según sus líneas.',
      statusDetail: 'Con aprobación UP, permanece pendiente hasta completar ambos pasos.', location: 'Subsidiarias y centros de costos → Aprobadores'
    },
    ...configured,
    {
      id: 'BUDGET_APPROVAL', name: 'Aprobación de presupuestos', module: 'Presupuestos', mode: 'Aprobación del módulo', state: 'module', label: 'En su módulo',
      detail: 'Aprueba y activa una versión presupuestaria mediante una acción autorizada.',
      statusDetail: 'Según los permisos del rol activo.', location: 'Contabilidad → Presupuestos'
    },
    {
      id: 'BUDGET_OVERRIDE', name: 'Sobreaprobación presupuestaria', module: 'Presupuestos', mode: 'Aprobación del módulo', state: 'module', label: 'En su módulo',
      detail: 'Autoriza o rechaza excedentes cuando el control presupuestario lo requiere. Debe aprobar una persona distinta del solicitante.',
      statusDetail: 'Según los permisos del rol activo.', location: 'Presupuestos → Modificaciones y autorizaciones'
    },
    {
      id: 'QUADRATIC_RECONCILIATION', name: 'Conciliación cuadrática', module: 'Bancos', mode: 'Aprobación del módulo', state: 'module', label: 'En su módulo',
      detail: 'Revisa, aprueba y cierra la prueba de efectivo de cuatro columnas. Requiere que las cuatro diferencias estén en cero.',
      statusDetail: 'Según los permisos del rol activo.', location: 'Bancos → Prueba de efectivo (4 columnas)'
    },
    {
      id: 'EXPENSE_APPROVAL', name: 'Aprobaciones de informes de gastos', module: 'Gastos', mode: 'Registro manual', state: 'manual', label: 'Registro manual',
      detail: 'Registra la decisión del aprobador del informe de gastos. No tiene enrutamiento automático por niveles.',
      statusDetail: 'No utiliza un flujo configurable.', location: 'Gastos → Aprobaciones de gastos'
    }
  ];
}
