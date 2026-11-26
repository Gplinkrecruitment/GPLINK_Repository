-- CEO "Pipeline & money" board: the owner's override on a mirrored Xero invoice
-- (26 Nov 2026). Some invoices were copied into Xero from Zoho and never
-- reconciled, so Xero still shows them AUTHORISED (unpaid) although the money
-- reached the bank long ago. The owner marks them here; the board then stops
-- counting them as owed and lists them as "paid — fix in Xero".
--
-- The hourly Xero sync (lib/xero.js mapInvoice + server.js upsertInvoices) never
-- sends these columns, and PostgREST merge-duplicates only updates the columns
-- it is sent, so a sync never wipes an override.
--
--   owner_status  'paid_outside_xero' | 'not_owed' | 'chase' | null
--   owner_note    why (e.g. the bank line that shows the payment)
--   owner_set_at  when the owner set it
--   owner_set_by  who set it

alter table public.xero_invoices
  add column if not exists owner_status text null,
  add column if not exists owner_note text,
  add column if not exists owner_set_at timestamptz,
  add column if not exists owner_set_by text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'xero_invoices_owner_status_check'
      and conrelid = 'public.xero_invoices'::regclass
  ) then
    alter table public.xero_invoices
      add constraint xero_invoices_owner_status_check
      check (owner_status in ('paid_outside_xero', 'not_owed', 'chase'));
  end if;
end $$;
