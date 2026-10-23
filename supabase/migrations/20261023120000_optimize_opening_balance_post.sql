-- Keep opening-balance posting below the PostgREST statement timeout.
--
-- `journal_line_gl_impact_sync` is intentionally a row trigger for normal
-- journal maintenance.  During an opening, however, every new journal line
-- used to delete and rebuild every GL impact accumulated so far.  Posting N
-- lines therefore performed O(N^2) GL writes (and the same amount of central
-- audit work).  The opening workflow already sets
-- `app.opening_balance_internal = 1` and builds the definitive GL impacts once
-- after all journal lines exist, including their historical currency fields.
-- Skip only the redundant intermediate synchronizations in that controlled
-- context.  Normal journals retain their immediate synchronization.

create or replace function public.sync_journal_gl_impacts_trigger()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if coalesce(current_setting('app.opening_balance_internal',true),'')='1' then
    if tg_op='DELETE' then return old;end if;
    return new;
  end if;

  perform public.sync_journal_gl_impacts(coalesce(new.journal_id,old.journal_id));
  if tg_op='DELETE' then return old;end if;
  return new;
end
$$;

revoke all on function public.sync_journal_gl_impacts_trigger()
  from public,anon,authenticated;

comment on function public.sync_journal_gl_impacts_trigger() is
 'Sincroniza el Mayor por línea en asientos ordinarios y difiere la sincronización durante una apertura, cuyo flujo inserta el impacto definitivo una sola vez.';

notify pgrst,'reload schema';
