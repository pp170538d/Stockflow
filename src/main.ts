import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode } from '@angular/core';
import { inject as injectAnalytics } from '@vercel/analytics';
import { appConfig } from './app/app.config';
import { App } from './app/app';

injectAnalytics({
  mode: isDevMode() ? 'development' : 'production',
  // Skida query parametre (?object=<uuid>, ?product=…&qty=…) da se ne šalju
  // interni ID-jevi, i da se /inventory?object=A i ?object=B broje kao jedna strana.
  beforeSend: (event) => {
    const url = new URL(event.url);
    url.search = '';
    return { ...event, url: url.toString() };
  },
});

bootstrapApplication(App, appConfig).catch((err) => console.error(err));