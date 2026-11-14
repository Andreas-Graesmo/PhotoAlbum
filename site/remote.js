// Fjernkontroll for visning på TV (se tv.html og TvRoom i Workeren).
// Mobilen sender albumet og kommandoer til TV-en, og TV-en svarer med hva den viser akkurat nå.

function createTvLink(getToken) {
  const STORE_KEY = "tv_session";
  const CHUNK = 150; // bilder per melding, så ingen melding blir for stor
  let session = loadSession(); // { code, ticket }
  let ws = null;
  let status = "off"; // off | connecting | on | lost
  let target = null; // lysbildefremvisningen som styrer TV-en
  let tvState = null; // siste melding om hva TV-en viser
  let sentAlbum = null; // { id, at }
  let lastGoAt = 0;
  let retryTimer = null;
  let pingTimer = null;

  function loadSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE_KEY));
      return s && s.code && s.ticket ? s : null;
    } catch {
      return null;
    }
  }

  function saveSession() {
    try {
      if (session) sessionStorage.setItem(STORE_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(STORE_KEY);
    } catch {
      /* privat modus e.l. */
    }
  }

  function setStatus(next) {
    status = next;
    target?.onStatus(status);
  }

  function open() {
    clearTimeout(retryTimer);
    if (ws || !session) return;
    if (status === "off") setStatus("connecting");
    const url = `${CONFIG.apiUrl.replace(/^http/, "ws")}/api/tv/ws?role=remote&code=${session.code}&secret=${session.ticket}`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      clearInterval(pingTimer);
      pingTimer = setInterval(() => socket.readyState === 1 && socket.send("ping"), 25000);
    };
    socket.onmessage = (e) => {
      if (ws !== socket || e.data === "pong") return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "presence" && !msg.tv) {
        tvState = null;
        setStatus("lost");
      } else if (msg.type === "state") {
        tvState = msg;
        if (status !== "on") setStatus("on");
        sync();
      }
    };
    socket.onclose = (e) => {
      if (ws !== socket) return;
      ws = null;
      clearInterval(pingTimer);
      if (!session) return;
      if (e.code === 4001) {
        // TV-en har fått ny kode eller er slått av
        forget();
        setStatus("off");
        return;
      }
      setStatus("lost");
      if (document.visibilityState === "visible") retryTimer = setTimeout(open, 2000);
    };
  }

  function forget() {
    session = null;
    tvState = null;
    sentAlbum = null;
    saveSession();
    clearTimeout(retryTimer);
  }

  function send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }

  /** Sørger for at TV-en viser samme album som mobilen, og at mobilen følger TV-en ellers. */
  function sync() {
    if (!target || !tvState || status !== "on") return;
    if (tvState.albumId !== target.albumId) {
      const justSent = sentAlbum && sentAlbum.id === target.albumId && Date.now() - sentAlbum.at < 3000;
      if (!justSent) sendAlbum();
      return;
    }
    // Rett etter at mobilen selv har bladd, kan en eldre melding fra TV-en være på vei
    const recentGo = Date.now() - lastGoAt < 800;
    target.onState({ index: recentGo ? null : tvState.index, playing: !!tvState.playing });
  }

  function sendAlbum() {
    const { albumId, title, photos } = target;
    sentAlbum = { id: albumId, at: Date.now() };
    send({ type: "album", id: albumId, title, total: photos.length, index: target.getIndex() });
    for (let offset = 0; offset < photos.length; offset += CHUNK) {
      const items = photos.slice(offset, offset + CHUNK).map((p) => ({ src: p.src, caption: p.caption || "" }));
      send({ type: "photos", id: albumId, offset, items });
    }
  }

  document.addEventListener("visibilitychange", () => {
    // Mobilen har vært låst eller i bakgrunnen: koble til igjen
    if (document.visibilityState === "visible" && session && !ws) open();
  });

  if (session) open();

  return {
    /** Settes når API-et forteller at det støtter visning på TV. */
    supported: false,
    get status() {
      return status;
    },
    get active() {
      return status !== "off";
    },
    /** Kobler til TV-en som viser denne koden. Kaster ApiError hvis koden er feil. */
    async connect(code) {
      const { ticket } = await api("/api/tv/pair", { method: "POST", token: getToken(), body: { code } });
      const old = ws;
      ws = null;
      old?.close();
      forget();
      session = { code, ticket };
      saveSession();
      status = "off";
      open();
    },
    disconnect() {
      send({ type: "bye" });
      const old = ws;
      ws = null;
      old?.close();
      clearInterval(pingTimer);
      forget();
      setStatus("off");
    },
    attach(t) {
      target = t;
      t.onStatus(status);
      sync();
    },
    detach(t) {
      if (target === t) target = null;
    },
    go(index) {
      lastGoAt = Date.now();
      send({ type: "go", index });
    },
    play(on) {
      send({ type: "play", on });
    },
  };
}

/** Dialogen der man skriver inn koden som står på TV-en. */
function openTvDialog(link) {
  const address = `${location.host}${location.pathname.replace(/[^/]*$/, "")}tv.html`;
  const input = el("input", {
    type: "text",
    name: "tv-code",
    inputmode: "numeric",
    pattern: "[0-9]*",
    maxlength: "4",
    autocomplete: "off",
    placeholder: "0000",
    "aria-label": "Koden på TV-en",
    required: true,
  });
  const error = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { class: "btn btn-primary", type: "submit" }, "Koble til");

  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const form = el(
    "form",
    {
      class: "tv-dialog",
      onsubmit: async (e) => {
        e.preventDefault();
        const code = input.value.replace(/\D/g, "");
        if (code.length !== 4) {
          error.textContent = "Koden har fire sifre";
          return;
        }
        error.textContent = "";
        submit.disabled = true;
        try {
          await link.connect(code);
          close();
        } catch (err) {
          error.textContent = err.message;
          input.select();
        } finally {
          submit.disabled = false;
        }
      },
    },
    el("h2", { class: "hand" }, "Vis på TV"),
    el(
      "ol",
      {},
      el("li", {}, "Åpne nettleseren på TV-en og gå til ", el("strong", { class: "tv-address" }, address)),
      el("li", {}, "Skriv inn koden som står på TV-skjermen"),
    ),
    input,
    error,
    el("div", { class: "tv-dialog-actions" }, el("button", { class: "btn", type: "button", onclick: close }, "Avbryt"), submit),
  );
  const backdrop = el(
    "div",
    {
      class: "tv-dialog-backdrop",
      onclick: (e) => {
        if (e.target === backdrop) close();
      },
    },
    form,
  );
  document.addEventListener("keydown", onKey);
  // Inne i fullskjerm må dialogen ligge i fullskjerm-elementet for å synes
  (document.fullscreenElement || document.webkitFullscreenElement || document.body).append(backdrop);
  input.focus();
}
