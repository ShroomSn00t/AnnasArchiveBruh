// Compass & Harbor eBook Source Plugin: Anna's Archive
//
// This plugin runs in a sandboxed worker without DOM, fetch, or local storage.
// Network requests use compass.http (or harbor.http) and HTML parsing uses
// compass.parseHtml (or harbor.parseHtml).

const bridge =
  typeof compass !== "undefined"
    ? compass
    : typeof harbor !== "undefined"
      ? harbor
      : (typeof globalThis !== "undefined" ? (globalThis.compass || globalThis.harbor) : null);

const MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.pk",
  "https://annas-archive.gd",
  "https://annas-archive.se",
  "https://annas-archive.li",
  "https://annas-archive.org",
];

let workingBase = MIRRORS[0];

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function abs(url, base) {
  if (!url) return undefined;
  const currentBase = base || workingBase || MIRRORS[0];
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return currentBase + url;
  return currentBase + "/" + url;
}

function cleanTitle(val) {
  return (val || "")
    .replace(/[^\p{L}\p{N}\s',.\-_:;!?()/[\]]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(val) {
  return (val || "").replace(/\s+/g, " ").trim();
}

async function fetchDoc(path) {
  // Sort candidates so the last known working mirror is attempted first
  const candidates = [workingBase, ...MIRRORS.filter((m) => m !== workingBase)];
  let lastError = null;

  for (const base of candidates) {
    try {
      const url = base + path;
      const res = await bridge.http(url, {
        method: "GET",
        headers: REQUEST_HEADERS,
        responseType: "text",
        timeoutMs: 15000,
      });

      if (res && res.ok && res.body) {
        // Skip pages blocked by a JS challenge if encountered
        if (res.body.includes("DDoS-Guard") && res.body.includes("js-challenge")) {
          continue;
        }

        const doc = await bridge.parseHtml(res.body);
        if (doc) {
          workingBase = base;
          return { doc, base, body: res.body };
        }
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unable to connect to Anna's Archive mirrors");
}

function browseQuery(tagId) {
  const params = new URLSearchParams();
  if (tagId) {
    if (tagId.startsWith("ext:")) params.set("ext", tagId.slice(4));
    else if (tagId.startsWith("content:")) params.set("content", tagId.slice(8));
    else if (tagId.startsWith("sort:")) params.set("sort", tagId.slice(5));
    else if (tagId.startsWith("lang:")) params.set("lang", tagId.slice(5));
  }
  const str = params.toString();
  return str ? "&" + str : "";
}

function parseCardsFromDoc(doc, base, body) {
  const items = new Map();

  // 1. DOM extraction: query links pointing to /md5/<hash>
  const links = doc.querySelectorAll('a[href*="/md5/"]');
  for (const a of links) {
    const href = a.attr("href") || "";
    const match = href.match(/\/md5\/([a-f0-9]{32})/i) || href.match(/\/md5\/([^\s/?&#]+)/i);
    if (!match) continue;
    const md5 = match[1];

    if (!items.has(md5)) {
      items.set(md5, {
        id: md5,
        title: "",
        cover: undefined,
        author: undefined,
        authors: [],
        description: undefined,
        genres: ["eBook"],
        siteUrl: base + "/md5/" + md5,
      });
    }
    const book = items.get(md5);

    // Look for cover image inside the link
    const img = a.querySelector("img");
    if (img && !book.cover) {
      const src = img.attr("src") || img.attr("data-src");
      if (src && !src.includes("spacer.gif")) {
        book.cover = abs(src, base);
      }
    }

    // Extract text from the link or child elements
    const linkText = cleanTitle(a.text());
    if (
      linkText &&
      linkText.length > book.title.length &&
      !linkText.toLowerCase().includes("download") &&
      !linkText.toLowerCase().startsWith("fast partner")
    ) {
      book.title = linkText;
    }
  }

  // 2. Fallback regex extraction if DOM links were sparse
  if (items.size === 0 && body) {
    const regex = /href=["']\/md5\/([a-f0-9]{32})["'][^>]*>(.*?)<\/a>/gis;
    let m;
    while ((m = regex.exec(body)) !== null) {
      const md5 = m[1];
      const rawInner = m[2].replace(/<[^>]+>/g, " ").trim();
      const title = cleanTitle(rawInner);
      if (md5 && title && !items.has(md5)) {
        items.set(md5, {
          id: md5,
          title: title,
          cover: undefined,
          genres: ["eBook"],
          siteUrl: base + "/md5/" + md5,
        });
      }
    }
  }

  return Array.from(items.values()).filter((b) => b.id && b.title);
}

const plugin = {
  id: "annas-archive",
  name: "Anna's Archive",

  async popular(offset, tagId) {
    const page = Math.floor((offset || 0) / 30) + 1;
    const filters = browseQuery(tagId);
    const path = "/search?q=&sort=popular&page=" + page + filters;
    const { doc, base, body } = await fetchDoc(path);
    return parseCardsFromDoc(doc, base, body);
  },

  async search(query, offset, tagId) {
    const trimmed = (query || "").trim();
    if (!trimmed) return this.popular(offset, tagId);
    const page = Math.floor((offset || 0) / 30) + 1;
    const filters = browseQuery(tagId);
    const path = "/search?q=" + encodeURIComponent(trimmed) + "&page=" + page + filters;
    const { doc, base, body } = await fetchDoc(path);
    return parseCardsFromDoc(doc, base, body);
  },

  async detail(id) {
    const cleanId = String(id).replace(/^\/md5\//, "").split(/[?#/]/)[0];
    const path = "/md5/" + cleanId;
    const { doc, base, body } = await fetchDoc(path);

    // Title
    const titleEl =
      doc.querySelector("h1") ||
      doc.querySelector(".font-semibold.text-2xl") ||
      doc.querySelector(".text-3xl") ||
      doc.querySelector(".text-2xl");
    let title = cleanTitle(titleEl?.text());
    if (!title && body) {
      const titleMatch = body.match(/<div class="[^"]*font-semibold text-2xl[^"]*">([^<]+)<\/div>/i);
      if (titleMatch) title = cleanTitle(titleMatch[1]);
    }
    if (!title) title = cleanId;

    // Authors
    const authorEl =
      doc.querySelector("a[href^='/search?q=']") ||
      doc.querySelector(".text-base.italic") ||
      doc.querySelector(".italic");
    const author = cleanText(authorEl?.text()) || undefined;

    // Cover
    let cover;
    const coverImgs = doc.querySelectorAll("img");
    for (const img of coverImgs) {
      const src = img.attr("src") || img.attr("data-src");
      if (src && (src.includes("/covers/") || src.includes("/md5/") || src.includes("cover"))) {
        cover = abs(src, base);
        break;
      }
    }
    if (!cover && coverImgs.length > 0) {
      cover = abs(coverImgs[0].attr("src") || coverImgs[0].attr("data-src"), base);
    }

    // Description / Synopsis
    const descEl =
      doc.querySelector(".js-md5-top-box-description") ||
      doc.querySelector(".description") ||
      doc.querySelector("div.text-sm.italic");
    let description = descEl?.text()?.trim();
    if (!description && body) {
      const descMatch = body.match(/js-md5-top-box-description[^>]*>(.*?)<\/div>/is);
      if (descMatch) description = descMatch[1].replace(/<[^>]+>/g, " ").trim();
    }

    // Extract format, file size, and language from metadata text
    let format = "eBook";
    let size;
    let language;
    let isbn;
    let year;
    let publisher;

    if (body) {
      const formatMatch = body.match(/\b(EPUB|PDF|MOBI|AZW3|CBR|CBZ|FB2|DJVU)\b/i);
      if (formatMatch) format = formatMatch[1].toUpperCase();

      const sizeMatch = body.match(/\b(\d+(?:\.\d+)?\s*(?:MB|KB|GB))\b/i);
      if (sizeMatch) size = sizeMatch[1];

      const langMatch = body.match(/([A-Z][a-z]+)\s*\[([a-z]{2,3})\]/);
      if (langMatch) language = langMatch[1];

      const isbnMatch = body.match(/\b(?:ISBN(?:-1[03])?:?\s*)([0-9X-]{10,17})\b/i);
      if (isbnMatch) isbn = isbnMatch[1].replace(/[^0-9X]/gi, "");

      const yearMatch = body.match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch) year = parseInt(yearMatch[1], 10);
    }

    // Download Mirrors
    const mirrors = [];
    const seenUrls = new Set();
    const mirrorLinks = doc.querySelectorAll("a[href]");

    for (const link of mirrorLinks) {
      const href = link.attr("href") || "";
      const text = link.text().trim();
      const fullUrl = abs(href, base);

      if (!fullUrl || seenUrls.has(fullUrl)) continue;

      if (
        fullUrl.includes("cloudflare-ipfs.com") ||
        fullUrl.includes("ipfs.io") ||
        fullUrl.includes("pinata.cloud") ||
        fullUrl.includes("/ipfs/")
      ) {
        seenUrls.add(fullUrl);
        mirrors.push({ name: "IPFS Gateway (" + (text || "Mirror") + ")", url: fullUrl });
      } else if (
        fullUrl.includes("library.lol") ||
        fullUrl.includes("libgen.li") ||
        fullUrl.includes("libgen.is") ||
        fullUrl.includes("libgen.rs")
      ) {
        seenUrls.add(fullUrl);
        mirrors.push({ name: "Library Genesis (" + (text || "Mirror") + ")", url: fullUrl });
      } else if (fullUrl.includes("/slow_download/")) {
        seenUrls.add(fullUrl);
        mirrors.push({ name: "Anna's Archive Direct (" + (text || "Slow Download") + ")", url: fullUrl });
      } else if (fullUrl.includes("z-library") || fullUrl.includes("scihub") || fullUrl.includes("scidb")) {
        seenUrls.add(fullUrl);
        mirrors.push({ name: text || "External Partner Mirror", url: fullUrl });
      }
    }

    return {
      id: cleanId,
      title,
      cover,
      author,
      authors: author ? [author] : [],
      description: description || "No summary provided by source.",
      isbn,
      publisher,
      year,
      originalLanguage: language || "en",
      genres: [format, "Anna's Archive"].filter(Boolean),
      format,
      size,
      mirrors,
      siteUrl: base + "/md5/" + cleanId,
    };
  },

  async chapters(id) {
    const detail = await this.detail(id).catch(() => null);
    const chaptersList = [
      {
        id: id + ":overview",
        title: "📖 Book Details & Download Links",
        position: 0,
        language: detail?.originalLanguage || "en",
      },
    ];

    if (detail?.mirrors && detail.mirrors.length > 0) {
      detail.mirrors.forEach((m, idx) => {
        chaptersList.push({
          id: id + ":mirror:" + idx,
          title: "📥 " + m.name,
          position: idx + 1,
          language: detail?.originalLanguage || "en",
        });
      });
    }

    if (detail?.description && detail.description.length > 30) {
      chaptersList.push({
        id: id + ":synopsis",
        title: "📝 Full Synopsis & Description",
        position: chaptersList.length,
        language: detail?.originalLanguage || "en",
      });
    }

    return chaptersList;
  },

  async content(chapterId) {
    const parts = String(chapterId).split(":");
    const id = parts[0];
    const section = parts[1] || "overview";
    const mirrorIdx = parts[2] !== undefined ? parseInt(parts[2], 10) : -1;

    const detail = await this.detail(id).catch(() => null);
    if (!detail) {
      return "Unable to retrieve book details from Anna's Archive.";
    }

    if (section === "synopsis") {
      return [
        "# " + detail.title,
        detail.author ? "Author: " + detail.author : "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "SYNOPSIS",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        detail.description || "No description available.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    if (section === "mirror" && mirrorIdx >= 0 && detail.mirrors?.[mirrorIdx]) {
      const m = detail.mirrors[mirrorIdx];
      return [
        "# " + detail.title,
        "## " + m.name,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Direct Download Link:",
        m.url,
        "",
        "Instructions:",
        "Copy and paste this link into your browser or download manager to save the file (" +
          (detail.format || "eBook") +
          ").",
        "",
        "File Details:",
        "• Format: " + (detail.format || "Unknown"),
        "• Size: " + (detail.size || "Unknown"),
        "• Language: " + (detail.originalLanguage || "Unknown"),
        "• MD5: " + id,
        detail.description
          ? "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSynopsis:\n" + detail.description
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    // Default Overview
    const lines = [
      "# " + detail.title,
      detail.author ? "Author: " + detail.author : "",
      detail.publisher ? "Publisher: " + detail.publisher : "",
      detail.year ? "Year: " + detail.year : "",
      detail.format ? "Format: " + detail.format.toUpperCase() : "",
      detail.size ? "File Size: " + detail.size : "",
      detail.isbn ? "ISBN: " + detail.isbn : "",
      detail.originalLanguage ? "Language: " + detail.originalLanguage : "",
      "MD5: " + id,
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "DOWNLOAD MIRRORS",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ];

    if (detail.mirrors && detail.mirrors.length > 0) {
      detail.mirrors.forEach((m, idx) => {
        lines.push(idx + 1 + ". " + m.name + ":");
        lines.push(m.url);
        lines.push("");
      });
    } else {
      lines.push("Source Web Page (view mirrors):");
      lines.push(detail.siteUrl || "https://annas-archive.gl/md5/" + id);
      lines.push("");
    }

    if (detail.description) {
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push("SYNOPSIS & DESCRIPTION");
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(detail.description);
    }

    return lines.join("\n\n");
  },

  async tags() {
    return [
      { id: "ext:epub", name: "EPUB", group: "Format" },
      { id: "ext:pdf", name: "PDF", group: "Format" },
      { id: "ext:mobi", name: "MOBI", group: "Format" },
      { id: "ext:cbr", name: "Comic (CBR/CBZ)", group: "Format" },
      { id: "content:book_fiction", name: "Fiction", group: "Category" },
      { id: "content:book_nonfiction", name: "Non-Fiction", group: "Category" },
      { id: "content:book_comic", name: "Comics & Manga", group: "Category" },
      { id: "content:magazine", name: "Magazines", group: "Category" },
      { id: "sort:popular", name: "Most Popular", group: "Sort" },
      { id: "sort:newest", name: "Newest", group: "Sort" },
      { id: "lang:en", name: "English", group: "Language" },
      { id: "lang:es", name: "Spanish", group: "Language" },
      { id: "lang:fr", name: "French", group: "Language" },
      { id: "lang:de", name: "German", group: "Language" },
      { id: "lang:zh", name: "Chinese", group: "Language" },
      { id: "lang:ja", name: "Japanese", group: "Language" },
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
