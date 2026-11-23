// Admin-siden: oversikt over album, redigering av album og brukergrupper.
//
// Sidene velges med adressen (#):
//   #            oversikt over alle album
//   #<albumId>   redigere et album
//   #grupper     brukergrupper

const adminStore = makeStore("album_admin_token");
const app = document.getElementById("app");
document.title = `Admin · ${CONFIG.title}`;

const FULL_MAX = 2560; // lengste side på stort bilde
const THUMB_MAX = 640; // lengste side på miniatyr
const UPLOAD_CONCURRENCY = 3;
const GROUPS_HASH = "grupper";

let token = adminStore.get();
let albums = [];
let groups = null; // null: API-et er for gammelt til å ha brukergrupper
let currentId = null;
let photos = [];
// Kortene på redigeringssiden er lukket når man åpner et album. De som åpnes, holder seg åpne
// når samme album tegnes på nytt (f.eks. etter sortering).
const openPanels = new Set();
let openPanelsAlbum = null;

if (token) boot();
else showLogin();

function showLogin() {
  window.removeEventListener("hashchange", route);
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
    await Promise.all([refreshAlbums(), refreshGroups()]);
  } catch {
    return;
  }
  render();
  window.addEventListener("hashchange", route);
  route();
}

async function refreshAlbums() {
  ({ albums } = await call("/api/albums"));
}

async function refreshGroups() {
  try {
    ({ groups } = await call("/api/admin/groups"));
  } catch (err) {
    if (err.status !== 404) throw err;
    groups = null; // eldre versjon av API-et
  }
}

function go(hash) {
  if (location.hash.slice(1) === hash) route();
  else location.hash = hash; // gir et nytt steg i historikken, så tilbakeknappen virker
}

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  closeMenu();
  window.scrollTo(0, 0);
  if (hash === GROUPS_HASH) openGroups();
  else if (hash && albums.some((a) => a.id === hash)) openAlbum(hash);
  else openOverview();
}

// ---------------------------------------------------------------- layout og meny

const main = el("main", { class: "admin-main" });
const menuPanel = el("nav", { class: "admin-menu-panel", hidden: true, "aria-label": "Admin-meny" });
const menuButton = el(
  "button",
  { class: "btn-icon", type: "button", title: "Meny", "aria-label": "Meny", "aria-expanded": "false", onclick: () => (menuPanel.hidden ? openMenu() : closeMenu()) },
  icon("menu"),
);

function render() {
  const header = el(
    "header",
    { class: "site-header" },
    el("div", { class: "admin-menu" }, menuButton, menuPanel),
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
  app.replaceChildren(header, main);
}

function openMenu() {
  const page = location.hash.slice(1) === GROUPS_HASH ? "groups" : "albums";
  const item = (label, iconName, hash, active) =>
    el("a", { class: `menu-item${active ? " is-active" : ""}`, href: `#${hash}`, onclick: (e) => (e.preventDefault(), closeMenu(), go(hash)) }, icon(iconName), el("span", {}, label));
  menuPanel.replaceChildren(
    item("Album", "image", "", page === "albums"),
    item("Brukergrupper", "users", GROUPS_HASH, page === "groups"),
    el("hr"),
    el("a", { class: "menu-item", href: "index.html", target: "_blank" }, icon("external"), el("span", {}, "Åpne albumsiden")),
  );
  menuPanel.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
  setTimeout(() => document.addEventListener("click", onOutsideClick));
  document.addEventListener("keydown", onMenuKey);
}

function closeMenu() {
  if (menuPanel.hidden) return;
  menuPanel.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onOutsideClick);
  document.removeEventListener("keydown", onMenuKey);
}

function onOutsideClick(e) {
  if (!menuPanel.contains(e.target) && !menuButton.contains(e.target)) closeMenu();
}

function onMenuKey(e) {
  if (e.key === "Escape") {
    closeMenu();
    menuButton.focus();
  }
}

/** Et sammenleggbart kort. `meta` er en kort oppsummering som vises når kortet er lukket. */
function section(key, title, { meta = null, status = null } = {}, ...body) {
  const details = el(
    "details",
    { class: "panel collapsible", open: openPanels.has(key) },
    el(
      "summary",
      { class: "panel-head" },
      el("span", { class: "panel-title" }, el("h2", {}, title), meta),
      el("span", { class: "row" }, status, icon("chevron")),
    ),
    el("div", { class: "panel-body" }, body),
  );
  details.addEventListener("toggle", () => (details.open ? openPanels.add(key) : openPanels.delete(key)));
  return details;
}

function groupNames(album) {
  if (!groups) return "";
  const ids = album.groups || ["standard"];
  return groups.filter((g) => ids.includes(g.id)).map((g) => g.name).join(", ") || "Bare deg";
}

// ---------------------------------------------------------------- oversikt

function openOverview() {
  currentId = null;
  document.title = `Admin · ${CONFIG.title}`;

  const title = el("input", { type: "text", placeholder: "F.eks. Sommerferie 2026", required: true, maxlength: "120" });
  const date = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const err = el("p", { class: "form-error" });
  const form = el(
    "form",
    {
      class: "panel new-album-form",
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          const { album } = await call("/api/admin/albums", { method: "POST", body: { title: title.value, date: date.value } });
          await refreshAlbums();
          openPanels.clear();
          openPanels.add("upload"); // et nytt album trenger bilder først
          openPanelsAlbum = album.id;
          go(album.id);
        } catch (e2) {
          err.textContent = e2.message;
        }
      },
    },
    el("div", { class: "panel-head" }, el("h2", {}, "Nytt album")),
    el(
      "div",
      { class: "form-grid" },
      el("label", {}, "Navn", title),
      el("label", {}, "Dato", date),
      el(
        "div",
        { class: "row span-2" },
        err,
        el("span", { class: "spacer" }),
        el("button", { class: "btn", type: "button", onclick: () => (form.hidden = true) }, "Avbryt"),
        el("button", { class: "btn btn-primary", type: "submit" }, "Lag album"),
      ),
    ),
  );

  const cards = albums.map((a) =>
    el(
      "a",
      { class: "album-card", href: `#${a.id}` },
      a.cover ? el("img", { src: a.cover, alt: "", loading: "lazy" }) : el("span", { class: "album-card-empty" }, icon("image")),
      el(
        "span",
        { class: "album-card-body" },
        el("strong", {}, a.title),
        el("small", {}, [formatDateRange(a.date, a.dateEnd), `${a.count || 0}\u00a0bilder`].filter(Boolean).join(" · ")),
        el(
          "span",
          { class: "album-card-tags" },
          el("span", { class: `badge${a.hidden ? "" : " badge-ok"}` }, a.hidden ? "Skjult" : "Publisert"),
          groups ? el("span", { class: "badge" }, groupNames(a)) : null,
        ),
      ),
    ),
  );

  main.replaceChildren(
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "Album"),
      el(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: () => {
            form.hidden = false;
            title.focus();
          },
        },
        "+ Nytt album",
      ),
    ),
    form,
    albums.length
      ? el("div", { class: "album-grid" }, cards)
      : el("div", { class: "empty-state" }, el("h1", {}, "Ingen album ennå"), el("p", {}, "Trykk «+ Nytt album» for å lage det første.")),
  );
}

// ---------------------------------------------------------------- album-redigering

async function openAlbum(id) {
  currentId = id;
  if (openPanelsAlbum !== id) {
    openPanels.clear();
    openPanelsAlbum = id;
  }
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
  document.title = `${data.album.title} · Admin`;
  renderAlbum(data.album);
}

function renderAlbum(album) {
  const heading = el("h1", {}, album.title);
  const title = el("input", { type: "text", value: album.title, maxlength: "120" });
  const date = el("input", { type: "date", value: album.date || "" });
  const dateEnd = el("input", { type: "date", value: album.dateEnd || "" });
  const desc = el("textarea", { maxlength: "2000", placeholder: "Kort tekst som vises øverst i albumet (valgfritt)" }, album.description || "");
  const published = el("input", { type: "checkbox", checked: !album.hidden });
  const status = el("span", { class: "save-status", role: "status" });
  const settingsMeta = el("span", { class: "panel-meta" });
  const showSettingsMeta = () => {
    settingsMeta.textContent = [album.hidden ? "Skjult" : "Publisert", formatDateRange(album.date, album.dateEnd)].filter(Boolean).join(" · ");
  };
  showSettingsMeta();

  const save = async () => {
    status.textContent = "Lagrer …";
    try {
      const res = await call(`/api/admin/albums/${album.id}`, {
        method: "PATCH",
        body: { title: title.value, date: date.value, dateEnd: dateEnd.value, description: desc.value, hidden: !published.checked },
      });
      Object.assign(album, res.album);
      heading.textContent = album.title;
      showSettingsMeta();
      await refreshAlbums();
      status.textContent = "Lagret ✓";
    } catch (err) {
      status.textContent = "";
      alert(err.message);
    }
  };

  // Tema: lagres med en gang man velger et
  const themeStatus = el("span", { class: "save-status", role: "status" });
  const themeMeta = el("span", { class: "panel-meta" }, themeById(album.theme).name);
  const themeButtons = THEMES.map((t) =>
    el(
      "button",
      { class: "theme-option", type: "button", "aria-pressed": String(themeById(album.theme) === t), onclick: () => pickTheme(t) },
      el("span", { class: "theme-swatch", dataset: { theme: t.id } }, el("span", { class: "theme-swatch-photo" }), el("span", { class: "theme-swatch-title" }, t.name)),
      el("span", { class: "theme-option-name" }, t.name),
    ),
  );
  const markTheme = (id) => {
    themeButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(THEMES[i] === themeById(id))));
    themeMeta.textContent = themeById(id).name;
  };
  async function pickTheme(t) {
    const previous = album.theme;
    markTheme(t.id);
    themeStatus.textContent = "Lagrer …";
    try {
      const res = await call(`/api/admin/albums/${album.id}`, { method: "PATCH", body: { theme: t.id } });
      // En eldre versjon av API-et kjenner ikke til temaer og lagrer dem ikke
      if (res.album.theme !== t.id) throw new Error("Temaet ble ikke lagret. API-et (Workeren) må publiseres på nytt først.");
      album.theme = t.id;
      themeStatus.textContent = "Lagret ✓";
    } catch (err) {
      markTheme(previous);
      themeStatus.textContent = "";
      alert(err.message);
    }
  }
  const themePanel = section(
    "theme",
    "Tema",
    { meta: themeMeta, status: themeStatus },
    el("p", { class: "muted" }, "Velg utseendet albumet skal ha for de som ser på det. Bildene og tekstene er de samme i alle temaer."),
    el("div", { class: "theme-picker" }, themeButtons),
  );
  // Skriftene til temaene hentes først når kortet åpnes
  const loadFonts = () => themePanel.open && THEMES.forEach(loadThemeFonts);
  themePanel.addEventListener("toggle", loadFonts);
  loadFonts();

  const settings = section(
    "settings",
    "Innstillinger",
    { meta: settingsMeta, status },
    el(
      "div",
      { class: "form-grid" },
      el("label", { class: "span-2" }, "Navn", title),
      el("label", {}, "Fra dato", date),
      el("label", {}, "Til dato (valgfritt)", dateEnd),
      el("label", { class: "span-2" }, "Innledning", desc),
      el(
        "div",
        { class: "row span-2" },
        el("label", { class: "check" }, published, "Publisert (synlig for gruppene under «Hvem kan se albumet»)"),
        el("span", { class: "spacer" }),
        el(
          "button",
          {
            class: "btn btn-danger",
            type: "button",
            onclick: async () => {
              if (!confirm(`Slette «${album.title}» og alle ${photos.length} bilder? Dette kan ikke angres.`)) return;
              try {
                await call(`/api/admin/albums/${album.id}`, { method: "DELETE" });
                await refreshAlbums();
                go("");
              } catch (err) {
                alert(err.message);
              }
            },
          },
          icon("trash"),
          "Slett album",
        ),
        el("button", { class: "btn btn-primary", type: "button", onclick: save }, "Lagre"),
      ),
    ),
  );

  const hero = heroPanel(album);

  const grid = el("div", { class: "photo-grid" });
  const photosMeta = el("span", { class: "panel-meta" });
  const photosPanel = section(
    "photos",
    "Bilder",
    { meta: photosMeta },
    el(
      "div",
      { class: "row panel-tools" },
      el(
        "p",
        { class: "muted" },
        "Trykk på et bilde for å se det større. Trykk på stjernen for å gjøre det til høydepunkt, og dra bildene for å endre rekkefølgen i lysbildefremvisningen.",
      ),
      el("button", { class: "btn", type: "button", onclick: () => sortByTime(album) }, "Sorter etter tidspunkt"),
    ),
    grid,
  );

  const storyList = el("div", { class: "story-editor-list" });
  const storiesMeta = el("span", { class: "panel-meta" });
  const storiesPanel = section(
    "stories",
    "Tekst til høydepunktene",
    { meta: storiesMeta },
    el(
      "p",
      { class: "muted" },
      "Høydepunktene vises nedover albumet, annenhver side, med teksten ved siden av. La feltene stå tomme hvis du bare vil vise bildet. Tom linje gir nytt avsnitt.",
    ),
    storyList,
  );

  main.replaceChildren(
    el("a", { class: "back-link", href: "#", onclick: (e) => (e.preventDefault(), go("")) }, icon("prev"), "Alle album"),
    el("div", { class: "page-head" }, heading, el("a", { class: "btn", href: `index.html#/${album.id}`, target: "_blank" }, "Vis album ↗")),
    settings,
    sharingPanel(album),
    hero.node,
    themePanel,
    uploadPanel(album, () => drawGrid()),
    photosPanel,
    storiesPanel,
  );
  drawGrid();

  function drawGrid() {
    const highlights = photos.filter((p) => p.highlight);
    photosMeta.textContent = `${photos.length} bilder · ${highlights.length} høydepunkter`;
    storiesMeta.textContent = `${highlights.length} høydepunkter`;
    grid.replaceChildren(...photos.map((p) => photoCard(album, p, drawGrid)));
    if (!photos.length) grid.append(el("p", { class: "muted" }, "Ingen bilder ennå."));
    storyList.replaceChildren(...highlights.map((p) => storyEditor(album, p)));
    if (!highlights.length) storyList.append(el("p", { class: "muted" }, "Marker bilder med ⭐ for å skrive tekst til dem."));
    hero.update(); // forsidebildet kan ha blitt byttet
  }
}

// ---------------------------------------------------------------- forsidebilde

const HERO_TEXT_LABELS = {
  "top-left": "Øverst til venstre",
  "top-center": "Øverst i midten",
  "top-right": "Øverst til høyre",
  "middle-left": "Midt på, til venstre",
  "middle-center": "Midt på bildet",
  "middle-right": "Midt på, til høyre",
  "bottom-left": "Nederst til venstre",
  "bottom-center": "Nederst i midten",
  "bottom-right": "Nederst til høyre",
  below: "Under bildet",
};
const HERO_TEXT_DEFAULT = "bottom-left";

/**
 * Velg hvor tittelen står på forsidebildet, så den ikke dekker motivet. Viser hvordan forsiden
 * ser ut på PC og mobil, siden bildet beskjæres forskjellig. Lagres med en gang.
 */
function heroPanel(album) {
  const status = el("span", { class: "save-status", role: "status" });
  const meta = el("span", { class: "panel-meta" });
  const previews = el("div", { class: "cover-previews" });
  const belowLabel = el("label", { class: "check" });
  let value = album.heroText || HERO_TEXT_DEFAULT;

  const mockText = () =>
    el(
      "div",
      { class: "cover-preview-text" },
      el("small", {}, formatDateRange(album.date, album.dateEnd)),
      el("strong", {}, album.title),
      el("small", { class: "cover-preview-count" }, `${photos.length} bilder`),
    );

  function preview(cover, kind, label, interactive) {
    const below = value === "below";
    const [v, h] = value.split("-");
    const frame = el(
      "div",
      { class: `cover-preview cover-preview--${kind}${below ? " is-below" : ""}`, dataset: below ? {} : { textV: v, textH: h } },
      el("img", { src: cover.thumb, alt: "" }),
      below ? null : mockText(),
    );
    if (interactive) {
      const spots = Object.keys(HERO_TEXT_LABELS)
        .filter((k) => k !== "below")
        .map((k) =>
          el("button", {
            type: "button",
            class: `cover-spot${k === value ? " is-active" : ""}`,
            title: HERO_TEXT_LABELS[k],
            "aria-label": HERO_TEXT_LABELS[k],
            "aria-pressed": String(k === value),
            onclick: () => pick(k),
          }),
        );
      frame.append(el("div", { class: "cover-spots" }, spots));
    }
    return el("figure", { class: `cover-preview-wrap cover-preview-wrap--${kind}` }, frame, below ? mockText() : null, el("figcaption", {}, label));
  }

  function update() {
    meta.textContent = HERO_TEXT_LABELS[value] || "";
    belowLabel.replaceChildren(
      el("input", { type: "checkbox", checked: value === "below", onchange: (e) => pick(e.target.checked ? "below" : HERO_TEXT_DEFAULT) }),
      "Vis teksten under bildet i stedet",
    );
    const cover = photos.find((p) => p.id === album.coverId) || photos.find((p) => p.highlight) || photos[0];
    if (!cover) {
      previews.replaceChildren(el("p", { class: "muted" }, "Albumet har ingen bilder ennå. Last opp bilder først."));
      return;
    }
    previews.replaceChildren(preview(cover, "wide", "PC – trykk der teksten skal stå", true), preview(cover, "tall", "Mobil", false));
  }

  async function pick(next) {
    const previous = value;
    value = next;
    update();
    status.textContent = "Lagrer …";
    try {
      const res = await call(`/api/admin/albums/${album.id}`, { method: "PATCH", body: { heroText: next } });
      // En eldre versjon av API-et kjenner ikke til feltet og lagrer det ikke
      if ((res.album.heroText || HERO_TEXT_DEFAULT) !== next) throw new Error("Plasseringen ble ikke lagret. API-et (Workeren) må publiseres på nytt først.");
      album.heroText = next;
      status.textContent = "Lagret ✓";
    } catch (err) {
      value = previous;
      update();
      status.textContent = "";
      alert(err.message);
    }
  }

  update();
  return {
    update,
    node: section(
      "hero",
      "Forsidebilde",
      { meta, status },
      el(
        "p",
        { class: "muted" },
        "Velg hvor tittelen skal stå, så den ikke dekker motivet. Selve forsidebildet velger du under «Bilder» med «Bruk som forside».",
      ),
      previews,
      belowLabel,
    ),
  };
}

// ---------------------------------------------------------------- deling og brukergrupper

const OLD_API_MESSAGE = "Brukergrupper krever en nyere versjon av API-et. Publiser Workeren på nytt med «npx wrangler deploy».";

/** Avkrysning for hvilke brukergrupper som får se albumet. Lagres med en gang. */
function sharingPanel(album) {
  const status = el("span", { class: "save-status", role: "status" });
  const meta = el("span", { class: "panel-meta" });
  if (!groups) return section("sharing", "Hvem kan se albumet", { meta, status }, el("p", { class: "muted" }, OLD_API_MESSAGE));

  const selected = new Set(album.groups || ["standard"]);
  const warning = el("p", { class: "muted sharing-warning" });
  const update = () => {
    warning.textContent = selected.size ? "" : "Ingen grupper er valgt, så bare du ser albumet.";
    meta.textContent = groupNames({ groups: [...selected] });
  };
  const boxes = groups.map((g) => {
    const box = el("input", {
      type: "checkbox",
      checked: selected.has(g.id),
      onchange: async () => {
        if (box.checked) selected.add(g.id);
        else selected.delete(g.id);
        update();
        status.textContent = "Lagrer …";
        try {
          const res = await call(`/api/admin/albums/${album.id}`, { method: "PATCH", body: { groups: [...selected] } });
          album.groups = res.album.groups;
          const listed = albums.find((a) => a.id === album.id);
          if (listed) listed.groups = res.album.groups;
          status.textContent = "Lagret ✓";
        } catch (err) {
          box.checked = !box.checked;
          if (box.checked) selected.add(g.id);
          else selected.delete(g.id);
          update();
          status.textContent = "";
          alert(err.message);
        }
      },
    });
    return el("label", { class: "check" }, box, g.name, g.builtin ? el("span", { class: "badge" }, "fellespassordet") : null);
  });
  update();
  return section(
    "sharing",
    "Hvem kan se albumet",
    { meta, status },
    el(
      "p",
      { class: "muted" },
      "Kryss av for brukergruppene som skal få se albumet når det er publisert. Du som admin ser alltid alle album. ",
      el("a", { class: "link-btn", href: `#${GROUPS_HASH}` }, "Administrer brukergrupper"),
    ),
    el("div", { class: "check-list" }, boxes),
    warning,
  );
}

async function openGroups() {
  currentId = null;
  document.title = `Brukergrupper · Admin`;
  main.replaceChildren(el("div", { class: "loading" }, "Laster …"));
  try {
    await Promise.all([refreshGroups(), refreshAlbums()]);
  } catch (err) {
    main.replaceChildren(el("p", { class: "form-error" }, err.message));
    return;
  }
  if (location.hash.slice(1) !== GROUPS_HASH) return;
  renderGroups();
}

function renderGroups() {
  const head = el("div", { class: "page-head" }, el("h1", {}, "Brukergrupper"));
  if (!groups) {
    main.replaceChildren(head, el("div", { class: "panel" }, el("p", { class: "muted" }, OLD_API_MESSAGE)));
    return;
  }

  const name = el("input", { type: "text", placeholder: "F.eks. Venner", required: true, maxlength: "60" });
  const password = el("input", { type: "text", placeholder: "Minst 4 tegn", required: true, minlength: "4", maxlength: "200", autocomplete: "off" });
  const err = el("p", { class: "form-error" });
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          await call("/api/admin/groups", { method: "POST", body: { name: name.value, password: password.value } });
          await refreshGroups();
          renderGroups();
        } catch (e2) {
          err.textContent = e2.message;
        }
      },
    },
    el("label", {}, "Navn", name),
    el("label", {}, "Passord", password),
    el("div", { class: "row span-2" }, err, el("span", { class: "spacer" }), el("button", { class: "btn btn-primary", type: "submit" }, "Lag gruppe")),
  );

  main.replaceChildren(
    head,
    el(
      "p",
      { class: "muted page-intro" },
      "Hver gruppe har sitt eget passord. De som logger inn på albumsiden med det, ser bare albumene som er delt med gruppen. Du som admin ser alltid alt. Hvilke album en gruppe ser, velger du på hvert album under «Hvem kan se albumet».",
    ),
    el("div", { class: "group-list" }, groups.map(groupCard)),
    el(
      "div",
      { class: "panel" },
      el("div", { class: "panel-head" }, el("h2", {}, "Ny brukergruppe")),
      el("p", { class: "muted" }, "Gi passordet til dem som skal være med i gruppen. De logger inn på albumsiden som vanlig."),
      form,
    ),
  );
}

function groupCard(g) {
  const shared = albums.filter((a) => (a.groups || ["standard"]).includes(g.id));
  const name = el("input", { type: "text", value: g.name, maxlength: "60" });
  const password = g.builtin
    ? null
    : el("input", { type: "text", placeholder: "Nytt passord (valgfritt)", maxlength: "200", autocomplete: "off" });
  const status = el("span", { class: "save-status", role: "status" });

  const save = async () => {
    const body = {};
    if (name.value.trim() !== g.name) body.name = name.value;
    if (password?.value) body.password = password.value;
    if (!Object.keys(body).length) return;
    if (body.password && !confirm(`Bytte passord for «${g.name}»? Alle som er logget inn med det gamle passordet, blir logget ut.`)) return;
    status.textContent = "Lagrer …";
    try {
      const res = await call(`/api/admin/groups/${g.id}`, { method: "PATCH", body });
      Object.assign(g, res.group);
      if (password) password.value = "";
      status.textContent = body.password ? "Nytt passord lagret ✓" : "Lagret ✓";
    } catch (err) {
      status.textContent = "";
      alert(err.message);
    }
  };

  const remove = async () => {
    if (!confirm(`Slette gruppen «${g.name}»? De som bruker passordet, mister tilgangen med en gang. Albumene og bildene slettes ikke.`)) return;
    try {
      await call(`/api/admin/groups/${g.id}`, { method: "DELETE" });
      await Promise.all([refreshGroups(), refreshAlbums()]);
      renderGroups();
    } catch (err) {
      alert(err.message);
    }
  };

  return el(
    "div",
    { class: "panel group-card" },
    el(
      "div",
      { class: "form-grid" },
      el("label", {}, "Navn", name),
      g.builtin
        ? el("p", { class: "muted group-note" }, "Passordet er VIEWER_PASSWORD hos Cloudflare. Bytt det med «npx wrangler secret put VIEWER_PASSWORD».")
        : el("label", {}, "Passord", password),
      el(
        "p",
        { class: "muted span-2 group-albums" },
        shared.length ? `Ser ${shared.length} album: ${shared.map((a) => a.title + (a.hidden ? " (skjult)" : "")).join(", ")}` : "Har ikke tilgang til noen album ennå.",
      ),
      el(
        "div",
        { class: "row span-2" },
        el("span", { class: "spacer" }),
        status,
        g.builtin ? null : el("button", { class: "btn btn-danger", type: "button", onclick: remove }, icon("trash"), "Slett gruppe"),
        el("button", { class: "btn btn-primary", type: "button", onclick: save }, "Lagre"),
      ),
    ),
  );
}

function storyEditor(album, p) {
  const status = el("span", { class: "save-status", role: "status" });
  const save = (field) => async (e) => {
    const value = e.target.value;
    status.textContent = "Lagrer …";
    try {
      await call(`/api/admin/albums/${album.id}/photos/${p.id}`, { method: "PATCH", body: { [field]: value } });
      p[field] = value;
      status.textContent = "Lagret ✓";
    } catch (err) {
      status.textContent = "";
      alert(err.message);
    }
  };
  return el(
    "div",
    { class: "story-editor" },
    previewButton(p, el("img", { src: p.thumb, alt: "", loading: "lazy" })),
    el(
      "div",
      { class: "story-editor-fields" },
      el(
        "label",
        {},
        "Overskrift",
        el("input", { type: "text", value: p.title || "", maxlength: "120", placeholder: "Dag 3 · Krabi", onchange: save("title") }),
      ),
      el(
        "label",
        {},
        "Tekst",
        el("textarea", { maxlength: "4000", placeholder: "Hva skjedde denne dagen?", onchange: save("story") }, p.story || ""),
      ),
      el("div", { class: "row" }, el("span", { class: "muted", style: "font-size:12px" }, "Lagres automatisk når du går ut av feltet"), el("span", { class: "spacer" }), status),
    ),
  );
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
          refreshAlbums().catch(() => {});
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
    placeholder: "Bildetekst (kort)",
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
    previewButton(p, el("img", { src: p.thumb, alt: p.name || "", loading: "lazy", draggable: "false" })),
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

// ---------------------------------------------------------------- forhåndsvisning

/** Gjør et miniatyrbilde trykkbart. Bildet pakkes ikke inn i en knapp, for da kan ikke kortet dras i alle nettlesere. */
function previewButton(p, img) {
  img.classList.add("preview-btn");
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  img.title = "Se bildet større";
  img.addEventListener("click", () => openPreview(p));
  img.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPreview(p);
    }
  });
  return img;
}

/** Viser et bilde stort, med piler for å bla gjennom resten av albumet. */
function openPreview(start) {
  const list = photos.slice();
  let index = Math.max(0, list.indexOf(start));
  let loadId = 0;
  const opener = document.activeElement;

  const img = el("img", { class: "preview-img", alt: "" });
  const info = el("p", { class: "preview-info" });
  const close = () => {
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("no-scroll");
    overlay.remove();
    opener?.focus?.();
  };
  const show = (i) => {
    index = (i + list.length) % list.length;
    const p = list[index];
    const id = ++loadId;
    // Miniatyren vises med en gang, og byttes ut når det store bildet er lastet
    img.src = p.thumb;
    img.alt = p.caption || p.name || "";
    const full = new Image();
    full.onload = () => {
      if (id === loadId) img.src = p.src;
    };
    full.src = p.src;
    info.textContent = [`${index + 1} / ${list.length}`, p.caption, formatTaken(p.takenAt), p.highlight ? "Høydepunkt" : ""].filter(Boolean).join(" · ");
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(index + 1);
    else if (e.key === "ArrowLeft") show(index - 1);
  };

  const many = list.length > 1;
  const overlay = el(
    "div",
    {
      class: "preview",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Forhåndsvisning",
      onclick: (e) => {
        if (e.target === overlay || e.target.classList.contains("preview-stage")) close();
      },
    },
    el("div", { class: "preview-stage" }, img),
    many ? el("button", { class: "stage-nav prev", type: "button", "aria-label": "Forrige", onclick: () => show(index - 1) }, icon("prev")) : null,
    many ? el("button", { class: "stage-nav next", type: "button", "aria-label": "Neste", onclick: () => show(index + 1) }, icon("next")) : null,
    el("button", { class: "btn-icon preview-close", type: "button", "aria-label": "Lukk", onclick: close }, icon("close")),
    info,
  );

  // Sveip for å bla på mobil
  let startX = null;
  overlay.addEventListener("pointerdown", (e) => {
    startX = e.pointerType === "mouse" ? null : e.clientX;
  });
  overlay.addEventListener("pointerup", (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (many && Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
  });

  document.addEventListener("keydown", onKey);
  document.body.classList.add("no-scroll");
  document.body.append(overlay);
  show(index);
  overlay.querySelector(".preview-close").focus();
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
  const filesInput = el("input", { type: "file", accept: "image/*,.heic,.heif,.hif", multiple: true, hidden: true });
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
    if (busy) return;
    const images = files.filter((f) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name));
    const skipped = files.length - images.length;
    log.replaceChildren();
    if (!images.length) {
      info.textContent = files.length
        ? `Fant ingen bilder å laste opp (${files.length} filer hoppet over). Støttede formater: JPEG, PNG, WebP, HEIC/HEIF/HIF.`
        : "Fant ingen filer.";
      return;
    }
    busy = true;
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
    info.textContent =
      (failed ? `${done} lastet opp, ${failed} feilet` : `${done} bilder lastet opp ✓`) +
      (skipped ? ` · ${skipped} andre filer hoppet over` : "");
    refreshAlbums().catch(() => {});
  }

  return section("upload", "Last opp", { meta: el("span", { class: "panel-meta" }, "Legg til bilder") }, zone, log);
}

async function uploadOne(album, file) {
  const takenAt = (await readExifDate(file)) || new Date(file.lastModified).toISOString().slice(0, 19);
  const bitmap = await decodeImage(file);
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

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|heic|heif|hif)$/i;
const HEIF_EXT = /\.(heic|heif|hif)$/i;
const HEIC_LIB_URL = "https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/heic-to.js";
let heicLib = null;

/** Leser et bilde til en bitmap. HEIC/HEIF/HIF (iPhone, Fujifilm, Canon) dekodes med libheif når nettleseren ikke kan selv. */
async function decodeImage(file) {
  const isHeif = HEIF_EXT.test(file.name) || /image\/hei[cf]/.test(file.type);
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (!isHeif) throw new Error("Kunne ikke lese bildet");
  }
  heicLib ??= import(HEIC_LIB_URL).catch((err) => {
    heicLib = null;
    throw err;
  });
  let lib;
  try {
    lib = await heicLib;
  } catch {
    throw new Error("Kunne ikke laste HEIF-støtte – sjekk nettforbindelsen");
  }
  try {
    return await lib.heicTo({ blob: file, type: "bitmap" });
  } catch {
    throw new Error("Kunne ikke lese HEIF-bildet – eksporter det som JPEG og prøv igjen");
  }
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
