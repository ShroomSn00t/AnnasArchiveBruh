// TorBox + Anna's Archive Cloud Reader Bridge
// Deployable to Cloudflare Workers, Vercel, or run locally via Node.js
// Provides instantaneous 1-click chapter listing and text streaming for Compass

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
function parseEpub(entries) {
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
  const itemRegex = /<item\s+[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(opfXml)) !== null) {
    manifest.set(itemMatch[1], itemMatch[2]);
  }
  const itemRegex2 = /<item\s+[^>]*href=["']([^"']+)["'][^>]*id=["']([^"']+)["'][^>]*>/gi;
  while ((itemMatch = itemRegex2.exec(opfXml)) !== null) {
    manifest.set(itemMatch[2], itemMatch[1]);
  }

  // Spine reading order
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

  // Chapter titles from NCX
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
      id: String(index + 1),
      title,
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
      // Clean HTML to readable prose paragraphs
      const cleaned = cleanHtmlToProse(rawHtml);
      chapterTexts.set(ch.id, cleaned);
      chapterTexts.set(ch.path, cleaned);
    }
  }

  return { chapters, chapterTexts };
}

// Convert chapter XHTML into clean paragraphs
function cleanHtmlToProse(html) {
  // Extract text within paragraphs, headings, blockquotes, divs
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
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

  return text;
}

async function safeFetch(url, options = {}, timeoutMs = 4000) {
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

// Resolver: Download EPUB from Libgen / Shadow Library
async function fetchEpubFromLibgen(query) {
  try {
    const searchUrl =
      "https://libgen.li/index.php?req=" + encodeURIComponent(query) + "&res=25";
    const res = await safeFetch(searchUrl, { headers: HEADERS }, 3500);
    if (!res || !res.ok) return null;
    const html = await res.text();

    const md5Regex = /ads\.php\?md5=([a-f0-9]{32})/gi;
    let m;
    const md5s = [];
    while ((m = md5Regex.exec(html)) !== null) {
      if (!md5s.includes(m[1])) md5s.push(m[1]);
    }
    if (md5s.length === 0) return null;

    for (const md5 of md5s.slice(0, 2)) {
      const adsUrl = "https://libgen.li/ads.php?md5=" + md5;
      const adsRes = await safeFetch(adsUrl, {
        headers: { ...HEADERS, Referer: searchUrl },
      }, 3500);
      if (!adsRes || !adsRes.ok) continue;
      const adsHtml = await adsRes.text();

      const getMatch = adsHtml.match(/href=["'](get\.php\?[^"']+)["']/i);
      if (!getMatch) continue;

      const getUrl = "https://libgen.li/" + getMatch[1];
      const fileRes = await safeFetch(getUrl, {
        headers: { ...HEADERS, Referer: adsUrl },
        redirect: "follow",
      }, 6000);

      if (fileRes && fileRes.ok) {
        const ab = await fileRes.arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
          return bytes;
        }
      }
    }
  } catch (e) {
    // Continue to next resolver
  }
  return null;
}

// Resolver: Download via TorBox WebDL
async function fetchEpubViaTorbox(targetUrl) {
  if (!TORBOX_API_KEY) return null;
  try {
    const createRes = await safeFetch("https://api.torbox.app/v1/api/webdl/createwebdownload", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TORBOX_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        ...HEADERS,
      },
      body: "link=" + encodeURIComponent(targetUrl),
    }, 5000);
    if (!createRes) return null;
    const body = await createRes.json();
    const webId = body?.data?.webdownload_id || body?.data?.id || body?.data?.web_id;
    if (!webId) return null;

    const dlRes = await safeFetch(
      "https://api.torbox.app/v1/api/webdl/requestdl?token=" +
        TORBOX_API_KEY +
        "&web_id=" +
        webId +
        "&redirect=false",
      { headers: HEADERS },
      5000
    );
    if (!dlRes) return null;
    const dlBody = await dlRes.json();
    const cdnUrl = dlBody?.data?.url || dlBody?.url;
    if (!cdnUrl) return null;

    const fileRes = await safeFetch(cdnUrl, { headers: HEADERS }, 10000);
    if (fileRes && fileRes.ok) {
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;
    }
  } catch (e) {
    // Continue to next resolver
  }
  return null;
}

// Resolver: Download via Internet Archive / Gutenberg
async function fetchEpubOpen(iaId, title) {
  if (title) {
    try {
      const gUrl = "https://www.gutenberg.org/ebooks/search/?query=" + encodeURIComponent(title);
      const res = await safeFetch(gUrl, { headers: HEADERS }, 3500);
      if (res && res.ok) {
        const html = await res.text();
        const m = html.match(/\/ebooks\/(\d+)/);
        if (m) {
          const dl = "https://www.gutenberg.org/ebooks/" + m[1] + ".epub.images";
          const f = await safeFetch(dl, { headers: HEADERS, redirect: "follow" }, 6000);
          if (f && f.ok) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;
          }
        }
      }
    } catch {}
  }

  if (iaId) {
    try {
      const iaUrl = "https://archive.org/download/" + iaId + "/" + iaId + ".epub";
      const res = await safeFetch(iaUrl, { headers: HEADERS, redirect: "follow" }, 5000);
      if (res && res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;
      }
    } catch {}
  }

  return null;
}

// Core Resolver Engine
async function getOrLoadBook(bookKey, title, isbn, iaId) {
  if (bookCache.has(bookKey)) {
    return bookCache.get(bookKey);
  }

  const query = isbn || title || bookKey;

  // Try Open sources first (blazing fast, sub-second)
  let epubBytes = await fetchEpubOpen(iaId, title);

  // Next try Libgen Shadow Library
  if (!epubBytes) {
    epubBytes = await fetchEpubFromLibgen(query);
  }

  // Next try TorBox WebDL
  if (!epubBytes && iaId && TORBOX_API_KEY) {
    epubBytes = await fetchEpubViaTorbox("https://archive.org/details/" + iaId);
  }

  if (!epubBytes) {
    epubBytes = await fetchEpubOpen(iaId, title);
  }

  if (!epubBytes) return null;

  const entries = await unzipEpub(epubBytes);
  const { chapters, chapterTexts } = parseEpub(entries);

  const bookData = {
    bookKey,
    title,
    chapters,
    chapterTexts,
  };

  bookCache.set(bookKey, bookData);
  return bookData;
}

// Automatically sync book to user's TorBox account
async function syncToTorbox(title, iaId, author) {
  if (!TORBOX_API_KEY) return null;
  try {
    let targetIa = iaId;
    if (!targetIa && title) {
      const query = author ? title + " " + author : title;
      const sUrl =
        "https://archive.org/advancedsearch.php?q=mediatype:texts+AND+(" +
        encodeURIComponent(query) +
        ")&fl[]=identifier,title&rows=3&page=1&output=json";
      const sRes = await safeFetch(sUrl, { headers: HEADERS }, 5000);
      if (sRes && sRes.ok) {
        const sData = await sRes.json();
        if (sData?.response?.docs?.[0]?.identifier) {
          targetIa = sData.response.docs[0].identifier;
        }
      }
    }

    if (targetIa) {
      const link = "https://archive.org/details/" + targetIa;
      const createRes = await safeFetch("https://api.torbox.app/v1/api/webdl/createwebdownload", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + TORBOX_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
          ...HEADERS,
        },
        body: "link=" + encodeURIComponent(link),
      }, 8000);
      if (createRes && createRes.ok) {
        return await createRes.json();
      }
    }
  } catch (e) {
    // Non-blocking sync
  }
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
        service: "Anna's Archive + TorBox Reader Bridge",
        torboxConnected: Boolean(TORBOX_API_KEY),
        cachedBooks: bookCache.size,
      }),
      { headers: corsHeaders }
    );
  }

  // 2. Chapters endpoint: /api/chapters?q=...&title=...&isbn=...
  if (url.pathname === "/api/chapters") {
    const q = url.searchParams.get("q") || "";
    const title = url.searchParams.get("title") || q;
    const author = url.searchParams.get("author") || "";
    const isbn = url.searchParams.get("isbn") || "";
    const iaId = url.searchParams.get("ia") || "";
    const bookKey = (isbn || title || q).toLowerCase().replace(/[^a-z0-9]/g, "");

    // Automatically trigger TorBox WebDL so book populates in user's TorBox dashboard
    const syncPromise = TORBOX_API_KEY ? syncToTorbox(title, iaId, author) : null;
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
        getOrLoadBook(bookKey, title, isbn, iaId),
      ]);

      if (!bookData || !bookData.chapters || bookData.chapters.length === 0) {
        return new Response(
          JSON.stringify({
            error: "Book not found or could not be decrypted",
            chapters: [],
            torbox: syncResult,
          }),
          { status: 404, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          bookKey,
          title: bookData.title || title,
          torboxSynced: Boolean(syncResult?.success),
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

  // 3. Manual TorBox sync endpoint: /api/sync-torbox?title=...&author=...
  if (url.pathname === "/api/sync-torbox") {
    const title = url.searchParams.get("title") || "";
    const author = url.searchParams.get("author") || "";
    const iaId = url.searchParams.get("ia") || "";
    const syncResult = await syncToTorbox(title, iaId, author);
    return new Response(
      JSON.stringify({
        success: Boolean(syncResult?.success),
        detail: syncResult?.detail,
        data: syncResult?.data,
      }),
      { headers: corsHeaders }
    );
  }

  // 3. Content endpoint: /api/content?bookKey=...&chapterId=...
  if (url.pathname === "/api/content") {
    const bookKey = url.searchParams.get("bookKey") || "";
    const chapterId = url.searchParams.get("chapterId") || "1";

    const bookData = bookCache.get(bookKey);
    if (!bookData) {
      // Attempt re-fetch
      const title = url.searchParams.get("title") || bookKey;
      const reloaded = await getOrLoadBook(bookKey, title, "", "");
      if (reloaded && reloaded.chapterTexts.has(chapterId)) {
        return new Response(reloaded.chapterTexts.get(chapterId), {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }

      return new Response("Chapter text unavailable. Please tap reload.", {
        status: 404,
        headers: corsHeaders,
      });
    }

    const text = bookData.chapterTexts.get(chapterId) || "Chapter content not found.";
    return new Response(text, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
      },
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
