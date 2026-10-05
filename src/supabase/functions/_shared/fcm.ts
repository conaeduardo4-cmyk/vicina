// Invio notifiche push con FCM HTTP v1 (gratuito, non richiede il piano Blaze).
// Serve il secret FCM_SERVICE_ACCOUNT = contenuto del JSON dell'account di servizio Firebase.

type ServiceAccount = { client_email: string; private_key: string; project_id: string };

const b64u = (x: ArrayBuffer | string) => {
  const s = typeof x === 'string' ? btoa(x) : btoa(String.fromCharCode(...new Uint8Array(x)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const serviceAccount = (): ServiceAccount | null => {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

let cache: { token: string; exp: number } | null = null;

async function accessToken(sa: ServiceAccount) {
  if (cache && cache.exp > Date.now() + 60_000) return cache.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64u(sig)}` })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description ?? 'oauth');
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cache.token;
}

// Restituisce 'ok', 'dead' (token non più valido, da eliminare) oppure 'err'.
export async function sendSosPush(sa: ServiceAccount, token: string, from: string, sosId: string) {
  const at = await accessToken(sa);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: `SOS da ${from}`, body: 'Ha bisogno di aiuto. Apri per vedere posizione e foto.' },
        data: { type: 'sos', sosId },
        android: { priority: 'HIGH', notification: { channel_id: 'sos', sound: 'default' } },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', 'interruption-level': 'time-sensitive' } }
        }
      }
    })
  });
  if (r.ok) return 'ok';
  const j = await r.json().catch(() => ({}));
  const code = j?.error?.details?.find?.((d: { errorCode?: string }) => d.errorCode)?.errorCode ?? j?.error?.status;
  const dead = r.status === 404 || code === 'UNREGISTERED' ||
    (r.status === 400 && /registration token/i.test(j?.error?.message ?? ''));
  return dead ? 'dead' : 'err';
}
