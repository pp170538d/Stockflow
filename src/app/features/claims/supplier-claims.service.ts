
import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { IdempotencyKey } from '../../core/idempotency';
export type ClaimStatus='AWAITING_SUPPLIER'|'REPLACEMENT_PROMISED'|'REPLACEMENT_RECEIVED'|'CREDIT_ACCEPTED'|'CLAIM_REJECTED'|'RESOLVED_OTHER';
export interface SupplierClaim{id:string;claim_number:string;claimed_qty:number;issue_code:string;description:string;status:ClaimStatus;supplier_reference:string|null;supplier_response:string|null;expected_replacement_at:string|null;created_at:string;responded_at:string|null;resolved_at:string|null;replacement_order_id:string|null;replacement_order_number:string|null;replacement_order_status:string|null;replacement_received_qty:number|null;replacement_received_at:string|null;supplier_name:string|null;product_name:string;}
@Injectable({providedIn:'root'})export class SupplierClaimsService{
 private createKey=new IdempotencyKey();private respondKey=new IdempotencyKey();
 async forLine(lineId:string):Promise<SupplierClaim|null>{const{data}=await supabase.rpc('supplier_claim_for_line',{p_delivery_item_id:lineId});return(data??null) as SupplierClaim|null;}
 async create(lineId:string,description:string){const p={lineId,description:description.trim()};const{data,error}=await supabase.rpc('create_supplier_claim',{p_delivery_item_id:lineId,p_description:p.description,p_idempotency_key:this.createKey.for(p)});if(error)return{data:null,error:friendlyClaim(error.message)};this.createKey.done();return{data,error:null};}
 async respond(claimId:string,outcome:ClaimStatus,reference:string|null,response:string|null,replacementAt:string|null){const p={claimId,outcome,reference,response,replacementAt};const{data,error}=await supabase.rpc('respond_supplier_claim',{p_claim_id:claimId,p_outcome:outcome,p_supplier_reference:reference,p_response:response,p_expected_replacement_at:replacementAt||null,p_idempotency_key:this.respondKey.for(p)});if(error)return{data:null,error:friendlyClaim(error.message)};this.respondKey.done();return{data,error:null};}
}

function friendlyClaim(message:string):string{
 const m=message.toLowerCase();
 if(m.includes('already exists')||m.includes('already has'))return 'A supplier claim already exists for this receipt line.';
 if(m.includes('no quality rejection')||m.includes('not rejected'))return 'This receipt line has no quality-rejected quantity to claim.';
 if(m.includes('quantity')&&(m.includes('exceed')||m.includes('greater')))return 'The claim quantity cannot exceed the quality-rejected quantity.';
 if(m.includes('already terminal')||m.includes('already resolved')||m.includes('claim is closed'))return 'This supplier claim is already closed and cannot be changed.';
 if(m.includes('replacement')&&m.includes('already'))return 'A replacement response has already been recorded for this claim.';
 if(m.includes('not signed in'))return 'Your session has expired. Sign in and try again.';
 if(m.includes('only admins'))return 'Only an administrator can manage supplier claims.';
 if(m.includes('demo account'))return 'This action is disabled in the demo account.';
 return message;
}
