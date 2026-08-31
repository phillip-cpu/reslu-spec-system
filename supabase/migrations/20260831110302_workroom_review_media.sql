-- Review media is separate from the immutable agent artifact. Each preview is
-- bound to the exact source hash named by the artifact, stored privately, and
-- readable only by members of the artifact's conversation.

create table if not exists public.agent_task_artifact_media (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.agent_task_artifacts(id) on delete cascade,
  asset_key text not null check (char_length(asset_key) between 1 and 500),
  preview_storage_path text not null unique check (char_length(preview_storage_path) between 1 and 1000),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  preview_sha256 text not null check (preview_sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/avif')),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  byte_size bigint not null check (byte_size > 0),
  created_at timestamptz not null default now(),
  unique (artifact_id, asset_key)
);

create index if not exists agent_task_artifact_media_artifact_idx
  on public.agent_task_artifact_media(artifact_id);

alter table public.agent_task_artifact_media enable row level security;

drop policy if exists "members_read_agent_task_artifact_media" on public.agent_task_artifact_media;
create policy "members_read_agent_task_artifact_media"
  on public.agent_task_artifact_media
  for select to authenticated
  using (
    exists (
      select 1
      from public.agent_task_artifacts artifact
      join public.agent_tasks task on task.id = artifact.task_id
      where artifact.id = agent_task_artifact_media.artifact_id
        and public.is_conversation_member(task.conversation_id)
    )
  );

revoke all on public.agent_task_artifact_media from anon;
grant select on public.agent_task_artifact_media to authenticated;

comment on table public.agent_task_artifact_media is
  'Private review derivatives bound to exact source hashes; service-role ingest only, conversation-member read only.';

notify pgrst, 'reload schema';
