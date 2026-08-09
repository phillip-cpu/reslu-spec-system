-- Permit the creator to receive the newly inserted conversation row before
-- the API adds conversation_participants in the immediately following write.
-- Without this, PostgREST's insert + select representation is rejected by the
-- SELECT policy because membership does not exist until the second statement.

drop policy if exists "members_read_conversations" on conversations;
create policy "members_read_conversations" on conversations
  for select to authenticated
  using (created_by = auth.uid() or is_conversation_member(id));

comment on policy "members_read_conversations" on conversations is
  'Conversation members can read a thread. Its creator may also read the newly inserted row during the short API transaction gap before their participant membership is added.';

notify pgrst, 'reload schema';
