// santehnik.dp.ua — "Markdown for AI" Worker
//
// DIY replacement for TidyCustoms' paid "Markdown for AI" + "LLMS.txt
// Generator" Publii plugins. Deliberately a *separate* Cloudflare Worker
// with a Route bound to the santehnik.dp.ua zone, NOT anything inside the
// Publii-managed repo — Publii's own sync wipes any file in that repo it
// didn't render itself (same reasoning as the reviews backend living in
// its own project). This Worker adds no files to any repo Publii touches;
// it converts pages on the fly at the edge.
//
// Routes this Worker must be bound to (see wrangler.toml [[routes]]):
//   santehnik.dp.ua/*.md      -> clean Markdown version of any page
//   santehnik.dp.ua/llms.txt  -> content index (built from sitemap.xml)
// Anything else falls through to the normal origin (GitHub Pages /
// Cloudflare Pages, whatever is serving the site) untouched.

const ORIGIN_TIMEOUT_MS = 8000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/llms.txt') {
        return await handleLlmsTxt(url);
      }
      if (url.pathname.endsWith('.md')) {
        return await handleMarkdown(url);
      }
    } catch (err) {
      return new Response('AI-markdown worker error: ' + (err && err.message ? err.message : String(err)), {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }

    // Shouldn't normally be reached if the Worker Route is scoped to just
    // the two patterns above, but fall through to origin just in case.
    return fetch(request);
  }
};

async function handleMarkdown(url) {
  // Publii renders pretty URLs (e.g. /avariynyy-vyklyk-santehnika-dnipro)
  // to actual .html files on disk/in the deployed repo — so the origin
  // document for /page.md is /page.html. Also accept an optional
  // trailing slash before .md (/slug/.md), defensively, in case any
  // future <link rel="alternate"> tag ever renders a trailing-slash
  // style URL. Special-case the homepage: /index.md must resolve to
  // /index.html, not the invalid /.html (head.hbs links to /index.md
  // for exactly this reason).
  let htmlPath = url.pathname.replace(/\/?\.md$/, '.html');
  if (htmlPath === '/.html' || htmlPath === '' || htmlPath === '/index.html') {
    htmlPath = '/index.html';
  }
  const htmlUrl = new URL(htmlPath, url.origin);

  const originRes = await fetchWithTimeout(htmlUrl.toString());
  if (!originRes || !originRes.ok) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const html = await originRes.text();
  const { title, canonical, description, body } = await convertToMarkdown(html);

  const finalCanonical = canonical || (htmlUrl.toString());
  const mdParts = [
    `# ${title || url.pathname}`,
    description ? `\n> ${description}` : '',
    `\nSource: ${finalCanonical}`,
    '\n---\n',
    body
  ].filter((p) => p !== '');

  return new Response(mdParts.join('\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-generated-by': 'santehnikdp-ai-md worker'
    }
  });
}

async function handleLlmsTxt(url) {
  const sitemapUrl = new URL('/sitemap.xml', url.origin);
  const res = await fetchWithTimeout(sitemapUrl.toString());

  const lines = [
    '# Сантехнік Дніпро',
    '',
    '> Аварійний виклик сантехніка, ремонт водопроводу, каналізації, опалення у Дніпрі. Цілодобово.',
    '',
    `Головна: ${url.origin}/`,
    `Головна (RU): ${url.origin}/ru`,
    '',
    '## Сторінки'
  ];

  if (res && res.ok) {
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    for (const loc of locs) {
      // Homepage in sitemap.xml is the bare origin (no .html to swap) --
      // point it at /index.md instead of linking to itself.
      const mdLink = loc.endsWith('.html')
        ? loc.replace(/\.html$/, '.md')
        : new URL('/index.md', loc).toString();
      lines.push(`- ${loc} -> ${mdLink}`);
    }
  } else {
    lines.push('', '(sitemap.xml тимчасово недоступний — список сторінок не згенеровано)');
  }

  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600'
    }
  });
}

async function fetchWithTimeout(u) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetch(u, { signal: controller.signal, cf: { cacheTtl: 300 } });
  } catch (err) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Strips theme chrome (nav, header, footer, scripts, the works/reviews/
// cta-call widgets, breadcrumbs) and converts what's left inside <main>
// into plain Markdown, using Cloudflare's native HTMLRewriter (streaming
// parser built into the Workers runtime -- no npm HTML/DOM library needed,
// which matters here since most of those expect a real DOMParser that
// isn't available in the Workers runtime).
async function convertToMarkdown(rawHtml) {
  // Cloudflare's HTMLRewriter (lol-html) doesn't reliably parse HTML5's
  // SVG "foreign content" self-closing syntax (<use ... />, <path ... />,
  // etc.) -- confirmed live on trendchoicehub.com's footer social icons
  // (<svg><use xlink:href="..."/></svg>), which failed with "Parser
  // error: No end tag" on every page until normalized. This theme likely
  // has the same pattern in its own share-button icons, so apply the
  // same fix here defensively even though it hasn't been confirmed to
  // bite on this specific site yet.
  const html = rawHtml.replace(
    /<(use|path|circle|rect|line|polygon|polyline|ellipse|stop|g)((?:[^>"]|"[^"]*")*?)\/>/g,
    '<$1$2></$1>'
  );

  let title = '';
  let canonical = '';
  let description = '';
  const parts = [];
  const push = (s) => parts.push(s);

  // Tags/classes to strip entirely (theme chrome, not article content).
  // Checked FIRST inside the single "main *" handler below, and only
  // that one handler is registered for this selector -- two separate
  // .on() calls (one to remove(), one to build markdown) turned out to
  // NOT guarantee the removal fires before the content handler sees the
  // same element (confirmed live: .cta-call text and a breadcrumbs
  // JSON-LD <script> both leaked into the output on the first deploy).
  // Doing the remove-or-emit decision inside one handler for the same
  // element sidesteps that ordering problem entirely.
  const REMOVE_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'form', 'nav', 'footer']);
  const REMOVE_CLASS_RE = /(^|\s)(top|lang-switcher|site-name|home-icon|works|reviews|breadcrumbs|cta-call|navbar_mobile_sidebar|navbar_mobile_sidebar__overlay)(\s|--|$)/;

  // el.remove() alone turned out NOT to reliably suppress the separate
  // text() callback for descendants (confirmed live: a .cta-call link's
  // own [text](href) syntax stopped appearing, but its plain text still
  // leaked through) -- so track "are we inside a subtree we're
  // stripping" explicitly via a depth counter instead of trusting
  // remove() to do that on its own.
  let skipDepth = 0;

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(t) { title += t.text; }
    })
    .on('link[rel="canonical"]', {
      element(el) { canonical = el.getAttribute('href') || canonical; }
    })
    .on('meta[name="description"]', {
      element(el) { description = el.getAttribute('content') || description; }
    })
    .on('main *', {
      element(el) {
        const tag = el.tagName;
        const cls = el.getAttribute('class') || '';
        if (REMOVE_TAGS.has(tag) || REMOVE_CLASS_RE.test(cls)) {
          el.remove();
          skipDepth++;
          el.onEndTag(() => { skipDepth--; return null; });
          return;
        }
        if (skipDepth > 0) return;
        if (/^h[1-6]$/.test(tag)) {
          push('\n' + '#'.repeat(Number(tag[1])) + ' ');
          el.onEndTag(() => { push('\n\n'); return null; });
        } else if (tag === 'p' || tag === 'figcaption') {
          el.onEndTag(() => { push('\n\n'); return null; });
        } else if (tag === 'a') {
          const href = el.getAttribute('href') || '';
          push('[');
          el.onEndTag(() => { push(`](${href})`); return null; });
        } else if (tag === 'strong' || tag === 'b') {
          push('**');
          el.onEndTag(() => { push('**'); return null; });
        } else if (tag === 'em' || tag === 'i') {
          push('_');
          el.onEndTag(() => { push('_'); return null; });
        } else if (tag === 'li') {
          push('- ');
          el.onEndTag(() => { push('\n'); return null; });
        } else if (tag === 'ul' || tag === 'ol') {
          el.onEndTag(() => { push('\n'); return null; });
        } else if (tag === 'blockquote') {
          push('> ');
          el.onEndTag(() => { push('\n\n'); return null; });
        } else if (tag === 'img') {
          const alt = el.getAttribute('alt') || '';
          const src = el.getAttribute('src') || '';
          if (src) push(`![${alt}](${src})`);
        } else if (tag === 'br') {
          push('\n');
        }
      },
      text(t) {
        if (skipDepth > 0) return;
        // Collapse whitespace within a text chunk but keep the chunk
        // itself -- structural newlines come from the element handlers
        // above, not from raw whitespace in the source HTML.
        push(t.text.replace(/[ \t\n\r]+/g, ' '));
      }
    });

  const transformed = rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  // Drive the stream to completion -- we don't use the transformed body
  // itself (all real output is collected into `parts` via the handlers
  // above), just need HTMLRewriter to finish walking the document.
  await transformed.arrayBuffer();

  const body = parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: title.trim(), canonical: canonical.trim(), description: description.trim(), body };
}
