import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { RevealDirective } from '../../shared/ui/reveal.directive';

interface Feature {
  title: string;
  body: string;
  icon: string; // single SVG path data
}

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, RevealDirective],
  templateUrl: './landing.component.html',
})
export class LandingComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  /** Cursor-follow glow position (0-100%) for the hero. */
  readonly glowX = signal(50);
  readonly glowY = signal(30);

  readonly year = new Date().getFullYear();

  readonly features: Feature[] = [
    {
      title: 'Semantic immutable ledger',
      body: 'Every quantity change is a meaningful, append-only event — DELIVERY, SALE, COUNT, ADJUSTMENT. The app answers not just what the stock is, but why.',
      icon: 'M4 7h16M4 12h16M4 17h10',
    },
    {
      title: 'Delivery reconciliation',
      body: 'Orders record intent, deliveries record reality. Variance is always computed, never edited into history — short and over surface as scannable chips.',
      icon: 'M3 7h13l3 3v7h-2M3 7v10h2M8 17h6M5 17a2 2 0 1 0 4 0M14 17a2 2 0 1 0 4 0',
    },
    {
      title: 'Physical stock count',
      body: 'Reconcile the shelf against the system. A server-side re-read at submit keeps a mid-count delivery from corrupting the correction. Every fix leaves a trace.',
      icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    },
    {
      title: 'Smart stock runway',
      body: 'Days-of-stock projection from real sales velocity, sorted most-at-risk-first with reorder alerts — and honest "no recent sales" instead of a fabricated number.',
      icon: 'M3 3v18h18M7 15l4-4 3 3 5-6',
    },
  ];

  readonly stack = [
    'Angular 20',
    'TypeScript',
    'Tailwind CSS v4',
    'Supabase',
    'PostgreSQL',
    'Row Level Security',
    'Vercel',
  ];

  ngOnInit(): void {
    // Returning users skip the marketing page.
    if (this.auth.isLoggedIn()) {
      this.router.navigateByUrl('/dashboard');
    }
  }

  onHeroMove(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    this.glowX.set(((event.clientX - rect.left) / rect.width) * 100);
    this.glowY.set(((event.clientY - rect.top) / rect.height) * 100);
  }

  /** Smooth-scroll to a section id, overriding the browser's instant jump. */
  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }
}
