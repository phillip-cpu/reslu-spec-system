-- RESLU Spec System — allow the reset audit action emitted by the
-- item material-change trigger.
--
-- Migration 005 changed reset_approval_on_material_change() so a client-
-- approved item records action='reset' when a material field changes. The
-- original approval_events check constraint still allowed only approve,
-- flag and revise, so the trigger made the entire item update fail with
-- approval_events_action_check. This surfaced through update_item_pricing
-- whenever a quoted price update also corrected quantity or supplier.
--
-- Keep reset as a first-class audit event. Do not weaken or remove the
-- constraint: unexpected action strings must still be rejected.

alter table approval_events
  drop constraint if exists approval_events_action_check;

alter table approval_events
  add constraint approval_events_action_check
  check (action in ('approve', 'flag', 'revise', 'reset'));

comment on constraint approval_events_action_check on approval_events is
  'Portal audit actions. reset is written by reset_approval_on_material_change when a material edit invalidates a previous client approval.';
