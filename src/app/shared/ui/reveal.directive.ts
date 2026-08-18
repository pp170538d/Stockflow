import {
  Directive,
  ElementRef,
  inject,
  input,
  numberAttribute,
  OnInit,
} from '@angular/core';

/**
 * Tiny, zero-dependency scroll-reveal.
 * Adds `is-visible` when the element scrolls into view (once).
 * Pair with the CSS in landing.component (or global styles):
 *
 *   [appReveal]            { opacity:0; transform:translateY(16px); transition:opacity .6s ease, transform .6s ease; }
 *   [appReveal].is-visible { opacity:1; transform:none; }
 *
 * Usage:
 *   <div appReveal>...</div>          // no delay
 *   <div appReveal="160">...</div>    // 160ms stagger delay
 *
 * `numberAttribute` converts the string in the template ("160") to a number,
 * and an empty attribute (`appReveal`) falls back to 0.
 *
 * Respects prefers-reduced-motion by revealing immediately.
 */
@Directive({
  selector: '[appReveal]',
  standalone: true,
})
export class RevealDirective implements OnInit {
  private el = inject(ElementRef<HTMLElement>);

  /** Optional stagger delay in ms. */
  readonly delay = input(0, { alias: 'appReveal', transform: numberAttribute });

  ngOnInit(): void {
    const node = this.el.nativeElement;

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduce || typeof IntersectionObserver === 'undefined') {
      node.classList.add('is-visible');
      return;
    }

    const delayMs = this.delay() || 0;
    if (delayMs) {
      node.style.transitionDelay = `${delayMs}ms`;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('is-visible');
            io.unobserve(node);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    io.observe(node);
  }
}
