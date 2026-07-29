-- Invoice-created estimate lines are unplanned costs, not client-quoted
-- scope. Set the missing quoted side to zero so quoted-minus-actual
-- variance reports the real loss once the invoice is approved.
--
-- The audit note is deliberately narrow: do not reinterpret ordinary
-- manually-created estimate lines whose quote is still unknown.
update public.cost_lines
set quoted_to_client_ex_gst = 0
where quoted_to_client_ex_gst is null
  and deleted_at is null
  and notes like 'Created from supplier invoice line%';
