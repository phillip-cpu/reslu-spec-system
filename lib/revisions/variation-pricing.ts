import { lineCost, lineClientPrice, ffeDerivedQuantity, roundMoney } from '../estimate.ts';
import { ffeClientQuoteUnitPrice, ffeProductCostUnitPrice } from '../ffe-pricing.ts';
import { revisionEstimate, type JobRevisionPayload } from './model.ts';

type PricedRow={id:string;origin:string;description:string;cost:number;selling:number;markup:number};
function prices(p:JobRevisionPayload):PricedRow[]{
 const measurements=new Map(p.measurement_groups.flatMap(g=>g.measurements).map(m=>[m.id,{value:Number(m.value)}]));
 const trades=p.sections.flatMap(s=>s.lines.map(row=>{
  const line=row as unknown as Parameters<typeof lineCost>[0];
  const measurement=measurements.get(String(row.measurement_id));
  const cost=lineCost(line,measurement)??0;
  return {id:row.id,origin:String(row.origin_id??row.id),description:String(row.description??''),cost,
   selling:lineClientPrice(line as Parameters<typeof lineClientPrice>[0],p.markup_pct,measurement)??0,markup:p.markup_pct};
 }));
 const items=p.items.filter(i=>i.cost_scope!=='trade_package').map(row=>{
  const item=row as unknown as Parameters<typeof ffeDerivedQuantity>[0];
  const qty=ffeDerivedQuantity(item,measurements.get(String(row.measurement_id))??null);
  const cost=roundMoney(qty*(ffeProductCostUnitPrice(row as unknown as Parameters<typeof ffeProductCostUnitPrice>[0])??0));
  const selling=roundMoney(qty*(ffeClientQuoteUnitPrice(row as unknown as Parameters<typeof ffeClientQuoteUnitPrice>[0])??0));
  return {id:row.id,origin:String(row.origin_id??row.id),description:String(row.name??''),cost,selling,markup:typeof row.markup_pct==='number'?row.markup_pct/100:0};
 });return [...trades,...items];
}

/** Omission credits are COST ONLY. Original dollar profit survives all omissions.
 * Additions attract the applicable markup on the extra cost. GST is applied once
 * to the resulting selling adjustment, never used as profit. No accounting writes.
 */
export function priceRevisionVariation(baseline:JobRevisionPayload,working:JobRevisionPayload){
 const before=prices(baseline),after=prices(working),byOrigin=new Map(after.map(r=>[r.origin,r]));
 const changes:{id:string;description:string;cost_delta_ex_gst:number;profit_added_ex_gst:number;selling_delta_ex_gst:number}[]=[];
 const add=(old:PricedRow|undefined,next:PricedRow|undefined)=>{
  const cost=roundMoney((next?.cost??0)-(old?.cost??0));
  const profit=cost>0?roundMoney(cost*(next?.markup??baseline.markup_pct)):0;
  if(cost!==0)changes.push({id:(next??old)!.id,description:(next??old)!.description,cost_delta_ex_gst:cost,profit_added_ex_gst:profit,selling_delta_ex_gst:roundMoney(cost+profit)});
 };
 for(const old of before){add(old,byOrigin.get(old.id));byOrigin.delete(old.id);}
 for(const next of byOrigin.values())add(undefined,next);
 // Use the established category/global rounding, not a sum of rounded FF&E rows.
 const original=revisionEstimate(baseline),revised=revisionEstimate(working);
 const baselineCost=roundMoney(original.rollup.allTradesSubtotalExGst+original.rollup.approvedVariationsExGst+original.ffe.total),baselineSelling=original.wholeJob.combinedExGst;
 const costDelta=roundMoney(revised.rollup.allTradesSubtotalExGst+revised.rollup.approvedVariationsExGst+revised.ffe.total-baselineCost),profitAdded=roundMoney(changes.reduce((n,r)=>n+r.profit_added_ex_gst,0));
 const rounding=roundMoney(costDelta-changes.reduce((n,r)=>n+r.cost_delta_ex_gst,0));
 if(rounding && changes.length){const last=changes[changes.length-1];last.cost_delta_ex_gst=roundMoney(last.cost_delta_ex_gst+rounding);last.selling_delta_ex_gst=roundMoney(last.selling_delta_ex_gst+rounding);}

 const sellingDelta=roundMoney(costDelta+profitAdded),selling=roundMoney(baselineSelling+sellingDelta),gst=roundMoney(selling*.1);
 return {changes,baseline_cost_ex_gst:baselineCost,baseline_selling_ex_gst:baselineSelling,baseline_profit_ex_gst:roundMoney(baselineSelling-baselineCost),
  cost_delta_ex_gst:costDelta,profit_added_ex_gst:profitAdded,profit_ex_gst:roundMoney(baselineSelling-baselineCost+profitAdded),selling_delta_ex_gst:sellingDelta,
  selling_ex_gst:selling,gst,total_inc_gst:roundMoney(selling+gst)};
}
