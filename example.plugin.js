// Compass eBook source plugin, minimal annotated example.
//
// This whole file runs as the body of a function that receives one argument named
// compass. There is no DOM, no fetch, no storage. Reach the network only through
// compass.http and parse HTML only through compass.parseHtml.
//
// Replace BASE and the selectors with the real site you are targeting. The structure
// (five required methods + optional tags) is what matters.

const BASE = "https://example-ebook-host.test";

async function getDoc(path) {
  const res = await compass.http(BASE + path, { responseType: "text" });
  if (!res.ok) throw new Error("http " + res.status + " for " + path);
  return compass.parseHtml(res.body);
}

// Binary gRPC source helper. Pass the raw Protobuf message—not a five-byte gRPC
// frame. Bundle the source's generated Protobuf encode/decode functions into this
// file, then use the decoded values in popular/search/detail/chapters/content.
async function grpcMessages(methodPath, requestBytes, decodeMessage) {
  const res = await compass.grpc(BASE + methodPath, requestBytes, {
    mode: "grpc", // use "grpc-web" only for a gRPC-Web endpoint
    timeoutMs: 20000,
  });
  if (!res.ok) {
    throw new Error("gRPC " + (res.grpcStatus ?? res.status) + ": " + (res.grpcMessage || methodPath));
  }
  return res.messages.map(decodeMessage);
}

// Covers MUST be absolute http(s) or Compass drops them.
function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

function cleanTitle(value) {
  return (value || "")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .replace(/\s+(?:kol|كول)$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Compass passes only tag IDs declared by tags(). Translate reserved IDs
// to the real query parameters supported by the source.
function browseQuery(tagId) {
  const params = new URLSearchParams();
  if (tagId?.startsWith("status:")) params.set("status", tagId.slice(7));
  if (tagId?.startsWith("sort:")) params.set("sort", tagId.slice(5));
  const query = params.toString();
  return query ? "&" + query : "";
}

function cardToSummary(el) {
  const link = el.querySelector("a.cover");
  const img = el.querySelector("img");
  if (!link) return null;
  const rawTitle = (link.attr("title") || el.querySelector(".title")?.text() || "").trim();
  const href = link.attr("href") || "";
  return {
    // The id is opaque to Compass and handed straight back to detail/chapters.
    id: href.replace(/^\/ebook\//, "").replace(/\/$/, ""),
    title: cleanTitle(rawTitle),
    // Metadata hints are optional. Exact IDs beat title matching when the source has them.
    seriesTitle: el.attr("data-series-title") || undefined,
    altTitles: (el.attr("data-alt-titles") || "").split("|").filter(Boolean),
    isbn: el.attr("data-isbn") || undefined,
    googleBooksId: el.attr("data-google-books-id") || undefined,
    openLibraryId: el.attr("data-open-library-id") || undefined,
    wikidataId: el.attr("data-wikidata-id") || undefined,
    anilistId: Number(el.attr("data-anilist-id")) || undefined,
    cover: abs(img?.attr("data-src") || img?.attr("src")),
    status: el.attr("data-status") || undefined,
    originalLanguage: el.attr("data-original-language") || undefined,
    genres: (el.attr("data-genres") || "").split("|").filter(Boolean),
    chapters: Number(el.attr("data-chapters")) || undefined,
    score: Number(el.attr("data-rating")) || undefined,
    trendingScore: Number(el.attr("data-trending-score")) || undefined,
    // Customize these selectors/markers for the site. Compass drops true entries.
    isFanMade:
      !!el.querySelector("[data-edition='fan'], .fan-edition") ||
      /(?:fan[ -]?made|fan edition|نسخة\s*الفان)/iu.test(rawTitle),
  };
}

const plugin = {
  // id must match the manifest id in repo.json.
  id: "example-source",
  name: "Example Source",

  // offset is an item offset (0, 48, 96, ...). tagId is set when the user filters.
  async popular(offset, tagId) {
    const page = Math.floor(offset / 48) + 1;
    const filters = browseQuery(tagId);
    const doc = await getDoc("/browse?page=" + page + filters);
    return doc.querySelectorAll(".grid .card").map(cardToSummary).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 48) + 1;
    const filters = browseQuery(tagId);
    const doc = await getDoc("/search?q=" + encodeURIComponent(query) + "&page=" + page + filters);
    return doc.querySelectorAll(".grid .card").map(cardToSummary).filter(Boolean);
  },

  async detail(id) {
    const doc = await getDoc("/ebook/" + id);
    const root = doc.querySelector(".series");
    if (!root) return null;
    return {
      id,
      title: cleanTitle(root.querySelector("h1")?.text() || id),
      // Send every identifier the site exposes. Omit unknown values; never invent IDs.
      seriesTitle: root.querySelector(".series-title")?.text(),
      altTitles: root.querySelectorAll(".alt-title").map((node) => node.text()).filter(Boolean),
      isbn: root.attr("data-isbn") || undefined,
      googleBooksId: root.attr("data-google-books-id") || undefined,
      openLibraryId: root.attr("data-open-library-id") || undefined,
      wikidataId: root.attr("data-wikidata-id") || undefined,
      anilistId: Number(root.attr("data-anilist-id")) || undefined,
      altTitle: root.querySelector(".alt-title")?.text(),
      cover: abs(root.querySelector("img.poster")?.attr("src")),
      description: root.querySelector(".summary")?.text(),
      status: root.querySelector(".status")?.text(),
      author: root.querySelector(".author")?.text(),
      chapters: Number(root.attr("data-chapters")) || undefined,
      volumes: Number(root.attr("data-volumes")) || undefined,
      originalLanguage: root.attr("data-original-language") || undefined,
      genres: root.querySelectorAll(".genres a").map((node) => node.text()).filter(Boolean),
      score: Number(root.attr("data-rating")) || undefined,
      trendingScore: Number(root.attr("data-trending-score")) || undefined,
    };
  },

  // Flat shape: return the source's explicit volume on every chapter. "0" is a
  // valid first volume. Never derive a volume from words in the chapter title.
  // Compass also accepts [{ volume: "0", chapters: [...] }, ...].
  async chapters(id) {
    const doc = await getDoc("/ebook/" + id + "/chapters");
    return doc
      .querySelectorAll(".chapter-list li a")
      .map((a, position) => {
        const href = a.attr("href") || "";
        return {
          // Encode what pageUrls will need (the chapter path) into the id.
          id: href.replace(/^\//, ""),
          chapter: a.attr("data-number") || undefined,
          // Zero-based reading position. Reverse newest-first source lists before mapping.
          position,
          title: a.querySelector(".name")?.text(),
          // Keep the site's value stable: "0", "1", "2", and so on.
          volume: a.attr("data-volume") ?? undefined,
          // Optional exact source title, e.g. "المجلد الأول: طبيعة الشيطان لا تتغير".
          volumeTitle: a.attr("data-volume-title") || undefined,
          pages: 0,
          language: "en",
          publishAt: a.querySelector(".date")?.attr("datetime") || undefined,
          // Use a number or the source's text count, such as "1.2K".
          views: a.querySelector(".views")?.text().replace(/\s*views?$/i, "").trim() || undefined,
        };
      })
      .filter((c) => c.id);
  },

  async content(chapterId) {
    const doc = await getDoc("/" + chapterId);
    // Select only real chapter blocks. querySelectorAll keeps DOM/source order;
    // never sort, reverse, or deduplicate prose (including Arabic/RTL text).
    const blocks = doc.querySelectorAll(
      ".chapter-content > p, .chapter-content > blockquote",
    );
    return blocks.map((node) => node.text().trim()).filter(Boolean).join("\n\n");
  },

  // Optional native filters. Declare only IDs the source implements.
  // Unsupported filters fall back to Compass-side metadata filtering/sorting.
  async tags() {
    return [
      { id: "status:ongoing", name: "Ongoing", group: "Status" },
      { id: "status:completed", name: "Completed", group: "Status" },
      { id: "status:hiatus", name: "Hiatus", group: "Status" },
      { id: "sort:popular", name: "Popular", group: "Sort" },
      { id: "sort:chapters", name: "Chapters", group: "Sort" },
      { id: "sort:rating", name: "Rating", group: "Sort" },
    ];
  },
};
