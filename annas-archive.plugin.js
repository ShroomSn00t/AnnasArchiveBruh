// Compass & Harbor eBook Source Plugin: Anna's Archive & Shadow Libraries
//
// Implements the EBookProvider interface: popular, search, detail, chapters, content, and tags.
// Integrates TorBox-compatible direct web download links, Libgen, and Anna's Archive mirrors.

const bridge =
  typeof compass !== "undefined"
    ? compass
    : typeof harbor !== "undefined"
      ? harbor
      : (typeof globalThis !== "undefined" ? (globalThis.compass || globalThis.harbor) : null);

const AA_MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.pk",
  "https://annas-archive.gd",
  "https://annas-archive.li",
  "https://annas-archive.org",
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

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

function torboxWebDlUrl(downloadUrl) {
  if (!downloadUrl) return "";
  return "https://torbox.app/webdl?url=" + encodeURIComponent(downloadUrl);
}

// Fetch helper that parses JSON or text
async function fetchHttp(url, responseType = "text") {
  try {
    const res = await bridge.http(url, {
      method: "GET",
      headers: HEADERS,
      responseType,
      timeoutMs: 15000,
    });
    return res;
  } catch (err) {
    return null;
  }
}

// Safe OpenLibrary JSON search
async function queryOpenLibrary(path) {
  const url = "https://openlibrary.org" + path;
  const res = await fetchHttp(url, "json");
  if (res && typeof res === "object") return res;
  if (res && res.body) {
    try {
      return JSON.parse(res.body);
    } catch {}
  }
  return null;
}

// Extract books from OpenLibrary Trending or Search responses
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

      // ID format encodes key and isbn for fast mirror resolution
      const id = "ol:" + (key || "item") + (isbn ? ":isbn:" + isbn : "") + ":t:" + encodeURIComponent(title);

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

    // 1. Fetch daily trending books (100+ books with covers)
    if (page === 1) {
      const trendingData = await queryOpenLibrary("/trending/daily.json");
      if (trendingData && Array.isArray(trendingData.works) && trendingData.works.length > 0) {
        return mapOpenLibraryDocs(trendingData.works.slice(0, 48));
      }
    }

    // 2. Category filtering or deeper pagination
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

    // Fallback: popular search
    const fallbackData = await queryOpenLibrary("/search.json?q=bestseller&page=" + page + "&limit=30");
    if (fallbackData && Array.isArray(fallbackData.docs)) {
      return mapOpenLibraryDocs(fallbackData.docs);
    }

    return [];
  },

  async search(query, offset, tagId) {
    const trimmed = cleanText(query);
    if (!trimmed) return this.popular(offset, tagId);

    const page = Math.floor((offset || 0) / 25) + 1;
    const olQuery = "/search.json?q=" + encodeURIComponent(trimmed) + "&page=" + page + "&limit=25";
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

    const searchQuery = isbn || title;
    const encodedQuery = encodeURIComponent(searchQuery);
    const aaBase = AA_MIRRORS[0];

    const mirrors = [
      {
        name: "⚡ TorBox 1-Click WebDL (Instant Cloud Download)",
        url: torboxWebDlUrl(aaBase + "/search?q=" + encodedQuery),
        torbox: true,
      },
      {
        name: "📖 Anna's Archive (All EPUB / PDF Editions)",
        url: aaBase + "/search?q=" + encodedQuery,
      },
      {
        name: "📥 Library Genesis (Direct Mirrors & Fast Download)",
        url: "https://libgen.li/index.php?req=" + encodedQuery,
      },
      {
        name: "🌐 IPFS Gateway Search",
        url: "https://cloudflare-ipfs.com/ipfs/search?q=" + encodedQuery,
      },
      {
        name: "⚡ TorBox WebDL Dashboard (Paste link here)",
        url: "https://torbox.app/webdl",
        torbox: true,
      },
    ];

    return {
      id,
      title,
      cover,
      author,
      authors: author ? [author] : [],
      description:
        description || "Search and download this book directly via Anna's Archive, Libgen, or TorBox.",
      isbn,
      year,
      originalLanguage: "en",
      genres: ["eBook", "Anna's Archive"],
      mirrors,
      siteUrl: aaBase + "/search?q=" + encodedQuery,
    };
  },

  async chapters(id) {
    const item = await this.detail(id).catch(() => null);
    const chaptersList = [
      {
        id: id + "::overview",
        title: "📖 Book Information & TorBox Direct Links",
        position: 0,
      },
      {
        id: id + "::torbox",
        title: "⚡ TorBox Instant WebDL",
        position: 1,
      },
      {
        id: id + "::annas",
        title: "📖 Anna's Archive Mirrors",
        position: 2,
      },
      {
        id: id + "::libgen",
        title: "📥 Library Genesis Direct Links",
        position: 3,
      },
    ];

    if (item?.description && item.description.length > 20) {
      chaptersList.push({
        id: id + "::synopsis",
        title: "📝 Synopsis & Overview",
        position: 4,
      });
    }

    return chaptersList;
  },

  async content(chapterId) {
    const parts = chapterId.split("::");
    const id = parts[0];
    const section = parts[1] || "overview";

    const item = await this.detail(id).catch(() => null);
    if (!item) {
      return "Unable to load book details.";
    }

    const title = item.title || "Book";
    const authorLine = item.author ? "Author: " + item.author : "";
    const isbnLine = item.isbn ? "ISBN: " + item.isbn : "";

    if (section === "torbox") {
      const tbMirror = item.mirrors.find((m) => m.torbox) || item.mirrors[0];
      return [
        "# " + title,
        authorLine,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "⚡ TORBOX CLOUD DOWNLOAD",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "1-Click TorBox WebDL URL:",
        tbMirror.url,
        "",
        "How to download with TorBox:",
        "1. Tap or copy the 1-Click link above to open TorBox WebDL directly.",
        "2. Alternatively, copy the Anna's Archive or Libgen link below and paste it into:",
        "   https://torbox.app/webdl",
        "3. TorBox will automatically download and cache the EPUB / PDF onto their high-speed servers for instant downloading or streaming!",
        "",
        "Direct Source Mirror:",
        item.siteUrl,
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    if (section === "annas") {
      const aaMirror = item.mirrors.find((m) => m.url.includes("annas-archive")) || item.mirrors[0];
      return [
        "# " + title,
        authorLine,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📖 ANNA'S ARCHIVE DIRECT LINKS",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Search & Download on Anna's Archive:",
        aaMirror.url,
        "",
        "Mirror domains available:",
        "• " + AA_MIRRORS.join("\n• "),
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    if (section === "libgen") {
      const libgenMirror = item.mirrors.find((m) => m.url.includes("libgen")) || item.mirrors[0];
      return [
        "# " + title,
        authorLine,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📥 LIBRARY GENESIS DIRECT DOWNLOAD",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Libgen Download Mirror:",
        libgenMirror.url,
        "",
        "Library Genesis provides direct EPUB and PDF downloads with no wait timers or captchas.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    if (section === "synopsis") {
      return [
        "# " + title,
        authorLine,
        isbnLine,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "SYNOPSIS",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        item.description || "No synopsis available for this book.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    // Default Overview
    const lines = [
      "# " + title,
      authorLine,
      isbnLine,
      item.year ? "Year: " + item.year : "",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "⚡ DOWNLOAD WITH TORBOX OR DIRECT MIRRORS",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ];

    item.mirrors.forEach((m, idx) => {
      lines.push((idx + 1) + ". " + m.name + ":");
      lines.push(m.url);
      lines.push("");
    });

    if (item.description) {
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push("DESCRIPTION & SYNOPSIS");
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(item.description);
    }

    return lines.filter(Boolean).join("\n\n");
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
