import { randomUUID } from 'node:crypto';
import type { JobRevisionPayload, FrozenJob } from './model.ts';
export function revisionFixture():FrozenJob{
 const project=randomUUID(),section=randomUUID(),line=randomUUID(),item=randomUUID(),group=randomUUID(),measurement=randomUUID(),sow=randomUUID(),scopeSection=randomUUID(),room=randomUUID();
 const payload:JobRevisionPayload={schema:1,project_id:project,markup_pct:.21,
 sections:[{id:section,project_id:project,name:'Synthetic internal',sort:0,lines:[{id:line,project_id:project,section_id:section,description:'Synthetic joinery',qty:2,unit:'ea',rate_ex_gst:100,cost_ex_gst:null,quoted_to_client_ex_gst:null,quote_status:'Q',actual_paid_ex_gst:60,source_payments:[{id:randomUUID(),source_amount_minor:100}],measurement_id:measurement,item_id:item,wastage_pct:0,markup_pct:null,gst_treatment:'gst',sort:0}]}],
 items:[{id:item,project_id:project,item_code:'TEST-1',name:'Synthetic fixture',category:'AP',quantity:2,price_trade:50,price_rrp:100,markup_pct:20,cost_scope:'direct',measurement_id:measurement,wastage_pct:0,coverage_per_unit:null,ordered_at:'2026-01-01',lead_time_weeks:2}],
 measurement_groups:[{id:group,project_id:project,name:'Areas',sort:0,measurements:[{id:measurement,project_id:project,group_id:group,label:'Area',value:2,unit:'m²',item_id:null,sort:0}]}],
 scope:{document:{id:sow,project_id:project,status:'draft',issued_at:null,revision_label:'T1'},sections:[{id:scopeSection,sow_id:sow,heading:'Synthetic room',source_room_id:room,sort:0,trade_heading_overrides:{Joiner:'Cabinetry'},lines:[{id:randomUUID(),section_id:scopeSection,text:'Synthetic build scope',kind:'inclusion',trade:'Joiner',sort:0}]}]},
 rooms:[{id:room,project_id:project,name:'Synthetic room'}],item_rooms:[{id:randomUUID(),item_id:item,room_id:room,quantity:2}],item_components:[{id:randomUUID(),item_id:item,name:'Synthetic component',quantity:1}],
 allowances:[{id:randomUUID(),description:'Included allowance',amount_inc_gst:110}],options:[{id:randomUUID(),description:'Separate option',amount_inc_gst:55,time_effect:'One day'}],payments:[{id:randomUUID(),description:'Deposit',percent:5},{id:randomUUID(),description:'Completion',percent:95}]};
 return {payload,sent_pdf:{reference:'synthetic-test.pdf',sha256:'a'.repeat(64),bytes:123},source_manifest_sha256:'b'.repeat(64),captured_at:'2026-01-01T00:00:00Z'};
}
