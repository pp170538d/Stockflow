import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { LocationPickerComponent } from '../../shared/ui/location-picker.component';
import { BusinessObject } from '../objects/object.model';

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

@Component({
  selector: 'app-reports', standalone: true,
  imports: [ DecimalPipe, PercentPipe, RouterLink, LocationPickerComponent],
  templateUrl: './reports.component.html',
})
export class ReportsComponent implements OnInit {
  readonly auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly tab = signal<Tab>('performance');
  readonly days = signal(30);
  readonly selectedObjectId = signal('');
  readonly classFilter = signal<ClassName | ''>('');
  readonly search = signal('');
  readonly objects = signal<BusinessObject[]>([]);
  readonly rows = signal<PerformanceRow[]>([]);
  readonly summary = signal<Summary|null>(null);
  readonly loading = signal(false);
  readonly error = signal<string|null>(null);
  readonly exporting = signal(false);
  readonly ranges = [7,30,90,365];
  readonly classes: ClassName[] = ['fast','normal','slow','dead','stockout','idle'];

  readonly reportLocations = computed(() => [{id:'',name:'All locations'}, ...this.objects()]);
  readonly filtered = computed(() => {
    const q=this.search().trim().toLowerCase(), c=this.classFilter();
    return this.rows().filter(r => (!c || r.class===c) && (!q || r.product_name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.object_name.toLowerCase().includes(q)));
  });
  readonly marginRows = computed(() => [...this.filtered()].filter(r=>r.sold>0).sort((a,b)=>(b.margin??-Infinity)-(a.margin??-Infinity)));

  async ngOnInit(): Promise<void> {
    const qp=this.route.snapshot.queryParamMap;
    const t=qp.get('tab'); if(t==='margin'||t==='accuracy'||t==='performance') this.tab.set(t);
    const d=Number(qp.get('days')); if(this.ranges.includes(d)) this.days.set(d);
    if(this.auth.isAdmin()) {
      const {data}=await supabase.from('objects').select('*').eq('active',true).order('name');
      this.objects.set((data??[]) as BusinessObject[]);
    }
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set(null);
    const objectId=this.auth.isAdmin()?this.selectedObjectId()||null:this.auth.profile()?.object_id??null;
    const [detail,summary]=await Promise.all([
      supabase.rpc('inventory_turnover',{p_days:this.days(),p_object_id:objectId}),
      supabase.rpc('inventory_performance_summary',{p_days:this.days(),p_object_id:objectId}),
    ]);
    if(detail.error||summary.error){this.error.set(detail.error?.message??summary.error?.message??'Could not load reports.');this.rows.set([]);this.summary.set(null);}
    else {this.rows.set((detail.data??[]) as PerformanceRow[]);this.summary.set(summary.data as Summary);}
    this.loading.set(false);
  }
  setTab(t:Tab):void { this.tab.set(t); void this.router.navigate([], {relativeTo:this.route,queryParams:{tab:t,days:this.days()},queryParamsHandling:'merge',replaceUrl:true}); }
  setDays(d:number):void { this.days.set(d); void this.router.navigate([], {relativeTo:this.route,queryParams:{days:d},queryParamsHandling:'merge',replaceUrl:true}); void this.load(); }
  setObject(id:string):void { this.selectedObjectId.set(id); void this.load(); }
  marginPct(r:PerformanceRow):number|null { return r.revenue ? ((r.margin??0)/r.revenue)*100 : null; }
  classLabel(c:ClassName):string { return ({fast:'Fast',normal:'Normal',slow:'Slow',dead:'Dead',stockout:'Stockout',idle:'Idle'})[c]; }
  classTone(c:ClassName):string { return ({fast:'bg-sky-50 text-sky-700 ring-sky-200',normal:'bg-emerald-50 text-emerald-700 ring-emerald-200',slow:'bg-amber-50 text-amber-700 ring-amber-200',dead:'bg-violet-50 text-violet-700 ring-violet-200',stockout:'bg-red-50 text-red-700 ring-red-200',idle:'bg-slate-100 text-slate-600 ring-slate-200'})[c]; }

  async exportCurrent():Promise<void>{
    this.exporting.set(true);
    const XLSX=await import('xlsx');
    const rows=this.tab()==='margin' ? this.marginRows().map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'Units sold':r.sold,Revenue:r.revenue,COGS:r.cogs,Margin:r.margin,'Margin %':this.marginPct(r),Currency:this.summary()?.currency})) : this.filtered().map(r=>({Location:r.object_name,SKU:r.sku,Product:r.product_name,'On hand':r.on_hand,Sold:r.sold,'Avg stock':r.avg_stock,Turnover:r.turnover,'Days of stock':r.days_of_stock,'Days at zero':r.days_out,'Stock value':r.stock_value,Class:this.classLabel(r.class),Currency:this.summary()?.currency}));
    const ws=XLSX.utils.json_to_sheet(rows); ws['!cols']=Object.keys(rows[0]??{Report:''}).map(k=>({wch:Math.max(12,k.length+2)}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,this.tab()==='margin'?'Sales margin':'Performance');
    XLSX.writeFile(wb,`stockflow-${this.tab()}-${this.days()}d.xlsx`); this.exporting.set(false);
  }
}
