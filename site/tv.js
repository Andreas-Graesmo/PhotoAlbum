// TV-siden: viser en kode, og deretter bildene mobilen ber om.
// Skrevet i gammeldags JavaScript (ES5) med vilje, siden nettleserne på TV-er ofte er gamle.
(function () {
  "use strict";

  var CONFIG = window.ALBUM_CONFIG;
  var INTERVAL = 5000; // automatisk blaing
  var PHOTO_TIMEOUT = 20000;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var pairScreen = $("pair");
  var showScreen = $("show");
  var codeEl = $("code");
  var statusEl = $("pair-status");
  var captionEl = $("caption");
  var noticeEl = $("notice");
  var layers = [$("img-a"), $("img-b")];
  var front = 0;

  $("pair-title").textContent = CONFIG.title;
  document.title = CONFIG.title + " på TV";

  var room = null; // { code, key }
  var ws = null;
  var pingTimer = null;
  var album = null; // { id, title, total, photos: [{ src, caption }] }
  var index = 0;
  var shown = -1;
  var playing = false;
  var playTimer = null;
  var loadToken = 0;

  try {
    room = JSON.parse(sessionStorage.getItem("tv_room"));
  } catch (e) {
    room = null;
  }

  if (room && room.code && room.key) connect();
  else newRoom();

  // ---------------------------------------------------------------- rom og forbindelse

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function saveRoom() {
    try {
      if (room) sessionStorage.setItem("tv_room", JSON.stringify(room));
      else sessionStorage.removeItem("tv_room");
    } catch (e) {
      /* privat modus e.l. */
    }
  }

  function request(method, path, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, CONFIG.apiUrl + path);
    xhr.onload = function () {
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        /* tomt svar */
      }
      done(xhr.status, data);
    };
    xhr.onerror = function () {
      done(0, null);
    };
    xhr.send();
  }

  function newRoom() {
    room = null;
    saveRoom();
    codeEl.textContent = "····";
    setStatus("Henter kode …");
    request("POST", "/api/tv/rooms", function (status, data) {
      if (status === 201 && data && data.code) {
        room = { code: data.code, key: data.key };
        saveRoom();
        connect();
      } else if (status === 401 || status === 404) {
        setStatus("Visning på TV er ikke slått på for dette albumet ennå.");
      } else {
        setStatus("Får ikke kontakt med serveren. Prøver igjen …");
        setTimeout(newRoom, 5000);
      }
    });
  }

  function connect() {
    var url = CONFIG.apiUrl.replace(/^http/, "ws") + "/api/tv/ws?role=tv&code=" + room.code + "&secret=" + room.key;
    var socket = new WebSocket(url);
    ws = socket;
    socket.onopen = function () {
      if (ws !== socket) return;
      codeEl.textContent = room.code;
      setStatus(album ? "" : "Venter på mobilen …");
      clearInterval(pingTimer);
      pingTimer = setInterval(function () {
        if (socket.readyState === 1) socket.send("ping");
      }, 25000);
    };
    socket.onmessage = function (e) {
      if (ws !== socket || e.data === "pong") return;
      var msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      handle(msg);
    };
    socket.onclose = function (e) {
      if (ws !== socket) return;
      ws = null;
      clearInterval(pingTimer);
      if (e.code === 4001) {
        // Rommet finnes ikke lenger – start på nytt med ny kode
        reset();
        newRoom();
      } else if (e.code === 4002) {
        setStatus("Albumet er åpnet i en annen fane på denne TV-en.");
      } else {
        if (!album) setStatus("Mistet kontakten. Kobler til igjen …");
        setTimeout(function () {
          if (!ws && room) connect();
        }, 2000);
      }
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function sendState() {
    send({ type: "state", albumId: album ? album.id : null, index: index, playing: playing });
  }

  // ---------------------------------------------------------------- meldinger fra mobilen

  function handle(msg) {
    if (msg.type === "presence") {
      if (msg.remotes > 0) sendState();
      if (!album) setStatus(msg.remotes > 0 ? "Mobilen er koblet til …" : "Venter på mobilen …");
    } else if (msg.type === "album") {
      setPlaying(false);
      album = { id: msg.id, title: msg.title || "", total: msg.total | 0, photos: [] };
      index = clampIndex(msg.index);
      shown = -1;
      pairScreen.hidden = true;
      showScreen.hidden = false;
      noticeEl.textContent = album.total ? "Laster bilder …" : "Albumet er tomt";
      sendState();
    } else if (msg.type === "photos") {
      if (!album || msg.id !== album.id || !msg.items) return;
      for (var i = 0; i < msg.items.length; i++) album.photos[msg.offset + i] = msg.items[i];
      render();
    } else if (msg.type === "go") {
      if (!album) return;
      index = clampIndex(msg.index);
      render();
      if (playing) restartTimer();
      sendState();
    } else if (msg.type === "play") {
      if (!album) return;
      setPlaying(!!msg.on);
      sendState();
    } else if (msg.type === "bye") {
      // Mobilen koblet fra med vilje: glem albumet og vis en ny kode
      var old = ws;
      ws = null;
      if (old) old.close();
      clearInterval(pingTimer);
      reset();
      newRoom();
    }
  }

  function reset() {
    setPlaying(false);
    album = null;
    index = 0;
    shown = -1;
    loadToken++;
    for (var i = 0; i < layers.length; i++) {
      layers[i].className = "photo";
      layers[i].removeAttribute("src");
    }
    captionEl.textContent = "";
    noticeEl.textContent = "";
    showScreen.hidden = true;
    pairScreen.hidden = false;
  }

  function clampIndex(i) {
    var total = album ? album.total : 0;
    i = i | 0;
    if (!total) return 0;
    return ((i % total) + total) % total;
  }

  // ---------------------------------------------------------------- visning

  function render() {
    if (!album || shown === index) return;
    var photo = album.photos[index];
    if (!photo) return; // bildelisten er ikke kommet frem ennå
    shown = index;
    var token = ++loadToken;
    var next = layers[1 - front];
    var done = false;
    var timeout = setTimeout(finish, PHOTO_TIMEOUT);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (token !== loadToken) return; // et nyere bilde er på vei
      noticeEl.textContent = "";
      captionEl.textContent = photo.caption || "";
      layers[front].className = "photo";
      next.className = "photo is-visible";
      front = 1 - front;
      preload(index + 1);
    }

    next.onload = finish;
    next.onerror = finish;
    next.src = photo.src;
  }

  function preload(i) {
    var photo = album && album.photos[clampIndex(i)];
    if (photo) new Image().src = photo.src;
  }

  function setPlaying(on) {
    playing = on;
    clearInterval(playTimer);
    playTimer = null;
    if (on) restartTimer();
    keepAwake();
  }

  function restartTimer() {
    clearInterval(playTimer);
    playTimer = setInterval(function () {
      if (!album || !album.total) return;
      index = clampIndex(index + 1);
      render();
      sendState();
    }, INTERVAL);
  }

  // ---------------------------------------------------------------- TV-ens egen fjernkontroll

  document.addEventListener("keydown", function (e) {
    if (!album) return;
    var key = e.keyCode;
    if (key === 39 || key === 37) {
      index = clampIndex(index + (key === 39 ? 1 : -1));
      render();
      if (playing) restartTimer();
    } else if (key === 13 || key === 32 || key === 415 || key === 19 || key === 10252) {
      // OK, mellomrom og avspill/pause-knappene på Samsung-fjernkontroller
      setPlaying(key === 415 ? true : key === 19 ? false : !playing);
    } else {
      return;
    }
    e.preventDefault();
    sendState();
  });

  // ---------------------------------------------------------------- hold skjermen våken

  var wakeLock = null;
  function keepAwake() {
    if (!navigator.wakeLock || wakeLock || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(
      function (lock) {
        wakeLock = lock;
        lock.addEventListener("release", function () {
          wakeLock = null;
        });
      },
      function () {
        /* ikke støttet eller ikke tillatt – da gjelder TV-ens egne innstillinger */
      }
    );
  }
  document.addEventListener("visibilitychange", keepAwake);
  keepAwake();
})();
