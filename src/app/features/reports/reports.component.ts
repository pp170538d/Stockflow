
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { LocationPickerComponent } from '../../shared/ui/location-picker.component';
import { BusinessObject } from '../objects/object.model';
import { reasonLabel } from '../../core/stock/reason-codes';
import { FormsModule } from '@angular/forms';

type Tab = 'performance' | 'margin' | 'accuracy';
type ClassName = 'fast' | 'normal' | 'slow' | 'dead';
type PerfSortKey = 'product'|'location'|'onHand'|'sold'|'avgStock'|'turnover'|'days'|'value'|'history'|'class';
type MarginSortKey = 'product'|'location'|'units'|'revenue'|'cogs'|'margin'|'marginPct'|'coverage';
type SortDir = 'asc'|'desc';

interface PerformanceRow {
  object_id:string; object_name:string; product_id:string; sku:string; product_name:string; category:string|null;
  on_hand:number; sold:number; avg_stock:number; turnover:number|null; days_of_stock:number|null; days_out:number;
  revenue:number|null; cogs:number|null; margin:number|null; priced_share:number|null; stock_value:number|null;
  last_sale_at:string|null;
  movement_class:ClassName;
  availability_state:'in_stock'|'currently_out';
  currently_out:boolean;
  had_stockout:boolean;
  confidence:'none'|'low'|'partial'|'complete';
  legacy_class:string;
  requested_days:number; history_days:number; history_coverage:number; history_start:string|null;
}
interface Summary {
  currency:string; inventory_value:number; turnover:number|null; days_of_inventory:number|null; revenue:number;
  cogs:number; margin:number; gross_margin_pct:number|null; slow_dead_value:number; slow_dead_share:number|null;
  history_days_min:number; history_days_max:number; history_complete:boolean; history_coverage:number;
  cost_coverage:number|null; price_coverage:number|null; classes:Record<ClassName,number>; current_stockouts:number; products_with_stockout_days:number; rows:PerformanceRow[];
}
interface AccuracyBlock {
  lines:number; exact_lines:number; short_lines:number; over_lines:number; affected_products:number;
  quality_lines?:number; short_units?:number; over_units?:number; quality_rejected_units?:number;
  accuracy_pct:number|null; variance_value?:number; shrinkage_value?:number; issue_value?:number; value_coverage:number|null;
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
  delivery_id:string; delivery_number:string; order_id:string; order_number:string; object_id:string; object_name:string; product_id:string; sku:string; product_name:string;
  ordered_qty:number; physical_qty:number; accepted_qty:number; short_qty:number; over_qty:number; quality_rejected_qty:number;
  held_qty:number; immediate_return_qty:number; variance_reason_code:string|null; rejection_reason_code:string|null;
  issue_value:number|null; delivered_at:string;
}
interface ReceiptExceptionsPage { rows:DeliveryIssue[]; page:number; page_size:number; total:number; total_pages:number; }
type ReceiptIssueFilter = ''|'SHORT'|'OVER'|'QUALITY'|'HELD'|'RETURNED_NOW';

interface AccuracyReport {
  initialization:{ sessions:number; lines:number; variance_lines:number; variance_value:number; excluded_from_accuracy:boolean };
  days:number; currency:string; generated_at:string; counts:AccuracyBlock; deliveries:AccuracyBlock;
  top_issues:AccuracyIssue[]; reasons:AccuracyReason[];
  recent_count_issues:CountIssue[]; recent_delivery_issues:DeliveryIssue[];
}

@Component({
  selector:'app-reports', standalone:true,
  imports:[DatePipe, DecimalPipe, PercentPipe, RouterLink, LocationPickerComponent, FormsModule],
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
  readonly receiptPage=signal(1);
  readonly receiptPageSize=20;
  readonly receiptTotal=signal(0);
  readonly receiptTotalPages=signal(0);
  readonly receiptRows=signal<DeliveryIssue[]>([]);
  readonly receiptIssueFilter=signal<ReceiptIssueFilter>('');
  readonly receiptSearch=signal('');
  readonly receiptLoading=signal(false);
  readonly perfSort=signal<PerfSortKey>('class');
  readonly perfSortDir=signal<SortDir>('asc');
  readonly marginSort=signal<MarginSortKey>('margin');
  readonly marginSortDir=signal<SortDir>('desc');
  readonly ranges=[7,30,90,365];
  readonly classes:ClassName[]=['fast','normal','slow','dead'];

  readonly reportLocations=computed(()=>[{id:'',name:'All locations'},...this.objects()]);
  readonly filtered=computed(()=>{
    const q=this.search().trim().toLowerCase(), c=this.classFilter();
    return this.rows().filter(r=>(!c||r.movement_class===c)&&(!q||r.product_name.toLowerCase().includes(q)||r.sku.toLowerCase().includes(q)||r.object_name.toLowerCase().includes(q)));
  });
  readonly performanceRows=computed(()=>{
    const key=this.perfSort(), sign=this.perfSortDir()==='asc'?1:-1;
    const rank:Record<ClassName,number>={dead:0,slow:1,normal:2,fast:3};
    return [...this.filtered()].sort((a,b)=>{
      let cmp=0;
      switch(key){
        case 'product':cmp=a.product_name.localeCompare(b.product_name)||a.sku.localeCompare(b.sku);break;
        case 'location':cmp=a.object_name.localeCompare(b.object_name)||a.product_name.localeCompare(b.product_name);break;
        case 'onHand':cmp=a.on_hand-b.on_hand;break;
        case 'sold':cmp=a.sold-b.sold;break;
        case 'avgStock':cmp=a.avg_stock-b.avg_stock;break;
        case 'turnover':cmp=(a.turnover??-Infinity)-(b.turnover??-Infinity);break;
        case 'days':cmp=(a.days_of_stock??Infinity)-(b.days_of_stock??Infinity);break;
        case 'value':cmp=(a.stock_value??-Infinity)-(b.stock_value??-Infinity);break;
        case 'history':cmp=a.history_coverage-b.history_coverage;break;
        case 'class':cmp=rank[a.movement_class]-rank[b.movement_class];break;
      }
      return cmp*sign||a.product_name.localeCompare(b.product_name)||a.object_name.localeCompare(b.object_name);
    });
  });
  readonly marginRows=computed(()=>{
    const key=this.marginSort(), sign=this.marginSortDir()==='asc'?1:-1;
    return [...this.filtered()].filter(r=>r.sold>0).sort((a,b)=>{
      let cmp=0;
      switch(key){
        case 'product':cmp=a.product_name.localeCompare(b.product_name)||a.sku.localeCompare(b.sku);break;
        case 'location':cmp=a.object_name.localeCompare(b.object_name)||a.product_name.localeCompare(b.product_name);break;
        case 'units':cmp=a.sold-b.sold;break;
        case 'revenue':cmp=(a.revenue??-Infinity)-(b.revenue??-Infinity);break;
        case 'cogs':cmp=(a.cogs??-Infinity)-(b.cogs??-Infinity);break;
        case 'margin':cmp=(a.margin??-Infinity)-(b.margin??-Infinity);break;
        case 'marginPct':cmp=(this.marginPct(a)??-Infinity)-(this.marginPct(b)??-Infinity);break;
        case 'coverage':cmp=(a.priced_share??-Infinity)-(b.priced_share??-Infinity);break;
      }
      return cmp*sign||a.product_name.localeCompare(b.product_name)||a.object_name.localeCompare(b.object_name);
    });
  });
  readonly accuracyIssues=computed(()=>{
    const a=this.accuracy(); if(!a) return 0;
    return a.counts.short_lines+a.counts.over_lines+a.deliveries.short_lines+a.deliveries.over_lines+(a.deliveries.quality_lines??0);
  });
  readonly shrinkage=computed(()=>{
    const a=this.accuracy(); return a ? (a.counts.shrinkage_value??0) : 0;
  });
  readonly maxReasonCount=computed(()=>Math.max(1,...(this.accuracy()?.reasons??[]).map(r=>r.occurrences)));
  readonly totalAccuracyExposure=computed(()=>{
    const a=this.accuracy(); return a ? (a.counts.variance_value??0)+(a.deliveries.issue_value??0) : 0;
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
    const [performance,accuracy,receiptPage]=await Promise.all([
      supabase.rpc('inventory_performance_v2',{p_days:this.days(),p_object_id:objectId}),
      supabase.rpc('stock_accuracy_report_v2',{p_days:this.days(),p_object_id:objectId}),
      supabase.rpc('receipt_exceptions_page',{p_days:this.days(),p_object_id:objectId,p_page:this.receiptPage(),p_page_size:this.receiptPageSize,p_issue_type:this.receiptIssueFilter()||null,p_search:this.receiptSearch().trim()||null}),
    ]);
    const err=performance.error??accuracy.error??receiptPage.error;
    if(err){this.error.set(err.message);this.rows.set([]);this.summary.set(null);this.accuracy.set(null);}
    else{
      const report=performance.data as Summary;
      this.rows.set(report?.rows??[]);
      this.summary.set(report);
      this.accuracy.set(accuracy.data as AccuracyReport);
      const rp=receiptPage.data as ReceiptExceptionsPage;
      this.receiptRows.set(rp?.rows??[]); this.receiptTotal.set(rp?.total??0); this.receiptTotalPages.set(rp?.total_pages??0);
    }
    this.loading.set(false);
  }

  async loadReceiptPage(reset=false):Promise<void>{
    if(reset)this.receiptPage.set(1);
    this.receiptLoading.set(true);
    const {data,error}=await supabase.rpc('receipt_exceptions_page',{p_days:this.days(),p_object_id:this.selectedObjectId()||null,p_page:this.receiptPage(),p_page_size:this.receiptPageSize,p_issue_type:this.receiptIssueFilter()||null,p_search:this.receiptSearch().trim()||null});
    this.receiptLoading.set(false);
    if(error){this.error.set(error.message);return;}
    const r=data as ReceiptExceptionsPage; this.receiptRows.set(r?.rows??[]);this.receiptTotal.set(r?.total??0);this.receiptTotalPages.set(r?.total_pages??0);
  }
  setReceiptFilter(v:ReceiptIssueFilter):void{this.receiptIssueFilter.set(v);void this.loadReceiptPage(true);}
  searchReceipts():void{void this.loadReceiptPage(true);}
  prevReceiptPage():void{if(this.receiptPage()>1){this.receiptPage.update(v=>v-1);void this.loadReceiptPage();}}
  nextReceiptPage():void{if(this.receiptPage()<this.receiptTotalPages()){this.receiptPage.update(v=>v+1);void this.loadReceiptPage();}}

  setTab(t:Tab):void{this.tab.set(t);void this.router.navigate([],{relativeTo:this.route,queryParams:{tab:t,days:this.days()},queryParamsHandling:'merge',replaceUrl:true});}
  setDays(d:number):void{this.days.set(d);this.receiptPage.set(1);void this.router.navigate([],{relativeTo:this.route,queryParams:{days:d},queryParamsHandling:'merge',replaceUrl:true});void this.load();}
  setObject(id:string):void{
    this.selectedObjectId.set(id);this.receiptPage.set(1);
    void this.router.navigate([],{relativeTo:this.route,queryParams:{object:id||null},queryParamsHandling:'merge',replaceUrl:true});
    void this.load();
  }
  setPerfSort(key:PerfSortKey):void{if(this.perfSort()===key)this.perfSortDir.update(d=>d==='asc'?'desc':'asc');else{this.perfSort.set(key);this.perfSortDir.set(key==='product'||key==='location'||key==='days'||key==='class'?'asc':'desc');}}
  setMarginSort(key:MarginSortKey):void{if(this.marginSort()===key)this.marginSortDir.update(d=>d==='asc'?'desc':'asc');else{this.marginSort.set(key);this.marginSortDir.set(key==='product'||key==='location'?'asc':'desc');}}
  perfSortMark(key:PerfSortKey):string{return this.perfSort()===key?(this.perfSortDir()==='asc'?'↑':'↓'):'↕';}
  marginSortMark(key:MarginSortKey):string{return this.marginSort()===key?(this.marginSortDir()==='asc'?'↑':'↓'):'↕';}
  perfSortAria(key:PerfSortKey):'ascending'|'descending'|'none'{return this.perfSort()===key?(this.perfSortDir()==='asc'?'ascending':'descending'):'none';}
  marginSortAria(key:MarginSortKey):'ascending'|'descending'|'none'{return this.marginSort()===key?(this.marginSortDir()==='asc'?'ascending':'descending'):'none';}
  marginPct(r:PerformanceRow):number|null{return r.revenue?((r.margin??0)/r.revenue)*100:null;}
  classLabel(c:ClassName):string{return({fast:'Fast',normal:'Normal',slow:'Slow',dead:'Dead'})[c];}
  classTone(c:ClassName):string{return({fast:'bg-sky-50 text-sky-700 ring-sky-200',normal:'bg-emerald-50 text-emerald-700 ring-emerald-200',slow:'bg-amber-50 text-amber-700 ring-amber-200',dead:'bg-violet-50 text-violet-700 ring-violet-200'})[c];}
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
      rows=this.marginRows().map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'Units sold':r.sold,'Net revenue (excl. VAT)':r.revenue,COGS:r.cogs,Margin:r.margin,'Margin % of net revenue':this.marginPct(r),Currency:this.summary()?.currency}));
    }else if(this.tab()==='accuracy'){
      sheet='Stock accuracy';
      rows=(this.accuracy()?.top_issues??[]).map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'Count issues':r.count_issues,'Delivery issues':r.delivery_issues,'Total issues':r.total_issues,'Variance exposure':r.issue_value,Currency:this.accuracy()?.currency,'Last issue':r.last_issue_at}));
    }else{
      sheet='Performance';
      rows=this.performanceRows().map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'On hand':r.on_hand,Sold:r.sold,'Avg stock':r.avg_stock,Turnover:r.turnover,'Days of stock':r.days_of_stock,'Stock value':r.stock_value,Class:this.classLabel(r.movement_class),History:`${r.history_days}/${r.requested_days}`,Currency:this.summary()?.currency}));
    }
    const ws=XLSX.utils.json_to_sheet(rows); ws['!cols']=Object.keys(rows[0]??{Report:''}).map(k=>({wch:Math.max(12,k.length+2)}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,sheet);
    XLSX.writeFile(wb,`stockflow-${this.tab()}-${this.days()}d.xlsx`); this.exporting.set(false);
  }
}


