// Innstillinger for nettsiden. Bytt ut apiUrl med adressen til din Cloudflare Worker
// (du får den når du kjører `npx wrangler deploy` i worker-mappen).
window.ALBUM_CONFIG = {
  title: "Fotoalbum",
  apiUrl: ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://localhost:8787"
    : "https://photo-album-api.graesmo.workers.dev",
};
