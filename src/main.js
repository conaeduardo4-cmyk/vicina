import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';
import { call, onUser, signIn, signUp, signOut, resetPassword, getProfile, putProfile, setMuted, addToken,
  watchProfile, watchLinks, watchGroups, watchMessages, sendText, uploadPhoto, photoUrl } from './supabase.js';

/* ---------- utilità ---------- */
const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
const I = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COL = ['#FF9500', '#AF52DE', '#32ADE6', '#34C759', '#FF2D55', '#5856D6'];
const col = n => COL[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const AV = (n, k) => k === 'g' ? `<div class="av" style="background:#5856D6">${I('people')}</div>` : `<div class="av" style="background:${col(n)}">${esc(String(n)[0] || '?')}</div>`;
const GG = { f: { sola: 'sola', prot: 'protetta', amico: "un'amica", amicoS: 'Amica', entr: 'entrata' }, m: { sola: 'solo', prot: 'protetto', amico: 'un amico', amicoS: 'Amico', entr: 'entrato' } };
const G = () => GG[st.g];
let tt; const toast = t => { const e = $('#toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(tt); tt = setTimeout(() => e.style.display = 'none', 2600); };
const isNet = e => !navigator.onLine || /fetch|network/i.test(e?.message || '');
const msg = e => (e?.code || '').includes('unavailable') || isNet(e) ? 'Connessione assente' : (e?.message || 'Errore');
const AE = { invalid_credentials: 'Email o password non corrette', user_already_exists: 'Esiste già un account con questa email', email_exists: 'Esiste già un account con questa email', weak_password: 'La password deve avere almeno 6 caratteri', validation_failed: 'Email non valida', email_address_invalid: 'Email non valida', email_not_confirmed: 'Conferma prima la tua email', over_request_rate_limit: 'Troppi tentativi, riprova più tardi', over_email_send_rate_limit: 'Troppe email inviate, riprova più tra poco' };

/* ---------- stato ---------- */
const st = { g: 'f', name: '', sur: '', uid: null, partner: null, friends: [], groups: [], muted: [], th: {}, open: null, raw: { links: [], groups: [] } };
let curG = null, draft = null, unsubs = [], chatUn = {};

const people = () => [...(st.partner ? [{ ...st.partner, k: 'p', sub: 'Partner' }] : []), ...st.friends.map(f => ({ ...f, k: 'f', sub: G().amicoS })),
  ...st.groups.map(g => ({ id: g.id, name: g.name, k: 'g', sub: g.members.length + '/8 persone', on: g.on && g.members.length > 1 }))];
const recips = () => people().filter(p => p.k !== 'g' || p.on);

function mapLinks() {
  st.partner = null; st.friends = [];
  for (const l of st.raw.links) { const o = l.uids.find(x => x !== st.uid); const p = { id: l.id, name: l.names?.[o] || 'Contatto' }; if (l.kind === 'partner') st.partner = p; else st.friends.push(p); }
}
function mapGroups() {
  st.groups = st.raw.groups.map(g => ({
    id: g.id, name: g.name, code: g.code, adminUid: g.adminUid, admin: g.adminUid === st.uid, on: !st.muted.includes(g.id),
    members: Object.entries(g.members || {}).map(([uid, name]) => ({ uid, name })).sort((a, b) => (b.uid === g.adminUid) - (a.uid === g.adminUid)),
    req: Object.entries(g.requests || {}).map(([uid, name]) => ({ uid, name }))
  }));
}

/* ---------- navigazione ---------- */
function go(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  $('#nav').style.display = ['wel', 'prof', 'login'].includes(id) ? 'none' : 'flex';
  if (id === 'chat') st.open = null; rAll();
}
$('#nav').style.display = 'none';
$$('#nav button').forEach(b => b.onclick = () => go(b.dataset.go));
const rAll = () => { rH(); rC(); rP(); };

/* ---------- home ---------- */
function rH() {
  const r = recips();
  $('#stat').innerHTML = r.length
    ? `<div class="stk">${r.slice(0, 4).map(p => AV(p.name, p.k)).join('')}${r.length > 4 ? `<div class="av more">+${r.length - 4}</div>` : ''}</div><div><b>Sei ${G().prot}</b><span>L'SOS arriva a ${r.length} ${r.length == 1 ? 'destinatario' : 'destinatari'}</span></div>`
    : `<div class="av" style="background:var(--fill);color:var(--sub)">${I('bell')}</div><div><b>Nessuno da avvisare</b><span>Aggiungi ${G().amico}, il partner o un gruppo</span></div>`;
}

/* ---------- chat (tempo reale) ---------- */
const urlCache = {};
const nameOf = (cid, uid) => st.raw.groups.find(x => x.id === cid)?.members?.[uid] || '';
function mapMsg(cid, m) {
  const mine = m.from === st.uid, t = m.createdAt ? new Date(m.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '';
  if (m.type === 'sos') {
    const slots = ['back', 'front'].map(k => { const p = (m.photos || []).find(x => x.endsWith('/' + k + '.jpg'));
      return p ? `<img alt="Foto ${k === 'back' ? 'posteriore' : 'frontale'}" data-p="${esc(p)}" src="${urlCache[p] || 'data:,'}">` : `<div>${I('camera')}In arrivo…</div>`; }).join('');
    const loc = m.lat != null ? `<a class="loc" href="https://maps.google.com/?q=${m.lat},${m.lng}" target="_blank" rel="noopener">${I('pin')}Apri la posizione</a>` : `<div class="s">Posizione non disponibile</div>`;
    return { cls: 'sos', t, pre: 'SOS – Ho bisogno di aiuto', html: `<div class="sosh">${I('alert')}SOS ${mine ? 'inviato da te' : 'da ' + esc(m.fromName)}</div>Ho bisogno di aiuto e non riesco a scrivere. Ecco dove sono e le foto di quello che ho intorno. Chiamami o raggiungimi subito.<div class="ph">${slots}</div>${loc}` };
  }
  const who = mine ? '' : nameOf(cid, m.from);
  return { cls: mine ? '' : 'in', t, pre: m.text, html: (who ? `<b class="s">${esc(who)}</b><br>` : '') + esc(m.text) };
}
async function hydrate() {
  for (const im of $$('#msgs img[data-p]')) {
    const p = im.dataset.p;
    try { urlCache[p] = urlCache[p] || await photoUrl(p); im.src = urlCache[p]; }
    catch { const d = document.createElement('div'); d.innerHTML = I('camera') + 'Foto non disponibile'; im.replaceWith(d); }
  }
}
function rC() {
  const o = st.open; $('#cl').style.display = o ? 'none' : 'flex'; $('#ct').style.display = o ? 'flex' : 'none';
  if (!o) {
    const p = people();
    $('#cList').innerHTML = p.length ? `<div class="grp">${p.map(x => { const m = (st.th[x.id] || []).slice(-1)[0];
      return `<div class="row" data-a="open" data-id="${x.id}">${AV(x.name, x.k)}<div class="fl"><b>${esc(x.name)}</b><span class="s" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m ? esc(m.pre) : esc(x.sub)}</span></div>${m ? `<span class="s">${m.t}</span>` : ''}${I('chev', 'c')}</div>`; }).join('')}</div>`
      : `<div class="empty">Nessuna conversazione. Aggiungi qualcuno dalla scheda Persone.</div>`;
    return;
  }
  const x = people().find(p => p.id === o); if (!x) { st.open = null; return rC(); }
  $('#tName').textContent = x.name; $('#tSub').textContent = x.sub; $('#tAv').innerHTML = AV(x.name, x.k);
  const l = st.th[o] || [];
  $('#msgs').innerHTML = l.length ? l.map(m => `<div class="msg ${m.cls}">${m.html}<div class="t">${m.t}</div></div>`).join('') : `<div class="empty">Qui compariranno i messaggi.</div>`;
  $('#msgs').scrollTop = 1e9; hydrate();
}
$('#send').onclick = async () => {
  const v = $('#txt').value.trim(); if (!v || !st.open) return; $('#txt').value = '';
  try { await sendText(st.open, st.uid, v); chatUn[st.open]?.reload?.(); } catch (e) { toast(msg(e)); }
};
$('#txt').onkeydown = e => { if (e.key === 'Enter') $('#send').click(); };

function syncChats() {
  const ids = new Set([...st.raw.links.map(l => l.id), ...st.raw.groups.map(g => g.id)]);
  for (const id of ids) if (!chatUn[id]) chatUn[id] = watchMessages(id, ms => { st.th[id] = ms.map(m => mapMsg(id, m)); rC(); });
  for (const id in chatUn) if (!ids.has(id)) { chatUn[id](); delete chatUn[id]; delete st.th[id]; }
}
function listen() {
  const u = st.uid;
  unsubs.push(watchProfile(u, p => { st.muted = p?.mutedGroups || []; mapGroups(); rAll(); }));
  unsubs.push(watchLinks(r => { st.raw.links = r; mapLinks(); syncChats(); rAll(); }));
  unsubs.push(watchGroups(r => { st.raw.groups = r; mapGroups(); syncChats(); rAll(); if (curG && $('#sb').classList.contains('on')) gSheet(curG); }));
}
function stopAll() {
  unsubs.forEach(f => f()); unsubs = []; Object.values(chatUn).forEach(f => f()); chatUn = {};
  Object.assign(st, { uid: null, partner: null, friends: [], groups: [], muted: [], th: {}, open: null, raw: { links: [], groups: [] } });
}

/* ---------- persone ---------- */
function rP() {
  const p = st.partner;
  $('#cir').innerHTML =
    `<div class="sh">Partner (facoltativo)</div><div class="grp">${p ? `<div class="row">${AV(p.name)}<div class="fl"><b>${esc(p.name)}</b><span class="s">Riceve i tuoi SOS</span></div><button class="ic" data-a="rmL" data-id="${p.id}" aria-label="Rimuovi">${I('x')}</button></div>` : `<div class="row tint" data-a="add" data-k="partner">${I('heart')}<span>Aggiungi partner</span></div>`}</div>`
    + `<div class="sh">Amici</div><div class="grp">${st.friends.map(f => `<div class="row">${AV(f.name)}<div class="fl"><b>${esc(f.name)}</b><span class="s">Riceve i tuoi SOS</span></div><button class="ic" data-a="rmL" data-id="${f.id}" aria-label="Rimuovi">${I('x')}</button></div>`).join('')}<div class="row tint" data-a="add" data-k="friend">${I('plus')}<span>Aggiungi ${G().amico}</span></div></div>`
    + `<div class="sh">Gruppi</div><div class="grp">${st.groups.map(g => `<div class="row" data-a="grp" data-id="${g.id}">${AV(g.name, 'g')}<div class="fl"><b>${esc(g.name)}</b><span class="s">${g.members.length}/8 persone${g.on ? '' : ' · SOS disattivato'}</span></div>${I('chev', 'c')}</div>`).join('')}<div class="row tint" data-a="add" data-k="newg">${I('plus')}<span>Crea un gruppo</span></div><div class="row tint" data-a="add" data-k="join">${I('people')}<span>Entra con un codice</span></div></div><div class="sf">Ogni gruppo può avere fino a 8 persone. L'SOS arriva a tutti: partner, amici e gruppi.</div>`
    + `<div class="sh">Account</div><div class="grp"><div class="row tint" data-a="out">${I('back')}<span>Esci</span></div><div class="row" data-a="del" style="color:var(--red)">${I('alert')}<span>Elimina account</span></div></div>`;
}

/* ---------- sheet ---------- */
const openSheet = h => { $('#sheet').innerHTML = '<div class="grab"></div>' + h; $('#sb').classList.add('on'); };
const closeSheet = () => { $('#sb').classList.remove('on'); curG = null; };
$('#sb').addEventListener('click', e => { if (e.target.id === 'sb') closeSheet(); });
async function addSheet(k) {
  curG = null;
  if (k === 'newg') return openSheet(`<h2>Nuovo gruppo</h2><p class="m" style="margin:6px 0 14px">Poi inviti le altre persone con un codice. Entrano solo se confermi tu.</p><div class="inset"><input type="text" id="gn" placeholder="Nome del gruppo" maxlength="30"></div><button class="btn" data-a="mkG">Crea gruppo</button>`);
  if (k === 'join') return openSheet(`<h2>Entra in un gruppo</h2><p class="m" style="margin:6px 0 14px">Inserisci il codice che ti ha dato l'admin. Dovrà confermare la tua richiesta.</p><div class="inset"><input type="text" id="ic" placeholder="Codice a 6 caratteri" maxlength="6" autocapitalize="characters"></div><button class="btn" data-a="doAdd">Chiedi di entrare</button>`);
  if (k === 'partner' && st.partner) { toast('Hai già un partner'); return; }
  openSheet(`<h2>${k === 'partner' ? 'Aggiungi partner' : 'Aggiungi ' + G().amico}</h2><p class="m" style="margin:6px 0 0">Dai questo codice alla persona (valido 10 minuti) oppure inserisci il suo. Il collegamento richiede il consenso di entrambi.</p><div class="code" id="invc">······</div><div class="inset"><input type="text" id="ic" placeholder="Codice dell'altra persona" maxlength="6" autocapitalize="characters"></div><button class="btn" data-a="doAdd">Collega</button>`);
  try { $('#invc').textContent = (await call('createInvite', { kind: k })).code; } catch (e) { toast(msg(e)); }
}
function gSheet(id) {
  const g = st.groups.find(x => x.id === id); if (!g) return;
  openSheet(`<div class="shr"><h2>${esc(g.name)}</h2><span class="chip">${g.members.length}/8</span></div>
  ${g.admin ? `<div class="code sm">${esc(g.code)}</div><p class="m" style="text-align:center">Codice invito: chi lo inserisce entra solo dopo la tua conferma.</p>` : ''}
  ${g.admin && g.req.length ? `<div class="sh">Richieste di ingresso</div><div class="grp">${g.req.map(m => `<div class="row">${AV(m.name)}<div class="fl"><b>${esc(m.name)}</b></div><button class="pill" data-a="no" data-id="${id}" data-uid="${m.uid}">Rifiuta</button><button class="pill on" data-a="ok" data-id="${id}" data-uid="${m.uid}">Accetta</button></div>`).join('')}</div>` : ''}
  <div class="sh">Membri</div><div class="grp">${g.members.map(m => `<div class="row">${AV(m.name)}<div class="fl"><b>${esc(m.name)}${m.uid === st.uid ? ' (tu)' : ''}</b></div>${m.uid === g.adminUid ? '<span class="s">Admin</span>' : (g.admin ? `<button class="ic" data-a="rmM" data-id="${id}" data-uid="${m.uid}" aria-label="Rimuovi">${I('x')}</button>` : '')}</div>`).join('')}</div>
  <div class="sh"></div><div class="grp"><label class="row"><span class="fl">Includi negli SOS</span><input type="checkbox" data-t="${id}" ${g.on ? 'checked' : ''}></label></div>
  ${g.admin ? `<button class="btn red" data-a="delG" data-id="${id}">Elimina gruppo</button>` : `<button class="btn red" data-a="leave" data-id="${id}">Esci dal gruppo</button>`}`);
}
$('#sheet').addEventListener('change', async e => {
  const id = e.target.dataset.t; if (!id) return;
  try { await setMuted(id, !e.target.checked); } catch (x) { toast(msg(x)); }
});
function permSheet() {
  openSheet(`<h2>Permessi per l'SOS</h2><p class="m" style="margin:6px 0 14px">Te li chiediamo ora, una sola volta, così durante un SOS non compare nessuna richiesta.</p>
  <div class="grp"><div class="row">${I('pin')}<div class="fl"><b>Posizione</b><span class="s">Solo quando usi l'app</span></div></div><div class="row">${I('camera')}<div class="fl"><b>Fotocamera</b><span class="s">Foto davanti e dietro durante l'SOS</span></div></div><div class="row">${I('bell')}<div class="fl"><b>Notifiche</b><span class="s">Per ricevere gli SOS degli altri</span></div></div></div>
  <button class="btn" data-a="perm">Continua</button>`);
}

/* ---------- azioni ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-a]'); if (!t) return;
  const a = t.dataset.a, id = t.dataset.id, uid = t.dataset.uid;
  try {
    if (a === 'open') { st.open = id; rC(); }
    else if (a === 'back') { st.open = null; rC(); }
    else if (a === 'add') addSheet(t.dataset.k);
    else if (a === 'grp') { curG = id; gSheet(id); }
    else if (a === 'doAdd') {
      const c = $('#ic').value.trim().toUpperCase(); if (c.length < 6) { toast('Il codice ha 6 caratteri'); return; }
      const r = await call('redeemInvite', { code: c }); closeSheet();
      toast(r.kind === 'group' ? 'Richiesta inviata: attendi la conferma' : 'Collegamento confermato con ' + r.name);
    }
    else if (a === 'mkG') { const n = $('#gn').value.trim(); if (!n) { toast('Dai un nome al gruppo'); return; } const r = await call('createGroup', { name: n }); curG = r.groupId; gSheet(r.groupId); }
    else if (a === 'rmL') { if (confirm('Rimuovere questo contatto?')) await call('removeLink', { linkId: id }); }
    else if (a === 'ok' || a === 'no') await call('decideJoin', { groupId: id, uid, accept: a === 'ok' });
    else if (a === 'rmM') await call('removeMember', { groupId: id, uid });
    else if (a === 'leave') { if (confirm('Uscire dal gruppo?')) { await call('removeMember', { groupId: id, uid: st.uid }); closeSheet(); } }
    else if (a === 'delG') { if (confirm('Eliminare il gruppo?')) { await call('deleteGroup', { groupId: id }); closeSheet(); } }
    else if (a === 'perm') { await askPerms(); closeSheet(); }
    else if (a === 'out') await signOut();
    else if (a === 'del') { if (confirm('Eliminare definitivamente il tuo account e tutti i dati?')) { await call('deleteAccount'); await signOut().catch(() => {}); } }
  } catch (err) { toast(msg(err)); }
});

/* ---------- permessi, notifiche push ---------- */
async function setupPush(ask) {
  if (!Capacitor.isNativePlatform() || !st.uid) return;
  try {
    let r = (await FirebaseMessaging.checkPermissions()).receive;
    if (r !== 'granted' && ask) r = (await FirebaseMessaging.requestPermissions()).receive;
    if (r !== 'granted') return;
    if (Capacitor.getPlatform() === 'android') await FirebaseMessaging.createChannel({ id: 'sos', name: 'SOS', importance: 5 });
    const { token } = await FirebaseMessaging.getToken();
    await addToken(token);
    if (!setupPush.l) { setupPush.l = 1; FirebaseMessaging.addListener('tokenReceived', ev => st.uid && addToken(ev.token).catch(() => {})); }
  } catch (e) { console.warn('push', e); }
}
async function askPerms() {
  try { await Geolocation.requestPermissions(); } catch {}
  try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); } catch {}
  await setupPush(true); localStorage.permAsked = '1';
}

/* ---------- SOS ---------- */
const C = 779.1, HOLD = 2000; let raf, t0 = 0, busy = false; const sos = $('#sos'), prog = $('#prog');
const reset = () => { cancelAnimationFrame(raf); sos.classList.remove('hold'); prog.style.strokeDashoffset = C; };
function loop() { const p = Math.min((performance.now() - t0) / HOLD, 1); prog.style.strokeDashoffset = C * (1 - p); if (p >= 1) { reset(); if (navigator.vibrate) navigator.vibrate(60); trigger(); } else raf = requestAnimationFrame(loop); }
sos.addEventListener('pointerdown', e => { if (busy) return; e.preventDefault(); sos.classList.add('hold'); t0 = performance.now(); raf = requestAnimationFrame(loop); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(v => sos.addEventListener(v, reset));
sos.addEventListener('contextmenu', e => e.preventDefault());
sos.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') trigger(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
const step = (n, s) => $('#s' + n).className = 'step ' + s;
const rid = () => crypto.randomUUID?.().replace(/-/g, '') || Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
async function getPos() {
  for (const o of [{ enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }, { enableHighAccuracy: false, timeout: 4000, maximumAge: 600000 }])
    try { const p = await Geolocation.getCurrentPosition(o); return { lat: p.coords.latitude, lng: p.coords.longitude }; } catch {}
  return null;
}
async function snap(facing) { // foto con la fotocamera indicata, senza anteprima (app in primo piano)
  let s, v;
  try {
    s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false });
    v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = s;
    v.style.cssText = 'position:fixed;opacity:0;width:1px;height:1px;pointer-events:none'; document.body.appendChild(v);
    await v.play(); await wait(600); // tempo per l'esposizione automatica
    const k = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement('canvas');
    c.width = v.videoWidth * k; c.height = v.videoHeight * k; c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; }
  finally { s?.getTracks().forEach(t => t.stop()); v?.remove(); }
}
function end() { busy = false; $('#ov').classList.remove('on'); $('#flash').classList.remove('go'); }
async function trigger() {
  if (busy) return;
  const r = recips(); if (!r.length) { toast('Aggiungi prima qualcuno da avvisare'); go('circle'); return; }
  busy = true; let off = 0; $('#cancel').style.display = 'block'; $('#ov').classList.add('on'); $('#cancel').onclick = () => { off = 1; };
  [1, 2, 3, 4].forEach(n => step(n, ''));
  const sosId = rid();
  try {
    step(1, 'run'); const pos = await getPos(); if (off) return end(); step(1, 'done');
    step(2, 'run'); await call('sendSos', { sosId, lat: pos?.lat ?? null, lng: pos?.lng ?? null }); $('#cancel').style.display = 'none'; step(2, 'done'); // l'allarme parte subito, le foto si aggiungono dopo
    for (const [n, facing, file] of [[3, 'environment', 'back'], [4, 'user', 'front']]) {
      step(n, 'run'); const img = await snap(facing);
      if (img) {
        $('#flash').classList.add('go');
        const path = `${st.uid}/${sosId}/${file}.jpg`;
        try { await uploadPhoto(path, img); await call('attachSosPhotos', { sosId, paths: [path] }); } catch (e) { console.warn('foto', e); }
        await wait(350); $('#flash').classList.remove('go');
      }
      step(n, 'done');
    }
    await wait(300); end(); go('chat'); st.open = r[0].id; rC(); toast('SOS inviato a ' + r.length + (r.length == 1 ? ' destinatario' : ' destinatari'));
  } catch (e) {
    end(); toast(e?.code === 'precondition' ? e.message : 'Invio non riuscito. Controlla la connessione e riprova.'); // TODO: fallback SMS offline
  }
}

/* ---------- onboarding ---------- */
const PG = [
  ['shield', 'linear-gradient(160deg,#FF6A60,#FF3B30)', 'Un tocco, e qualcuno lo sa', 'Vicina avvisa le persone di cui ti fidi quando ti senti in pericolo, senza che tu debba scrivere nulla.'],
  ['alert', 'linear-gradient(160deg,#FF9F0A,#FF6A00)', 'Il pulsante SOS', 'Sta al centro dello schermo. Tienilo premuto 2 secondi: così non parte per sbaglio.'],
  ['pin', 'linear-gradient(160deg,#5AC8FA,#007AFF)', 'Posizione e foto', 'Parte la tua posizione attuale, con una foto scattata dalla fotocamera posteriore e una da quella frontale.'],
  ['people', 'linear-gradient(160deg,#BF5AF2,#5856D6)', 'Partner, amici e gruppi', 'Aggiungi chi vuoi con un codice. Crea gruppi fino a 8 persone: l’SOS arriva a tutti insieme.'],
  ['chat', 'linear-gradient(160deg,#30D158,#00A63E)', 'Messaggio già pronto', 'Nella chat dell’app arriva un messaggio precompilato: in emergenza non c’è tempo per scrivere.'],
  ['check', 'linear-gradient(160deg,#8E8E93,#48484A)', 'Decidi tu', 'Nessuno si collega senza il tuo consenso e puoi rimuovere chiunque quando vuoi. Non sostituisce il 112.']];
let wi = 0;
$('#wtrk').innerHTML = PG.map(p => `<div class="pg"><div class="big" style="background:${p[1]}">${I(p[0])}</div><h1>${p[2]}</h1><p>${p[3]}</p></div>`).join('');
$('#dots').innerHTML = PG.map(() => '<i></i>').join('');
function wGo(n) { wi = Math.max(0, Math.min(PG.length - 1, n)); const L = wi === PG.length - 1;
  $('#wtrk').style.transform = 'translateX(-' + wi * 100 + '%)'; $$('#dots i').forEach((d, k) => d.classList.toggle('on', k === wi));
  $('#wnext').textContent = L ? 'Inizia' : 'Continua'; $('#wskip').style.visibility = L ? 'hidden' : 'visible'; }
const leaveWel = () => { localStorage.seen = '1'; go('prof'); };
$('#wnext').onclick = () => wi === PG.length - 1 ? leaveWel() : wGo(wi + 1);
$('#wskip').onclick = leaveWel;
let sx = 0; $('#wvp').addEventListener('touchstart', e => sx = e.touches[0].clientX, { passive: true });
$('#wvp').addEventListener('touchend', e => { const d = e.changedTouches[0].clientX - sx; if (Math.abs(d) > 50) wGo(wi + (d < 0 ? 1 : -1)); });
wGo(0);

let gSel = null; $('#pd').max = new Date().toISOString().slice(0, 10);
const chkProf = () => $('#pnext').disabled = !($('#pn').value.trim() && $('#ps').value.trim() && $('#pd').value && gSel);
$$('.seg button').forEach(b => b.onclick = () => { gSel = b.dataset.g; $$('.seg button').forEach(x => x.classList.toggle('on', x === b)); chkProf(); });
['#pn', '#ps', '#pd'].forEach(x => $(x).addEventListener('input', chkProf));
const applyG = () => { $('#lt').textContent = 'Non sei mai ' + G().sola + '.'; $('#hn').textContent = 'Ciao, ' + st.name; };
$('#pnext').onclick = async () => {
  const d = new Date($('#pd').value), n = new Date(); let a = n.getFullYear() - d.getFullYear();
  if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--;
  if (isNaN(a) || a < 14) { toast('Per usare l\'app servono almeno 14 anni'); return; }
  draft = { gender: gSel, name: $('#pn').value.trim(), surname: $('#ps').value.trim(), dob: $('#pd').value };
  st.g = gSel; st.name = draft.name; applyG();
  if (st.uid) { try { await saveProfile(); start(); } catch (e) { toast(msg(e)); } } else go('login');
};

/* ---------- login e profilo ---------- */
async function authGo(create) {
  const em = $('#email').value.trim(), pw = $('#pwd').value; if (!em || !pw) { toast('Inserisci email e password'); return; }
  try {
    if (create) { if ((await signUp(em, pw)).needsConfirm) toast('Controlla la tua email per confermare l\'account'); }
    else await signIn(em, pw);
  } catch (e) { toast(AE[e.code] || (isNet(e) ? 'Connessione assente' : 'Accesso non riuscito')); }
}
$('#btnLogin').onclick = () => authGo(false); $('#btnReg').onclick = () => authGo(true);
$('#btnReset').onclick = async () => { const em = $('#email').value.trim(); if (!em) { toast('Scrivi prima la tua email'); return; }
  try { await resetPassword(em); toast('Ti abbiamo inviato un\'email per reimpostarla'); } catch (e) { toast(AE[e.code] || (isNet(e) ? 'Connessione assente' : 'Invio non riuscito')); } };
async function saveProfile() {
  await putProfile(st.uid, draft);
}
function start() {
  applyG(); listen(); go('home');
  if (localStorage.permAsked) setupPush(false); else setTimeout(permSheet, 600);
}
let cur; // evita di riavviare tutto quando Supabase riemette lo stesso utente (es. al ritorno in primo piano)
onUser(async u => {
  const id = u?.id || null; if (id === cur) return; cur = id;
  if (!u) { stopAll(); go(localStorage.seen ? 'login' : 'wel'); return; }
  st.uid = u.id;
  try {
    const d = await getProfile(u.id);
    if (d) { st.g = d.gender; st.name = d.name; st.sur = d.surname; start(); }
    else if (draft) { await saveProfile(); start(); }
    else go('prof');
  } catch (e) { toast(msg(e)); }
});
rAll();
