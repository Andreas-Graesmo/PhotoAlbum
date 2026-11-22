/**
 * Fotoalbum-API på Cloudflare Workers + R2.
 *
 * Lagring i R2-bøtta (binding PHOTOS):
 *   meta/albums.json                 – liste over album
 *   meta/album-<albumId>.json        – bildene i et album, i visningsrekkefølge
 *   meta/groups.json                 – brukergrupper (navn + passord-hash)
 *   photos/<albumId>/<photoId>/full  – stort bilde (JPEG, maks ~2560 px)
 *   photos/<albumId>/<photoId>/thumb – miniatyrbilde (JPEG, maks ~640 px)
 *
 * Hemmeligheter: VIEWER_PASSWORD, ADMIN_PASSWORD, TOKEN_SECRET
 * Variabler:     ALLOWED_ORIGINS (kommaseparert)
 *
 * Brukergrupper: hver gruppe har sitt eget passord, og hvert album har en liste over gruppene som
 * får se det (album.groups). Den innebygde gruppen «standard» bruker VIEWER_PASSWORD. Album uten
 * groups-felt (laget før grupper fantes) vises for standardgruppen. Admin ser alle album.
 *
 * Visning på TV (binding TV, Durable Object TvRoom): TV-siden oppretter et «rom» og viser en
 * firesifret kode. En innlogget mobil kobler seg til rommet med koden og styrer hva TV-en viser.
 * TV-en trenger ikke passord: den får bare de signerte bildelenkene mobilen sender.
 */

import { DurableObject } from "cloudflare:workers";

const ALBUMS_KEY = "meta/albums.json";
const GROUPS_KEY = "meta/groups.json";
const STANDARD_GROUP = "standard";
const STANDARD_GROUP_NAME = "Fellespassordet";
const albumKey = (id) => `meta/album-${id}.json`;
const photoKey = (albumId, photoId, size) => `photos/${albumId}/${photoId}/${size}`;

const DAY = 86400;
const VIEWER_TOKEN_TTL = 30 * DAY;
const ADMIN_TOKEN_TTL = 12 * 3600;
const IMG_WINDOW = 7 * DAY; // signerte bilde-URLer er stabile i en uke (bra for cache)

const ID_RE = /^[a-z0-9-]{1,64}$/;
const TV_CODE_RE = /^\d{4}$/;
const TV_ROOM_TTL = 12 * 3600 * 1000; // ubrukte TV-rom ryddes bort etter et halvt døgn

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.headers.get("Upgrade") === "websocket") {
      // WebSocket-svar kan ikke få CORS-hoder lagt på i etterkant, så de håndteres for seg
      try {
        return await tvSocket(request, env);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(err);
        return new Response(err instanceof HttpError ? err.message : "Intern feil", {
          status: err instanceof HttpError ? err.status : 500,
        });
      }
    }
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: status === 500 ? "Intern feil" : err.message }, status, cors);
    }
  },
};

// ---------------------------------------------------------------- routing

async function route(request, env) {
  if (!env.TOKEN_SECRET || !env.VIEWER_PASSWORD || !env.ADMIN_PASSWORD) {
    throw new HttpError(500, "Mangler hemmeligheter");
  }
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  // Bilder: /img/<albumId>/<photoId>/<full|thumb>?e=..&s=..
  if (parts[0] === "img" && parts.length === 4 && method === "GET") {
    return serveImage(env, parts, url);
  }
  if (parts[0] !== "api") throw new HttpError(404, "Finnes ikke");

  const [, a, b, c, d, e] = parts;

  if (a === "login" && method === "POST") return login(request, env);

  // TV-en er ikke innlogget når den ber om en kode
  if (a === "tv" && b === "rooms" && !c && method === "POST") return createTvRoom(env);

  const session = await authenticate(request, env);

  if (a === "tv" && b === "pair" && !c && method === "POST") return pairTv(request, env);

  if (a === "session" && method === "GET") return json({ role: session.role, group: session.group || null });

  if (a === "albums" && method === "GET") {
    if (!b) return listAlbums(env, session, url);
    return getAlbum(env, checkId(b), session, url);
  }

  if (a === "admin") {
    if (session.role !== "admin") throw new HttpError(403, "Krever admin");
    if (b === "groups") {
      if (!c && method === "GET") return listGroups(env);
      if (!c && method === "POST") return createGroup(request, env);
      const groupId = checkId(c);
      if (!d && method === "PATCH") return updateGroup(request, env, groupId);
      if (!d && method === "DELETE") return deleteGroup(env, groupId);
      throw new HttpError(404, "Finnes ikke");
    }
    if (b !== "albums") throw new HttpError(404, "Finnes ikke");

    if (!c && method === "POST") return createAlbum(request, env);
    const albumId = checkId(c);
    if (!d && method === "PATCH") return updateAlbum(request, env, albumId);
    if (!d && method === "DELETE") return deleteAlbum(env, albumId);
    if (d === "order" && method === "PUT") return reorderPhotos(request, env, albumId);
    if (d === "photos" && !e && method === "POST") return uploadPhoto(request, env, albumId, url);
    if (d === "photos" && e && method === "PATCH") return updatePhoto(request, env, albumId, checkId(e));
    if (d === "photos" && e && method === "DELETE") return deletePhoto(env, albumId, checkId(e));
  }
  throw new HttpError(404, "Finnes ikke");
}

function checkId(id) {
  if (!id || !ID_RE.test(id)) throw new HttpError(400, "Ugyldig id");
  return id;
}

// ---------------------------------------------------------------- auth

async function login(request, env) {
  const { password } = await readBody(request);
  if (typeof password !== "string" || !password) throw new HttpError(400, "Mangler passord");

  let claims = null;
  if (await safeEqual(password, env.ADMIN_PASSWORD)) claims = { role: "admin" };
  else if (await safeEqual(password, env.VIEWER_PASSWORD)) claims = { role: "viewer", group: STANDARD_GROUP };
  else {
    const group = await findGroupByPassword(env, password);
    if (group) claims = { role: "viewer", group: group.id, rev: group.rev };
  }

  if (!claims) {
    await new Promise((r) => setTimeout(r, 600)); // gjør gjetting tregere
    throw new HttpError(401, "Feil passord");
  }
  const ttl = claims.role === "admin" ? ADMIN_TOKEN_TTL : VIEWER_TOKEN_TTL;
  const payload = b64urlEncodeString(JSON.stringify({ ...claims, exp: now() + ttl }));
  const token = `${payload}.${await sign(env, `tok:${payload}`)}`;
  return json({ token, role: claims.role });
}

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) throw new HttpError(401, "Ikke innlogget");
  if (!(await safeEqual(sig, await sign(env, `tok:${payload}`)))) {
    throw new HttpError(401, "Ugyldig innlogging");
  }
  let data;
  try {
    data = JSON.parse(b64urlDecodeString(payload));
  } catch {
    throw new HttpError(401, "Ugyldig innlogging");
  }
  if (!data.exp || data.exp < now()) throw new HttpError(401, "Innloggingen har utløpt");
  if (data.role === "viewer") {
    data.group ||= STANDARD_GROUP; // innlogginger fra før grupper fantes
    if (data.group !== STANDARD_GROUP) {
      // Slettet gruppe eller nytt passord: medlemmene må logge inn på nytt
      const { data: groups } = await readJSON(env, GROUPS_KEY, { groups: [] });
      const group = groups.groups.find((g) => g.id === data.group);
      if (!group || group.rev !== data.rev) throw new HttpError(401, "Innloggingen gjelder ikke lenger");
    }
  }
  return data;
}

// ---------------------------------------------------------------- brukergrupper

/** Passordene lagres som HMAC med TOKEN_SECRET, så de ikke kan leses ut av R2-bøtta. */
function passwordHash(env, password) {
  return sign(env, `pw:${password}`);
}

async function findGroupByPassword(env, password) {
  const { data } = await readJSON(env, GROUPS_KEY, { groups: [] });
  if (!data.groups.length) return null;
  const hash = await passwordHash(env, password);
  for (const g of data.groups) {
    if (await safeEqual(hash, g.hash)) return g;
  }
  return null;
}

/** Alle grupper slik admin ser dem, med standardgruppen først. Hashene sendes aldri ut. */
function publicGroups(data) {
  return [
    { id: STANDARD_GROUP, name: data.standardName || STANDARD_GROUP_NAME, builtin: true },
    ...data.groups.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  ];
}

async function listGroups(env) {
  const { data } = await readJSON(env, GROUPS_KEY, { groups: [] });
  return json({ groups: publicGroups(data) });
}

async function checkNewPassword(env, password, groups, exceptId) {
  if (typeof password !== "string" || password.length < 4) throw new HttpError(400, "Passordet må ha minst 4 tegn");
  if (password.length > 200) throw new HttpError(400, "Passordet er for langt");
  if ((await safeEqual(password, env.ADMIN_PASSWORD)) || (await safeEqual(password, env.VIEWER_PASSWORD))) {
    throw new HttpError(400, "Passordet er allerede i bruk");
  }
  const hash = await passwordHash(env, password);
  for (const g of groups) {
    if (g.id !== exceptId && (await safeEqual(hash, g.hash))) throw new HttpError(400, "Passordet er allerede i bruk av en annen gruppe");
  }
  return hash;
}

async function createGroup(request, env) {
  const body = await readBody(request);
  const name = cleanText(body.name, 60);
  if (!name) throw new HttpError(400, "Gruppen må ha et navn");
  let group;
  const data = await updateJSON(env, GROUPS_KEY, { groups: [] }, async (data) => {
    group = {
      id: `${slugify(name, "gruppe")}-${randomId(4)}`,
      name,
      hash: await checkNewPassword(env, body.password, data.groups),
      rev: 1,
      createdAt: new Date().toISOString(),
    };
    data.groups.push(group);
  });
  return json({ group: publicGroups(data).find((g) => g.id === group.id) }, 201);
}

async function updateGroup(request, env, groupId) {
  const body = await readBody(request);
  const data = await updateJSON(env, GROUPS_KEY, { groups: [] }, async (data) => {
    const name = "name" in body ? cleanText(body.name, 60) : null;
    if ("name" in body && !name) throw new HttpError(400, "Gruppen må ha et navn");
    if (groupId === STANDARD_GROUP) {
      if ("password" in body) throw new HttpError(400, "Fellespassordet endres med «npx wrangler secret put VIEWER_PASSWORD»");
      if (name) data.standardName = name;
      return;
    }
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) throw new HttpError(404, "Gruppen finnes ikke");
    if (name) group.name = name;
    if ("password" in body) {
      group.hash = await checkNewPassword(env, body.password, data.groups, groupId);
      group.rev = (group.rev || 1) + 1; // logger ut alle som brukte det gamle passordet
    }
  });
  return json({ group: publicGroups(data).find((g) => g.id === groupId) });
}

async function deleteGroup(env, groupId) {
  if (groupId === STANDARD_GROUP) throw new HttpError(400, "Standardgruppen kan ikke slettes");
  await updateJSON(env, GROUPS_KEY, { groups: [] }, (data) => {
    const before = data.groups.length;
    data.groups = data.groups.filter((g) => g.id !== groupId);
    if (data.groups.length === before) throw new HttpError(404, "Gruppen finnes ikke");
  });
  await updateJSON(env, ALBUMS_KEY, { albums: [] }, (data) => {
    for (const a of data.albums) {
      if (Array.isArray(a.groups)) a.groups = a.groups.filter((id) => id !== groupId);
    }
  });
  return json({ ok: true });
}

/** Gruppene som får se et album. Album fra før grupper fantes vises for standardgruppen. */
function albumGroups(album) {
  return Array.isArray(album.groups) ? album.groups : [STANDARD_GROUP];
}

function canSee(session, album) {
  if (session.role === "admin") return true;
  return !album.hidden && albumGroups(album).includes(session.group);
}

async function cleanGroups(env, v) {
  if (!Array.isArray(v)) throw new HttpError(400, "Ugyldige grupper");
  const { data } = await readJSON(env, GROUPS_KEY, { groups: [] });
  const known = new Set([STANDARD_GROUP, ...data.groups.map((g) => g.id)]);
  return [...new Set(v)].filter((id) => typeof id === "string" && known.has(id));
}

// ---------------------------------------------------------------- visning på TV

function tvRoom(env, code) {
  if (!env.TV) throw new HttpError(404, "Visning på TV er ikke slått på");
  if (typeof code !== "string" || !TV_CODE_RE.test(code)) throw new HttpError(400, "Koden skal ha fire sifre");
  return env.TV.get(env.TV.idFromName(code));
}

/** TV-en ber om et rom og får en ledig kode pluss en nøkkel som bare den kjenner. */
async function createTvRoom(env) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
    const room = await tvRoom(env, code).create();
    if (room) return json({ code, key: room.key }, 201);
  }
  throw new HttpError(503, "Fant ingen ledig kode, prøv igjen");
}

/** En innlogget mobil bytter koden på TV-skjermen mot en billett til rommet. */
async function pairTv(request, env) {
  const { code } = await readBody(request);
  const room = await tvRoom(env, typeof code === "string" ? code.trim() : code).pair();
  if (!room) throw new HttpError(404, "Fant ingen TV med den koden");
  return json({ ticket: room.ticket });
}

/** WebSocket: /api/tv/ws?code=1234&role=tv|remote&secret=… */
async function tvSocket(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/tv/ws") throw new HttpError(404, "Finnes ikke");
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  if (origin && !allowed.includes(origin)) throw new HttpError(403, "Ikke tillatt");
  return tvRoom(env, url.searchParams.get("code")).fetch(request);
}

/**
 * Ett rom per kode. Rommet videresender meldinger mellom TV-en og mobilene som styrer den,
 * og forteller begge parter hvem som er til stede. Det lagrer ingen bilder eller albumdata.
 */
export class TvRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Lar klientene holde forbindelsen i live uten å vekke rommet
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async create() {
    const createdAt = await this.ctx.storage.get("createdAt");
    const busy = this.openSockets("tv").length > 0 || (createdAt && Date.now() - createdAt < 15000);
    if (busy) return null;
    for (const ws of this.ctx.getWebSockets()) closeSocket(ws, 4001, "Rommet er erstattet");
    const key = randomId(24);
    await this.ctx.storage.put({ key, ticket: randomId(24), createdAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + TV_ROOM_TTL);
    return { key };
  }

  async pair() {
    if (!this.openSockets("tv").length) return null;
    return { ticket: await this.ctx.storage.get("ticket") };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const secret = url.searchParams.get("secret") || "";
    const [client, server] = Object.values(new WebSocketPair());

    const expected = role === "tv" || role === "remote" ? await this.ctx.storage.get(role === "tv" ? "key" : "ticket") : null;
    if (!expected || !(await safeEqual(secret, expected))) {
      // Svar over WebSocket, så nettleseren kan skille «rommet finnes ikke» fra nettverksfeil
      server.accept();
      server.close(4001, "Ukjent rom");
      return new Response(null, { status: 101, webSocket: client });
    }

    const replaced = role === "tv" ? this.ctx.getWebSockets("tv") : [];
    this.ctx.acceptWebSocket(server, [role]);
    for (const ws of replaced) closeSocket(ws, 4002, "Erstattet av en ny tilkobling");
    this.announce(replaced);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    const fromTv = this.ctx.getTags(ws).includes("tv");
    for (const peer of this.openSockets(fromTv ? "remote" : "tv")) sendSocket(peer, message);
  }

  webSocketClose(ws, code, reason) {
    closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
    this.announce([ws]);
  }

  webSocketError(ws) {
    this.announce([ws]);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + TV_ROOM_TTL);
    else await this.ctx.storage.deleteAll();
  }

  openSockets(tag, except = []) {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1 && !except.includes(ws));
  }

  /** Forteller alle hvem som er koblet til akkurat nå. */
  announce(except = []) {
    const message = JSON.stringify({
      type: "presence",
      tv: this.openSockets("tv", except).length > 0,
      remotes: this.openSockets("remote", except).length,
    });
    for (const ws of this.openSockets(undefined, except)) sendSocket(ws, message);
  }
}

function sendSocket(ws, message) {
  try {
    ws.send(message);
  } catch {
    /* forbindelsen er borte */
  }
}

function closeSocket(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    /* allerede lukket */
  }
}

// ---------------------------------------------------------------- albums

async function listAlbums(env, session, url) {
  const { data } = await readJSON(env, ALBUMS_KEY, { albums: [] });
  const albums = data.albums
    .filter((a) => canSee(session, a))
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const out = [];
  for (const a of albums) {
    out.push({
      ...publicAlbum(session, a),
      cover: a.coverId ? await signedUrl(env, url, a.id, a.coverId, "thumb") : null,
    });
  }
  return json({ albums: out, tv: !!env.TV }); // tv: nettsiden viser «Vis på TV» bare når API-et støtter det
}

/** Admin får se hvilke grupper albumet er delt med; de andre trenger ikke vite det. */
function publicAlbum(session, album) {
  const { groups, ...rest } = album;
  return session.role === "admin" ? { ...rest, groups: albumGroups(album) } : rest;
}

async function getAlbum(env, albumId, session, url) {
  const found = await findAlbum(env, albumId);
  if (!canSee(session, found)) throw new HttpError(404, "Albumet finnes ikke");
  const album = publicAlbum(session, found);
  const { data } = await readJSON(env, albumKey(albumId), { photos: [] });
  const photos = [];
  for (const p of data.photos) {
    photos.push({
      ...p,
      thumb: await signedUrl(env, url, albumId, p.id, "thumb"),
      src: await signedUrl(env, url, albumId, p.id, "full"),
    });
  }
  return json({ album, photos });
}

async function findAlbum(env, albumId) {
  const { data } = await readJSON(env, ALBUMS_KEY, { albums: [] });
  const album = data.albums.find((a) => a.id === albumId);
  if (!album) throw new HttpError(404, "Albumet finnes ikke");
  return album;
}

async function createAlbum(request, env) {
  const body = await readBody(request);
  const title = cleanText(body.title, 120);
  if (!title) throw new HttpError(400, "Albumet må ha et navn");
  const album = {
    id: `${slugify(title)}-${randomId(4)}`,
    title,
    date: cleanDate(body.date) || new Date().toISOString().slice(0, 10),
    dateEnd: cleanDate(body.dateEnd),
    description: cleanText(body.description, 2000),
    theme: cleanTheme(body.theme),
    hidden: body.hidden !== false, // nye album er skjult til du publiserer dem
    groups: "groups" in body ? await cleanGroups(env, body.groups) : [STANDARD_GROUP],
    coverId: null,
    count: 0,
    createdAt: new Date().toISOString(),
  };
  await updateJSON(env, ALBUMS_KEY, { albums: [] }, (data) => {
    data.albums.push(album);
  });
  await env.PHOTOS.put(albumKey(album.id), JSON.stringify({ photos: [] }), jsonMeta);
  return json({ album }, 201);
}

async function updateAlbum(request, env, albumId) {
  const body = await readBody(request);
  const groups = "groups" in body ? await cleanGroups(env, body.groups) : null;
  let updated;
  await updateJSON(env, ALBUMS_KEY, { albums: [] }, (data) => {
    const album = data.albums.find((a) => a.id === albumId);
    if (!album) throw new HttpError(404, "Albumet finnes ikke");
    if ("title" in body) {
      const t = cleanText(body.title, 120);
      if (!t) throw new HttpError(400, "Albumet må ha et navn");
      album.title = t;
    }
    if ("date" in body) album.date = cleanDate(body.date) || album.date;
    if ("dateEnd" in body) album.dateEnd = cleanDate(body.dateEnd);
    if ("description" in body) album.description = cleanText(body.description, 2000);
    if ("hidden" in body) album.hidden = !!body.hidden;
    if ("theme" in body) album.theme = cleanTheme(body.theme);
    if ("coverId" in body) album.coverId = body.coverId ? checkId(body.coverId) : null;
    if (groups) album.groups = groups;
    updated = album;
  });
  return json({ album: { ...updated, groups: albumGroups(updated) } });
}

async function deleteAlbum(env, albumId) {
  await updateJSON(env, ALBUMS_KEY, { albums: [] }, (data) => {
    const before = data.albums.length;
    data.albums = data.albums.filter((a) => a.id !== albumId);
    if (data.albums.length === before) throw new HttpError(404, "Albumet finnes ikke");
  });
  // Slett alle bildefiler i albumet
  let cursor;
  do {
    const list = await env.PHOTOS.list({ prefix: `photos/${albumId}/`, cursor });
    if (list.objects.length) await env.PHOTOS.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.PHOTOS.delete(albumKey(albumId));
  return json({ ok: true });
}

// ---------------------------------------------------------------- photos

async function uploadPhoto(request, env, albumId, url) {
  await findAlbum(env, albumId);
  const form = await request.formData();
  const full = form.get("full");
  const thumb = form.get("thumb");
  if (!(full instanceof File) || !(thumb instanceof File)) {
    throw new HttpError(400, "Mangler bildefiler");
  }
  const allowed = ["image/jpeg", "image/webp", "image/png"];
  if (!allowed.includes(full.type) || !allowed.includes(thumb.type)) {
    throw new HttpError(400, "Ugyldig bildeformat");
  }
  let meta = {};
  try {
    meta = JSON.parse(form.get("meta") || "{}");
  } catch {
    /* ignorer */
  }

  const photo = {
    id: randomId(10),
    name: cleanText(meta.name, 200),
    w: clampInt(meta.w, 1, 20000),
    h: clampInt(meta.h, 1, 20000),
    takenAt: typeof meta.takenAt === "string" ? meta.takenAt.slice(0, 32) : null,
    caption: "",
    highlight: false,
    uploadedAt: new Date().toISOString(),
  };

  await env.PHOTOS.put(photoKey(albumId, photo.id, "full"), full.stream(), {
    httpMetadata: { contentType: full.type },
  });
  await env.PHOTOS.put(photoKey(albumId, photo.id, "thumb"), thumb.stream(), {
    httpMetadata: { contentType: thumb.type },
  });

  let count = 0;
  await updateJSON(env, albumKey(albumId), { photos: [] }, (data) => {
    data.photos.push(photo);
    count = data.photos.length;
  });
  await updateJSON(env, ALBUMS_KEY, { albums: [] }, (data) => {
    const album = data.albums.find((a) => a.id === albumId);
    if (!album) return;
    album.count = count;
    if (!album.coverId) album.coverId = photo.id;
  });

  return json(
    {
      photo: {
        ...photo,
        thumb: await signedUrl(env, url, albumId, photo.id, "thumb"),
        src: await signedUrl(env, url, albumId, photo.id, "full"),
      },
    },
    201,
  );
}

async function updatePhoto(request, env, albumId, photoId) {
  const body = await readBody(request);
  let updated;
  await updateJSON(env, albumKey(albumId), { photos: [] }, (data) => {
    const p = data.photos.find((x) => x.id === photoId);
    if (!p) throw new HttpError(404, "Bildet finnes ikke");
    if ("highlight" in body) p.highlight = !!body.highlight;
    if ("caption" in body) p.caption = cleanText(body.caption, 500);
    if ("title" in body) p.title = cleanText(body.title, 120);
    if ("story" in body) p.story = cleanText(body.story, 4000);
    updated = p;
  });
  return json({ photo: updated });
}

async function deletePhoto(env, albumId, photoId) {
  let remaining = [];
  await updateJSON(env, albumKey(albumId), { photos: [] }, (data) => {
    data.photos = data.photos.filter((x) => x.id !== photoId);
    remaining = data.photos;
  });
  await env.PHOTOS.delete([
    photoKey(albumId, photoId, "full"),
    photoKey(albumId, photoId, "thumb"),
  ]);
  await updateJSON(env, ALBUMS_KEY, { albums: [] }, (data) => {
    const album = data.albums.find((a) => a.id === albumId);
    if (!album) return;
    album.count = remaining.length;
    if (album.coverId === photoId) album.coverId = remaining[0]?.id || null;
  });
  return json({ ok: true });
}

async function reorderPhotos(request, env, albumId) {
  const { ids } = await readBody(request);
  if (!Array.isArray(ids)) throw new HttpError(400, "Mangler rekkefølge");
  await updateJSON(env, albumKey(albumId), { photos: [] }, (data) => {
    const pos = new Map(ids.map((id, i) => [id, i]));
    data.photos.sort((x, y) => (pos.get(x.id) ?? 1e9) - (pos.get(y.id) ?? 1e9));
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------- images

async function signedUrl(env, url, albumId, photoId, size) {
  const exp = Math.floor(now() / IMG_WINDOW) * IMG_WINDOW + 2 * IMG_WINDOW;
  const path = `/img/${albumId}/${photoId}/${size}`;
  const s = (await sign(env, `img:${path}:${exp}`)).slice(0, 32);
  return `${url.origin}${path}?e=${exp}&s=${s}`;
}

async function serveImage(env, parts, url) {
  const [, albumId, photoId, size] = parts;
  checkId(albumId);
  checkId(photoId);
  if (size !== "full" && size !== "thumb") throw new HttpError(404, "Finnes ikke");
  const exp = Number(url.searchParams.get("e"));
  const s = url.searchParams.get("s") || "";
  if (!exp || exp < now()) throw new HttpError(403, "Lenken har utløpt");
  const path = `/img/${albumId}/${photoId}/${size}`;
  const expected = (await sign(env, `img:${path}:${exp}`)).slice(0, 32);
  if (!(await safeEqual(s, expected))) throw new HttpError(403, "Ugyldig lenke");

  const obj = await env.PHOTOS.get(photoKey(albumId, photoId, size));
  if (!obj) throw new HttpError(404, "Bildet finnes ikke");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=604800, immutable");
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------- storage helpers

const jsonMeta = { httpMetadata: { contentType: "application/json" } };

async function readJSON(env, key, fallback) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return { data: fallback, etag: null };
  return { data: await obj.json(), etag: obj.etag };
}

/** Les-endre-skriv med optimistisk låsing, slik at samtidige opplastinger ikke overskriver hverandre. */
async function updateJSON(env, key, fallback, mutate) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, etag } = await readJSON(env, key, structuredClone(fallback));
    await mutate(data);
    const opts = { ...jsonMeta };
    if (etag) opts.onlyIf = { etagMatches: etag };
    const res = await env.PHOTOS.put(key, JSON.stringify(data), opts);
    if (res) return data;
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 120 * (attempt + 1)));
  }
  throw new HttpError(409, "For mange samtidige endringer, prøv igjen");
}

// ---------------------------------------------------------------- misc helpers

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "Ugyldig forespørsel");
  }
}

const enc = new TextEncoder();
let keyCache = { secret: null, key: null };

async function sign(env, message) {
  if (keyCache.secret !== env.TOKEN_SECRET) {
    keyCache = {
      secret: env.TOKEN_SECRET,
      key: await crypto.subtle.importKey(
        "raw",
        enc.encode(env.TOKEN_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  }
  const sig = await crypto.subtle.sign("HMAC", keyCache.key, enc.encode(message));
  return b64urlEncodeBytes(new Uint8Array(sig));
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function b64urlEncodeBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeString(str) {
  return b64urlEncodeBytes(enc.encode(str));
}
function b64urlDecodeString(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

function randomId(len) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function slugify(s, fallback = "album") {
  return (
    s
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/å/g, "a")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback
  );
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
/** Navnet på utseendet albumet vises med. Selve temaene ligger i nettsiden (THEMES i common.js). */
function cleanTheme(v) {
  return typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v) ? v : null;
}
function cleanDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}
function now() {
  return Math.floor(Date.now() / 1000);
}
