#!/usr/bin/env node
/**
 * ProspectAI — Daily article generator
 * Runs in GitHub Actions. Picks the next pending topic, asks Claude to write
 * the review, renders the article page, updates the manifest, homepage
 * (LATEST + TICKER blocks), and sitemap. The workflow then opens a PR and
 * pings Discord for approval. Merging the PR publishes everything.
 *
 * Required env: ANTHROPIC_API_KEY
 * No npm dependencies — plain Node 20+.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = "https://gaviningit.github.io/prospectai";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}

// ---------- 1. Pick the next topic ----------
const topicsPath = `${ROOT}data/topics.json`;
const topicsDoc = JSON.parse(readFileSync(topicsPath, "utf8"));
const topic = topicsDoc.topics.find((t) => t.status === "pending");
if (!topic) {
  console.error("No pending topics left in data/topics.json — add more.");
  process.exit(1);
}
console.log(`Topic: ${topic.topic} [${topic.categoryLabel}]`);

// ---------- 2. Ask Claude for the article ----------
const prompt = `You are the senior reviewer at ProspectAI, an independent site that publishes honest, hands-on style reviews of AI tools. Write a complete review article for this topic:

"${topic.topic}"

Category: ${topic.categoryLabel}

Requirements:
- 900-1300 words, written for a smart general reader. Direct, concrete, zero fluff.
- Honest tone: name real strengths AND real weaknesses. Include realistic pricing (label it "at the time of writing").
- Use real, verifiable facts about the actual product(s). If unsure of a detail, phrase it cautiously rather than inventing specifics.
- Structure: a strong intro (no heading), then 4-6 sections with h2 headings, ending with a verdict.
- Where the article recommends a tool, mention its official website by name (links will be added separately).
- Do NOT use phrases like "in conclusion", "it's worth noting", "game-changer".

Return ONLY a valid JSON object, no markdown fences, no text before or after:
{
  "title": "final article headline",
  "slug": "url-friendly-slug",
  "excerpt": "one compelling sentence describing the article",
  "read_time": "X min read",
  "intro_html": "<p>...</p><p>...</p> (2-3 intro paragraphs)",
  "sections": [
    { "heading": "section heading", "html": "<p>...</p> (section body, may include <ul><li>, <strong>, <h3>)" }
  ],
  "pros": ["...", "..."],
  "cons": ["...", "..."],
  "verdict_html": "<p>2-4 sentence final verdict</p>"
}`;

async function callClaude() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

function parseArticle(raw) {
  // Strip accidental code fences and find the JSON object
  let s = raw.trim();
  if (s.startsWith("```")) s = s.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON object in model output");
  return JSON.parse(s.slice(start, end + 1));
}

let article;
try {
  article = parseArticle(await callClaude());
} catch (e) {
  console.error("First attempt failed, retrying once:", e.message);
  article = parseArticle(await callClaude());
}

// Sanitize slug ourselves — never trust model output for file paths
const slug = (article.slug || article.title)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 60);

const today = new Date().toISOString().slice(0, 10);
const monthYear = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
const cat = topic.category;
const catLabel = topic.categoryLabel;

// ---------- 3. Render the article page ----------
const manifestPath = `${ROOT}data/articles.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Pick 2 related articles (same category first, then newest)
const related = [...manifest.articles]
  .sort((a, b) => (b.category === cat) - (a.category === cat) || b.date.localeCompare(a.date))
  .slice(0, 2);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sectionsHtml = article.sections
  .map((s) => `      <h2>${esc(s.heading)}</h2>\n      ${s.html}`)
  .join("\n\n");

const prosConsHtml =
  article.pros && article.pros.length
    ? `      <div class="tool-pros-cons">
        <div class="pros">
          <div class="pros-head">What we liked</div>
          <ul>${article.pros.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
        </div>
        <div class="cons">
          <div class="cons-head">What we didn't</div>
          <ul>${article.cons.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
        </div>
      </div>`
    : "";

const relatedHtml = related
  .map(
    (r) => `        <a href="${r.slug}.html" class="related-card">
          <div class="related-thumb hero-${r.category}"></div>
          <div class="related-headline">${esc(r.title)}</div>
          <div class="related-meta">${esc(r.categoryLabel)} · ${esc(r.readTime)}</div>
        </a>`
  )
  .join("\n");

const articleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(article.title)} — ProspectAI</title>
  <meta name="description" content="${esc(article.excerpt)}" />
  <meta property="og:title" content="${esc(article.title)}" />
  <meta property="og:description" content="${esc(article.excerpt)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${SITE}/articles/${slug}.html" />
  <link rel="canonical" href="${SITE}/articles/${slug}.html" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236c4cf4'/%3E%3Cstop offset='1' stop-color='%2300c08b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100' height='100' rx='22' fill='url(%23g)'/%3E%3Ctext x='50' y='68' font-family='Arial,sans-serif' font-weight='bold' font-size='52' fill='white' text-anchor='middle'%3EP%3C/text%3E%3C/svg%3E" />
  <link rel="stylesheet" href="../article.css?v=4" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": ${JSON.stringify(article.title)},
    "description": ${JSON.stringify(article.excerpt)},
    "datePublished": "${today}",
    "author": { "@type": "Organization", "name": "ProspectAI Editorial" },
    "publisher": { "@type": "Organization", "name": "ProspectAI" }
  }
  </script>
</head>
<body>

  <nav class="nav">
    <div class="nav-inner">
      <a href="../index.html" class="nav-logo">Prospect<span class="logo-ai">AI</span></a>
      <a href="../reviews.html" class="nav-back">← Back to reviews</a>
      <a href="../index.html#newsletter" class="nav-newsletter">Free Newsletter</a>
    </div>
  </nav>

  <div class="article-wrap">

    <div class="breadcrumb">
      <a href="../index.html">Home</a>
      <span class="breadcrumb-sep">›</span>
      <a href="../reviews.html?cat=${cat}">${esc(catLabel)}</a>
      <span class="breadcrumb-sep">›</span>
      <span>${esc(article.title.length > 40 ? article.title.slice(0, 40) + "…" : article.title)}</span>
    </div>

    <div class="article-header">
      <span class="tag tag-${cat}">${esc(catLabel)}</span>
      <h1 class="article-title">${esc(article.title)}</h1>
      <p class="article-deck">${esc(article.excerpt)}</p>
      <div class="article-meta-bar">
        <span><strong>ProspectAI Editorial</strong></span>
        <div class="meta-dot"></div>
        <span>${monthYear}</span>
        <div class="meta-dot"></div>
        <span>${esc(article.read_time)}</span>
        <div class="disclosure-badge">✓ Affiliate disclosure</div>
      </div>
    </div>

    <div class="article-hero-img hero-${cat}"></div>

    <div class="article-body">

      ${article.intro_html}

${sectionsHtml}

${prosConsHtml}

      <div class="verdict">
        <div class="verdict-label">The Verdict</div>
        ${article.verdict_html}
      </div>

      <div class="callout">
        <p><strong>Disclosure:</strong> some links on this page may be affiliate links — if you sign up through them we may earn a commission at no cost to you. This never influences our verdicts. <a href="../disclosure.html">Read our full disclosure</a>.</p>
      </div>

    </div>

    <div class="related-section">
      <div class="related-title">Keep Reading</div>
      <div class="related-grid">
${relatedHtml}
      </div>
    </div>

  </div>

  <footer>
    <div class="container">
      <p class="footer-logo-sm">Prospect<span class="logo-ai">AI</span></p>
      <p class="footer-copy">© 2026 ProspectAI. We may earn commissions from links on this site. This never influences our editorial opinions. Nothing here is financial advice.</p>
    </div>
  </footer>

</body>
</html>
`;

writeFileSync(`${ROOT}articles/${slug}.html`, articleHtml);
console.log(`Wrote articles/${slug}.html`);

// ---------- 4. Update manifest ----------
manifest.articles.unshift({
  slug,
  title: article.title,
  category: cat,
  categoryLabel: catLabel,
  excerpt: article.excerpt,
  readTime: article.read_time,
  date: today,
});
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ---------- 5. Update homepage LATEST + TICKER blocks ----------
const indexPath = `${ROOT}index.html`;
let index = readFileSync(indexPath, "utf8");

const cardHtml = (a) => `        <a href="articles/${a.slug}.html" class="article-card">
          <div class="article-thumb thumb-${a.category}"></div>
          <div class="article-body">
            <span class="tag tag-${a.category}">${esc(a.categoryLabel)}</span>
            <h3 class="article-headline">${esc(a.title)}</h3>
            <p class="article-excerpt">${esc(a.excerpt)}</p>
            <div class="card-meta"><span>${esc(a.readTime)}</span><div class="meta-dot"></div><span>${new Date(a.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span></div>
          </div>
        </a>`;

const latest = manifest.articles.slice(0, 6).map(cardHtml).join("\n");
index = index.replace(
  /<!-- LATEST:START -->[\s\S]*?<!-- LATEST:END -->/,
  `<!-- LATEST:START -->\n${latest}\n        <!-- LATEST:END -->`
);

const tickerItem = (a, label) =>
  `      <a href="articles/${a.slug}.html" class="ticker-item"><b>${label}</b> ${esc(a.title)}</a>`;
const ticker = manifest.articles
  .slice(0, 5)
  .map((a, i) => tickerItem(a, i === 0 ? "NEW" : a.title.includes(" vs ") ? "VS" : "REVIEW"))
  .join("\n");
index = index.replace(
  /<!-- TICKER:START -->[\s\S]*?<!-- TICKER:END -->/,
  `<!-- TICKER:START -->\n${ticker}\n      <!-- TICKER:END -->`
);

writeFileSync(indexPath, index);
console.log("Updated index.html (latest grid + ticker)");

// ---------- 6. Regenerate sitemap ----------
const staticPages = ["", "reviews.html", "about.html", "disclosure.html", "privacy.html"];
const urls = [
  ...staticPages.map((p) => `${SITE}/${p}`),
  ...manifest.articles.map((a) => `${SITE}/articles/${a.slug}.html`),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
writeFileSync(`${ROOT}sitemap.xml`, sitemap);
console.log("Regenerated sitemap.xml");

// ---------- 7. Mark topic used ----------
topic.status = "done";
topic.publishedSlug = slug;
topic.publishedDate = today;
writeFileSync(topicsPath, JSON.stringify(topicsDoc, null, 2) + "\n");

// ---------- 8. Expose outputs for the workflow ----------
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `slug=${slug}`,
      `title=${article.title.replace(/\n/g, " ")}`,
      `excerpt=${article.excerpt.replace(/\n/g, " ")}`,
      `category=${catLabel}`,
      `read_time=${article.read_time}`,
      "",
    ].join("\n")
  );
}
console.log("Done.");
