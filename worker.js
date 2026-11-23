// Cloudflare Worker: vlastní příjem poptávek (POST /api/poptavka) → e-mail přes Cloudflare Email Routing.
// Vše ostatní obsluhují statické soubory (env.ASSETS). Když tohle selže, formulář sám zkusí FormSubmit.
import { EmailMessage } from 'cloudflare:email';

const TO = 'samot.sulc@seznam.cz';     // musí být ověřená cílová adresa v Email Routing
const FROM = 'poptavka@sulc3d.cz';     // odesílatel na doméně se zapnutým Email Routing
const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;    // stejný limit jako ve formuláři

// pořadí a popisky polí v e-mailu
const FIELDS = [
  ['name', 'Jméno'], ['email', 'E-mail'], ['telefon', 'Telefon'], ['sluzba', 'Služba'],
  ['material', 'Materiál'], ['pocet_kusu', 'Počet kusů'], ['message', 'Popis'], ['odhad', 'Orientační odhad']
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/poptavka') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
      try {
        return await handleInquiry(request, env);
      } catch (err) {
        console.error('poptavka selhala', err && err.stack || err);
        return json({ ok: false, error: 'send' }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  }
};

async function handleInquiry(request, env) {
  const form = await request.formData();
  // honeypot: robot vyplní skryté pole → tváříme se, že je vše v pořádku
  if (str(form.get('_honey'))) return json({ ok: true });

  const name = str(form.get('name')), email = str(form.get('email'));
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'invalid' }, 400);

  const files = [];
  for (const [key, val] of form.entries()) {
    if (/^attachment\d+$/.test(key) && typeof val === 'object' && val && val.size > 0) files.push(val);
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  if (files.length > MAX_FILES || total > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  const rows = FIELDS.map(([k, label]) => [label, str(form.get(k))]).filter(([, v]) => v);
  if (files.length) rows.push(['Přílohy', files.map(f => `${f.name} (${kb(f.size)})`).join('\n')]);

  const subject = `Nová poptávka – 3D tisk – ${name}`;
  const raw = await buildMime({ subject, replyTo: email, rows, files });
  await env.MAIL.send(new EmailMessage(FROM, TO, raw));
  return json({ ok: true });
}

// ── MIME ──
async function buildMime({ subject, replyTo, rows, files }) {
  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<!doctype html><meta charset="utf-8"><h2 style="font-family:sans-serif">Nová poptávka ze sulc3d.cz</h2>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">' +
    rows.map(([k, v]) => `<tr><th align="left" valign="top" style="border:1px solid #ccc;background:#f3f3f3;color:#222">${esc(k)}</th>` +
      `<td style="border:1px solid #ccc;white-space:pre-wrap">${esc(v)}</td></tr>`).join('') + '</table>';
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n\n');

  const parts = [
    `From: =?UTF-8?B?${b64str('sulc3d.cz poptávka')}?= <${FROM}>`,
    `To: <${TO}>`,
    `Reply-To: <${replyTo.replace(/[<>\r\n]/g, '')}>`,
    `Subject: =?UTF-8?B?${b64str(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@sulc3d.cz>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${boundary}a"`,
    '',
    `--${boundary}a`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64str(text)),
    `--${boundary}a`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64str(html)),
    `--${boundary}a--`
  ];
  for (const f of files) {
    const fname = (f.name || 'soubor').replace(/[\r\n"\\]/g, '_');
    parts.push(
      `--${boundary}`,
      'Content-Type: application/octet-stream',
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="=?UTF-8?B?${b64str(fname)}?="; filename*=UTF-8''${encodeURIComponent(fname)}`,
      '',
      wrap(b64bytes(new Uint8Array(await f.arrayBuffer())))
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

const str = v => (typeof v === 'string' ? v.trim() : '');
const kb = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} kB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`);
const b64str = s => b64bytes(new TextEncoder().encode(s));
function b64bytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap = s => s.replace(/.{76}/g, '$&\r\n');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
