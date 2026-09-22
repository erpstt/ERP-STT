-- Renaming a function preserves its OID: existing RLS policies still reference
-- the original session helper, not the new scheduled-report wrapper.
-- Restore its previous authenticated execution privilege. The helper takes no
-- arguments and resolves only the requesting user's selected company/session.
grant execute on function public.active_subsidiary_id_without_report_context() to authenticated;
notify pgrst, 'reload schema';
