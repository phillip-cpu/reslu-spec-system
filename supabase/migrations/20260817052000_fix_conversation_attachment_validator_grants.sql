-- The voice-note metadata validator is referenced by CHECK constraints on
-- every conversation attachment, including photos and PDFs. PostgreSQL
-- evaluates that function as the inserting role, so authenticated uploads
-- require EXECUTE even though the function is not an exposed RPC.

revoke all on function public.valid_conversation_voice_note_metadata(text, jsonb)
  from public, anon;
grant execute on function public.valid_conversation_voice_note_metadata(text, jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';
