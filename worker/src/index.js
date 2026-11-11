/**
 * Fotoalbum-API på Cloudflare Workers + R2.
 *
 * Lagring i R2-bøtta (binding PHOTOS):
 *   meta/albums.json                 – liste over album
 *   meta/album-<albumId>.json        – bildene i et album, i visningsrekkefølge
 *   photos/<albumId>/<photoId>/full  – stort bilde (JPEG, maks ~2560 px)
 *   photos/<albumId>/<photoId>/thumb – miniatyrbilde (JPEG, maks ~640 px)
 *
 * Hemmeligheter: VIEWER_PASSWORD, ADMIN_PASSWORD, TOKEN_SECRET
 * Variabler:     ALLOWED_ORIGINS (kommaseparert)
 */

const ALBUMS_KEY = "meta/albums.json";
const albumKey = (id) => `meta/album-${id}.json`;
const photoKey = (albumId, photoId, size) => `photos/${albumId}/${photoId}/${size}`;

const DAY = 86400;
const VIEWER_TOKEN_TTL = 30 * DAY;
const ADMIN_TOKEN_TTL = 12 * 3600;
const IMG_WINDOW = 7 * DAY; // signerte bilde-URLer er stabile i en uke (bra for cache)

const ID_RE = /^[a-z0-9-]{1,64}$/;

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

  const session = await authenticate(request, env);

  if (a === "session" && method === "GET") return json({ role: session.role });

  if (a === "albums" && method === "GET") {
    if (!b) return listAlbums(env, session.role === "admin", url);
    return getAlbum(env, checkId(b), session.role === "admin", url);
  }

  if (a === "admin") {
    if (session.role !== "admin") throw new HttpError(403, "Krever admin");
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

  let role = null;
  if (await safeEqual(password, env.ADMIN_PASSWORD)) role = "admin";
  else if (await safeEqual(password, env.VIEWER_PASSWORD)) role = "viewer";

  if (!role) {
    await new Promise((r) => setTimeout(r, 600)); // gjør gjetting tregere
    throw new HttpError(401, "Feil passord");
  }
  const ttl = role === "admin" ? ADMIN_TOKEN_TTL : VIEWER_TOKEN_TTL;
  const payload = b64urlEncodeString(JSON.stringify({ role, exp: now() + ttl }));
  const token = `${payload}.${await sign(env, `tok:${payload}`)}`;
  return json({ token, role });
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
  return data;
}

// ---------------------------------------------------------------- albums

async function listAlbums(env, isAdmin, url) {
  const { data } = await readJSON(env, ALBUMS_KEY, { albums: [] });
  const albums = data.albums
    .filter((a) => isAdmin || !a.hidden)
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const out = [];
  for (const a of albums) {
    out.push({
      ...a,
      cover: a.coverId ? await signedUrl(env, url, a.id, a.coverId, "thumb") : null,
    });
  }
  return json({ albums: out });
}

async function getAlbum(env, albumId, isAdmin, url) {
  const album = await findAlbum(env, albumId);
  if (album.hidden && !isAdmin) throw new HttpError(404, "Albumet finnes ikke");
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
    description: cleanText(body.description, 2000),
    hidden: body.hidden !== false, // nye album er skjult til du publiserer dem
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
    if ("description" in body) album.description = cleanText(body.description, 2000);
    if ("hidden" in body) album.hidden = !!body.hidden;
    if ("coverId" in body) album.coverId = body.coverId ? checkId(body.coverId) : null;
    updated = album;
  });
  return json({ album: updated });
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

function slugify(s) {
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
      .slice(0, 40) || "album"
  );
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
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
