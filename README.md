# Anna's Archive & TorBox 1-Click Reader for Compass / Harbor

Custom eBook source extension and serverless reader bridge for [Compass](https://github.com/ShroomSn00t/AnnasArchiveBruh). Enables searching and reading shadow library & TorBox books in 1-click directly inside the app's reader.

---

## ⚡ 1-Click Reading Setup (Cloudflare Worker)

Because Compass's sandbox cannot decompress multi-megabyte binary ZIPs in JavaScript on mobile or desktop, this repo includes a lightweight **Serverless Cloud Bridge** (`worker.js`):

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) (Free, no credit card needed).
2. Go to **Workers & Pages** -> **Create Worker**.
3. Name it `annas-archive-bridge`.
4. Copy and paste the entire code from [`worker.js`](./worker.js).
5. Click **Deploy**.
6. Copy your free Worker URL (e.g. `https://annas-archive-bridge.<your-name>.workers.dev`).
7. Paste it into line 17 of [`annas-archive.plugin.js`](./annas-archive.plugin.js):
   ```javascript
   const BRIDGE_URL = "https://annas-archive-bridge.<your-name>.workers.dev";
   ```
8. Commit & push!

*(Alternatively, to run locally on your PC, simply run `node worker.js` and keep `BRIDGE_URL = "http://localhost:3000"`).*

---

## 🚀 How to Install in Compass / Harbor

1. Open **Compass** or **Harbor**.
2. Navigate to **Extensions** / **Sources** -> **Add Repository**.
3. Paste the following URL:
   ```text
   https://raw.githubusercontent.com/ShroomSn00t/AnnasArchiveBruh/main/repo.json
   ```
4. Click **Install** / **Update** next to **Anna's Archive (1-Click TorBox Reader)**.

---

## ✨ Features

- **1-Click Chapter Reading**: Instantly streams clean prose text and real book chapters.
- **TorBox WebDL Integration**: Uses your TorBox Pro API key for high-speed book downloads.
- **Shadow Library Support**: Integrates Anna's Archive, Libgen, OpenLibrary, and Internet Archive.
- **Zero In-App Clutter**: No external links or browser buttons required.
