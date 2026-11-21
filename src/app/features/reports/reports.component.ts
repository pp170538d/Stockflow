import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { LocationPickerComponent } from '../../shared/ui/location-picker.component';
import { BusinessObject } from '../objects/object.model';
import { reasonLabel } from '../../core/stock/reason-codes';

type Tab = 'performance' | 'margin' | 'accuracy';
type ClassName = 'fast' | 'normal' | 'slow' | 'dead' | 'stockout' | 'idle';

interface PerformanceRow {
  object_id:string; object_name:string; product_id:string; sku:string; product_name:string; category:string|null;
  on_hand:number; sold:number; avg_stock:number; turnover:number|null; days_of_stock:number|null; days_out:number;
  revenue:number|null; cogs:number|null; margin:number|null; priced_share:number|null; stock_value:number|null;
  last_sale_at:string|null; class:ClassName; requested_days:number; history_days:number; history_coverage:number; history_start:string|null;
}
interface Summary {
  currency:string; inventory_value:number; turnover:number|null; days_of_inventory:number|null; revenue:number;
  cogs:number; margin:number; gross_margin_pct:number|null; slow_dead_value:number; slow_dead_share:number|null;
  history_days_min:number; history_days_max:number; history_complete:boolean; history_coverage:number;
  cost_coverage:number|null; price_coverage:number|null; classes:Record<ClassName,number>;
}
interface AccuracyBlock {
  lines:number; exact_lines:number; short_lines:number; over_lines:number; affected_products:number;
  accuracy_pct:number|null; variance_value:number; shrinkage_value:number; value_coverage:number|null;
  sessions?:number; deliveries?:number;
}
interface AccuracyIssue {
  object_id:string; object_name:string; product_id:string; sku:string; product_name:string;
  count_issues:number; delivery_issues:number; total_issues:number; issue_value:number; last_issue_at:string;
}
interface AccuracyReason { type:'count'|'delivery'; code:string; occurrences:number; value:number; }
interface CountIssue {
  count_id:string; object_id:string; object_name:string; product_id:string; sku:string; product_name:string;
  expected_qty:number; counted_qty:number; variance:number; reason:string|null; reason_code:string|null; variance_value:number|null; counted_at:string;
}
interface DeliveryIssue {
  order_id:string; object_id:string; object_name:string; product_id:string; sku:string; product_name:string;
  ordered_qty:number; delivered_qty:number; variance:number; reason:string|null; reason_code:string|null; variance_value:number|null; delivered_at:string;
}
interface AccuracyReport {
  initialization:{ sessions:number; lines:number; variance_lines:number; variance_value:number; excluded_from_accuracy:boolean };
  days:number; currency:string; generated_at:string; counts:AccuracyBlock; deliveries:AccuracyBlock;
  top_issues:AccuracyIssue[]; reasons:AccuracyReason[];
  recent_count_issues:CountIssue[]; recent_delivery_issues:DeliveryIssue[];
}

@Component({
  selector:'app-reports', standalone:true,
  imports:[DatePipe, DecimalPipe, PercentPipe, RouterLink, LocationPickerComponent],
  templateUrl:'./reports.component.html',
})
export class ReportsComponent implements OnInit {
  readonly auth=inject(AuthService);
  private route=inject(ActivatedRoute);
  private router=inject(Router);

  readonly tab=signal<Tab>('performance');
  readonly days=signal(30);
  readonly selectedObjectId=signal('');
  readonly classFilter=signal<ClassName|''>('');
  readonly search=signal('');
  readonly objects=signal<BusinessObject[]>([]);
  readonly rows=signal<PerformanceRow[]>([]);
  readonly summary=signal<Summary|null>(null);
  readonly accuracy=signal<AccuracyReport|null>(null);
  readonly loading=signal(false);
  readonly error=signal<string|null>(null);
  readonly exporting=signal(false);
  readonly ranges=[7,30,90,365];
  readonly classes:ClassName[]=['fast','normal','slow','dead','stockout','idle'];

  readonly reportLocations=computed(()=>[{id:'',name:'All locations'},...this.objects()]);
  readonly filtered=computed(()=>{
    const q=this.search().trim().toLowerCase(), c=this.classFilter();
    return this.rows().filter(r=>(!c||r.class===c)&&(!q||r.product_name.toLowerCase().includes(q)||r.sku.toLowerCase().includes(q)||r.object_name.toLowerCase().includes(q)));
  });
  readonly marginRows=computed(()=>[...this.filtered()].filter(r=>r.sold>0).sort((a,b)=>(b.margin??-Infinity)-(a.margin??-Infinity)));
  readonly accuracyIssues=computed(()=>{
    const a=this.accuracy(); if(!a) return 0;
    return a.counts.short_lines+a.counts.over_lines+a.deliveries.short_lines+a.deliveries.over_lines;
  });
  readonly shrinkage=computed(()=>{
    const a=this.accuracy(); return a ? (a.counts.shrinkage_value??0)+(a.deliveries.shrinkage_value??0) : 0;
  });
  readonly maxReasonCount=computed(()=>Math.max(1,...(this.accuracy()?.reasons??[]).map(r=>r.occurrences)));
  readonly totalAccuracyExposure=computed(()=>{
    const a=this.accuracy(); return a ? a.counts.variance_value+a.deliveries.variance_value : 0;
  });

  async ngOnInit():Promise<void>{
    const qp=this.route.snapshot.queryParamMap;
    const t=qp.get('tab'); if(t==='margin'||t==='accuracy'||t==='performance') this.tab.set(t);
    const d=Number(qp.get('days')); if(this.ranges.includes(d)) this.days.set(d);
    if(this.auth.isAdmin()){
      const {data}=await supabase.from('objects').select('*').eq('active',true).order('name');
      this.objects.set((data??[]) as BusinessObject[]);
      const objectId=qp.get('object');
      if(objectId&&this.objects().some(o=>o.id===objectId)) this.selectedObjectId.set(objectId);
    }
    await this.load();
  }

  async load():Promise<void>{
    this.loading.set(true); this.error.set(null);
    const objectId=this.auth.isAdmin()?this.selectedObjectId()||null:this.auth.profile()?.object_id??null;
    const [detail,summary,accuracy]=await Promise.all([
      supabase.rpc('inventory_turnover',{p_days:this.days(),p_object_id:objectId}),
      supabase.rpc('inventory_performance_summary',{p_days:this.days(),p_object_id:objectId}),
      supabase.rpc('stock_accuracy_report',{p_days:this.days(),p_object_id:objectId}),
    ]);
    const err=detail.error??summary.error??accuracy.error;
    if(err){this.error.set(err.message);this.rows.set([]);this.summary.set(null);this.accuracy.set(null);}
    else{
      this.rows.set((detail.data??[]) as PerformanceRow[]);
      this.summary.set(summary.data as Summary);
      this.accuracy.set(accuracy.data as AccuracyReport);
    }
    this.loading.set(false);
  }

  setTab(t:Tab):void{this.tab.set(t);void this.router.navigate([],{relativeTo:this.route,queryParams:{tab:t,days:this.days()},queryParamsHandling:'merge',replaceUrl:true});}
  setDays(d:number):void{this.days.set(d);void this.router.navigate([],{relativeTo:this.route,queryParams:{days:d},queryParamsHandling:'merge',replaceUrl:true});void this.load();}
  setObject(id:string):void{
    this.selectedObjectId.set(id);
    void this.router.navigate([],{relativeTo:this.route,queryParams:{object:id||null},queryParamsHandling:'merge',replaceUrl:true});
    void this.load();
  }
  marginPct(r:PerformanceRow):number|null{return r.revenue?((r.margin??0)/r.revenue)*100:null;}
  classLabel(c:ClassName):string{return({fast:'Fast',normal:'Normal',slow:'Slow',dead:'Dead',stockout:'Stockout',idle:'Idle'})[c];}
  classTone(c:ClassName):string{return({fast:'bg-sky-50 text-sky-700 ring-sky-200',normal:'bg-emerald-50 text-emerald-700 ring-emerald-200',slow:'bg-amber-50 text-amber-700 ring-amber-200',dead:'bg-violet-50 text-violet-700 ring-violet-200',stockout:'bg-red-50 text-red-700 ring-red-200',idle:'bg-slate-100 text-slate-600 ring-slate-200'})[c];}
  label(code:string|null):string{return reasonLabel(code);}
  /** Note only when it adds something beyond the code label. */
  extraNote(reason:string|null, code:string|null):string|null{return reason&&reason!==reasonLabel(code)?reason:null;}
  signed(n:number):string{return n>0?`+${n}`:n<0?`−${Math.abs(n)}`:'0';}

  async exportCurrent():Promise<void>{
    this.exporting.set(true);
    const XLSX=await import('xlsx');
    let rows:any[]=[]; let sheet='Report';
    if(this.tab()==='margin'){
      sheet='Sales margin';
      rows=this.marginRows().map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'Units sold':r.sold,Revenue:r.revenue,COGS:r.cogs,Margin:r.margin,'Margin %':this.marginPct(r),Currency:this.summary()?.currency}));
    }else if(this.tab()==='accuracy'){
      sheet='Stock accuracy';
      rows=(this.accuracy()?.top_issues??[]).map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'Count issues':r.count_issues,'Delivery issues':r.delivery_issues,'Total issues':r.total_issues,'Variance exposure':r.issue_value,Currency:this.accuracy()?.currency,'Last issue':r.last_issue_at}));
    }else{
      sheet='Performance';
      rows=this.filtered().map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'On hand':r.on_hand,Sold:r.sold,'Avg stock':r.avg_stock,Turnover:r.turnover,'Days of stock':r.days_of_stock,'Stock value':r.stock_value,Class:this.classLabel(r.class),History:`${r.history_days}/${r.requested_days}`,Currency:this.summary()?.currency}));
    }
    const ws=XLSX.utils.json_to_sheet(rows); ws['!cols']=Object.keys(rows[0]??{Report:''}).map(k=>({wch:Math.max(12,k.length+2)}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,sheet);
    XLSX.writeFile(wb,`stockflow-${this.tab()}-${this.days()}d.xlsx`); this.exporting.set(false);
  }
}
