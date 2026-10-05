// Cancella le foto SOS dopo 7 giorni (privacy / GDPR). La chiama ogni giorno
// il workflow GitHub "maintenance", che serve anche a tenere sveglio il progetto gratuito.
import { adminClient, cors, json } from '../_shared/http.ts';

const PHOTO_DAYS = 7;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Non autorizzato' }, 401);
  try {
    const admin = adminClient();
    const cutoff = new Date(Date.now() - PHOTO_DAYS * 864e5).toISOString();
    const { data, error } = await admin.from('sos').select('id, sender').lt('created_at', cutoff).limit(500);
    if (error) throw error;
    const rows = data ?? [];
    const paths = rows.flatMap(r => [`${r.sender}/${r.id}/back.jpg`, `${r.sender}/${r.id}/front.jpg`]);
    for (let i = 0; i < paths.length; i += 100) await admin.storage.from('sos').remove(paths.slice(i, i + 100));
    if (rows.length) await admin.from('sos').delete().in('id', rows.map(r => r.id));
    await admin.from('codes').delete().lt('expires_at', new Date().toISOString());
    return json({ deleted: rows.length });
  } catch (e) {
    console.error(e);
    return json({ error: 'Errore' }, 500);
  }
});
