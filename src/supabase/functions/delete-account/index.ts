import { adminClient, cors, currentUser, json } from '../_shared/http.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = adminClient();
    const user = await currentUser(req, admin);
    if (!user) return json({ error: 'Accedi per continuare' }, 401);

    const { data, error } = await admin.rpc('delete_account_data', { p_uid: user.id });
    if (error) { console.error(error); return json({ error: 'Errore' }, 500); }

    const paths = (data as string[]).flatMap(id => [`${user.id}/${id}/back.jpg`, `${user.id}/${id}/front.jpg`]);
    for (let i = 0; i < paths.length; i += 100) await admin.storage.from('sos').remove(paths.slice(i, i + 100));

    const { error: de } = await admin.auth.admin.deleteUser(user.id);
    if (de) { console.error(de); return json({ error: 'Errore' }, 500); }
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: 'Errore' }, 500);
  }
});
