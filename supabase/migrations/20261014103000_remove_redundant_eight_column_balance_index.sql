-- El índice general de reportes ya cubre exactamente estas columnas.
-- Se elimina el índice redundante creado con la primera versión del reporte
-- para no duplicar almacenamiento ni costo de escritura en el Libro Mayor.
drop index if exists public.gl_impact_eight_column_balance_idx;
