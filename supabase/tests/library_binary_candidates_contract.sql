-- Run after the binary/candidate migration. All fixtures roll back.
begin;
do $$
declare product uuid; category_code text; first_job uuid; second_job uuid; rows_seen integer; before_items bigint;
begin
 if has_table_privilege('anon','public.project_library_candidates','select') then raise exception 'Anonymous candidate access'; end if;
 if has_table_privilege('authenticated','public.library_product_documents','update') or has_table_privilege('authenticated','public.library_product_documents','delete') then raise exception 'Document history is not append-only'; end if;
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='project_library_candidates' and column_name in ('quantity','price_trade','price_rrp','client_approved','ordered_at')) then raise exception 'Candidate became costable/orderable'; end if;
 select prefix into category_code from public.categories limit 1;
 select id into first_job from public.projects where deleted_at is null order by id limit 1;
 select id into second_job from public.projects where deleted_at is null and id<>first_job order by id limit 1;
 select count(*) into before_items from public.items;
 insert into public.library_items(name,category) values('ROLLBACK ONLY binary reuse contract',category_code) returning id into product;
 insert into public.library_product_documents(library_item_id,kind,url,label,storage_path,filename,mime_type,size_bytes,sha256,version_note) values
 (product,'install_manual','https://example.com/manual.pdf','Test revision 1','library/'||product||'/documents/11111111-1111-1111-1111-111111111111-manual.pdf','manual.pdf','application/pdf',100,repeat('a',64),'v1'),
 (product,'install_manual','https://example.com/manual.pdf','Test revision 2','library/'||product||'/documents/22222222-2222-2222-2222-222222222222-manual.pdf','manual.pdf','application/pdf',101,repeat('b',64),'v2');
 insert into public.project_library_candidates(project_id,library_item_id) values(first_job,product),(second_job,product);
 select count(*) into rows_seen from public.project_library_candidates c join public.library_product_documents d on d.library_item_id=c.library_item_id where c.library_item_id=product;
 if rows_seen<>4 then raise exception 'Two jobs did not resolve both stored revisions'; end if;
 if (select count(*) from public.items)<>before_items then raise exception 'Unknown quantity entered costable items'; end if;
end $$;
rollback;
