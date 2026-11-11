// Admin-siden: lag album, last opp bilder, velg høydepunkter og rekkefølge.

const adminStore = makeStore("album_admin_token");
const app = document.getElementById("app");
document.title = `Admin · ${CONFIG.title}`;

const FULL_MAX = 2560; // lengste side på stort bilde
const THUMB_MAX = 640; // lengste side på miniatyr
const UPLOAD_CONCURRENCY = 3;

let token = adminStore.get();
let albums = [];
let currentId = null;
let photos = [];

if (token) boot();
else showLogin();

function showLogin() {
  renderLogin(app, {
    heading: "Admin",
    hint: "Logg inn med admin-passordet.",
    requireRole: "admin",
    onLogin: (t) => {
      token = t;
      adminStore.set(t);
      boot();
    },
  });
}

async function call(path, opts = {}) {
  try {
    return await api(path, { ...opts, token });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      adminStore.clear();
      token = null;
      showLogin();
    }
    throw err;
  }
}

async function boot() {
  try {
    await refreshAlbums();
  } catch {
    return;
  }
  const fromHash = location.hash.slice(1);
  currentId = albums.some((a) => a.id === fromHash) ? fromHash : albums[0]?.id || null;
  render();
  if (currentId) openAlbum(currentId);
}

async function refreshAlbums() {
  ({ albums } = await call("/api/albums"));
}

// ---------------------------------------------------------------- layout

const sidebar = el("aside", { class: "admin-sidebar" });
const main = el("section", { class: "admin-main" });

function render() {
  const header = el(
    "header",
    { class: "site-header" },
    el("a", { class: "brand", href: "index.html" }, CONFIG.title),
    el("strong", {}, "Admin"),
    el(
      "button",
      {
        class: "btn-icon",
        title: "Logg ut",
        "aria-label": "Logg ut",
        onclick: () => {
          adminStore.clear();
          token = null;
          showLogin();
        },
      },
      icon("logout"),
    ),
  );
  renderSidebar();
  app.replaceChildren(header, el("div", { class: "admin" }, sidebar, main));
  if (!currentId) {
    main.replaceChildren(
      el("div", { class: "empty-state" }, el("h1", {}, "Ingen album ennå"), el("p", {}, "Lag ditt første album til venstre.")),
    );
  }
}

function renderSidebar() {
  const list = el("ul", { class: "admin-album-list" });
  for (const a of albums) {
    list.append(
      el(
        "li",
        {},
        el(
          "button",
          { class: a.id === currentId ? "is-active" : "", onclick: () => openAlbum(a.id) },
          el("span", {}, a.title, a.hidden ? el("span", { class: "badge" }, "skjult") : null),
          el("small", {}, a.count || 0),
        ),
      ),
    );
  }

  const title = el("input", { type: "text", placeholder: "F.eks. Sommerferie 2026", required: true, maxlength: "120" });
  const date = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const err = el("p", { class: "form-error" });
  const form = el(
    "form",
    {
      class: "new-album-form",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          const { album } = await call("/api/admin/albums", {
            method: "POST",
            body: { title: title.value, date: date.value },
          });
          await refreshAlbums();
          openAlbum(album.id);
        } catch (e2) {
          err.textContent = e2.message;
        }
      },
    },
    el("label", {}, "Navn", title),
    el("label", {}, "Dato", date),
    el("button", { class: "btn btn-primary", type: "submit" }, "Lag nytt album"),
    err,
  );

  sidebar.replaceChildren(el("h2", {}, "Album"), albums.length ? list : el("p", { class: "muted" }, "Ingen album."), el("h2", {}, "Nytt album"), form);
}

// ---------------------------------------------------------------- album-redigering

async function openAlbum(id) {
  currentId = id;
  history.replaceState(null, "", `#${id}`);
  if (!main.isConnected) render();
  renderSidebar();
  main.replaceChildren(el("div", { class: "loading" }, "Laster …"));
  let data;
  try {
    data = await call(`/api/albums/${id}`);
  } catch (err) {
    main.replaceChildren(el("p", { class: "form-error" }, err.message));
    return;
  }
  if (currentId !== id) return;
  photos = data.photos;
  renderAlbum(data.album);
}

function renderAlbum(album) {
  const title = el("input", { type: "text", value: album.title, maxlength: "120" });
  const date = el("input", { type: "date", value: album.date || "" });
  const desc = el("textarea", { maxlength: "2000", placeholder: "Kort tekst som vises øverst i albumet (valgfritt)" }, album.description || "");
  const published = el("input", { type: "checkbox", checked: !album.hidden });
  const status = el("span", { class: "save-status", role: "status" });

  const save = async () => {
    status.textContent = "Lagrer …";
    try {
      await call(`/api/admin/albums/${album.id}`, {
        method: "PATCH",
        body: { title: title.value, date: date.value, description: desc.value, hidden: !published.checked },
      });
      await refreshAlbums();
      renderSidebar();
      status.textContent = "Lagret ✓";
    } catch (err) {
      status.textContent = "";
      alert(err.message);
    }
  };

  const settings = el(
    "div",
    { class: "panel" },
    el(
      "div",
      { class: "panel-head" },
      el("h2", {}, album.title),
      el("a", { class: "btn", href: `index.html#/${album.id}`, target: "_blank" }, "Vis album ↗"),
    ),
    el(
      "div",
      { class: "form-grid" },
      el("label", {}, "Navn", title),
      el("label", {}, "Dato", date),
      el("label", { class: "span-2" }, "Beskrivelse", desc),
      el(
        "div",
        { class: "row span-2" },
        el("label", { class: "check" }, published, "Publisert (synlig for alle med passordet)"),
        el("span", { class: "spacer" }),
        status,
        el(
          "button",
          {
            class: "btn btn-danger",
            onclick: async () => {
              if (!confirm(`Slette «${album.title}» og alle ${photos.length} bilder? Dette kan ikke angres.`)) return;
              try {
                await call(`/api/admin/albums/${album.id}`, { method: "DELETE" });
                await refreshAlbums();
                currentId = albums[0]?.id || null;
                render();
                if (currentId) openAlbum(currentId);
              } catch (err) {
                alert(err.message);
              }
            },
          },
          icon("trash"),
          "Slett album",
        ),
        el("button", { class: "btn btn-primary", onclick: save }, "Lagre"),
      ),
    ),
  );

  const grid = el("div", { class: "photo-grid" });
  const highlightCount = el("span", { class: "muted" });

  const photosPanel = el(
    "div",
    { class: "panel" },
    el(
      "div",
      { class: "panel-head" },
      el("h2", {}, "Bilder"),
      el(
        "div",
        { class: "row" },
        highlightCount,
        el("button", { class: "btn", onclick: () => sortByTime(album) }, "Sorter etter tidspunkt"),
      ),
    ),
    el("p", { class: "muted" }, "Trykk på stjernen for å gjøre et bilde til høydepunkt. Dra bildene for å endre rekkefølgen i lysbildefremvisningen."),
    grid,
  );

  main.replaceChildren(settings, uploadPanel(album, () => drawGrid()), photosPanel);
  drawGrid();

  function drawGrid() {
    highlightCount.textContent = `${photos.filter((p) => p.highlight).length} høydepunkter · ${photos.length} bilder`;
    grid.replaceChildren(...photos.map((p) => photoCard(album, p, drawGrid)));
    if (!photos.length) grid.append(el("p", { class: "muted" }, "Ingen bilder ennå."));
  }
}

function photoCard(album, p, redraw) {
  const star = el(
    "button",
    {
      class: `chip-btn${p.highlight ? " is-on" : ""}`,
      title: p.highlight ? "Fjern som høydepunkt" : "Gjør til høydepunkt",
      "aria-pressed": String(!!p.highlight),
      onclick: async () => {
        p.highlight = !p.highlight;
        redraw();
        try {
          await call(`/api/admin/albums/${album.id}/photos/${p.id}`, { method: "PATCH", body: { highlight: p.highlight } });
        } catch (err) {
          p.highlight = !p.highlight;
          redraw();
          alert(err.message);
        }
      },
    },
    icon("star"),
  );

  const del = el(
    "button",
    {
      class: "chip-btn",
      title: "Slett bilde",
      onclick: async () => {
        if (!confirm("Slette dette bildet? Det kan ikke angres.")) return;
        try {
          await call(`/api/admin/albums/${album.id}/photos/${p.id}`, { method: "DELETE" });
          photos = photos.filter((x) => x !== p);
          if (album.coverId === p.id) album.coverId = photos[0]?.id || null;
          redraw();
          refreshAlbums().then(renderSidebar);
        } catch (err) {
          alert(err.message);
        }
      },
    },
    icon("trash"),
  );

  const caption = el("input", {
    type: "text",
    value: p.caption || "",
    placeholder: "Bildetekst",
    maxlength: "500",
    onchange: async (e) => {
      try {
        await call(`/api/admin/albums/${album.id}/photos/${p.id}`, { method: "PATCH", body: { caption: e.target.value } });
        p.caption = e.target.value;
      } catch (err) {
        alert(err.message);
      }
    },
  });

  const isCover = album.coverId === p.id;
  const coverBtn = isCover
    ? el("span", { class: "cover-tag" }, "Forsidebilde")
    : el(
        "button",
        {
          class: "link-btn",
          onclick: async () => {
            try {
              await call(`/api/admin/albums/${album.id}`, { method: "PATCH", body: { coverId: p.id } });
              album.coverId = p.id;
              redraw();
            } catch (err) {
              alert(err.message);
            }
          },
        },
        "Bruk som forside",
      );

  const card = el(
    "div",
    { class: `photo-card${p.highlight ? " is-highlight" : ""}`, draggable: "true", dataset: { id: p.id } },
    el("img", { src: p.thumb, alt: p.name || "", loading: "lazy", draggable: "false" }),
    el("div", { class: "photo-card-tools" }, star, del),
    el(
      "div",
      { class: "photo-card-body" },
      caption,
      el("div", { class: "photo-card-meta" }, el("span", {}, formatTaken(p.takenAt)), coverBtn),
    ),
  );

  // Dra og slipp for å endre rekkefølge
  card.addEventListener("dragstart", (e) => {
    if (e.target.closest("input")) return e.preventDefault();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", p.id);
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    const after = isAfter(e, card);
    card.classList.toggle("drop-before", !after);
    card.classList.toggle("drop-after", after);
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
  card.addEventListener("drop", async (e) => {
    e.preventDefault();
    card.classList.remove("drop-before", "drop-after");
    const fromId = e.dataTransfer.getData("text/plain");
    if (!fromId || fromId === p.id) return;
    const moved = photos.find((x) => x.id === fromId);
    if (!moved) return;
    const before = photos.slice();
    photos = photos.filter((x) => x !== moved);
    const target = photos.indexOf(p) + (isAfter(e, card) ? 1 : 0);
    photos.splice(target, 0, moved);
    redraw();
    try {
      await saveOrder(album);
    } catch (err) {
      photos = before;
      redraw();
      alert(err.message);
    }
  });

  return card;
}

function isAfter(e, node) {
  const r = node.getBoundingClientRect();
  return e.clientX > r.left + r.width / 2;
}

function saveOrder(album) {
  return call(`/api/admin/albums/${album.id}/order`, { method: "PUT", body: { ids: photos.map((p) => p.id) } });
}

async function sortByTime(album) {
  if (!confirm("Sortere alle bildene etter når de ble tatt?")) return;
  photos.sort(byTaken);
  try {
    await saveOrder(album);
  } catch (err) {
    alert(err.message);
  }
  openAlbum(album.id);
}

function byTaken(a, b) {
  return (a.takenAt || "").localeCompare(b.takenAt || "") || (a.name || "").localeCompare(b.name || "");
}

function formatTaken(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------- opplasting

function uploadPanel(album, onUploaded) {
  const filesInput = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const folderInput = el("input", { type: "file", multiple: true, hidden: true, webkitdirectory: true });
  const bar = el("div");
  const progress = el("div", { class: "progress", hidden: true }, bar);
  const info = el("p", { class: "muted" }, "Slipp bilder eller en hel mappe her");
  const log = el("ul", { class: "upload-log" });

  const zone = el(
    "div",
    { class: "dropzone" },
    icon("image"),
    info,
    el(
      "div",
      { class: "row" },
      el("button", { class: "btn", onclick: () => filesInput.click() }, "Velg bilder"),
      el("button", { class: "btn btn-primary", onclick: () => folderInput.click() }, "Velg mappe"),
    ),
    progress,
    filesInput,
    folderInput,
  );

  for (const input of [filesInput, folderInput]) {
    input.addEventListener("change", () => {
      handle([...input.files]);
      input.value = "";
    });
  }
  zone.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", async (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    zone.classList.remove("is-over");
    handle(await filesFromDrop(e.dataTransfer));
  });

  let busy = false;

  async function handle(files) {
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!images.length || busy) return;
    busy = true;
    log.replaceChildren();
    progress.hidden = false;
    let done = 0;
    let failed = 0;
    const update = () => {
      bar.style.width = `${((done + failed) / images.length) * 100}%`;
      info.textContent = `Laster opp ${done + failed} av ${images.length} …`;
    };
    update();

    const queue = images.slice().sort((a, b) => a.name.localeCompare(b.name));
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift();
        try {
          const photo = await uploadOne(album, file);
          if (currentId === album.id) {
            photos.push(photo);
            if (!album.coverId) album.coverId = photo.id;
            onUploaded();
          }
          done++;
        } catch (err) {
          failed++;
          log.append(el("li", {}, `${file.name}: ${err.message}`));
        }
        update();
      }
    };
    const existing = new Set(photos.map((p) => p.id));
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));

    // Opplastingene skjer parallelt, så sorter de nye bildene etter tidspunkt bak de gamle
    if (done && currentId === album.id) {
      const old = photos.filter((p) => existing.has(p.id));
      const added = photos.filter((p) => !existing.has(p.id)).sort(byTaken);
      photos = [...old, ...added];
      onUploaded();
      await saveOrder(album).catch((err) => log.append(el("li", {}, `Rekkefølge: ${err.message}`)));
    }

    busy = false;
    progress.hidden = true;
    info.textContent = failed ? `${done} lastet opp, ${failed} feilet` : `${done} bilder lastet opp ✓`;
    refreshAlbums().then(renderSidebar).catch(() => {});
  }

  return el("div", { class: "panel" }, el("div", { class: "panel-head" }, el("h2", {}, "Last opp")), zone, log);
}

async function uploadOne(album, file) {
  const takenAt = (await readExifDate(file)) || new Date(file.lastModified).toISOString().slice(0, 19);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(/\.hei[cf]$/i.test(file.name) ? "HEIC støttes ikke i denne nettleseren – bruk JPEG eller prøv Safari" : "Kunne ikke lese bildet");
  }
  const full = await resize(bitmap, FULL_MAX, 0.85);
  const thumb = await resize(bitmap, THUMB_MAX, 0.78);
  bitmap.close?.();

  const form = new FormData();
  form.append("full", full.blob, "full.jpg");
  form.append("thumb", thumb.blob, "thumb.jpg");
  form.append("meta", JSON.stringify({ name: file.name, w: full.w, h: full.h, takenAt }));
  const { photo } = await call(`/api/admin/albums/${album.id}/photos`, { method: "POST", body: form });
  return photo;
}

async function resize(bitmap, max, quality) {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Kunne ikke komprimere bildet"))), "image/jpeg", quality));
  return { blob, w, h };
}

/** Henter filer fra dra-og-slipp, også fra mapper. */
async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

/** Leser «DateTimeOriginal» fra EXIF i JPEG-filer, slik at bildene kan sorteres etter når de ble tatt. */
async function readExifDate(file) {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiffDate(v, off + 10);
      off += 2 + size;
    }
  } catch {
    /* ødelagt EXIF – bruk fildato */
  }
  return null;
}

function parseTiffDate(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const readIfd = (ifd) => {
    const entries = {};
    const n = u16(ifd);
    for (let i = 0; i < n; i++) entries[u16(ifd + 2 + i * 12)] = ifd + 2 + i * 12;
    return entries;
  };
  const ifd0 = readIfd(u32(4));
  let entry = null;
  if (ifd0[0x8769] != null) {
    const exif = readIfd(u32(ifd0[0x8769] + 8));
    entry = exif[0x9003] ?? exif[0x9004] ?? null;
  }
  entry ??= ifd0[0x0132] ?? null;
  if (entry == null) return null;
  const valOff = u32(entry + 8);
  let s = "";
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(start + valOff + i));
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}
