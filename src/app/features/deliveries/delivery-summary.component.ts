import { Component,computed,effect,inject,input,output,signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Order } from '../orders/order.model';
import { DeliveriesService } from './deliveries.service';
import { ExternalProvider,PROVIDER_LABELS,RECEIPT_ACK_OUTCOME_LABELS,RECEIPT_ACK_STATUS_LABELS,ReceiptAckStatus,ReceiptLine,Resolution } from './delivery.model';
import { printGoodsReceipt } from './grn-pdf';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { dispatchTypeLabel,legalSystemHintFor,receiptAckLabelFor } from '../../core/compliance/compliance';
import { SupplierClaimDrawerComponent } from '../claims/supplier-claim-drawer.component';
import { HeldStockDrawerComponent } from '../custody/held-stock-drawer.component';
import { HeldStock,HeldStockService } from '../custody/held-stock.service';

type ClaimSel={lineId:string;product:string;issue:string};
type HeldSel={lineId:string;product:string};
type Direct='BACKORDER'|'CLOSE_SHORT';
const LABEL:Record<Direct,string>={BACKORDER:'Backorder',CLOSE_SHORT:'Close short'};

@Component({selector:'app-delivery-summary',standalone:true,imports:[DatePipe,FormsModule,SupplierClaimDrawerComponent,HeldStockDrawerComponent],templateUrl:'./delivery-summary.component.html'})
export class DeliverySummaryComponent{
 readonly svc=inject(DeliveriesService);private heldSvc=inject(HeldStockService);private toast=inject(ToastService);private confirm=inject(ConfirmService);
 readonly open=input(false);readonly order=input<Order|null>(null);readonly close=output<void>();readonly changed=output<void>();
 readonly claimSelection=signal<ClaimSel|null>(null);readonly heldSelection=signal<HeldSel|null>(null);readonly heldByLine=signal<Record<string,HeldStock|null>>({});readonly expandedLineId=signal<string|null>(null);readonly r=computed(()=>this.svc.receipt());
 readonly ackLabel=computed(()=>receiptAckLabelFor(this.r()?.compliance_profile));readonly legalHint=computed(()=>legalSystemHintFor(this.r()?.compliance_profile));readonly dispatchLabel=dispatchTypeLabel;readonly statusLabels=RECEIPT_ACK_STATUS_LABELS;readonly outcomeLabels=RECEIPT_ACK_OUTCOME_LABELS;readonly providerLabels=PROVIDER_LABELS;readonly providers=Object.keys(PROVIDER_LABELS) as ExternalProvider[];readonly statuses=Object.keys(RECEIPT_ACK_STATUS_LABELS) as ReceiptAckStatus[];
 readonly ackEditing=signal(false);ackNumber='';ackStatus:ReceiptAckStatus='SENT';ackProvider:ExternalProvider='MANUAL';ackExternalId='';ackSentAt='';ackNote='';
 constructor(){effect(()=>{const o=this.order();if(this.open()&&o){this.claimSelection.set(null);this.heldSelection.set(null);this.expandedLineId.set(null);this.ackEditing.set(false);void this.reload(o.id);}});}
 private async reload(orderId:string){await this.svc.loadReceipt(orderId);await this.loadHeld();}
 private async loadHeld(){const ls=this.r()?.lines.filter(l=>l.line_id&&l.held_qty>0)??[];const result:Record<string,HeldStock|null>={};await Promise.all(ls.map(async l=>result[l.line_id!]=await this.heldSvc.forLine(l.line_id!)));this.heldByLine.set(result);}
 held(l:ReceiptLine){return l.line_id?this.heldByLine()[l.line_id]??null:null;}
 readonly totals=computed(()=>this.r()?.lines.reduce((a,l)=>({ordered:a.ordered+l.ordered_qty,physical:a.physical+l.physical_qty,accepted:a.accepted+l.accepted_qty,held:a.held+l.held_qty,returned:a.returned+l.immediate_return_qty,acceptedLater:a.acceptedLater+l.accepted_later_qty,totalStock:a.totalStock+l.total_stock_qty,returnedLater:a.returnedLater+l.returned_later_qty,disposed:a.disposed+l.disposed_qty,stillHeld:a.stillHeld+l.held_remaining_qty}),{ordered:0,physical:0,accepted:0,held:0,returned:0,acceptedLater:0,totalStock:0,returnedLater:0,disposed:0,stillHeld:0})??{ordered:0,physical:0,accepted:0,held:0,returned:0,acceptedLater:0,totalStock:0,returnedLater:0,disposed:0,stillHeld:0});
 readonly hasPostReceipt=computed(()=>{const x=this.totals();return x.acceptedLater>0||x.returnedLater>0||x.disposed>0;});
 hasLinePostReceipt(l:ReceiptLine){return l.accepted_later_qty>0||l.returned_later_qty>0||l.disposed_qty>0;}
 dispositionLabel(type:string){return type==='ACCEPT'?'Accepted into usable stock':type==='RETURN_LATER'?'Returned later':type==='DISPOSED'?'Authorized disposal':'Returned immediately';}
 readonly issueLines=computed(()=>this.r()?.lines.filter(l=>l.short_qty>0||l.over_qty>0||l.quality_rejected_qty>0)??[]);readonly openLines=computed(()=>this.issueLines().filter(l=>l.resolution_status==='open'));
 lineNumber(i:number){return String(i+1).padStart(2,'0');} isExpanded(l:ReceiptLine){return this.expandedLineId()===l.line_id;} toggle(l:ReceiptLine){this.expandedLineId.update(x=>x===l.line_id?null:l.line_id);}
 qualityLabel(l:ReceiptLine){return l.rejection_reason_code==='DAMAGED'?'Damaged':l.rejection_reason_code==='WRONG_ITEM'?'Wrong item':l.rejection_reason_code==='OTHER'?'Other':null;}
 issueText(l:ReceiptLine){const a:string[]=[];if(l.short_qty)a.push(`Short ${l.short_qty}`);if(l.over_qty)a.push(`Over ${l.over_qty}`);if(l.quality_rejected_qty)a.push(`${this.qualityLabel(l)??'Not accepted'} ${l.quality_rejected_qty}`);if(l.immediate_return_qty)a.push(`Returned now ${l.immediate_return_qty}`);if(l.held_qty)a.push(`Held ${l.held_qty}`);return a.join(' · ')||'Exact receipt';}
 openClaim(l:ReceiptLine){if(l.line_id)this.claimSelection.set({lineId:l.line_id,product:l.product_name,issue:this.issueText(l)});} openHeld(l:ReceiptLine){if(l.line_id)this.heldSelection.set({lineId:l.line_id,product:l.product_name});}
 async resolve(l:ReceiptLine,res:Direct){const ok=await this.confirm.ask({title:LABEL[res]+'?',message:`${l.product_name}: Short ${l.short_qty}.`,confirmLabel:LABEL[res]});if(!ok)return;const x=await this.svc.resolve([l.line_id!],res as Resolution,null);if(x.error)this.toast.error(x.error);else{this.toast.success(x.backorderNumber?`Backorder ${x.backorderNumber} created.`:'Exception resolved.');await this.childChanged();}}
 async childChanged(){const o=this.order();if(o)await this.reload(o.id);this.changed.emit();}
 startAck(){const a=this.r()?.receipt_ack;this.ackNumber=a?.document_number??'';this.ackStatus=a?.status??'SENT';this.ackProvider=a?.provider??(this.r()?.compliance_profile==='SERBIA'?'SEO_SERBIA':'MANUAL');this.ackExternalId=a?.external_id??'';this.ackSentAt=toLocal(a?.sent_at??new Date().toISOString());this.ackNote=a?.note??'';this.ackEditing.set(true);}
 async saveAck(){const r=this.r();if(!r||!this.ackNumber.trim())return;const err=await this.svc.setReceiptAck({deliveryId:r.delivery.id,documentNumber:this.ackNumber.trim(),status:this.ackStatus,provider:this.ackProvider,externalId:this.ackExternalId.trim()||null,sentAt:this.ackSentAt?new Date(this.ackSentAt).toISOString():null,note:this.ackNote.trim()||null});if(err){this.toast.error(err);return;}this.ackEditing.set(false);this.toast.success(`${this.ackLabel()} reference saved.`);this.changed.emit();}
 ackTone(s:ReceiptAckStatus|undefined){return s==='SUPPLIER_AGREED'?'bg-green-50 text-green-700 ring-green-200':s==='SUPPLIER_DISPUTED'?'bg-red-50 text-red-700 ring-red-200':'bg-blue-50 text-blue-700 ring-blue-200';}
 print(){const r=this.r();if(!r)return;const e=printGoodsReceipt(r);if(e)this.toast.error(e);}
}
function toLocal(iso:string){const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
