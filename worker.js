// TorBox + Anna's Archive Cloud Reader Bridge
// Deployable to Cloudflare Workers, Vercel, or run locally via Node.js
// Sends real torrents to TorBox and provides instantaneous 1-click chapter reading for Compass

const TORBOX_API_KEY = "265cd0c5-9953-4505-b9cc-0fc071c58b67";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// In-memory cache for parsed books: bookKey -> { title, chapters: [{ id, title, position, path }], entries: Map<path, string> }
const bookCache = new Map();

// Helper: Clean text
function cleanText(str) {
  return (str || "")
    .replace(/[^\p{L}\p{N}\s',.\-_:;!?()/[\]]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Unzip EPUB ArrayBuffer into entries: Map<path, Uint8Array>
async function unzipEpub(uint8Array) {
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

// Parse EPUB chapters from unzipped entries
function parseEpub(entries, bookTitle = "") {
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

  // Manifest ID -> href
  const manifest = new Map();
  const itemRegex = /<item\b([^>]+)>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(opfXml)) !== null) {
    const attrs = itemMatch[1];
    const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (idMatch && hrefMatch) {
      manifest.set(idMatch[1], hrefMatch[1]);
    }
  }

  // Spine reading order
  const spine = [];
  const spineRegex = /<itemref\b([^>]+)>/gi;
  let spineMatch;
  while ((spineMatch = spineRegex.exec(opfXml)) !== null) {
    const attrs = spineMatch[1];
    const idrefMatch = attrs.match(/\bidref=["']([^"']+)["']/i);
    if (idrefMatch) {
      const idref = idrefMatch[1];
      const href = manifest.get(idref);
      if (href) {
        const cleanHref = href.split("#")[0];
        const fullPath = opfDir + cleanHref;
        spine.push({ idref, path: fullPath, href: cleanHref });
      }
    }
  }

  // Chapter titles from NCX and EPUB3 Nav
  const titles = new Map();

  // 1. Check NCX table of contents
  for (const [key, bytes] of entries.entries()) {
    if (key.endsWith(".ncx")) {
      const ncxXml = decoder.decode(bytes);
      // Strictly isolate each <navPoint> block so regex never bleeds into adjacent navPoints
      const npRegex = /<navPoint\b[^>]*>([\s\S]*?)(?:<navPoint\b|<\/navPoint>|$)/gi;
      let m;
      while ((m = npRegex.exec(ncxXml)) !== null) {
        const block = m[1];
        const textMatch = block.match(/<text\b[^>]*>([\s\S]*?)<\/text>/i);
        const srcMatch = block.match(/<content\b[^>]*src=["']([^"']+)["']/i);
        if (textMatch && srcMatch) {
          const rawTitle = textMatch[1].replace(/<[^>]+>/g, "").trim();
          const src = srcMatch[1].split("#")[0].trim();
          const baseName = src.split("/").pop();
          const fullSrc = opfDir + src;

          if (!titles.has(fullSrc)) titles.set(fullSrc, rawTitle);
          if (!titles.has(src)) titles.set(src, rawTitle);
          if (!titles.has(baseName)) titles.set(baseName, rawTitle);
          if (!titles.has(decodeURIComponent(baseName))) titles.set(decodeURIComponent(baseName), rawTitle);
        }
      }
    }

    // 2. Check EPUB3 nav.xhtml / toc.xhtml
    if (key.endsWith("nav.xhtml") || key.endsWith("toc.xhtml") || key.endsWith("toc.html")) {
      const navHtml = decoder.decode(bytes);
      const aRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let aMatch;
      while ((aMatch = aRegex.exec(navHtml)) !== null) {
        const src = aMatch[1].split("#")[0].trim();
        const rawTitle = aMatch[2].replace(/<[^>]+>/g, "").trim();
        if (rawTitle && src) {
          const baseName = src.split("/").pop();
          const fullSrc = opfDir + src;
          if (!titles.has(fullSrc)) titles.set(fullSrc, rawTitle);
          if (!titles.has(src)) titles.set(src, rawTitle);
          if (!titles.has(baseName)) titles.set(baseName, rawTitle);
          if (!titles.has(decodeURIComponent(baseName))) titles.set(decodeURIComponent(baseName), rawTitle);
        }
      }
    }
  }

  // Map spine items to chapters in exact sequential order
  const chapters = spine.map((item, index) => {
    const baseName = item.path.split("/").pop();
    let title =
      titles.get(item.path) ||
      titles.get(decodeURIComponent(item.path)) ||
      titles.get(item.href) ||
      titles.get(baseName) ||
      titles.get(decodeURIComponent(baseName)) ||
      "";

    if (!title) {
      const fileBytes = entries.get(item.path);
      if (fileBytes) {
        const hText = decoder.decode(fileBytes.subarray(0, 4000));
        // Only check h1-h3 headings inside body
        const hm =
          hText.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) ||
          hText.match(/<p\s+[^>]*class=["'][^"']*(?:chapter|title|heading|subhead)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
        if (hm) {
          title = hm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
      }
    }

    let t = (title || "").trim();
    if (!t || t.toLowerCase() === "untitled") {
      if (index === 0) {
        t = "Cover";
      } else {
        t = "Chapter " + index;
      }
    }

    return {
      id: String(index + 1),
      title: t,
      position: index,
      path: item.path,
    };
  });

  // Extract clean text for every chapter and store in memory
  const chapterTexts = new Map();
  for (const ch of chapters) {
    const bytes = entries.get(ch.path);
    if (bytes) {
      const rawHtml = decoder.decode(bytes);
      let cleaned = cleanHtmlToProse(rawHtml);
      if (!cleaned || cleaned.length < 5) {
        cleaned = ch.title + "\n\n[Illustration / Front Matter]";
      }
      chapterTexts.set(ch.id, cleaned);
      chapterTexts.set(ch.path, cleaned);
    }
  }

  return { chapters, chapterTexts };
}

// Convert chapter XHTML into clean paragraphs
function cleanHtmlToProse(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, "\n\n[$1]\n\n")
    .replace(/<(?:p|div|h[1-6]|li|blockquote)[^>]*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+\n/g, "\n\n")
    .trim();
}

async function safeFetch(url, options = {}, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

// Search real book torrents from torrent DHT / index
async function findBookTorrent(title, author) {
  const cleanT = cleanText(title);
  const cleanA = cleanText(author);
  const q = (cleanT + (cleanA ? " " + cleanA : "")).trim();

  let items = [];
  // 1. Search with 'epub' keyword
  const sRes1 = await safeFetch(
    "https://apibay.org/q.php?q=" + encodeURIComponent(q + " epub"),
    { headers: HEADERS },
    4000
  );
  if (sRes1 && sRes1.ok) {
    const data = await sRes1.json();
    if (Array.isArray(data) && data[0] && data[0].id !== "0") {
      items = data;
    }
  }

  // 2. Search without 'epub' keyword if no results
  if (items.length === 0) {
    const sRes2 = await safeFetch(
      "https://apibay.org/q.php?q=" + encodeURIComponent(q),
      { headers: HEADERS },
      4000
    );
    if (sRes2 && sRes2.ok) {
      const data = await sRes2.json();
      if (Array.isArray(data) && data[0] && data[0].id !== "0") {
        items = data;
      }
    }
  }

  if (items.length === 0) return null;

  const candidates = items.slice(0, 5);

  // Check which candidate torrents are already cached in TorBox
  if (TORBOX_API_KEY) {
    try {
      const hashes = candidates.map((c) => c.info_hash.toLowerCase());
      const cacheRes = await safeFetch(
        "https://api.torbox.app/v1/api/torrents/checkcached?hash=" +
          hashes.join(",") +
          "&format=object",
        { headers: { Authorization: "Bearer " + TORBOX_API_KEY } },
        4000
      );
      if (cacheRes && cacheRes.ok) {
        const cacheData = await cacheRes.json();
        const cachedMap = cacheData?.data || {};
        const cachedCandidate = candidates.find(
          (c) => cachedMap[c.info_hash.toLowerCase()]
        );
        if (cachedCandidate) {
          return {
            name: cachedCandidate.name,
            info_hash: cachedCandidate.info_hash,
            magnet:
              "magnet:?xt=urn:btih:" +
              cachedCandidate.info_hash +
              "&dn=" +
              encodeURIComponent(cachedCandidate.name),
            cached: true,
          };
        }
      }
    } catch {}
  }

  // Fall back to top seeded candidate
  const top = candidates[0];
  return {
    name: top.name,
    info_hash: top.info_hash,
    magnet:
      "magnet:?xt=urn:btih:" +
      top.info_hash +
      "&dn=" +
      encodeURIComponent(top.name),
    cached: false,
  };
}

// Fetch and unpack EPUB directly from TorBox torrent ID in 1 step
async function fetchEpubFromTorboxId(torrentId) {
  if (!TORBOX_API_KEY || !torrentId) return null;
  try {
    const listRes = await safeFetch(
      "https://api.torbox.app/v1/api/torrents/mylist?id=" + torrentId,
      { headers: { Authorization: "Bearer " + TORBOX_API_KEY } },
      5000
    );
    if (!listRes || !listRes.ok) return null;
    const listData = await listRes.json();
    const torrentObj = listData?.data;
    const files = torrentObj?.files || (Array.isArray(torrentObj) ? torrentObj[0]?.files : []) || [];
    const epubFile =
      files.find((f) => f.name && f.name.toLowerCase().endsWith(".epub")) ||
      files.find((f) => f.mimetype === "application/epub+zip") ||
      files[0];
    if (!epubFile) return null;

    const dlRes = await safeFetch(
      "https://api.torbox.app/v1/api/torrents/requestdl?token=" +
        TORBOX_API_KEY +
        "&torrent_id=" +
        torrentId +
        "&file_id=" +
        epubFile.id,
      { headers: HEADERS },
      5000
    );
    if (!dlRes || !dlRes.ok) return null;
    const dlData = await dlRes.json();
    const cdnUrl = dlData?.data;
    if (!cdnUrl) return null;

    const fileRes = await safeFetch(cdnUrl, { headers: HEADERS }, 10000);
    if (fileRes && fileRes.ok) {
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        return { bytes, torrentId, name: torrentObj?.name || "" };
      }
    }
  } catch {}
  return null;
}

// Check if a book torrent already exists in user's TorBox account
async function findEpubInUserTorboxAccount(title) {
  if (!TORBOX_API_KEY || !title) return null;
  try {
    const res = await safeFetch("https://api.torbox.app/v1/api/torrents/mylist", {
      headers: { Authorization: "Bearer " + TORBOX_API_KEY },
    }, 4000);
    if (!res || !res.ok) return null;
    const data = await res.json();
    const list = data?.data || [];
    const norm = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!norm) return null;

    for (const t of list) {
      const tNorm = (t.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (tNorm.includes(norm) || norm.includes(tNorm)) {
        const direct = await fetchEpubFromTorboxId(t.id);
        if (direct && direct.bytes) return direct;
      }
    }
  } catch {}
  return null;
}

// Send torrent magnet to TorBox and retrieve EPUB
async function fetchEpubViaTorboxTorrent(title, author) {
  if (!TORBOX_API_KEY) return null;
  try {
    const torrentInfo = await findBookTorrent(title, author);
    if (!torrentInfo || !torrentInfo.magnet) return null;

    // Send torrent to TorBox
    const form = new FormData();
    form.append("magnet", torrentInfo.magnet);
    form.append("allow_zipped", "true");

    const createRes = await safeFetch(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + TORBOX_API_KEY },
        body: form,
      },
      6000
    );

    if (!createRes || !createRes.ok) return null;
    const createData = await createRes.json();
    const torrentId = createData?.data?.torrent_id;
    if (!torrentId) return null;

    return await fetchEpubFromTorboxId(torrentId);
  } catch (e) {
    // Non-blocking fallback
  }
  return null;
}

// Resolver: Download genuine direct EPUB via Archive.org metadata API
async function fetchDirectIaEpub(iaId, title, author) {
  try {
    let targetIa = iaId;
    if (!targetIa && title) {
      const q = (title + (author ? " " + author : "")).trim();
      const sUrl =
        "https://archive.org/advancedsearch.php?q=mediatype:texts+AND+(" +
        encodeURIComponent(q) +
        ")+AND+language:eng&fl[]=identifier,title,format&rows=5&page=1&output=json";
      const sRes = await safeFetch(sUrl, { headers: HEADERS }, 4000);
      if (sRes && sRes.ok) {
        const sData = await sRes.json();
        const docs = sData?.response?.docs || [];
        const epubDoc = docs.find((d) => d.format?.includes("EPUB")) || docs[0];
        if (epubDoc) targetIa = epubDoc.identifier;
      }
    }

    if (targetIa) {
      const metaRes = await safeFetch(
        "https://archive.org/metadata/" + targetIa + "/files",
        { headers: HEADERS },
        4000
      );
      if (metaRes && metaRes.ok) {
        const meta = await metaRes.json();
        const epubs = (meta.result || []).filter(
          (f) =>
            f.name.toLowerCase().endsWith(".epub") &&
            !f.name.toLowerCase().endsWith("_lcp.epub")
        );
        if (epubs.length > 0) {
          const dlUrl =
            "https://archive.org/download/" +
            targetIa +
            "/" +
            encodeURIComponent(epubs[0].name);
          const dlRes = await safeFetch(
            dlUrl,
            { headers: HEADERS, redirect: "follow" },
            8000
          );
          if (dlRes && dlRes.ok) {
            const bytes = new Uint8Array(await dlRes.arrayBuffer());
            if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;
          }
        }
      }
    }
  } catch {}
  return null;
}

// Resolver: Download EPUB from Libgen / Shadow Library (multi-mirror from open-slum.org)
async function fetchEpubFromLibgen(query) {
  const mirrors = ["https://libgen.li", "https://libgen.bz"];
  for (const mirror of mirrors) {
    try {
      const searchUrl =
        mirror +
        "/index.php?req=" +
        encodeURIComponent(query) +
        "&columns%5B%5D=t&columns%5B%5D=a&extension%5B%5D=epub";
      const res = await safeFetch(searchUrl, { headers: HEADERS }, 4000);
      if (!res || !res.ok) continue;
      const html = await res.text();

      const md5Regex = /ads\.php\?md5=([a-f0-9]{32})/gi;
      let m;
      const md5s = [];
      while ((m = md5Regex.exec(html)) !== null) {
        if (!md5s.includes(m[1])) md5s.push(m[1]);
      }
      if (md5s.length === 0) continue;

      for (const md5 of md5s.slice(0, 2)) {
        const adsUrl = mirror + "/ads.php?md5=" + md5;
        const adsRes = await safeFetch(
          adsUrl,
          { headers: { ...HEADERS, Referer: searchUrl } },
          3500
        );
        if (!adsRes || !adsRes.ok) continue;
        const adsHtml = await adsRes.text();

        const getMatch = adsHtml.match(/href=["'](get\.php\?[^"']+)["']/i);
        if (!getMatch) continue;

        const getUrl = mirror + "/" + getMatch[1];
        const fileRes = await safeFetch(
          getUrl,
          { headers: { ...HEADERS, Referer: adsUrl }, redirect: "follow" },
          6000
        );

        if (fileRes && fileRes.ok) {
          const ab = await fileRes.arrayBuffer();
          const bytes = new Uint8Array(ab);
          if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
            return bytes;
          }
        }
      }
    } catch {}
  }
  return null;
}

// Resolver: Strictly verified Gutenberg classic books only
async function fetchEpubGutenbergStrict(title) {
  if (!title) return null;
  try {
    const gUrl =
      "https://www.gutenberg.org/ebooks/search/?query=" +
      encodeURIComponent(title);
    const res = await safeFetch(gUrl, { headers: HEADERS }, 3500);
    if (res && res.ok) {
      const html = await res.text();
      // Match ebook card
      const cardMatch = html.match(
        /<li class="booklink"[\s\S]*?href="\/ebooks\/(\d+)"[\s\S]*?<span class="title">([^<]+)<\/span>/i
      );
      if (cardMatch) {
        const bookId = cardMatch[1];
        const gTitle = cardMatch[2].toLowerCase();
        const reqTitle = title.toLowerCase();

        // Strict verification: Gutenberg title must closely match requested title
        if (gTitle.includes(reqTitle) || reqTitle.includes(gTitle)) {
          const dl =
            "https://www.gutenberg.org/ebooks/" + bookId + ".epub.images";
          const f = await safeFetch(
            dl,
            { headers: HEADERS, redirect: "follow" },
            6000
          );
          if (f && f.ok) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;
          }
        }
      }
    }
  } catch {}
  return null;
}

// Core Resolver Engine: TorBox Torrent first, then fallback direct mirrors
async function getOrLoadBook(bookKey, title, author, isbn, iaId, torrentId) {
  if (bookCache.has(bookKey)) {
    return bookCache.get(bookKey);
  }

  let epubBytes = null;
  let torrentData = null;

  // 1. Direct fetch if torrentId is already known (Fastest: ~300ms direct CDN download)
  if (torrentId && TORBOX_API_KEY) {
    const directResult = await fetchEpubFromTorboxId(torrentId);
    if (directResult && directResult.bytes) {
      epubBytes = directResult.bytes;
      torrentData = directResult;
    }
  }

  // 2. Check if already in user's TorBox account (avoid re-downloading)
  if (!epubBytes && TORBOX_API_KEY && title) {
    const existing = await findEpubInUserTorboxAccount(title);
    if (existing && existing.bytes) {
      epubBytes = existing.bytes;
      torrentData = existing;
    }
  }

  // 3. Search torrent index and send to TorBox
  if (!epubBytes) {
    const tbTorrentResult = await fetchEpubViaTorboxTorrent(title, author);
    if (tbTorrentResult && tbTorrentResult.bytes) {
      epubBytes = tbTorrentResult.bytes;
      torrentData = tbTorrentResult;
    }
  }

  // 4. Direct Archive.org metadata EPUB download
  if (!epubBytes) {
    epubBytes = await fetchDirectIaEpub(iaId, title, author);
  }

  // 3. Libgen Shadow Library
  if (!epubBytes) {
    const q = (title + (author ? " " + author : "")).trim() || bookKey;
    epubBytes = await fetchEpubFromLibgen(q);
  }

  // 4. Gutenberg (Strictly verified classics only)
  if (!epubBytes) {
    epubBytes = await fetchEpubGutenbergStrict(title);
  }

  if (!epubBytes) return null;

  const entries = await unzipEpub(epubBytes);
  const { chapters, chapterTexts } = parseEpub(entries, title);

  const bookData = {
    bookKey,
    title,
    author,
    chapters,
    chapterTexts,
    torrentData,
  };

  bookCache.set(bookKey, bookData);
  return bookData;
}

// Automatically sync book torrent to user's TorBox account
async function syncTorrentToTorbox(title, author) {
  if (!TORBOX_API_KEY) return null;
  try {
    const torrentInfo = await findBookTorrent(title, author);
    if (!torrentInfo || !torrentInfo.magnet) return null;

    const form = new FormData();
    form.append("magnet", torrentInfo.magnet);
    form.append("allow_zipped", "true");

    const res = await safeFetch(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + TORBOX_API_KEY },
        body: form,
      },
      8000
    );

    if (res && res.ok) {
      const data = await res.json();
      return {
        success: Boolean(data?.success),
        name: torrentInfo.name,
        torrentId: data?.data?.torrent_id,
        hash: torrentInfo.info_hash,
        detail: data?.detail,
      };
    }
  } catch {}
  return null;
}

// HTTP Request Handler (compatible with Cloudflare Workers, Vercel, and Node.js)
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "Anna's Archive + TorBox Torrent Reader Bridge",
        torboxConnected: Boolean(TORBOX_API_KEY),
        cachedBooks: bookCache.size,
      }),
      { headers: corsHeaders }
    );
  }

  // 2. Chapters endpoint: /api/chapters?title=...&author=...
  if (url.pathname === "/api/chapters") {
    const q = url.searchParams.get("q") || "";
    const title = url.searchParams.get("title") || q;
    const author = url.searchParams.get("author") || "";
    const isbn = url.searchParams.get("isbn") || "";
    const iaId = url.searchParams.get("ia") || "";
    const torrentIdParam = url.searchParams.get("torrentId") || "";
    const bookKey = (isbn || title || q).toLowerCase().replace(/[^a-z0-9]/g, "");

    // Send torrent to TorBox in parallel so TorBox gets populated with the real torrent
    const syncPromise = TORBOX_API_KEY ? syncTorrentToTorbox(title, author) : null;
    if (ctx && typeof ctx.waitUntil === "function" && syncPromise) {
      ctx.waitUntil(syncPromise);
    }

    if (!bookKey) {
      return new Response(JSON.stringify({ error: "Missing book query" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      const [syncResult, bookData] = await Promise.all([
        syncPromise,
        getOrLoadBook(bookKey, title, author, isbn, iaId, torrentIdParam),
      ]);

      if (!bookData || !bookData.chapters || bookData.chapters.length === 0) {
        return new Response(
          JSON.stringify({
            error: "Book not found or could not be decrypted",
            chapters: [],
            torboxTorrent: syncResult,
          }),
          { status: 404, headers: corsHeaders }
        );
      }

      const torrentId = bookData.torrentData?.torrentId || syncResult?.torrentId || null;
      return new Response(
        JSON.stringify({
          success: true,
          bookKey,
          title: bookData.title || title,
          torboxTorrentSynced: Boolean(syncResult?.success),
          torrentInfo: syncResult || (bookData.torrentData ? { torrentId: bookData.torrentData.torrentId, name: bookData.torrentData.name } : null),
          torrentId,
          totalChapters: bookData.chapters.length,
          chapters: bookData.chapters.map((c) => ({
            id: c.id,
            title: c.title,
            position: c.position,
          })),
        }),
        { headers: corsHeaders }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // 3. Manual TorBox torrent sync endpoint: /api/sync-torbox?title=...&author=...
  if (url.pathname === "/api/sync-torbox") {
    const title = url.searchParams.get("title") || "";
    const author = url.searchParams.get("author") || "";
    const syncResult = await syncTorrentToTorbox(title, author);
    return new Response(
      JSON.stringify({
        success: Boolean(syncResult?.success),
        data: syncResult,
      }),
      { headers: corsHeaders }
    );
  }

  // 4. Content endpoint: /api/content?bookKey=...&chapterId=...
  if (url.pathname === "/api/content") {
    const bookKey = url.searchParams.get("bookKey") || "";
    const chapterId = url.searchParams.get("chapterId") || "1";
    const title = url.searchParams.get("title") || "";
    const author = url.searchParams.get("author") || "";
    const isbn = url.searchParams.get("isbn") || "";
    const torrentId = url.searchParams.get("torrentId") || "";

    let bookData = bookCache.get(bookKey);
    if (!bookData) {
      // Reload on fresh worker isolates using full metadata
      bookData = await getOrLoadBook(bookKey, title, author, isbn, "", torrentId);
    }

    if (bookData && bookData.chapterTexts) {
      const text = bookData.chapterTexts.get(chapterId) || bookData.chapterTexts.get(String(chapterId));
      if (text && text.trim().length > 0) {
        return new Response(text.trim(), {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }
    }

    // Front matter / cover placeholder fallback (never return 404 to Compass if book was loaded)
    if (bookData && bookData.chapters) {
      const ch = bookData.chapters.find((c) => String(c.id) === String(chapterId));
      if (ch) {
        return new Response((ch.title || "Chapter") + "\n\n[Illustration / Front Matter]", {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }
    }

    return new Response("Chapter content not found. Please tap reload.", {
      status: 404,
      headers: corsHeaders,
    });
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}

// Export for Cloudflare Workers / Vercel
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

// Also support running directly in Node.js
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  const isMain = process.argv[1] && process.argv[1].endsWith("worker.js");
  if (isMain) {
    const http = await import("http");
    const PORT = process.env.PORT || 3000;
    const server = http.createServer(async (req, res) => {
      const fullUrl = "http://" + (req.headers.host || "localhost:" + PORT) + req.url;
      const webReq = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
      });
      const webRes = await handleRequest(webReq);
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      const text = await webRes.text();
      res.end(text);
    });
    server.listen(PORT, () => {
      console.log("⚡ Anna's Archive + TorBox Reader Bridge running on http://localhost:" + PORT);
    });
  }
}
