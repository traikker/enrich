#!/usr/bin/env node
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import dns from 'node:dns/promises';

type SourceTier =
  | 'jsonld'
  | 'mailto'
  | 'staff_card'
  | 'author_page'
  | 'about_page'
  | 'contact_page'
  | 'text'
  | 'inferred';

interface Evidence {
  url: string;
  sourceTier: SourceTier;
  freshness: number; // 0..1
}

interface ContactCandidate {
  name?: string;
  title?: string;
  email?: string;
  socials: Set<string>;
  evidence: Evidence[];
}

interface FinalContact {
  name?: string;
  title?: string;
  email?: string;
  score: number;
  reasons: string[];
}

interface PlatformSocials {
  facebook?: string;
  instagram?: string;
  linkedin?: string;
  x?: string;
  tiktok?: string;
}

interface PageProcessResult {
  current: string;
  candidates: ContactCandidate[];
  socials: string[];
  discovered: string[];
  usedRender: boolean;
  durationMs: number;
  skipped?: 'fetch_failed';
}

const SOCIAL_HOSTS = [
  'linkedin.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'github.com',
  'medium.com',
  'crunchbase.com'
];

const PRIORITY_PATHS = [
  '/',
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
  '/team',
  '/leadership',
  '/press',
  '/authors',
  '/people',
  '/company',
  '/staff'
];

// Fast mode defaults
const FETCH_TIMEOUT_MS = 5000;
const RENDER_TIMEOUT_MS = 10000;
const RENDER_WAIT_MS = 800;
const MAX_PAGES = 24;
const MAX_RENDERED_PAGES = 1;
const MAX_SITEMAP_PRIORITY = 24;
const MAX_SITEMAP_GENERAL = 8;
const MAX_NESTED_SITEMAPS = 2;
const MAX_DISCOVERED_PER_PAGE = 12;
const FETCH_CONCURRENCY = 5;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function progress(message: string): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${message}`);
}

function normalizeDomain(input: string): { baseUrl: URL; domain: string } {
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const baseUrl = new URL(withProtocol);
  const domain = baseUrl.hostname.replace(/^www\./i, '').toLowerCase();
  baseUrl.hash = '';
  return { baseUrl, domain };
}

function isSameDomain(target: URL, domain: string): boolean {
  const host = target.hostname.replace(/^www\./i, '').toLowerCase();
  return host === domain;
}

function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/[),.;:]+$/g, '');
}

function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_RE) ?? [];
  return Array.from(new Set(found.map(sanitizeEmail)));
}

function sourceTierFromPath(pathname: string): SourceTier {
  const p = pathname.toLowerCase();
  if (p.includes('contact')) return 'contact_page';
  if (p.includes('author')) return 'author_page';
  if (p.includes('about') || p.includes('team') || p.includes('leadership') || p.includes('staff')) return 'about_page';
  return 'text';
}

function sourceWeight(tier: SourceTier): number {
  switch (tier) {
    case 'jsonld': return 0.92;
    case 'mailto': return 0.87;
    case 'staff_card': return 0.78;
    case 'author_page': return 0.72;
    case 'about_page': return 0.69;
    case 'contact_page': return 0.67;
    case 'text': return 0.58;
    case 'inferred': return 0.35;
  }
}

function toAbsoluteLinks(base: URL, links: string[]): string[] {
  const out = new Set<string>();
  for (const href of links) {
    try {
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
      const u = new URL(href, base);
      u.hash = '';
      out.add(u.toString());
    } catch {
      // ignore
    }
  }
  return [...out];
}

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; EnrichBot/1.0; +https://example.org/bot)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchRendered(url: string): Promise<string | null> {
  try {
    // @ts-ignore - optional dependency loaded only when JS rendering is needed
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; EnrichBot/1.0)' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    await page.waitForTimeout(RENDER_WAIT_MS);
    const html = await page.content();
    await browser.close();
    return html;
  } catch {
    return null;
  }
}

function getFreshness($: ReturnType<typeof load>): number {
  const year = new Date().getFullYear().toString();
  const body = $('body').text();
  if (body.includes(year)) return 1;
  if (body.includes((new Date().getFullYear() - 1).toString())) return 0.8;
  const dt = $('time[datetime]').first().attr('datetime');
  if (!dt) return 0.4;
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return 0.4;
  const ageDays = (Date.now() - d.getTime()) / 86400000;
  if (ageDays < 365) return 1;
  if (ageDays < 730) return 0.7;
  return 0.3;
}

function likelyName(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.length > 60 || t.length < 4) return false;
  if (/\d/.test(t)) return false;
  if (!/^[A-Z][a-z]+(?:\s+[A-Z][a-z'\-]+){1,3}$/.test(t)) return false;
  return true;
}

function likelyTitle(s: string): boolean {
  return /(ceo|cto|coo|cfo|founder|director|manager|head of|vp|president|editor|author|lead|engineer|marketing|sales)/i.test(s);
}

function scoreSocialOwnership(url: string, domain: string): number {
  const bare = domain.split('.')[0];
  return url.toLowerCase().includes(bare) ? 0.05 : 0;
}

function parseJsonLdPeople(
  $: ReturnType<typeof load>,
  pageUrl: URL,
  freshness: number
): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      const nodes = flattenJsonLd(parsed);
      for (const node of nodes) {
        const type = `${node['@type'] ?? ''}`.toLowerCase();
        if (!(type.includes('person') || type.includes('organization'))) continue;
        const socials = new Set<string>();
        const sameAs = node.sameAs;
        if (Array.isArray(sameAs)) {
          for (const x of sameAs) {
            if (typeof x === 'string') socials.add(x);
          }
        }
        const email = typeof node.email === 'string' ? sanitizeEmail(node.email.replace(/^mailto:/i, '')) : undefined;
        const name = typeof node.name === 'string' ? node.name.trim() : undefined;
        const title = typeof node.jobTitle === 'string' ? node.jobTitle.trim() : undefined;
        if (!name && !email && socials.size === 0) continue;
        out.push({
          name,
          title,
          email,
          socials,
          evidence: [{ url: pageUrl.toString(), sourceTier: 'jsonld', freshness }]
        });
      }
    } catch {
      // tolerate broken JSON-LD
    }
  });
  return out;
}

function flattenJsonLd(node: any): any[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(flattenJsonLd);
  if (node['@graph'] && Array.isArray(node['@graph'])) return node['@graph'].flatMap(flattenJsonLd);
  return [node];
}

function extractSocialLinks($: ReturnType<typeof load>, base: URL): string[] {
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    links.push(href);
  });
  const abs = toAbsoluteLinks(base, links);
  return abs.filter((u) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return SOCIAL_HOSTS.some((s) => h.includes(s));
    } catch {
      return false;
    }
  });
}

function extractMailto($: ReturnType<typeof load>): string[] {
  const out = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const email = href.replace(/^mailto:/i, '').split('?')[0];
    if (email) out.add(sanitizeEmail(email));
  });
  return [...out];
}

function pickPlatformSocials(urls: string[]): PlatformSocials {
  const picks: PlatformSocials = {};
  for (const raw of urls) {
    let host = '';
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }

    if (!picks.facebook && host.includes('facebook.com')) picks.facebook = raw;
    if (!picks.instagram && host.includes('instagram.com')) picks.instagram = raw;
    if (!picks.linkedin && host.includes('linkedin.com')) picks.linkedin = raw;
    if (!picks.tiktok && host.includes('tiktok.com')) picks.tiktok = raw;
    if (!picks.x && (host.includes('x.com') || host.includes('twitter.com'))) picks.x = raw;

    if (picks.facebook && picks.instagram && picks.linkedin && picks.x && picks.tiktok) break;
  }
  return picks;
}

function parseStaffCards(
  $: ReturnType<typeof load>,
  pageUrl: URL,
  fallbackTier: SourceTier,
  freshness: number
): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const selectors = [
    '[class*="team"] [class*="card"]',
    '[class*="staff"] [class*="card"]',
    '[class*="author"]',
    '[class*="person"]',
    'article',
    '.bio'
  ];

  const seen = new Set<any>();
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const block = $(el);
      const text = block.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length < 20) return;

      const email = extractEmails(text)[0];
      const name = [
        block.find('h1,h2,h3,h4,strong').first().text().trim(),
        block.find('[class*="name"]').first().text().trim()
      ].find(likelyName);

      const titleCand = [
        block.find('[class*="title"],[class*="role"],[class*="position"]').first().text().trim(),
        text.split('|')[1]?.trim(),
        text.split('—')[1]?.trim()
      ].find((s) => !!s && likelyTitle(s));

      const socials = new Set<string>();
      block.find('a[href]').each((_, a) => {
        const href = $(a).attr('href') ?? '';
        const abs = toAbsoluteLinks(pageUrl, [href]);
        for (const u of abs) {
          try {
            const host = new URL(u).hostname.toLowerCase();
            if (SOCIAL_HOSTS.some((s) => host.includes(s))) socials.add(u);
          } catch {
            // ignore
          }
        }
      });

      if (!name && !email && socials.size === 0) return;
      out.push({
        name,
        title: titleCand,
        email,
        socials,
        evidence: [{ url: pageUrl.toString(), sourceTier: email ? 'staff_card' : fallbackTier, freshness }]
      });
    });
  }

  return out;
}

function parseVisibleTextContacts(
  $: ReturnType<typeof load>,
  pageUrl: URL,
  tier: SourceTier,
  freshness: number
): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const text = $('body').text().replace(/\s+/g, ' ');
  const emails = extractEmails(text);

  for (const email of emails) {
    const idx = text.indexOf(email);
    const left = Math.max(0, idx - 140);
    const right = Math.min(text.length, idx + email.length + 140);
    const window = text.slice(left, right);

    const nameMatch = window.match(/[A-Z][a-z]+\s+[A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?/);
    const titleMatch = window.match(/(CEO|CTO|COO|CFO|Founder|Director|Manager|Head of [A-Za-z ]+|VP|President|Editor|Author)/i);

    out.push({
      name: nameMatch?.[0],
      title: titleMatch?.[0],
      email,
      socials: new Set(),
      evidence: [{ url: pageUrl.toString(), sourceTier: tier, freshness }]
    });
  }

  return out;
}

function mergeCandidate(into: ContactCandidate, from: ContactCandidate): void {
  if (!into.name && from.name) into.name = from.name;
  if (!into.title && from.title) into.title = from.title;
  if (!into.email && from.email) into.email = from.email;
  for (const s of from.socials) into.socials.add(s);
  into.evidence.push(...from.evidence);
}

function candidateKey(c: ContactCandidate): string {
  if (c.email) return `e:${c.email}`;
  if (c.name) return `n:${c.name.toLowerCase()}`;
  if (c.socials.size) return `s:${[...c.socials][0]}`;
  return `u:${Math.random()}`;
}

function inferPatternEmail(name: string, domain: string, knownEmails: string[]): string | undefined {
  const parts = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];

  const localParts = knownEmails
    .map((e) => e.split('@')[0])
    .filter(Boolean);

  const patterns = [
    `${first}.${last}`,
    `${first}${last}`,
    `${first[0]}${last}`,
    `${first}.${last[0]}`,
    `${last}.${first}`
  ];

  for (const p of patterns) {
    if (localParts.includes(p)) return `${p}@${domain}`;
  }

  return undefined;
}

async function getSitemapUrls(base: URL, domain: string): Promise<string[]> {
  const candidates = [
    new URL('/sitemap.xml', base).toString(),
    new URL('/sitemap_index.xml', base).toString()
  ];
  const out = new Set<string>();
  const parser = new XMLParser({ ignoreAttributes: false });

  for (const sm of candidates) {
    const xml = await fetchText(sm, FETCH_TIMEOUT_MS);
    if (!xml || !xml.includes('<urlset') && !xml.includes('<sitemapindex')) continue;
    try {
      const doc = parser.parse(xml);
      const sitemapNodes = arrify(doc?.sitemapindex?.sitemap);
      for (const n of sitemapNodes) {
        const loc = n?.loc;
        if (typeof loc === 'string') out.add(loc);
      }

      const urls = arrify(doc?.urlset?.url);
      for (const n of urls) {
        const loc = n?.loc;
        if (typeof loc !== 'string') continue;
        try {
          const u = new URL(loc);
          if (isSameDomain(u, domain)) out.add(u.toString());
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // fetch a few nested sitemap files
  const nested = [...out].filter((u) => u.endsWith('.xml')).slice(0, MAX_NESTED_SITEMAPS);
  for (const n of nested) {
    const xml = await fetchText(n, FETCH_TIMEOUT_MS);
    if (!xml || !xml.includes('<urlset')) continue;
    try {
      const doc = parser.parse(xml);
      const urls = arrify(doc?.urlset?.url);
      for (const x of urls) {
        const loc = x?.loc;
        if (typeof loc === 'string') {
          const u = new URL(loc);
          if (isSameDomain(u, domain)) out.add(u.toString());
        }
      }
    } catch {
      // ignore
    }
  }

  return [...out];
}

function arrify<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function resolveMx(domain: string): Promise<boolean> {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0;
  } catch {
    return false;
  }
}

function computeFinalScore(c: ContactCandidate, domain: string, recurrence: number, hasMx: boolean): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const bestSource = c.evidence
    .map((e) => e.sourceTier)
    .sort((a, b) => sourceWeight(b) - sourceWeight(a))[0] ?? 'text';

  const src = sourceWeight(bestSource);
  score += src;
  reasons.push(`source:${bestSource}=${src.toFixed(2)}`);

  const fresh = Math.max(...c.evidence.map((e) => e.freshness), 0.3);
  score += fresh * 0.08;
  reasons.push(`freshness:+${(fresh * 0.08).toFixed(2)}`);

  const rec = Math.min(0.18, Math.max(0, recurrence - 1) * 0.06);
  score += rec;
  reasons.push(`recurrence:+${rec.toFixed(2)} (${recurrence}x)`);

  if (c.email && c.email.endsWith(`@${domain}`)) {
    score += 0.08;
    reasons.push('domain-match:+0.08');
  }

  if (c.email && hasMx) {
    score += 0.05;
    reasons.push('mx:+0.05');
  }

  let socialBoost = 0;
  for (const s of c.socials) socialBoost += scoreSocialOwnership(s, domain);
  socialBoost = Math.min(0.08, socialBoost);
  if (socialBoost > 0) {
    score += socialBoost;
    reasons.push(`social-ownership:+${socialBoost.toFixed(2)}`);
  }

  score = Math.max(0, Math.min(1, score));
  return { score, reasons };
}

async function crawlAndEnrich(inputUrl: string): Promise<{ domain: string; contact: FinalContact | null; socials: PlatformSocials; endpointsSearched: number }> {
  const { baseUrl, domain } = normalizeDomain(inputUrl);
  progress(`start domain=${domain}`);

  const startUrls = PRIORITY_PATHS.map((p) => new URL(p, baseUrl).toString());
  progress('loading sitemaps...');
  const sitemapUrls = await getSitemapUrls(baseUrl, domain);
  progress(`sitemap urls discovered=${sitemapUrls.length}`);

  const queue = [
    ...new Set([
      baseUrl.toString(),
      ...startUrls,
      ...sitemapUrls.filter((u) => /contact|about|team|leadership|press|author|people|staff/i.test(u)).slice(0, MAX_SITEMAP_PRIORITY),
      ...sitemapUrls.slice(0, MAX_SITEMAP_GENERAL)
    ])
  ];

  const visited = new Set<string>();
  const allCandidates: ContactCandidate[] = [];
  const globalSocials = new Set<string>();

  let renderedPages = 0;
  const heartbeat = setInterval(() => {
    progress(`still working... crawled=${visited.size}/${MAX_PAGES} queue=${queue.length} candidates=${allCandidates.length}`);
  }, 10000);

  async function processPage(current: string): Promise<PageProcessResult> {
    progress(`fetching ${current}`);
    const startedAt = Date.now();
    const u = new URL(current);

    let html = await fetchText(current);
    let usedRender = false;

    if (!html) {
      return {
        current,
        candidates: [],
        socials: [],
        discovered: [],
        usedRender,
        durationMs: Date.now() - startedAt,
        skipped: 'fetch_failed'
      };
    }

    const $static = load(html);
    const staticEmails = extractEmails($static.text());
    const isImportant = /contact|about|team|leadership|press|author|staff|people/i.test(u.pathname);

    if (staticEmails.length === 0 && isImportant && renderedPages < MAX_RENDERED_PAGES) {
      renderedPages++;
      progress(`rendering js page ${current}`);
      const rendered = await fetchRendered(current);
      if (rendered) {
        html = rendered;
        usedRender = true;
      } else {
        renderedPages--;
      }
    }

    const $ = load(html);
    const freshness = getFreshness($);
    const pathTier = sourceTierFromPath(u.pathname);

    const pageCandidates: ContactCandidate[] = [];
    const socials = extractSocialLinks($, u);

    const mailtos = extractMailto($);
    for (const em of mailtos) {
      pageCandidates.push({
        email: em,
        socials: new Set(),
        evidence: [{ url: current, sourceTier: 'mailto', freshness }]
      });
    }

    pageCandidates.push(...parseJsonLdPeople($, u, freshness));
    pageCandidates.push(...parseStaffCards($, u, pathTier, freshness));
    pageCandidates.push(...parseVisibleTextContacts($, u, pathTier, freshness));

    // Discover next links from header/footer + relevant nav pages
    const links: string[] = [];
    $('header a[href], footer a[href], nav a[href], main a[href]').each((_, el) => {
      const h = $(el).attr('href');
      if (h) links.push(h);
    });

    const discovered = toAbsoluteLinks(u, links)
      .filter((x) => {
        try {
          const uu = new URL(x);
          if (!isSameDomain(uu, domain)) return false;
          return /contact|about|team|leadership|press|author|people|staff|company|bio|news/i.test(uu.pathname);
        } catch {
          return false;
        }
      })
      .slice(0, MAX_DISCOVERED_PER_PAGE);

    return {
      current,
      candidates: pageCandidates,
      socials,
      discovered,
      usedRender,
      durationMs: Date.now() - startedAt
    };
  }

  try {
    while (queue.length && visited.size < MAX_PAGES) {
      const batch: string[] = [];

      while (
        queue.length &&
        batch.length < FETCH_CONCURRENCY &&
        visited.size + batch.length < MAX_PAGES
      ) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;

        const u = new URL(current);
        if (!isSameDomain(u, domain)) continue;

        visited.add(current);
        batch.push(current);
      }

      if (batch.length === 0) continue;

      const results = await Promise.all(batch.map((current) => processPage(current)));

      for (const result of results) {
        if (result.skipped === 'fetch_failed') {
          progress(`skip (fetch failed) ${result.current} in ${result.durationMs}ms`);
          continue;
        }

        for (const s of result.socials) globalSocials.add(s);
        allCandidates.push(...result.candidates);

        for (const d of result.discovered) {
          if (!visited.has(d)) queue.push(d);
        }

        progress(`done ${result.current} in ${result.durationMs}ms${result.usedRender ? ' (rendered)' : ''}`);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  // Merge by key
  const merged = new Map<string, ContactCandidate>();
  for (const c of allCandidates) {
    const k = candidateKey(c);
    const existing = merged.get(k);
    if (!existing) {
      merged.set(k, {
        name: c.name,
        title: c.title,
        email: c.email,
        socials: new Set(c.socials),
        evidence: [...c.evidence]
      });
    } else {
      mergeCandidate(existing, c);
    }
  }

  // Cross-merge by name<->email proximity/corroboration
  const byName = new Map<string, ContactCandidate>();
  const byEmail = new Map<string, ContactCandidate>();
  for (const c of merged.values()) {
    if (c.name) byName.set(c.name.toLowerCase(), c);
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
  }

  for (const c of merged.values()) {
    if (c.name && !c.email) {
      const knownDomainEmails = [...byEmail.values()].map((x) => x.email!).filter((e) => e.endsWith(`@${domain}`));
      const inferred = inferPatternEmail(c.name, domain, knownDomainEmails);
      if (inferred) {
        c.email = inferred;
        c.evidence.push({
          url: c.evidence[0]?.url ?? baseUrl.toString(),
          sourceTier: 'inferred',
          freshness: 0.5
        });
      }
    }
  }

  const mxCache = new Map<string, boolean>();
  async function hasMxForEmail(email?: string): Promise<boolean> {
    if (!email) return false;
    const d = email.split('@')[1];
    if (!d) return false;
    if (!mxCache.has(d)) mxCache.set(d, await resolveMx(d));
    return mxCache.get(d)!;
  }

  const finalsMeta: Array<{ contact: FinalContact; candidate: ContactCandidate; recurrence: number }> = [];
  for (const c of merged.values()) {
    if (!c.email && !c.name) continue;
    const recurrence = new Set(c.evidence.map((e) => `${e.sourceTier}:${e.url}`)).size;
    const { score, reasons } = computeFinalScore(c, domain, recurrence, false);
    finalsMeta.push({
      candidate: c,
      recurrence,
      contact: {
        name: c.name,
        title: c.title,
        email: c.email,
        score,
        reasons
      }
    });
  }

  finalsMeta.sort((a, b) => b.contact.score - a.contact.score);

  // MX check only for top candidate to keep runtime low.
  const top = finalsMeta[0];
  if (top?.candidate.email) {
    const hasMx = await hasMxForEmail(top.candidate.email);
    if (hasMx) {
      const { score, reasons } = computeFinalScore(top.candidate, domain, top.recurrence, true);
      top.contact.score = score;
      top.contact.reasons = reasons;
    }
  }

  finalsMeta.sort((a, b) => b.contact.score - a.contact.score);
  const bestContact = finalsMeta[0]?.contact ?? null;
  progress(`scoring complete candidates=${finalsMeta.length} best=${bestContact?.email ?? bestContact?.name ?? 'none'}`);
  const bestCandidateSocials = finalsMeta[0] ? [...finalsMeta[0].candidate.socials] : [];
  const socials = pickPlatformSocials([
    ...bestCandidateSocials,
    ...globalSocials
  ]);

  return {
    domain,
    contact: bestContact,
    socials,
    endpointsSearched: visited.size
  };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: bun run src/enrich.ts <url>');
    process.exit(1);
  }

  const result = await crawlAndEnrich(arg);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
