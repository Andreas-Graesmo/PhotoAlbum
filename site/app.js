// Album-siden for besøkende.

const tokenStore = makeStore("album_token");
const app = document.getElementById("app");
document.title = CONFIG.title;
document.body.classList.add("journal");

let albums = [];
let slideshow = null;
const tv = createTvLink(() => tokenStore.get()); // fjernstyring av TV-siden (remote.js)

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
    const data = await api("/api/albums", { token });
    albums = data.albums;
    tv.supported = !!data.tv; // eldre versjoner av API-et har ikke visning på TV
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
  const cover = photos.find((p) => p.id === album.coverId) || highlights[0] || photos[0];

  const openPhoto = (p) => {
    slideshow.go(photos.indexOf(p));
    slideshow.enterFullscreen();
  };

  // Forside: stort bilde med tittel og datoer
  const hero = el(
    "section",
    { class: `hero${cover ? "" : " hero--plain"}` },
    cover ? el("img", { class: "hero-img", src: cover.src, alt: "", fetchpriority: "high" }) : null,
    el(
      "div",
      { class: "hero-text" },
      el("p", { class: "hero-dates hand" }, formatDateRange(album.date, album.dateEnd)),
      el("h1", { class: "hero-title" }, album.title),
      el("p", { class: "hero-count" }, `${photos.length} bilder`),
    ),
  );

  main.replaceChildren(hero);
  if (album.description) main.append(el("p", { class: "album-desc" }, album.description));

  // Høydepunkter: én rad per bilde, annenhver side, med tekst ved siden av
  if (highlights.length) {
    const list = el("div", { class: "stories" });
    highlights.forEach((p, i) => {
      const hasText = p.title || p.story;
      const portrait = p.w && p.h && p.h > p.w;
      list.append(
        el(
          "article",
          { class: `story${i % 2 ? " story--flip" : ""}${hasText ? "" : " story--solo"}${portrait ? " story--portrait" : ""}` },
          el(
            "button",
            { class: "polaroid", style: `--tilt:${tilt(i)}deg`, "aria-label": p.title || p.caption || "Åpne bilde", onclick: () => openPhoto(p) },
            el("img", {
              src: p.src,
              alt: p.caption || p.title || "",
              loading: "lazy",
              decoding: "async",
              width: p.w || null,
              height: p.h || null,
            }),
            p.caption ? el("span", { class: "polaroid-caption hand" }, p.caption) : null,
          ),
          hasText
            ? el(
                "div",
                { class: "story-text" },
                p.title ? el("h2", { class: "story-title hand" }, p.title) : null,
                ...(p.story || "")
                  .split(/\n{2,}/)
                  .filter((s) => s.trim())
                  .map((s) => el("p", {}, s.trim())),
              )
            : null,
        ),
      );
    });
    main.append(el("section", { class: "section" }, el("h2", { class: "section-title hand" }, "Høydepunkter"), list));
    revealOnScroll(list.children);
  }

  if (photos.length) {
    const slideSection = el("section", { class: "section", id: "lysbilder" }, el("h2", { class: "section-title hand" }, "Alle bilder"));
    main.append(slideSection);
    slideshow = createSlideshow(slideSection, photos, album);
  } else {
    main.append(el("p", { class: "muted center" }, "Dette albumet har ingen bilder ennå."));
  }
  window.scrollTo(0, 0);
}

/** Litt tilfeldig, men stabil, helning på polaroidene. */
function tilt(i) {
  const tilts = [-2.2, 1.8, -1.2, 2.4, -1.8, 1.1];
  return tilts[i % tilts.length];
}

function revealOnScroll(nodes) {
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  for (const n of nodes) {
    n.classList.add("reveal");
    io.observe(n);
  }
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
          el("span", { class: "menu-item-text" }, el("strong", {}, a.title), el("small", {}, formatDateRange(a.date, a.dateEnd))),
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

function createSlideshow(container, photos, album) {
  let index = 0;
  let timer = null;
  let idleTimer = null;
  let wakeLock = null;
  let wakeLockPending = false;
  let destroyed = false;
  let tvPlaying = false; // om TV-en blar automatisk (når mobilen er fjernkontroll)
  const INTERVAL = 5000;
  const IDLE_AFTER = 3000;

  const img = el("img", { class: "stage-img", alt: "" });
  const caption = el("p", { class: "stage-caption" });
  const counter = el("span", { class: "stage-counter" });
  const playBtn = el("button", { class: "btn-icon", "aria-label": "Spill av", onclick: () => togglePlay() }, icon("play"));
  const fsBtn = el("button", { class: "btn-icon", "aria-label": "Fullskjerm", onclick: () => toggleFullscreen() }, icon("expand"));
  const tvBtn = tv.supported
    ? el("button", { class: "btn-icon tv-btn", "aria-label": "Vis på TV", title: "Vis på TV", onclick: () => onTvClick() }, icon("tv"))
    : null;
  const tvStatus = el("p", { class: "tv-status", role: "status", hidden: true });

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
    tvStatus,
    stage,
    el("div", { class: "stage-bar" }, counter, caption, el("div", { class: "stage-controls" }, playBtn, tvBtn, fsBtn)),
    strip,
    el("p", { class: "rotate-hint" }, "Snu mobilen på siden for større bilder"),
  );
  container.append(root);

  // I fullskjerm skjules kontrollene etter litt, og kommer tilbake når man rører noe
  root.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") wake();
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest("button")) wake();
  });

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
    else if (Math.abs(dx) < 10 && isFullscreen() && !e.target.closest("button")) {
      // Trykk på bildet viser eller skjuler kontrollene
      if (root.classList.contains("is-idle")) wake();
      else goIdle();
    }
  });
  stage.addEventListener("pointercancel", () => {
    startX = null;
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
    wake();
  }
  document.addEventListener("keydown", onKey);

  function onFsChange() {
    const fs = isFullscreen();
    const leaving = !fs && root.classList.contains("is-fullscreen");
    root.classList.toggle("is-fullscreen", fs);
    if (fs) wake();
    else {
      clearTimeout(idleTimer);
      root.classList.remove("is-idle");
      // Automatisk blaing skal ikke fortsette i bakgrunnen etter fullskjerm
      if (leaving && timer) togglePlay();
    }
    fsBtn.replaceChildren(icon(fs ? "shrink" : "expand"));
    fsBtn.setAttribute("aria-label", fs ? "Avslutt fullskjerm" : "Fullskjerm");
    syncWakeLock();
  }
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  document.addEventListener("visibilitychange", syncWakeLock);

  function wake() {
    clearTimeout(idleTimer);
    root.classList.remove("is-idle");
    if (isFullscreen()) idleTimer = setTimeout(goIdle, IDLE_AFTER);
  }

  function goIdle() {
    clearTimeout(idleTimer);
    if (isFullscreen()) root.classList.add("is-idle");
  }

  /** Hindrer at skjermen slukker (og TV-speilingen stopper) under fullskjerm og avspilling. */
  async function syncWakeLock() {
    if (!navigator.wakeLock || wakeLockPending) return;
    const want = () => !destroyed && (isFullscreen() || !!timer) && document.visibilityState === "visible";
    if (want() && !wakeLock) {
      wakeLockPending = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
        wakeLock = lock;
      } catch {
        /* f.eks. lav batteri – da slukker skjermen som vanlig */
      }
      wakeLockPending = false;
      if (!want()) syncWakeLock();
    } else if (!want() && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  function go(i, fromTv = false) {
    index = (i + photos.length) % photos.length;
    const p = photos[index];
    img.classList.remove("is-loaded");
    img.onload = () => img.classList.add("is-loaded");
    img.src = p.src;
    img.alt = p.caption || "";
    caption.textContent = p.caption || "";
    root.classList.toggle("has-caption", !!p.caption);
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
    if (!fromTv && tv.status === "on") tv.go(index);
  }

  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(() => go(index + 1), INTERVAL);
  }

  function togglePlay() {
    if (tv.active) {
      // Mobilen er fjernkontroll: det er TV-en som blar, og den svarer med ny status
      if (tv.status === "on") tv.play(!tvPlaying);
      return;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    } else {
      restartTimer();
    }
    showPlaying(!!timer);
    syncWakeLock();
  }

  function showPlaying(on) {
    playBtn.replaceChildren(icon(on ? "pause" : "play"));
    playBtn.setAttribute("aria-label", on ? "Pause" : "Spill av");
    root.classList.toggle("is-playing", on);
  }

  // ---- Visning på TV: denne fremvisningen er fjernkontroll så lenge en TV er koblet til

  const TV_STATUS = { connecting: "Kobler til TV-en …", on: "Viser på TV-en", lost: "Får ikke kontakt med TV-en …" };

  const tvTarget = {
    albumId: album.id,
    title: album.title,
    photos,
    getIndex: () => index,
    onState({ index: i, playing }) {
      if (i != null && i !== index && i >= 0 && i < photos.length) go(i, true);
      tvPlaying = playing;
      showPlaying(playing);
    },
    onStatus(status) {
      const remote = status !== "off";
      if (remote && timer) {
        clearInterval(timer);
        timer = null;
        syncWakeLock();
      }
      if (status !== "on") tvPlaying = false;
      showPlaying(remote ? tvPlaying : !!timer);
      root.classList.toggle("is-remote", remote);
      tvStatus.hidden = !remote;
      tvStatus.textContent = TV_STATUS[status] || "";
      tvBtn?.setAttribute("aria-label", remote ? "Koble fra TV-en" : "Vis på TV");
      tvBtn?.setAttribute("title", remote ? "Koble fra TV-en" : "Vis på TV");
    },
  };

  function onTvClick() {
    if (!tv.active) openTvDialog(tv);
    else if (confirm("Koble fra TV-en?")) tv.disconnect();
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
      onFsChange();
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
    onFsChange();
  }

  go(0, true); // ikke flytt TV-en hvis den allerede viser dette albumet
  tv.attach(tvTarget);

  return {
    go,
    enterFullscreen,
    destroy() {
      clearInterval(timer);
      clearTimeout(idleTimer);
      destroyed = true;
      tv.detach(tvTarget);
      syncWakeLock();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      document.removeEventListener("visibilitychange", syncWakeLock);
      document.body.classList.remove("no-scroll");
    },
  };
}

function isInView(node) {
  const r = node.getBoundingClientRect();
  return r.top < innerHeight * 0.6 && r.bottom > innerHeight * 0.4;
}
