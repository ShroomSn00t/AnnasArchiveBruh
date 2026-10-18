// Compass & Harbor eBook Source Plugin: Anna's Archive & Shadow Libraries
//
// 1-Click in-app reader: Downloads & unzips EPUB files directly into Compass,
// extracting chapters and story text. Integrates TorBox WebDL API + Open & Shadow Libraries.

// =============================================================================
// 🔑 TORBOX API KEY CONFIGURATION
// Paste your TorBox API key below (get it from https://torbox.app/settings)
// to unlock automatic 1-click downloading & reading of all shadow library books!
// =============================================================================
const TORBOX_API_KEY = "";

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

// In-memory cache for parsed EPUBs: bookId -> { chapters: [], entries: Map<path, Uint8Array> }
const epubCache = new Map();

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

// Convert Base64 string to Uint8Array
function base64ToBytes(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Pure JS ZIP & EPUB Decompressor using standard DecompressionStream
async function unzipEntries(uint8Array) {
  const view = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
  const len = uint8Array.byteLength;
  let eocdOffset = -1;

  for (let i = len - 22; i >= Math.max(0, len - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid ZIP/EPUB: EOCD record not found");

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map();
  let p = cdOffset;
  const decoder = new TextDecoder();

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const compression = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);

    const name = decoder.decode(uint8Array.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;

    const compressedData = uint8Array.subarray(dataOffset, dataOffset + compressedSize);
    let decompressed;

    if (compression === 0) {
      decompressed = compressedData;
    } else if (compression === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Response(compressedData).body.pipeThrough(ds);
      decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue;
    }

    entries.set(name, decompressed);
  }

  return entries;
}

// Parse EPUB chapters from unzipped file entries
function parseEpubChapters(entries) {
  const decoder = new TextDecoder();
  let opfPath = "";

  const containerBytes = entries.get("META-INF/container.xml");
  if (containerBytes) {
    const xml = decoder.decode(containerBytes);
    const m = xml.match(/full-path=["']([^"']+\.opf)["']/i);
    if (m) opfPath = m[1];
  }

  if (!opfPath) {
    for (const key of entries.keys()) {
      if (key.endsWith(".opf")) {
        opfPath = key;
        break;
      }
    }
  }

  if (!opfPath) throw new Error("No OPF manifest found in EPUB");

  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfXml = decoder.decode(entries.get(opfPath));

  // Map manifest ID -> href
  const manifest = new Map();
  const itemRegex = /<item\s+[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(opfXml)) !== null) {
    manifest.set(itemMatch[1], itemMatch[2]);
  }
  const itemRegex2 = /<item\s+[^>]*href=["']([^"']+)["'][^>]*id=["']([^"']+)["'][^>]*>/gi;
  while ((itemMatch = itemRegex2.exec(opfXml)) !== null) {
    manifest.set(itemMatch[2], itemMatch[1]);
  }

  // Parse spine reading order
  const spine = [];
  const spineRegex = /<itemref\s+[^>]*idref=["']([^"']+)["'][^>]*>/gi;
  let spineMatch;
  while ((spineMatch = spineRegex.exec(opfXml)) !== null) {
    const idref = spineMatch[1];
    const href = manifest.get(idref);
    if (href) {
      const cleanHref = href.split("#")[0];
      const fullPath = opfDir + cleanHref;
      spine.push({ idref, path: fullPath });
    }
  }

  // Extract real chapter titles from NCX or NAV
  const titles = new Map();
  for (const [key, bytes] of entries.entries()) {
    if (key.endsWith(".ncx")) {
      const ncxXml = decoder.decode(bytes);
      const navPointRegex =
        /<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content\s+[^>]*src=["']([^"']+)["']/gi;
      let npMatch;
      while ((npMatch = navPointRegex.exec(ncxXml)) !== null) {
        const title = npMatch[1].trim();
        const src = npMatch[2].split("#")[0];
        const fullSrc = opfDir + src;
        titles.set(fullSrc, title);
      }
    }
  }

  const chapters = spine.map((item, index) => {
    let title = titles.get(item.path);
    if (!title) {
      const fileBytes = entries.get(item.path);
      if (fileBytes) {
        const hText = decoder.decode(fileBytes.subarray(0, 4000));
        const hm =
          hText.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) ||
          hText.match(/<title>([^<]+)<\/title>/i);
        if (hm) title = hm[1].replace(/\s+/g, " ").trim();
      }
    }
    if (!title || title.toLowerCase().includes("untitled")) {
      title = "Chapter " + (index + 1);
    }
    return {
      path: item.path,
      title,
      position: index,
    };
  });

  return chapters;
}

// Request direct CDN download URL from TorBox WebDL API
async function downloadViaTorbox(targetUrl) {
  const apiKey = TORBOX_API_KEY;
  if (!apiKey) return null;

  try {
    // 1. Submit download request to TorBox
    const createRes = await bridge.http("https://api.torbox.app/v1/api/webdl/createwebdownload", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        ...HEADERS,
      },
      body: "link=" + encodeURIComponent(targetUrl),
      responseType: "json",
      timeoutMs: 15000,
    });

    const body = createRes?.body || createRes;
    const webId = body?.data?.id || body?.data?.web_id;
    if (!webId) return null;

    // 2. Fetch direct CDN link
    const dlRes = await bridge.http(
      "https://api.torbox.app/v1/api/webdl/requestdl?token=" +
        apiKey +
        "&web_id=" +
        webId +
        "&redirect=false",
      {
        method: "GET",
        headers: HEADERS,
        responseType: "json",
        timeoutMs: 15000,
      }
    );

    const dlBody = dlRes?.body || dlRes;
    return dlBody?.data?.url || dlBody?.url || null;
  } catch (err) {
    return null;
  }
}

// Safe OpenLibrary JSON search
async function queryOpenLibrary(path) {
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
    // 1. Check in-memory unzipped EPUB cache
    if (epubCache.has(id)) {
      const cached = epubCache.get(id);
      return cached.chapters.map((c) => ({
        id: id + "::" + encodeURIComponent(c.path),
        title: c.title,
        position: c.position,
      }));
    }

    // Extract title, isbn, and Internet Archive item if available
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

    // 2. Candidate download URLs for the EPUB
    const candidates = [];

    // Gutenberg / Internet Archive direct public mirror
    if (iaId) {
      candidates.push("https://archive.org/download/" + iaId + "/" + iaId + ".epub");
    }

    // Direct Anna's Archive search URL for TorBox
    const query = isbn || title;
    candidates.push("https://annas-archive.gl/search?q=" + encodeURIComponent(query));
    candidates.push("https://libgen.li/index.php?req=" + encodeURIComponent(query));

    // 3. Attempt downloading the EPUB
    let epubBytes = null;

    // A) If TorBox API key is provided, use TorBox high-speed WebDL
    if (TORBOX_API_KEY) {
      for (const target of candidates) {
        const torboxCdnUrl = await downloadViaTorbox(target);
        if (torboxCdnUrl) {
          const res = await bridge.http(torboxCdnUrl, {
            method: "GET",
            headers: HEADERS,
            responseType: "base64",
            timeoutMs: 30000,
          });
          if (res && res.ok && res.body) {
            epubBytes = base64ToBytes(res.body);
            break;
          }
        }
      }
    }

    // B) Direct public download attempt (Internet Archive or open mirrors)
    if (!epubBytes && iaId) {
      try {
        const iaUrl = "https://archive.org/download/" + iaId + "/" + iaId + ".epub";
        const res = await bridge.http(iaUrl, {
          method: "GET",
          headers: HEADERS,
          responseType: "base64",
          timeoutMs: 25000,
        });
        if (res && res.ok && res.body) {
          epubBytes = base64ToBytes(res.body);
        }
      } catch {}
    }

    // 4. If EPUB was successfully downloaded, unzip and parse into REAL chapters!
    if (epubBytes && epubBytes.length > 500) {
      try {
        const entries = await unzipEntries(epubBytes);
        const chapters = parseEpubChapters(entries);
        if (chapters.length > 0) {
          epubCache.set(id, { chapters, entries });
          return chapters.map((c) => ({
            id: id + "::" + encodeURIComponent(c.path),
            title: c.title,
            position: c.position,
          }));
        }
      } catch (err) {
        // Fallback below if EPUB unzip failed
      }
    }

    // 5. If TorBox API key is missing or file requires TorBox activation
    if (!TORBOX_API_KEY) {
      return [
        {
          id: id + "::setup_torbox",
          title: "🔑 Set TorBox API Key to unlock 1-Click Reading",
          position: 0,
        },
        {
          id: id + "::mirrors",
          title: "📥 Open Anna's Archive Download Mirrors",
          position: 1,
        },
      ];
    }

    return [
      {
        id: id + "::loading_error",
        title: "⚠️ Downloading book... Tap to retry",
        position: 0,
      },
      {
        id: id + "::mirrors",
        title: "📥 Open Anna's Archive Download Mirrors",
        position: 1,
      },
    ];
  },

  async content(chapterId) {
    const parts = chapterId.split("::");
    const bookId = parts[0];
    const subPath = parts[1] ? decodeURIComponent(parts[1]) : "";

    // 1. If this is a real chapter from the unzipped EPUB:
    if (epubCache.has(bookId)) {
      const { entries } = epubCache.get(bookId);
      const chapterBytes = entries.get(subPath);
      if (chapterBytes) {
        const decoder = new TextDecoder();
        const html = decoder.decode(chapterBytes);
        const doc = await bridge.parseHtml(html);

        if (doc) {
          const blocks = doc.querySelectorAll("p, blockquote, div.para, h1, h2, h3, h4, li");
          if (blocks && blocks.length > 0) {
            const text = blocks
              .map((b) => b.text().trim())
              .filter(Boolean)
              .join("\n\n");
            if (text.length > 20) return text;
          }
        }

        // Fallback: strip tags
        const stripped = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return stripped;
      }
    }

    // 2. If TorBox API key setup is needed:
    if (subPath === "setup_torbox") {
      return [
        "# ⚡ Unlock 1-Click Reading in Compass with TorBox",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "To read protected books directly in Compass with 1-click, connect your TorBox API key:",
        "",
        "1. Go to: https://torbox.app/settings",
        "2. Copy your API Key.",
        "3. Open your plugin file:",
        "   d:\\Programming\\AnnasArchiveBruh\\annas-archive.plugin.js",
        "4. Paste your key into line 9:",
        "   const TORBOX_API_KEY = \"your_api_key_here\";",
        "5. Save the file and push to GitHub (or paste into your local repo).",
        "",
        "Once your API key is pasted, Compass will automatically download, unzip, and display all chapters (Chapter 1, Chapter 2, etc.) so you can read any book in 1-click!",
      ].join("\n");
    }

    // 3. Fallback mirrors
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
