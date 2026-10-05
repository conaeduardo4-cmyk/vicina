// Backend di Vicina su Supabase (sostituisce src/firebase.js).
import { createClient } from '@supabase/supabase-js';

const e = import.meta.env;
export const sb = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

/* ---------- errori ---------- */
// code: 'precondition' = messaggio pensato per l'utente, 'unavailable' = niente rete, 'internal' = altro
export class AppError extends Error { constructor(m, code) { super(m); this.code = code; } }
const isNet = x => !navigator.onLine || /fetch|network|timeout/i.test(x?.message || '') || x?.name === 'FunctionsFetchError';
const norm = x => {
  if (x instanceof AppError) return x;
  if (isNet(x)) return new AppError('Connessione assente', 'unavailable');
  if (x?.code === 'P0001') return new AppError(x.message, 'precondition');
  console.warn(x);
  return new AppError('Errore', 'internal');
};

/* ---------- chiamate al server (stesso nome delle vecchie Cloud Functions) ---------- */
const RPC = {
  createInvite: ['create_invite', d => ({ p_kind: d.kind })],
  redeemInvite: ['redeem_invite', d => ({ p_code: d.code })],
  removeLink: ['remove_link', d => ({ p_link_id: d.linkId })],
  createGroup: ['create_group', d => ({ p_name: d.name })],
  decideJoin: ['decide_join', d => ({ p_group_id: d.groupId, p_uid: d.uid, p_accept: !!d.accept })],
  removeMember: ['remove_member', d => ({ p_group_id: d.groupId, p_uid: d.uid })],
  deleteGroup: ['delete_group', d => ({ p_group_id: d.groupId })],
  attachSosPhotos: ['attach_sos_photos', d => ({ p_sos_id: d.sosId, p_paths: d.paths })]
};
const FN = { sendSos: 'send-sos', deleteAccount: 'delete-account' };

export async function call(name, data = {}) {
  if (RPC[name]) {
    const [fn, args] = RPC[name];
    const { data: r, error } = await sb.rpc(fn, args(data));
    if (error) throw norm(error);
    return r;
  }
  const { data: r, error } = await sb.functions.invoke(FN[name], { body: data });
  if (error) {
    let m = null;
    try { const j = await error.context.json(); if (error.context.status === 400) m = j.error; } catch { /* nessun corpo */ }
    throw m ? new AppError(m, 'precondition') : norm(error);
  }
  return r;
}

/* ---------- accesso ---------- */
export function onUser(cb) {
  return sb.auth.onAuthStateChange((ev, s) => {
    if (ev === 'TOKEN_REFRESHED' || ev === 'USER_UPDATED' || ev === 'PASSWORD_RECOVERY') return;
    setTimeout(() => cb(s?.user ?? null), 0); // mai chiamare Supabase direttamente qui dentro
  });
}
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
}
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password }); if (error) throw error;
  return { needsConfirm: !data.session };
}
export const signOut = () => sb.auth.signOut({ scope: 'local' });
export async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: e.VITE_RESET_URL || undefined }); if (error) throw error;
}

/* ---------- profilo e impostazioni ---------- */
export async function getProfile(uid) {
  const { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (error) throw norm(error);
  return data && { name: data.name, surname: data.surname, dob: data.dob, gender: data.gender, mutedGroups: data.muted_groups || [] };
}
export async function putProfile(uid, d) {
  const { error } = await sb.from('profiles').insert({ id: uid, name: d.name, surname: d.surname, dob: d.dob, gender: d.gender });
  if (error) throw norm(error);
}
export async function setMuted(groupId, muted) {
  const { error } = await sb.rpc('set_group_muted', { p_group_id: groupId, p_muted: muted }); if (error) throw norm(error);
}
export async function addToken(token) {
  const { error } = await sb.rpc('add_fcm_token', { p_token: token }); if (error) throw norm(error);
}

/* ---------- tempo reale ----------
   Ad ogni evento ricarico i dati (poche righe): più semplice e robusto che applicare i cambiamenti uno a uno.
   Ricarico anche quando l'app torna in primo piano e ogni minuto, perché chi viene tolto da un gruppo
   non riceve l'evento (non vede più la riga) e deve accorgersene comunque. */
function live(table, filter, load, cb) {
  let dead = false, busy = false, again = false, last = '';
  const run = async () => {
    if (dead) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const d = await load(), s = JSON.stringify(d);
        if (s !== last && !dead) { last = s; cb(d); }
      } while (again && !dead);
    } catch (x) { console.warn('live', table, x); }
    busy = false;
  };
  const ch = sb.channel(`${table}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, run)
    .subscribe(s => { if (s === 'SUBSCRIBED') run(); });
  const poll = setInterval(run, 60000);
  const vis = () => { if (document.visibilityState === 'visible') run(); };
  document.addEventListener('visibilitychange', vis);
  run();
  const stop = () => { dead = true; clearInterval(poll); document.removeEventListener('visibilitychange', vis); sb.removeChannel(ch); };
  stop.reload = run;
  return stop;
}
const rows = async q => { const { data, error } = await q; if (error) throw error; return data; };

export const watchProfile = (uid, cb) => live('profiles', `id=eq.${uid}`, () => getProfile(uid), cb);
export const watchLinks = cb => live('links', null,
  async () => (await rows(sb.from('links').select('*'))).map(r => ({ id: r.id, kind: r.kind, uids: r.uids, names: r.names })), cb);
export const watchGroups = cb => live('groups', null,
  async () => (await rows(sb.from('groups').select('*'))).map(r => ({
    id: r.id, name: r.name, code: r.code, adminUid: r.admin_uid, memberUids: r.member_uids, members: r.members, requests: r.requests })), cb);
export const watchMessages = (chatId, cb) => live('messages', `chat_id=eq.${chatId}`,
  async () => (await rows(sb.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(100)))
    .reverse().map(r => ({ type: r.type, from: r.sender, fromName: r.from_name, text: r.text, sosId: r.sos_id,
      lat: r.lat, lng: r.lng, photos: r.photos || [], createdAt: r.created_at })), cb);

/* ---------- messaggi e foto ---------- */
export async function sendText(chatId, uid, text) {
  const { error } = await sb.from('messages').insert({ chat_id: chatId, type: 'text', sender: uid, text });
  if (error) throw norm(error);
}
export async function uploadPhoto(path, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const { error } = await sb.storage.from('sos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
}
export async function photoUrl(path) {
  const { data, error } = await sb.storage.from('sos').createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}
