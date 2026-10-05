import { adminClient, cors, currentUser, json } from '../_shared/http.ts';
import { sendSosPush, serviceAccount } from '../_shared/fcm.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = adminClient();
    const user = await currentUser(req, admin);
    if (!user) return json({ error: 'Accedi per continuare' }, 401);

    const { sosId, lat, lng } = await req.json();
    const { data, error } = await admin.rpc('send_sos', {
      p_uid: user.id, p_sos_id: sosId,
      p_lat: typeof lat === 'number' ? lat : null, p_lng: typeof lng === 'number' ? lng : null
    });
    if (error) {
      if (error.code === 'P0001') return json({ error: error.message }, 400);
      console.error('send_sos', error);
      return json({ error: 'Errore' }, 500);
    }

    // L'SOS è già salvato: un problema con le push non deve far fallire la richiesta.
    const sa = serviceAccount();
    const tokens: string[] = (data.tokens ?? []).map((t: { token: string }) => t.token);
    if (!sa) console.error('FCM_SERVICE_ACCOUNT mancante: nessuna push inviata');
    else if (tokens.length) {
      const res = await Promise.allSettled(tokens.map(t => sendSosPush(sa, t, data.me, sosId)));
      const dead = tokens.filter((_, i) => res[i].status === 'fulfilled' && (res[i] as PromiseFulfilledResult<string>).value === 'dead');
      res.forEach(r => r.status === 'rejected' && console.error('push', r.reason));
      if (dead.length) await admin.rpc('remove_dead_tokens', { p_tokens: dead });
    }
    return json({ recipients: data.recipients });
  } catch (e) {
    console.error(e);
    return json({ error: 'Errore' }, 500);
  }
});
