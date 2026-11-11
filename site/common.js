// Felles hjelpefunksjoner for album- og admin-siden.

const CONFIG = window.ALBUM_CONFIG;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function makeStore(key) {
  return {
    get() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* privat modus e.l. */
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignorer */
      }
    },
  };
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(CONFIG.apiUrl + path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Får ikke kontakt med serveren");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* tomt svar */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Feil (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const ICONS = {
  prev: '<path d="M15 18l-6-6 6-6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
};

function icon(name) {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" });
}

/** «3.–17. november 2026», «28. oktober – 5. november 2026» eller «28. des. 2025 – 3. jan. 2026». */
function formatDateRange(from, to) {
  if (!to || to <= from) return formatDate(from);
  const a = new Date(`${from}T12:00:00`);
  const b = new Date(`${to}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return formatDate(from);
  const month = (d) => d.toLocaleDateString("nb-NO", { month: "long" });
  if (a.getFullYear() !== b.getFullYear()) {
    const opts = { day: "numeric", month: "short", year: "numeric" };
    return `${a.toLocaleDateString("nb-NO", opts)} – ${b.toLocaleDateString("nb-NO", opts)}`;
  }
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}.–${b.getDate()}. ${month(b)} ${b.getFullYear()}`;
  return `${a.getDate()}. ${month(a)} – ${b.getDate()}. ${month(b)} ${b.getFullYear()}`;
}

/** Viser et innloggingsskjema og kaller onLogin(token, role) ved riktig passord. */
function renderLogin(root, { heading, hint, requireRole, onLogin }) {
  const input = el("input", {
    type: "password",
    name: "password",
    autocomplete: "current-password",
    placeholder: "Passord",
    required: true,
    autofocus: true,
  });
  const error = el("p", { class: "form-error", role: "alert" });
  const button = el("button", { class: "btn btn-primary", type: "submit" }, "Logg inn");
  const form = el(
    "form",
    {
      class: "login-card",
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        button.disabled = true;
        try {
          const { token, role } = await api("/api/login", {
            method: "POST",
            body: { password: input.value },
          });
          if (requireRole && role !== requireRole) throw new ApiError(403, "Dette passordet gir ikke admin-tilgang");
          onLogin(token, role);
        } catch (err) {
          error.textContent = err.message;
          input.select();
        } finally {
          button.disabled = false;
        }
      },
    },
    el("h1", {}, heading),
    hint ? el("p", { class: "muted" }, hint) : null,
    input,
    button,
    error,
  );
  root.replaceChildren(el("main", { class: "login-wrap" }, form));
  input.focus();
}
