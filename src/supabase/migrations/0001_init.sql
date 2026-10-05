-- Vicina: schema Supabase (sostituisce Firestore + regole + Cloud Functions).
-- Eseguilo una volta dal SQL Editor di Supabase (oppure con `supabase db push`).

create extension if not exists pgcrypto with schema extensions;

-- ---------- tabelle ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  surname text not null check (char_length(surname) between 1 and 40),
  dob date not null,
  gender text not null check (gender in ('f','m')),
  muted_groups text[] not null default '{}',
  fcm_tokens text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.links (
  id text primary key,                       -- "uidA_uidB" (ordinati)
  kind text not null check (kind in ('friend','partner')),
  uids uuid[] not null,
  names jsonb not null,
  created_at timestamptz not null default now()
);
create index links_uids_idx on public.links using gin (uids);

create table public.groups (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  admin_uid uuid not null,
  code text not null,
  member_uids uuid[] not null,
  members jsonb not null,                    -- { uid: "Nome Cognome" }
  requests jsonb not null default '{}',      -- richieste di ingresso in attesa
  created_at timestamptz not null default now()
);
create index groups_members_idx on public.groups using gin (member_uids);

create table public.codes (
  code text primary key,
  kind text not null check (kind in ('friend','partner','group')),
  owner uuid not null,
  group_id text,
  expires_at timestamptz                     -- null per i codici gruppo
);

create table public.chats (
  id text primary key,                       -- = id del link o del gruppo
  kind text not null check (kind in ('direct','group')),
  participants uuid[] not null
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null references public.chats(id) on delete cascade,
  type text not null check (type in ('text','sos')),
  sender uuid not null,
  from_name text,
  text text check (text is null or char_length(text) <= 1000),
  sos_id text,
  lat double precision,
  lng double precision,
  photos text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_chat_idx on public.messages (chat_id, created_at desc);
create index messages_sender_idx on public.messages (sender);

create table public.sos (
  id text primary key,
  sender uuid not null,
  from_name text,
  recipients uuid[] not null,
  msgs uuid[] not null,
  lat double precision,
  lng double precision,
  photos text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index sos_created_idx on public.sos (created_at);
create index sos_sender_idx on public.sos (sender);

-- ---------- sicurezza a livello di riga (equivalente di firestore.rules) ----------
alter table public.profiles enable row level security;
alter table public.links    enable row level security;
alter table public.groups   enable row level security;
alter table public.codes    enable row level security;
alter table public.chats    enable row level security;
alter table public.messages enable row level security;
alter table public.sos      enable row level security;

-- Profilo: lo legge e lo crea solo il proprietario. Le modifiche passano da funzioni dedicate.
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());

-- Collegamenti, gruppi, SOS, chat: solo lettura per chi ne fa parte. Le scritture le fa il server.
create policy links_select  on public.links  for select to authenticated using (auth.uid() = any(uids));
create policy groups_select on public.groups for select to authenticated using (auth.uid() = any(member_uids));
create policy sos_select    on public.sos    for select to authenticated using (sender = auth.uid() or auth.uid() = any(recipients));
create policy chats_select  on public.chats  for select to authenticated using (auth.uid() = any(participants));
-- codes: nessuna policy = nessun accesso diretto

-- Messaggi: leggono e scrivono (solo testo) i partecipanti. Gli SOS li crea solo il server.
create policy messages_select on public.messages for select to authenticated
  using (exists (select 1 from public.chats c where c.id = chat_id and auth.uid() = any(c.participants)));
create policy messages_insert on public.messages for insert to authenticated
  with check (
    type = 'text' and sender = auth.uid()
    and text is not null and char_length(text) between 1 and 1000
    and exists (select 1 from public.chats c where c.id = chat_id and auth.uid() = any(c.participants))
  );

revoke all on public.codes from anon, authenticated;
revoke insert, update, delete on public.links, public.groups, public.chats, public.sos from anon, authenticated;
revoke update, delete on public.profiles, public.messages from anon, authenticated;
revoke all on public.profiles, public.links, public.groups, public.chats, public.messages, public.sos from anon;

-- ---------- funzioni di supporto ----------
create function public._user_name(u uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare d record;
begin
  select name, surname into d from profiles where id = u;
  if not found then raise exception 'Completa prima il profilo' using errcode = 'P0001'; end if;
  return trim(d.name || ' ' || d.surname);
end $$;

create function public._unique_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text; i int;
begin
  for i in 1..8 loop
    select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
             1 + (get_byte(extensions.gen_random_bytes(1), 0) % 31), 1), '')
      into c from generate_series(1, 6);
    if not exists (select 1 from codes where code = c) then return c; end if;
  end loop;
  raise exception 'Riprova tra un momento' using errcode = 'P0001';
end $$;

revoke all on function public._user_name(uuid), public._unique_code() from public, anon, authenticated;

-- ---------- collegamenti (partner / amici) ----------
create function public.create_invite(p_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); c text;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  if p_kind not in ('friend','partner') then raise exception 'Tipo non valido' using errcode = 'P0001'; end if;
  delete from codes where kind <> 'group' and expires_at < now();
  c := _unique_code();
  insert into codes(code, kind, owner, expires_at) values (c, p_kind, u, now() + interval '10 minutes');
  return jsonb_build_object('code', c);
end $$;

create function public.redeem_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid(); c text := upper(trim(coalesce(p_code, '')));
  me text; cd codes%rowtype; g groups%rowtype; owner_name text; lid text;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  if c !~ '^[A-Z0-9]{6}$' then raise exception 'Codice non valido' using errcode = 'P0001'; end if;
  me := _user_name(u);
  select * into cd from codes where code = c for update;
  if not found then raise exception 'Codice non valido o scaduto' using errcode = 'P0001'; end if;

  if cd.kind = 'group' then
    select * into g from groups where id = cd.group_id for update;
    if not found then raise exception 'Gruppo non trovato' using errcode = 'P0001'; end if;
    if g.members ? u::text then raise exception 'Sei già nel gruppo' using errcode = 'P0001'; end if;
    if (select count(*) from jsonb_object_keys(g.requests)) >= 20 then
      raise exception 'Troppe richieste in attesa' using errcode = 'P0001';
    end if;
    update groups set requests = requests || jsonb_build_object(u::text, me) where id = g.id;
    return jsonb_build_object('kind', 'group', 'name', g.name);
  end if;

  if cd.expires_at < now() then raise exception 'Codice scaduto' using errcode = 'P0001'; end if;
  if cd.owner = u then raise exception 'Non puoi usare il tuo codice' using errcode = 'P0001'; end if;
  owner_name := _user_name(cd.owner);
  if cd.kind = 'partner' then
    if exists (select 1 from links where kind = 'partner' and u = any(uids)) then
      raise exception 'Hai già un partner' using errcode = 'P0001'; end if;
    if exists (select 1 from links where kind = 'partner' and cd.owner = any(uids)) then
      raise exception 'Questa persona ha già un partner' using errcode = 'P0001'; end if;
  end if;
  lid := case when (u::text collate "C") < (cd.owner::text collate "C")
              then u::text || '_' || cd.owner::text else cd.owner::text || '_' || u::text end;
  if exists (select 1 from links where id = lid) then
    raise exception 'Siete già collegati' using errcode = 'P0001'; end if;
  insert into links(id, kind, uids, names)
    values (lid, cd.kind, array[u, cd.owner], jsonb_build_object(u::text, me, cd.owner::text, owner_name));
  insert into chats(id, kind, participants) values (lid, 'direct', array[u, cd.owner]);
  delete from codes where code = c;
  return jsonb_build_object('kind', cd.kind, 'name', owner_name);
end $$;

create function public.remove_link(p_link_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); l links%rowtype;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  select * into l from links where id = p_link_id;
  if not found or not (u = any(l.uids)) then raise exception 'Non autorizzato' using errcode = 'P0001'; end if;
  delete from chats where id = p_link_id;     -- elimina anche i messaggi (cascade)
  delete from links where id = p_link_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- gruppi (max 8 persone) ----------
create function public.create_group(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); n text := left(trim(coalesce(p_name, '')), 30); me text; v_code text; gid text;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  if n = '' then raise exception 'Dai un nome al gruppo' using errcode = 'P0001'; end if;
  if (select count(*) from groups where u = any(member_uids)) >= 10 then
    raise exception 'Hai raggiunto il massimo di 10 gruppi' using errcode = 'P0001'; end if;
  me := _user_name(u); v_code := _unique_code(); gid := gen_random_uuid()::text;
  insert into groups(id, name, admin_uid, code, member_uids, members, requests)
    values (gid, n, u, v_code, array[u], jsonb_build_object(u::text, me), '{}'::jsonb);
  insert into codes(code, kind, owner, group_id) values (v_code, 'group', u, gid);
  insert into chats(id, kind, participants) values (gid, 'group', array[u]);
  return jsonb_build_object('groupId', gid, 'code', v_code);
end $$;

create function public.decide_join(p_group_id text, p_uid uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); g groups%rowtype; n text;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  select * into g from groups where id = p_group_id for update;
  if not found or g.admin_uid <> u then raise exception 'Solo l''admin può farlo' using errcode = 'P0001'; end if;
  n := g.requests ->> p_uid::text;
  if n is null then raise exception 'Richiesta non trovata' using errcode = 'P0001'; end if;
  if p_accept then
    if cardinality(g.member_uids) >= 8 then
      raise exception 'Gruppo pieno: massimo 8 persone' using errcode = 'P0001'; end if;
    update groups set requests = requests - p_uid::text,
                      members = members || jsonb_build_object(p_uid::text, n),
                      member_uids = array_append(member_uids, p_uid)
      where id = g.id;
    update chats set participants = array_append(participants, p_uid) where id = g.id;
  else
    update groups set requests = requests - p_uid::text where id = g.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.remove_member(p_group_id text, p_uid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); g groups%rowtype;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  select * into g from groups where id = p_group_id for update;
  if not found then raise exception 'Gruppo non trovato' using errcode = 'P0001'; end if;
  if p_uid = g.admin_uid then raise exception 'L''admin non può uscire: elimina il gruppo' using errcode = 'P0001'; end if;
  if u <> g.admin_uid and u <> p_uid then raise exception 'Non autorizzato' using errcode = 'P0001'; end if;
  update groups set members = members - p_uid::text, member_uids = array_remove(member_uids, p_uid) where id = g.id;
  update chats set participants = array_remove(participants, p_uid) where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

create function public.delete_group(p_group_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); g groups%rowtype;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  select * into g from groups where id = p_group_id;
  if not found or g.admin_uid <> u then raise exception 'Solo l''admin può eliminare il gruppo' using errcode = 'P0001'; end if;
  delete from chats where id = g.id;
  delete from codes where code = g.code;
  delete from groups where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- impostazioni utente ----------
create function public.set_group_muted(p_group_id text, p_muted boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set muted_groups = case
      when p_muted then (select array(select distinct x from unnest(muted_groups || p_group_id) x))
      else array_remove(muted_groups, p_group_id) end
    where id = auth.uid();
end $$;

create function public.add_fcm_token(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(p_token, '') = '' then return; end if;
  -- un token appartiene a un solo utente (utile se due account usano lo stesso telefono)
  update profiles set fcm_tokens = array_remove(fcm_tokens, p_token) where id <> auth.uid() and p_token = any(fcm_tokens);
  update profiles set fcm_tokens = case
      when p_token = any(fcm_tokens) then fcm_tokens
      else (array_append(fcm_tokens, p_token))[greatest(1, cardinality(fcm_tokens) - 8):] end
    where id = auth.uid();
end $$;

-- ---------- SOS ----------
-- Solo service_role: la chiama la Edge Function "send-sos" dopo aver verificato l'utente.
create function public.send_sos(p_uid uuid, p_sos_id text, p_lat double precision, p_lng double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me text; muted text[]; cids text[] := '{}'; rec uuid[] := '{}'; r record; cid text; mid uuid;
  msgs uuid[] := '{}'; lat_ double precision; lng_ double precision; toks jsonb;
begin
  if coalesce(p_sos_id, '') !~ '^[A-Za-z0-9_-]{10,40}$' then raise exception 'SOS non valido' using errcode = 'P0001'; end if;
  me := _user_name(p_uid);
  select muted_groups into muted from profiles where id = p_uid;
  for r in select id, uids from links where p_uid = any(uids) loop
    cids := cids || r.id;
    rec := rec || array(select x from unnest(r.uids) x where x <> p_uid);
  end loop;
  for r in select id, member_uids from groups where p_uid = any(member_uids) loop
    if r.id = any(muted) then continue; end if;
    cids := cids || r.id;
    rec := rec || array(select x from unnest(r.member_uids) x where x <> p_uid);
  end loop;
  rec := array(select distinct x from unnest(rec) x);
  if cardinality(cids) = 0 or cardinality(rec) = 0 then
    raise exception 'Aggiungi prima qualcuno da avvisare' using errcode = 'P0001'; end if;
  if exists (select 1 from sos where id = p_sos_id) then raise exception 'SOS già inviato' using errcode = 'P0001'; end if;

  if p_lat is not null and p_lng is not null and abs(p_lat) <= 90 and abs(p_lng) <= 180 then
    lat_ := p_lat; lng_ := p_lng;
  end if;
  foreach cid in array cids loop
    insert into messages(chat_id, type, sender, from_name, sos_id, lat, lng)
      values (cid, 'sos', p_uid, me, p_sos_id, lat_, lng_) returning id into mid;
    msgs := msgs || mid;
  end loop;
  insert into sos(id, sender, from_name, recipients, msgs, lat, lng)
    values (p_sos_id, p_uid, me, rec, msgs, lat_, lng_);

  select jsonb_agg(jsonb_build_object('token', t)) into toks
    from profiles pr, unnest(pr.fcm_tokens) t where pr.id = any(rec);
  return jsonb_build_object('me', me, 'recipients', cardinality(rec), 'tokens', coalesce(toks, '[]'::jsonb));
end $$;

create function public.attach_sos_photos(p_sos_id text, p_paths text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s sos%rowtype; ok text[]; prefix text;
begin
  if u is null then raise exception 'Accedi per continuare' using errcode = 'P0001'; end if;
  select * into s from sos where id = p_sos_id;
  if not found or s.sender <> u then raise exception 'Non autorizzato' using errcode = 'P0001'; end if;
  prefix := u::text || '/' || p_sos_id || '/';
  ok := array(select p from unnest(coalesce(p_paths, '{}')) p
              where starts_with(p, prefix) and p ~ '/(back|front)\.jpg$' limit 2);
  if cardinality(ok) = 0 then return jsonb_build_object('ok', true); end if;
  update messages set photos = (select array(select distinct x from unnest(photos || ok) x)) where id = any(s.msgs);
  update sos set photos = (select array(select distinct x from unnest(photos || ok) x)) where id = p_sos_id;
  return jsonb_build_object('ok', true);
end $$;

create function public.remove_dead_tokens(p_tokens text[]) returns void
language sql security definer set search_path = public as $$
  update profiles
     set fcm_tokens = array(select t from unnest(fcm_tokens) t where t <> all(p_tokens))
   where fcm_tokens && p_tokens;
$$;

-- Elimina tutti i dati di un utente. Restituisce gli id degli SOS (la Edge Function cancella le foto).
create function public.delete_account_data(p_uid uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare r record; sosids text[];
begin
  for r in select id from links where p_uid = any(uids) loop
    delete from chats where id = r.id;
    delete from links where id = r.id;
  end loop;
  for r in select * from groups where p_uid = any(member_uids) loop
    if r.admin_uid = p_uid then
      delete from chats where id = r.id;
      delete from codes where code = r.code;
      delete from groups where id = r.id;
    else
      update groups set members = members - p_uid::text, member_uids = array_remove(member_uids, p_uid) where id = r.id;
      update chats set participants = array_remove(participants, p_uid) where id = r.id;
    end if;
  end loop;
  select array_agg(id) into sosids from sos where sender = p_uid;
  delete from sos where sender = p_uid;
  delete from messages where sender = p_uid;
  delete from codes where owner = p_uid;
  delete from profiles where id = p_uid;
  return coalesce(sosids, '{}');
end $$;

-- permessi: le funzioni utente solo agli utenti loggati, quelle di servizio solo a service_role
revoke all on function
  public.create_invite(text), public.redeem_invite(text), public.remove_link(text),
  public.create_group(text), public.decide_join(text, uuid, boolean), public.remove_member(text, uuid),
  public.delete_group(text), public.set_group_muted(text, boolean), public.add_fcm_token(text),
  public.attach_sos_photos(text, text[]),
  public.send_sos(uuid, text, double precision, double precision),
  public.remove_dead_tokens(text[]), public.delete_account_data(uuid)
  from public, anon, authenticated;

grant execute on function
  public.create_invite(text), public.redeem_invite(text), public.remove_link(text),
  public.create_group(text), public.decide_join(text, uuid, boolean), public.remove_member(text, uuid),
  public.delete_group(text), public.set_group_muted(text, boolean), public.add_fcm_token(text),
  public.attach_sos_photos(text, text[])
  to authenticated;

grant execute on function
  public.send_sos(uuid, text, double precision, double precision),
  public.remove_dead_tokens(text[]), public.delete_account_data(uuid)
  to service_role;

-- ---------- foto SOS (bucket privato, max 2 MB, solo JPEG) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sos', 'sos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

create policy "sos: carica le proprie foto" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] ~ '^[A-Za-z0-9_-]{10,40}$'
    and storage.filename(name) in ('back.jpg', 'front.jpg')
  );

create policy "sos: leggono mittente e destinatari" on storage.objects for select to authenticated
  using (
    bucket_id = 'sos'
    and exists (
      select 1 from public.sos s
      where s.id = (storage.foldername(name))[2]
        and (s.sender = auth.uid() or auth.uid() = any(s.recipients))
    )
  );

-- ---------- tempo reale ----------
alter publication supabase_realtime add table public.profiles, public.links, public.groups, public.messages;
