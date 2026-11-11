// Album-siden for besøkende.

const tokenStore = makeStore("album_token");
const app = document.getElementById("app");
document.title = CONFIG.title;

let albums = [];
let slideshow = null;

start();

function start() {
  const token = tokenStore.get();
  if (!token) return showLogin();
  loadAlbums(token);
}

function showLogin() {
  renderLogin(app, {
    heading: CONFIG.title,
    hint: "Skriv inn passordet for å se bildene.",
    onLogin: (token) => {
      tokenStore.set(token);
      loadAlbums(token);
    },
  });
}

function handleError(err) {
  if (err.status === 401) {
    tokenStore.clear();
    return showLogin();
  }
  app.replaceChildren(
    el("main", { class: "empty-state" }, el("h1", {}, "Noe gikk galt"), el("p", { class: "muted" }, err.message)),
  );
}

async function loadAlbums(token) {
  try {
    ({ albums } = await api("/api/albums", { token }));
  } catch (err) {
    return handleError(err);
  }
  window.onhashchange = () => showAlbum(token);
  showAlbum(token);
}

function currentAlbumId() {
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  return albums.some((a) => a.id === id) ? id : albums[0]?.id;
}

async function showAlbum(token) {
  slideshow?.destroy();
  slideshow = null;
  const albumId = currentAlbumId();
  const header = renderHeader(albumId);

  if (!albumId) {
    app.replaceChildren(
      header,
      el("main", { class: "empty-state" }, el("h1", {}, "Ingen album ennå"), el("p", { class: "muted" }, "Kom tilbake senere.")),
    );
    return;
  }

  const main = el("main", { class: "album" }, el("div", { class: "loading" }, "Laster bilder …"));
  app.replaceChildren(header, main);

  let data;
  try {
    data = await api(`/api/albums/${albumId}`, { token });
  } catch (err) {
    return handleError(err);
  }
  if (currentAlbumId() !== albumId) return; // brukeren har byttet album i mellomtiden

  const { album, photos } = data;
  document.title = `${album.title} · ${CONFIG.title}`;
  const highlights = photos.filter((p) => p.highlight);

  const intro = el(
    "section",
    { class: "album-intro" },
    el("p", { class: "eyebrow" }, [formatDate(album.date), `${photos.length} bilder`].filter(Boolean).join(" · ")),
    el("h1", { class: "album-title" }, album.title),
    album.description ? el("p", { class: "album-desc" }, album.description) : null,
  );

  const slideSection = el(
    "section",
    { class: "section", id: "lysbilder" },
    el("h2", { class: "section-title" }, "Alle bilder"),
  );

  main.replaceChildren(intro);

  if (highlights.length) {
    const grid = el("div", { class: "justified" });
    for (const p of highlights) {
      const ratio = p.w && p.h ? p.w / p.h : 1.5;
      grid.append(
        el(
          "button",
          {
            class: "justified-item",
            style: `--r:${ratio.toFixed(3)}`,
            "aria-label": p.caption || "Åpne bilde",
            onclick: () => {
              slideshow.go(photos.indexOf(p));
              slideshow.enterFullscreen();
            },
          },
          el("img", { src: p.thumb, alt: p.caption || "", loading: "lazy", decoding: "async" }),
          p.caption ? el("span", { class: "justified-caption" }, p.caption) : null,
        ),
      );
    }
    grid.append(el("span", { class: "justified-filler" }));
    main.append(el("section", { class: "section" }, el("h2", { class: "section-title" }, "Høydepunkter"), grid));
  }

  if (photos.length) {
    main.append(slideSection);
    slideshow = createSlideshow(slideSection, photos);
  } else {
    main.append(el("p", { class: "muted center" }, "Dette albumet har ingen bilder ennå."));
  }
  window.scrollTo(0, 0);
}

function renderHeader(activeId) {
  const active = albums.find((a) => a.id === activeId);
  const panel = el("div", { class: "album-menu-panel", hidden: true });

  // Grupper album per år
  const byYear = new Map();
  for (const a of albums) {
    const year = (a.date || "").slice(0, 4) || "Uten dato";
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(a);
  }
  for (const [year, list] of byYear) {
    panel.append(el("p", { class: "menu-year" }, year));
    for (const a of list) {
      panel.append(
        el(
          "a",
          { href: `#/${a.id}`, class: `menu-item${a.id === activeId ? " is-active" : ""}`, onclick: () => closeMenu() },
          a.cover ? el("img", { src: a.cover, alt: "", loading: "lazy" }) : el("span", { class: "menu-thumb-empty" }, icon("image")),
          el("span", { class: "menu-item-text" }, el("strong", {}, a.title), el("small", {}, formatDate(a.date))),
        ),
      );
    }
  }

  const toggle = el(
    "button",
    { class: "album-menu-toggle", "aria-expanded": "false", "aria-haspopup": "true", onclick: () => (panel.hidden ? openMenu() : closeMenu()) },
    el("span", {}, active ? active.title : "Velg album"),
    icon("chevron"),
  );

  function onDocClick(e) {
    if (!menu.contains(e.target)) closeMenu();
  }
  function onKey(e) {
    if (e.key === "Escape") closeMenu();
  }
  function openMenu() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }
  function closeMenu() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  }

  const menu = el("div", { class: "album-menu" }, toggle, panel);

  return el(
    "header",
    { class: "site-header" },
    el("a", { class: "brand", href: "#" }, CONFIG.title),
    albums.length ? menu : el("span"),
    el(
      "button",
      {
        class: "btn-icon",
        title: "Logg ut",
        "aria-label": "Logg ut",
        onclick: () => {
          tokenStore.clear();
          showLogin();
        },
      },
      icon("logout"),
    ),
  );
}

// ---------------------------------------------------------------- lysbildefremvisning

function createSlideshow(container, photos) {
  let index = 0;
  let timer = null;
  const INTERVAL = 5000;

  const img = el("img", { class: "stage-img", alt: "" });
  const caption = el("p", { class: "stage-caption" });
  const counter = el("span", { class: "stage-counter" });
  const playBtn = el("button", { class: "btn-icon", "aria-label": "Spill av", onclick: () => togglePlay() }, icon("play"));
  const fsBtn = el("button", { class: "btn-icon", "aria-label": "Fullskjerm", onclick: () => toggleFullscreen() }, icon("expand"));

  const stage = el(
    "div",
    { class: "stage" },
    img,
    el("button", { class: "stage-nav prev", "aria-label": "Forrige", onclick: () => go(index - 1) }, icon("prev")),
    el("button", { class: "stage-nav next", "aria-label": "Neste", onclick: () => go(index + 1) }, icon("next")),
  );

  const strip = el("div", { class: "thumb-strip" });
  const thumbs = photos.map((p, i) =>
    el(
      "button",
      { class: "thumb", "aria-label": `Bilde ${i + 1}`, onclick: () => go(i) },
      el("img", { src: p.thumb, alt: "", loading: "lazy", decoding: "async" }),
    ),
  );
  strip.append(...thumbs);

  const root = el(
    "div",
    { class: "slideshow", tabindex: "0" },
    stage,
    el("div", { class: "stage-bar" }, counter, caption, el("div", { class: "stage-controls" }, playBtn, fsBtn)),
    strip,
  );
  container.append(root);

  // Sveip på mobil
  let startX = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") startX = e.clientX;
  });
  stage.addEventListener("pointerup", (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
  });

  function onKey(e) {
    if (e.target.closest("input, textarea")) return;
    const active = isFullscreen() || root.contains(document.activeElement) || isInView(root);
    if (!active) return;
    if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === " " && (isFullscreen() || root.contains(document.activeElement))) {
      e.preventDefault();
      togglePlay();
    } else if (e.key.toLowerCase() === "f") toggleFullscreen();
    else if (e.key === "Escape" && root.classList.contains("pseudo-fullscreen")) toggleFullscreen();
    else return;
  }
  document.addEventListener("keydown", onKey);

  function onFsChange() {
    updateFsButton();
  }
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  function go(i) {
    index = (i + photos.length) % photos.length;
    const p = photos[index];
    img.classList.remove("is-loaded");
    img.onload = () => img.classList.add("is-loaded");
    img.src = p.src;
    img.alt = p.caption || "";
    caption.textContent = p.caption || "";
    counter.textContent = `${index + 1} / ${photos.length}`;
    thumbs.forEach((t, j) => t.classList.toggle("is-active", j === index));
    const t = thumbs[index];
    strip.scrollTo({ left: t.offsetLeft - strip.clientWidth / 2 + t.clientWidth / 2, behavior: "smooth" });
    // Forhåndslast nabobildene
    for (const n of [index + 1, index - 1]) {
      const q = photos[(n + photos.length) % photos.length];
      new Image().src = q.src;
    }
    if (timer) restartTimer();
  }

  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(() => go(index + 1), INTERVAL);
  }

  function togglePlay() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    } else {
      restartTimer();
    }
    playBtn.replaceChildren(icon(timer ? "pause" : "play"));
    playBtn.setAttribute("aria-label", timer ? "Pause" : "Spill av");
    root.classList.toggle("is-playing", !!timer);
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement) || root.classList.contains("pseudo-fullscreen");
  }

  function enterFullscreen() {
    if (!isFullscreen()) toggleFullscreen();
  }

  function toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (root.classList.contains("pseudo-fullscreen")) {
      root.classList.remove("pseudo-fullscreen");
      document.body.classList.remove("no-scroll");
      updateFsButton();
    } else if (root.requestFullscreen) {
      root.requestFullscreen().catch(pseudoFullscreen);
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    } else {
      // iPhone støtter ikke ekte fullskjerm for elementer – bruk et overlegg i stedet
      pseudoFullscreen();
    }
    root.focus({ preventScroll: true });
  }

  function pseudoFullscreen() {
    root.classList.add("pseudo-fullscreen");
    document.body.classList.add("no-scroll");
    updateFsButton();
  }

  function updateFsButton() {
    const fs = isFullscreen();
    fsBtn.replaceChildren(icon(fs ? "shrink" : "expand"));
    fsBtn.setAttribute("aria-label", fs ? "Avslutt fullskjerm" : "Fullskjerm");
  }

  go(0);

  return {
    go,
    enterFullscreen,
    destroy() {
      clearInterval(timer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      document.body.classList.remove("no-scroll");
    },
  };
}

function isInView(node) {
  const r = node.getBoundingClientRect();
  return r.top < innerHeight * 0.6 && r.bottom > innerHeight * 0.4;
}
