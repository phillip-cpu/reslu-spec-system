-- Run after the binary/candidate migration. All fixtures roll back.
begin;
do $$
declare product uuid; category_code text; first_job uuid; second_job uuid; rows_seen integer; before_items bigint;
begin
 if has_table_privilege('anon','public.library_product_documents','select') then raise exception 'Anonymous document access'; end if;
 if has_table_privilege('authenticated','public.library_product_documents','update') or has_table_privilege('authenticated','public.library_product_documents','delete') then raise exception 'Document history is not append-only'; end if;

 select prefix into category_code from public.categories limit 1;
 select id into first_job from public.projects where deleted_at is null order by id limit 1;
 select id into second_job from public.projects where deleted_at is null and id<>first_job order by id limit 1;
 select count(*) into before_items from public.items;
 insert into public.library_items(name,category) values('ROLLBACK ONLY binary reuse contract',category_code) returning id into product;
 insert into public.library_product_documents(library_item_id,kind,url,label,storage_path,filename,mime_type,size_bytes,sha256,version_note) values
 (product,'install_manual','https://example.com/manual.pdf','Test revision 1','library/'||product||'/documents/11111111-1111-1111-1111-111111111111-manual.pdf','manual.pdf','application/pdf',100,repeat('a',64),'v1'),
 (product,'install_manual','https://example.com/manual.pdf','Test revision 2','library/'||product||'/documents/22222222-2222-2222-2222-222222222222-manual.pdf','manual.pdf','application/pdf',101,repeat('b',64),'v2');
 update public.projects set settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object('builder_workspace',coalesce(settings->'builder_workspace','{}'::jsonb)||jsonb_build_object('candidates',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'library_item_id',product,'selection_scope','shared','selection_key',null)))) where id in (first_job,second_job);
 select count(*) into rows_seen from public.projects p cross join lateral jsonb_array_elements(p.settings#>'{builder_workspace,candidates}') c join public.library_product_documents d on d.library_item_id=(c->>'library_item_id')::uuid where p.id in (first_job,second_job) and d.library_item_id=product;
 if rows_seen<>4 then raise exception 'Two jobs did not resolve both stored revisions'; end if;
 if (select count(*) from public.items)<>before_items then raise exception 'Unknown quantity entered costable items'; end if;
end $$;
rollback;
