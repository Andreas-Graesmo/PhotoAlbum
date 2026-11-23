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

/**
 * Temaene et album kan vises med. Det første er standard. Fargene og skriftene ligger i
 * styles.css under [data-theme="<id>"]; her står bare det JavaScript trenger.
 *   color – bakgrunnsfargen (brukes til nettleserens verktøylinje)
 *   fonts – skrifter som hentes fra Google Fonts når temaet er i bruk
 */
const THEMES = [
  { id: "reisedagbok", name: "Reisedagbok", color: "#f5eddf", fonts: "family=Caveat:wght@500;700" },
  { id: "storby", name: "Storby", color: "#14161b", fonts: "family=Bebas+Neue" },
  { id: "strand", name: "Sol og strand", color: "#fdf3dc", fonts: "family=Pacifico&family=Nunito:wght@400;800" },
  { id: "tropisk", name: "Tropisk", color: "#f3f1df", fonts: "family=Shrikhand&family=Rubik:wght@400;800" },
  { id: "middelhav", name: "Middelhavet", color: "#fbf6ec", fonts: "family=Courgette&family=DM+Serif+Display&family=Lora:ital,wght@0,400;1,400" },
  { id: "safari", name: "Ørken og safari", color: "#f3e6cf", fonts: "family=Alfa+Slab+One&family=Zilla+Slab:wght@400;700" },
  { id: "fjell", name: "Fjell og hytte", color: "#e8ebe2", fonts: "family=Amatic+SC:wght@700&family=Bitter:wght@400;700" },
  { id: "sjo", name: "Sjø og båt", color: "#f7f5ef", fonts: "family=Oswald:wght@500&family=Abril+Fatface" },
  { id: "vinter", name: "Vinter", color: "#eaf2f8", fonts: "family=Josefin+Sans:wght@300;600" },
  { id: "nordlys", name: "Natt og nordlys", color: "#071a22", fonts: "family=Marcellus&family=Spectral:ital,wght@0,300;0,400;1,300;1,400" },
  { id: "host", name: "Høst", color: "#f2e6d6", fonts: "family=Kalam:wght@700&family=Young+Serif" },
  { id: "var", name: "Vår og påske", color: "#fbf9ee", fonts: "family=Dancing+Script:wght@700&family=Quicksand:wght@500;700" },
  { id: "jul", name: "Jul", color: "#123a2e", fonts: "family=Mountains+of+Christmas:wght@700" },
  { id: "syttende-mai", name: "17. mai", color: "#fbfaf7", fonts: "family=Bungee&family=Bricolage+Grotesque:opsz,wght@12..96,700" },
  { id: "bryllup", name: "Bryllup og fest", color: "#fbf6f2", fonts: "family=Great+Vibes&family=Cormorant+Garamond:ital,wght@0,500;1,500" },
  { id: "bursdag", name: "Bursdag", color: "#fff7ec", fonts: "family=Fredoka:wght@500;700" },
  { id: "barn", name: "Barn og familie", color: "#fffdf6", fonts: "family=Gaegu:wght@700&family=Baloo+2:wght@500;800" },
  { id: "festival", name: "Festival og konsert", color: "#0b0a12", fonts: "family=Rubik+Mono+One&family=Rubik:wght@400;800" },
  { id: "nostalgi", name: "Gamle dager", color: "#1b1917", fonts: "family=Special+Elite&family=Playfair+Display:wght@700" },
  { id: "galleri", name: "Galleri", color: "#ffffff" },
];

function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

function loadThemeFonts(theme) {
  const id = `theme-fonts-${theme.id}`;
  if (!theme.fonts || document.getElementById(id)) return;
  document.head.append(el("link", { id, rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${theme.fonts}&display=swap` }));
}

/** Setter utseendet på hele siden. Ukjent eller manglende tema gir standardtemaet. */
function applyTheme(id) {
  const theme = themeById(id);
  if (theme !== THEMES[0]) loadThemeFonts(theme); // standardtemaets skrifter ligger alt i index.html
  document.body.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.color);
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
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a5.5 5.5 0 013.5 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
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

/**
 * Forsidebildet får rammen til bildets egen form (liggende eller stående), men aldri høyere enn
 * skjermen. Blir bildet likevel mye beskåret (f.eks. stående bilde på PC), vises hele bildet med en
 * uskarp kopi av det bak. Svarer «cover» (fyll rammen) eller «contain» (vis hele bildet).
 */
function heroFit(frameRatio, photoRatio) {
  const crop = 1 - Math.min(frameRatio / photoRatio, photoRatio / frameRatio);
  return crop > 0.25 ? "contain" : "cover";
}

function photoRatio(p) {
  return p && p.w && p.h ? p.w / p.h : 1.6;
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
