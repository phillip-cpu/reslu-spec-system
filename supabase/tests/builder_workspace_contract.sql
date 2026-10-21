begin;
do $$
declare product uuid; category_code text; job uuid; seen integer;
begin
 if has_table_privilege('anon','public.builder_profiles','select') or has_table_privilege('anon','public.library_product_documents','select') then raise exception 'Anonymous access expanded'; end if;
 if has_table_privilege('authenticated','public.library_product_documents','update') or has_table_privilege('authenticated','public.library_product_documents','delete') then raise exception 'Documentation history must be append-only'; end if;
 if exists(select 1 from pg_class where oid in ('public.builder_profiles'::regclass,'public.builder_library_selections'::regclass,'public.library_product_documents'::regclass) and not relrowsecurity) then raise exception 'RLS disabled'; end if;
 select prefix into category_code from public.categories limit 1;
 insert into public.library_items(name,category) values('ROLLBACK ONLY documentation reuse test',category_code) returning id into product;
 insert into public.library_product_documents(library_item_id,kind,url,label,version_note) values(product,'install_manual','https://example.com/rollback-test-v1.pdf','Rollback test manual','v1'),(product,'install_manual','https://example.com/rollback-test-v2.pdf','Rollback test manual','v2');
 for job in select id from public.projects where deleted_at is null order by id limit 2 loop
  insert into public.items(project_id,library_item_id,name,category,quantity,client_approved) values(job,product,'ROLLBACK ONLY documentation reuse test',category_code,0,false);
 end loop;
 select count(*) into seen from public.items i join public.library_product_documents d on d.library_item_id=i.library_item_id where i.library_item_id=product;
 if seen<>4 then raise exception 'Both jobs must resolve both product document revisions'; end if;
 if exists(select 1 from public.items where library_item_id=product and (client_approved or quantity<>0)) then raise exception 'Association fabricated approval or measured quantity'; end if;
end $$;
rollback;
