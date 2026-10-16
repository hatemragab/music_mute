# Public search and AI discovery

MusicMute has three public indexable pages: the English product page at
`https://music-mute.com/`, its Arabic equivalent at `/ar/`, and the browser app
entry at `https://app.music-mute.com/`. The product site explains capabilities
and availability; the app entry explains the browser workflow and sign-in.

## Content and crawl behavior

- The landing build renders the actual React page into both HTML entries, then
  hydrates the same component. English and Arabic content, headings, links, FAQs
  and platform caveats are available without JavaScript. URL language stays
  deterministic; browser language and saved preferences do not change the
  language under an English canonical. Language links navigate between URLs.
- Each landing language has its own canonical and reciprocal `en`, `ar` and
  `x-default` alternates. Sitemaps list only canonical public URLs. The known
  `www` host and `index.html` aliases permanently redirect, preserving queries.
- The app entry contains a semantic static introduction that React replaces
  when ready, with corresponding English/Arabic signed-out product copy. App
  account, auth, jobs, library, player and settings routes receive `noindex`
  HTTP headers and HTML metadata; the server removes public canonical, social
  and application schema from those documents. Auth and API authorization still
  protect private data; indexing directives are not access controls.
- Both sites have descriptive titles, descriptions, Open Graph/Twitter cards,
  local 1200 by 630 PNG artwork and truthful application/site structured data.
  Landing FAQ schema derives from the same translated visible FAQ text. There
  are no invented ratings, prices, release links or performance guarantees.
- `robots.txt` permits crawling, including search and AI search crawlers through
  the wildcard group. Private app routes remain crawlable so engines can read
  `noindex`. Robots files, sitemaps and `llms.txt` use their correct MIME types.
- `llms.txt` is an optional public reading guide with product links and limits,
  not an indexing protocol, permission grant or ranking mechanism.

## IndexNow

Set optional server-only `INDEXNOW_KEY` independently for each CapRover app.
Use 8-128 letters, digits or dashes. Invalid configured values fail startup.
The server serves `/{key}.txt` as the exact plain-text verification value for
GET/HEAD with `noindex` and `no-store`; it stays outside browser configuration
and source control. Leave the existing environment values intact when updating.

After deployment, verify the key URL and public canonical URLs, then POST to
`https://api.indexnow.org/indexnow` with `host`, `key`, `keyLocation` and
`urlList`. Submit only changed canonical public pages belonging to that host:
landing `/` and `/ar/`, or app `/`. A `200` confirms receipt and a `202` means
key validation is pending. Neither establishes indexing or ranking. Notify again
when public content changes; do not submit authenticated URLs.

## Verification and operations

Run each component's documented formatting, lint, type, unit, build, server and
installed-desktop-Chrome suites, plus landing packaging tests. The browser checks
cover no-JavaScript content, language/RTL, hydration, social/schema metadata and
private-route behavior. Rebuild allowlisted archives from the intended deployment
tree; a clean Git checkout can omit existing locally deployed authentication
fixes. Never package credentials, dotenv files, private media or unrelated
components. Record the source/archive hashes and preserve existing app settings.

On production, read back the active CapRover image, one running instance and
completed build. Check HTTPS DNS, redirects, canonical/hreflang, rendered body,
robots, sitemaps, schema, image dimensions, key verification and private noindex.
User-agent HTTP probes are useful transport checks but do not prove requests
from an engine's verified IP range. Retain CDN protections and inspect crawler
access separately if engines report a challenge or blocked request.

Verify the domain in Google Search Console and submit both sitemaps. Monitor URL
Inspection, indexing coverage and Core Web Vitals there. Bing Webmaster Tools
and IndexNow complement sitemap discovery. Do not claim search inclusion from
a deploy, submitted sitemap, accepted notification or a local browser test.

## Official references reviewed on 2026-10-16

- [Google SEO fundamentals](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
- [Google AI features and websites](https://developers.google.com/search/docs/appearance/ai-features)
- [Google localized pages](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
- [OpenAI search crawler guidance](https://developers.openai.com/api/docs/bots)
- [Bing webmaster guidelines](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a)
- [IndexNow protocol](https://www.indexnow.org/documentation)

Google says ordinary SEO practices apply to its AI features, and no special
AI text file or schema is required. Search visibility depends on crawling,
indexing, relevance and the engine's own decisions; it cannot be guaranteed.
