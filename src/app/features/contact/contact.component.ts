import { Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';

@Component({
  selector: 'app-contact',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './contact.component.html',
})
export class ContactComponent {
  private readonly fb = inject(FormBuilder);

  readonly sending = signal(false);
  readonly submittedEmail = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly year = new Date().getFullYear();

  readonly locationOptions = ['1', '2-5', '6-20', '21+'];

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    company: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    locations: [''],
    workflow: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(1200)]],
    message: ['', [Validators.maxLength(1200)]],
    website: [''], // honeypot: real users never see or fill this
    consent: [false, [Validators.requiredTrue]],
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.sending()) {
      this.form.markAllAsTouched();
      return;
    }

    this.sending.set(true);
    this.error.set(null);
    const value = this.form.getRawValue();

    try {
      const { data, error } = await supabase.functions.invoke('request-demo', {
        body: {
          name: value.name.trim(),
          email: value.email.trim().toLowerCase(),
          company: value.company.trim(),
          locations: value.locations || null,
          workflow: value.workflow.trim(),
          message: value.message.trim() || null,
          website: value.website,
          consent: value.consent,
          source: 'contact-page',
        },
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Request could not be sent.');

      this.submittedEmail.set(value.email.trim().toLowerCase());
      this.form.reset({
        name: '', email: '', company: '', locations: '', workflow: '',
        message: '', website: '', consent: false,
      });
    } catch {
      this.error.set('Your request could not be sent right now. Please try again in a moment.');
    } finally {
      this.sending.set(false);
    }
  }
}
