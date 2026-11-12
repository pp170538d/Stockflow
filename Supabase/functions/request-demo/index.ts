import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = new Set([
  'https://stockflow-ops.vercel.app',
  'http://localhost:4200',
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Payload = {
  name?: unknown; email?: unknown; company?: unknown; locations?: unknown;
  workflow?: unknown; message?: unknown; website?: unknown; consent?: unknown; source?: unknown;
};

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405, cors);
  if (!ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Origin not allowed.' }, 403, cors);

  try {
    const body = await req.json() as Payload;
    if (text(body.website)) return json({ ok: true }, 200, cors); // silent honeypot success
    if (body.consent !== true) return json({ ok: false, error: 'Consent is required.' }, 400, cors);

    const name = text(body.name);
    const email = text(body.email).toLowerCase();
    const company = text(body.company);
    const locations = text(body.locations) || null;
    const workflow = text(body.workflow);
    const message = text(body.message) || null;
    const source = text(body.source) || 'contact-page';

    if (name.length < 2 || name.length > 100) return invalid(cors);
    if (!EMAIL_RE.test(email) || email.length > 254) return invalid(cors);
    if (company.length < 2 || company.length > 150) return invalid(cors);
    if (locations && !['1', '2-5', '6-20', '21+'].includes(locations)) return invalid(cors);
    if (workflow.length < 10 || workflow.length > 1200) return invalid(cors);
    if (message && message.length > 1200) return invalid(cors);

    const supabase = createClient(
      mustEnv('SUPABASE_URL'),
      mustEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: lead, error: insertError } = await supabase
      .from('demo_requests')
      .insert({
        name, email, company, locations_range: locations, workflow, message,
        source, consent_at: new Date().toISOString(),
      })
      .select('id, created_at')
      .single();

    if (insertError) throw insertError;

    let notificationSent = false;
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (resendKey) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: Deno.env.get('DEMO_FROM_EMAIL') ?? 'Stockflow <onboarding@resend.dev>',
          to: [mustEnv('DEMO_NOTIFICATION_EMAIL')],
          reply_to: email,
          subject: `New Stockflow demo request - ${company}`,
          html: emailHtml({ name, email, company, locations, workflow, message, id: lead.id }),
        }),
      });
      notificationSent = response.ok;
      if (notificationSent) {
        await supabase.from('demo_requests')
          .update({ notification_sent_at: new Date().toISOString() })
          .eq('id', lead.id);
      } else {
        console.error('Resend failed:', response.status, await response.text());
      }
    }

    return json({ ok: true, requestId: lead.id, notificationSent }, 200, cors);
  } catch (error) {
    console.error('request-demo failed:', error);
    return json({ ok: false, error: 'Request could not be processed.' }, 500, cors);
  }
});

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://stockflow-ops.vercel.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
function json(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
function invalid(headers: HeadersInit): Response {
  return json({ ok: false, error: 'Check the submitted details.' }, 400, headers);
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function safe(value: string | null): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function emailHtml(v: { name: string; email: string; company: string; locations: string | null; workflow: string; message: string | null; id: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:640px;margin:0 auto;padding:32px 16px"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden"><div style="padding:22px 24px;background:#0f172a;color:#fff"><div style="font-size:12px;color:#a5b4fc;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Stockflow</div><h1 style="margin:7px 0 0;font-size:22px">New demo request</h1></div><div style="padding:24px"><p><strong>${safe(v.name)}</strong> from <strong>${safe(v.company)}</strong></p><p><a href="mailto:${safe(v.email)}">${safe(v.email)}</a><br>Locations: ${safe(v.locations ?? 'Not provided')}</p><h2 style="margin-top:24px;font-size:13px;text-transform:uppercase;color:#64748b">Current workflow</h2><p style="white-space:pre-wrap;line-height:1.6">${safe(v.workflow)}</p>${v.message ? `<h2 style="margin-top:24px;font-size:13px;text-transform:uppercase;color:#64748b">Specific request</h2><p style="white-space:pre-wrap;line-height:1.6">${safe(v.message)}</p>` : ''}<p style="margin-top:28px;font-size:11px;color:#94a3b8">Lead ID: ${safe(v.id)}</p></div></div></div></body></html>`;
}
