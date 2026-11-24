import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { IdempotencyKey } from '../../core/idempotency';
export type HeldDisposition='RETURN_IMMEDIATE'|'RETURN_LATER'|'DISPOSED';
export interface HeldStock{ id:string;quantity:number;remaining_qty:number;status:'HELD'|'PARTIALLY_DISPOSED'|'CLOSED';source_reason:string|null;created_at:string;dispositions:any[]; }
@Injectable({providedIn:'root'})export class HeldStockService{
 private key=new IdempotencyKey();
 async forLine(lineId:string):Promise<HeldStock|null>{const{data}=await supabase.rpc('held_stock_for_line',{p_delivery_item_id:lineId});return(data??null) as HeldStock|null;}
 async dispose(heldId:string,quantity:number,type:HeldDisposition,provider:string|null,documentNo:string|null,externalId:string|null,note:string|null){const p={heldId,quantity,type,provider,documentNo,externalId,note};const{data,error}=await supabase.rpc('dispose_held_stock',{p_held_stock_id:heldId,p_quantity:quantity,p_disposition_type:type,p_dispatch_provider:provider,p_dispatch_document_number:documentNo,p_dispatch_external_id:externalId,p_note:note,p_idempotency_key:this.key.for(p)});if(error)return{data:null,error:error.message};this.key.done();return{data,error:null};}
}
