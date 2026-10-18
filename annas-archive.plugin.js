// Compass & Harbor eBook Source Plugin: Anna's Archive & Shadow Libraries
//
// 1-Click in-app reader: Integrates with TorBox + Anna's Archive Serverless Bridge
// and Open Libraries for instant chapter listing and full story text reading.

// =============================================================================
// 🔑 CONFIGURATION
// =============================================================================
// Hardcoded TorBox API Key
const TORBOX_API_KEY = "265cd0c5-9953-4505-b9cc-0fc071c58b67";

// Serverless / Local Reader Bridge URL (Default: localhost:3000 or your Cloudflare Worker)
// Set this to your deployed Cloudflare Worker URL (e.g., https://your-worker.workers.dev)
// to read from ANY device (mobile, tablet, PC).
const BRIDGE_URL = "http://localhost:3000";

const bridge =
  typeof compass !== "undefined"
    ? compass
    : typeof harbor !== "undefined"
      ? harbor
      : (typeof globalThis !== "undefined" ? (globalThis.compass || globalThis.harbor) : null);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// In-memory cache for parsed content: id -> string
const textCache = new Map();

function cleanText(str) {
  return (str || "")
    .replace(/[^\p{L}\p{N}\s',.\-_:;!?()/[\]]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCoverUrl(coverId) {
  if (!coverId) return undefined;
  if (typeof coverId === "string" && /^https?:\/\//i.test(coverId)) return coverId;
  return "https://covers.openlibrary.org/b/id/" + coverId + "-L.jpg";
}

// Safe OpenLibrary JSON search
async function queryOpenLibrary(path) {
  if (!bridge) return null;
  try {
    const res = await bridge.http("https://openlibrary.org" + path, {
      method: "GET",
      headers: HEADERS,
      responseType: "json",
      timeoutMs: 15000,
    });
    if (res && typeof res === "object" && !res.body) return res;
    if (res && res.body) {
      try {
        return JSON.parse(res.body);
      } catch {}
    }
    return res;
  } catch {
    return null;
  }
}

function mapOpenLibraryDocs(docs) {
  if (!Array.isArray(docs)) return [];
  return docs
    .map((doc) => {
      const title = cleanText(doc.title);
      if (!title) return null;
      const key = (doc.key || "").replace(/^\/works\//, "");
      const author = Array.isArray(doc.author_name)
        ? doc.author_name[0]
        : typeof doc.author_name === "string"
          ? doc.author_name
          : undefined;
      const isbn = Array.isArray(doc.isbn) ? doc.isbn[0] : undefined;
      const cover = buildCoverUrl(doc.cover_i || (doc.cover_id ? doc.cover_id : undefined));
      const ia = Array.isArray(doc.ia) && doc.ia[0] ? doc.ia[0] : undefined;

      const id =
        "ol:" +
        (key || "item") +
        (isbn ? ":isbn:" + isbn : "") +
        (ia ? ":ia:" + ia : "") +
        ":t:" +
        encodeURIComponent(title);

      return {
        id,
        title,
        cover,
        author,
        authors: author ? [author] : [],
        description: doc.first_sentence ? doc.first_sentence[0] : undefined,
        genres: Array.isArray(doc.subject) ? doc.subject.slice(0, 4) : ["eBook"],
        isbn,
        year: typeof doc.first_publish_year === "number" ? doc.first_publish_year : undefined,
      };
    })
    .filter(Boolean);
}

const plugin = {
  id: "annas-archive",
  name: "Anna's Archive",

  async popular(offset, tagId) {
    const page = Math.floor((offset || 0) / 30) + 1;

    if (page === 1) {
      const trendingData = await queryOpenLibrary("/trending/daily.json");
      if (trendingData && Array.isArray(trendingData.works) && trendingData.works.length > 0) {
        return mapOpenLibraryDocs(trendingData.works.slice(0, 48));
      }
    }

    let subject = "bestsellers";
    if (tagId) {
      if (tagId.includes("fiction")) subject = "fiction";
      else if (tagId.includes("comic")) subject = "comic_books";
      else if (tagId.includes("nonfiction")) subject = "history";
    }

    const subjectData = await queryOpenLibrary(
      "/subjects/" + subject + ".json?limit=36&offset=" + (page - 1) * 36
    );
    if (subjectData && Array.isArray(subjectData.works) && subjectData.works.length > 0) {
      return mapOpenLibraryDocs(subjectData.works);
    }

    const fallbackData = await queryOpenLibrary(
      "/search.json?q=bestseller&page=" + page + "&limit=30"
    );
    if (fallbackData && Array.isArray(fallbackData.docs)) {
      return mapOpenLibraryDocs(fallbackData.docs);
    }

    return [];
  },

  async search(query, offset, tagId) {
    const trimmed = cleanText(query);
    if (!trimmed) return this.popular(offset, tagId);

    const page = Math.floor((offset || 0) / 25) + 1;
    const olQuery =
      "/search.json?q=" + encodeURIComponent(trimmed) + "&page=" + page + "&limit=25";
    const olData = await queryOpenLibrary(olQuery).catch(() => null);
    if (olData && Array.isArray(olData.docs) && olData.docs.length > 0) {
      return mapOpenLibraryDocs(olData.docs);
    }

    return [];
  },

  async detail(id) {
    let title = "";
    let author = "";
    let isbn = "";
    let cover;
    let description = "";
    let year;

    if (id.startsWith("ol:")) {
      const parts = id.split(":");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "isbn" && parts[i + 1]) isbn = parts[i + 1];
        if (parts[i] === "t" && parts[i + 1]) title = decodeURIComponent(parts[i + 1]);
      }
      const workId = parts[1];
      if (workId && workId !== "item") {
        const workData = await queryOpenLibrary("/works/" + workId + ".json");
        if (workData) {
          if (!title && workData.title) title = cleanText(workData.title);
          if (workData.description) {
            description =
              typeof workData.description === "string"
                ? workData.description
                : workData.description.value || "";
          }
          if (Array.isArray(workData.covers) && workData.covers[0]) {
            cover = buildCoverUrl(workData.covers[0]);
          }
        }
      }
    }

    if (!title) title = cleanText(id);

    return {
      id,
      title,
      cover,
      author,
      authors: author ? [author] : [],
      description:
        description || "Read " + title + " in 1-click directly in Compass.",
      isbn,
      year,
      originalLanguage: "en",
      genres: ["eBook", "Anna's Archive"],
      siteUrl: "https://annas-archive.gl/search?q=" + encodeURIComponent(isbn || title),
    };
  },

  async chapters(id) {
    let title = "";
    let isbn = "";
    let iaId = "";

    if (id.startsWith("ol:")) {
      const parts = id.split(":");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "isbn" && parts[i + 1]) isbn = parts[i + 1];
        if (parts[i] === "ia" && parts[i + 1]) iaId = parts[i + 1];
        if (parts[i] === "t" && parts[i + 1]) title = decodeURIComponent(parts[i + 1]);
      }
    }
    if (!title) title = id;

    // 1. Try Reader Bridge (Cloudflare Worker or Local Node daemon)
    // The Bridge resolves TorBox / Anna's Archive / Libgen in 200ms and returns real chapters!
    if (BRIDGE_URL) {
      try {
        const qUrl =
          BRIDGE_URL +
          "/api/chapters?q=" +
          encodeURIComponent(isbn || title) +
          "&title=" +
          encodeURIComponent(title) +
          (isbn ? "&isbn=" + encodeURIComponent(isbn) : "") +
          (iaId ? "&ia=" + encodeURIComponent(iaId) : "");

        const res = await bridge.http(qUrl, {
          method: "GET",
          headers: HEADERS,
          responseType: "json",
          timeoutMs: 15000,
        });

        const data = res?.body || res;
        if (data && data.success && Array.isArray(data.chapters) && data.chapters.length > 0) {
          return data.chapters.map((c) => ({
            id: id + "::bridge::" + encodeURIComponent(data.bookKey) + "::" + c.id,
            title: c.title,
            position: c.position,
            language: "en",
          }));
        }
      } catch (err) {
        // Bridge unreachable or still starting, fall back below
      }
    }

    // 2. Direct Gutenberg Online HTML Chapters (for classics / open books)
    try {
      const gUrl = "https://www.gutenberg.org/ebooks/search/?query=" + encodeURIComponent(title);
      const gRes = await bridge.http(gUrl, { method: "GET", headers: HEADERS, responseType: "text" });
      const gHtml = gRes?.body || (typeof gRes === "string" ? gRes : "");
      const bookMatch = gHtml.match(/\/ebooks\/(\d+)/);
      if (bookMatch) {
        const bookGutenId = bookMatch[1];
        const readUrl = "https://www.gutenberg.org/files/" + bookGutenId + "/" + bookGutenId + "-h/" + bookGutenId + "-h.htm";
        const readRes = await bridge.http(readUrl, { method: "GET", headers: HEADERS, responseType: "text" });
        const readHtml = readRes?.body || (typeof readRes === "string" ? readRes : "");
        if (readHtml && readHtml.length > 1000) {
          // Parse chapter headings
          const headingMatches = [...readHtml.matchAll(/<h[23][^>]*>([^<]+)<\/h[23]>/gi)];
          if (headingMatches.length > 0) {
            textCache.set(id + "::gutenberg", readHtml);
            return headingMatches.map((m, idx) => ({
              id: id + "::gutenberg::" + idx,
              title: m[1].replace(/\s+/g, " ").trim(),
              position: idx,
              language: "en",
            }));
          }
        }
      }
    } catch {}

    // 3. Informative setup guide if Cloudflare Worker bridge is not yet connected
    return [
      {
        id: id + "::setup_bridge",
        title: "⚡ Connect Cloud Reader Bridge for 1-Click Reading",
        position: 0,
        language: "en",
      },
      {
        id: id + "::mirrors",
        title: "📥 Open Anna's Archive Download Mirrors",
        position: 1,
        language: "en",
      },
    ];
  },

  async content(chapterId) {
    const parts = chapterId.split("::");
    const bookId = parts[0];
    const mode = parts[1];

    // 1. Content served from the Cloud Reader Bridge:
    if (mode === "bridge" && parts[2] && parts[3]) {
      const bookKey = decodeURIComponent(parts[2]);
      const chId = parts[3];
      if (BRIDGE_URL) {
        const cUrl =
          BRIDGE_URL +
          "/api/content?bookKey=" +
          encodeURIComponent(bookKey) +
          "&chapterId=" +
          encodeURIComponent(chId);

        const res = await bridge.http(cUrl, {
          method: "GET",
          headers: HEADERS,
          responseType: "text",
          timeoutMs: 15000,
        });

        const text = res?.body || (typeof res === "string" ? res : "");
        if (text && text.length > 20) return text;
      }
    }

    // 2. Content from Gutenberg HTML:
    if (mode === "gutenberg" && parts[2]) {
      const idx = parseInt(parts[2], 10);
      const rawHtml = textCache.get(bookId + "::gutenberg");
      if (rawHtml) {
        const sections = rawHtml.split(/<h[23][^>]*>/i);
        if (sections[idx + 1]) {
          const sectionHtml = sections[idx + 1];
          const cleanSection = sectionHtml
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
          return cleanSection;
        }
      }
    }

    // 3. Instructions for 1-Click Bridge Activation:
    if (mode === "setup_bridge") {
      return [
        "# ⚡ 1-Click Reading Setup",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "To read protected & shadow library books directly in Compass with 1 click:",
        "",
        "Option A: Deploy Free Cloudflare Worker (Works on all devices)",
        "1. Open your GitHub repo: https://github.com/ShroomSn00t/AnnasArchiveBruh",
        "2. Copy the code in worker.js.",
        "3. Go to https://dash.cloudflare.com -> Workers -> Create Worker.",
        "4. Paste worker.js and click Deploy.",
        "5. Paste your Worker URL into annas-archive.plugin.js (BRIDGE_URL line 17).",
        "",
        "Option B: Run on your PC (Instant)",
        "1. Open terminal in d:\\Programming\\AnnasArchiveBruh",
        "2. Run: node worker.js",
        "3. Refresh Compass — all books will load real chapters in 1 click!",
      ].join("\n");
    }

    // 4. Fallback mirrors
    const detail = await this.detail(bookId);
    return [
      "# " + (detail.title || "Book"),
      detail.author ? "Author: " + detail.author : "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "Anna's Archive Mirror Page:",
      detail.siteUrl,
      "",
      "TorBox WebDL URL:",
      "https://torbox.app/webdl?url=" + encodeURIComponent(detail.siteUrl),
    ]
      .filter(Boolean)
      .join("\n\n");
  },

  async tags() {
    return [
      { id: "content:bestsellers", name: "Bestsellers", group: "Category" },
      { id: "content:book_fiction", name: "Fiction", group: "Category" },
      { id: "content:book_nonfiction", name: "Non-Fiction", group: "Category" },
      { id: "content:book_comic", name: "Comics & Graphic Novels", group: "Category" },
      { id: "sort:popular", name: "Most Popular", group: "Sort" },
      { id: "sort:newest", name: "Newest", group: "Sort" },
    ];
  },
};

if (typeof compass !== "undefined" && typeof compass.register === "function") {
  compass.register(plugin);
}
if (typeof harbor !== "undefined" && typeof harbor.register === "function") {
  harbor.register(plugin);
}

return plugin;
