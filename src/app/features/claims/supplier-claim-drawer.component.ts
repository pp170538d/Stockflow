import { Component,effect,inject,input,output,signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ToastService } from '../../shared/ui/toast.service';
import { SupplierClaim,SupplierClaimsService,ClaimStatus } from './supplier-claims.service';
@Component({selector:'app-supplier-claim-drawer',standalone:true,imports:[FormsModule],templateUrl:'./supplier-claim-drawer.component.html'})
export class SupplierClaimDrawerComponent{
 private svc=inject(SupplierClaimsService);private toast=inject(ToastService);private router=inject(Router);readonly open=input(false);readonly lineId=input<string|null>(null);readonly product=input('');readonly issue=input('');readonly close=output<void>();readonly changed=output<void>();readonly claim=signal<SupplierClaim|null>(null);readonly loading=signal(false);readonly saving=signal(false);description='';outcome:ClaimStatus='REPLACEMENT_PROMISED';reference='';response='';replacementAt='';
 constructor(){effect(()=>{const id=this.lineId();if(this.open()&&id)void this.load(id);});}
 async load(id:string){this.loading.set(true);this.claim.set(await this.svc.forLine(id));this.loading.set(false);}
 async create(){const id=this.lineId();if(!id||!this.description.trim())return;this.saving.set(true);const r=await this.svc.create(id,this.description);this.saving.set(false);if(r.error){this.toast.error(r.error);return;}this.toast.success(`Claim ${r.data.claim_number} created.`);await this.load(id);this.changed.emit();}
 async respond(){const c=this.claim();if(!c)return;this.saving.set(true);const r=await this.svc.respond(c.id,this.outcome,this.reference.trim()||null,this.response.trim()||null,this.replacementAt||null);this.saving.set(false);if(r.error){this.toast.error(r.error);return;}this.toast.success(this.outcome==='REPLACEMENT_PROMISED'?`Replacement order ${r.data.replacement_order_number} created.`:'Supplier response recorded.');await this.load(this.lineId()!);this.changed.emit();}
 async receiveReplacement(){const c=this.claim();if(!c?.replacement_order_id)return;this.close.emit();await this.router.navigate(['/orders',c.replacement_order_id,'receive']);}
}
