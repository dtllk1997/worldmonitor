
// api/breaking-news.js
// Breaking News API — Multi-source global news aggregator
// Deployed on Vercel as Edge Function

export const config = { runtime: 'edge' };

const BREAKING_FEEDS = [
    // ── Tier 1: Wire Services ──
    { url: 'https://feeds.reuters.com/reuters/topNews', name: 'Reuters' },
    { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters World' },
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World' },
    { url: 'https://feeds.bbci.co.uk/news/rss.xml', name: 'BBC Top' },

    // ── Tier 2: Major Outlets ──
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'NY Times' },
    { url: 'https://www.theguardian.com/world/rss', name: 'The Guardian' },
    { url: 'https://rss.dw.com/rdf/rss-en-all', name: 'DW News' },
    { url: 'https://www.france24.com/en/rss', name: 'France24' },

    // ── Tier 3: Regional / Wire ──
    { url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', name: 'CNBC World' },
    { url: 'https://abcnews.go.com/abcnews/internationalheadlines', name: 'ABC News' },
    { url: 'https://www.independent.co.uk/news/world/rss', name: 'Independent' },
];

// ===== KEYWORD EXTRACTION =====
function getKeywords(title) {
    const stop = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'will',
        'would', 'could', 'should', 'may', 'might', 'can', 'do', 'does', 'did',
        'to', 'of', 'in', 'for', 'on', 'at', 'by', 'with', 'from', 'up', 'about',
        'into', 'through', 'during', 'before', 'after', 'between', 'out', 'off',
        'over', 'under', 'again', 'then', 'once', 'here', 'there', 'when', 'where',
        'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
        'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
        'very', 'just', 'new', 'says', 'said', 'report', 'reports', 'according',
        'also', 'now', 'latest', 'first', 'big', 'its', 'what', 'whats', 'who',
        'whos', 'that', 'this', 'these', 'those', 'been', 'being', 'your', 'you',
        'and', 'but', 'yet', 'still', 'really', 'actually', 'inside', 'gets',
        'got', 'get', 'makes', 'made', 'make', 'one', 'two', 'last', 'next',
        'launches', 'launched', 'launch', 'unveils', 'unveiled', 'announces',
        'announced', 'releases', 'released', 'introduces', 'reveals', 'adds',
        'rolls', 'hits', 'raises', 'says', 'inks', 'reaches', 'moves', 'stands',
        'support', 'supports', 'left', 'right', 'many', 'another', 'helps',
        'live', 'updates', 'breaking', 'watch', 'video', 'photos', 'gallery'
    ]);

    return title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w));
}

// ===== SIMILARITY CHECK =====
function areSimilar(title1, title2) {
    const kw1 = getKeywords(title1);
    const kw2 = getKeywords(title2);

    if (kw1.length < 2 || kw2.length < 2) return false;

    const set1 = new Set(kw1);
    const set2 = new Set(kw2);

    let common = 0;
    for (const w of set1) {
        if (set2.has(w)) common++;
    }

    const ratio = common / Math.min(set1.size, set2.size);
    return ratio >= 0.5;
}

// ===== FILTER: skip non-news =====
function isRealNews(title) {
    const skip = [
        'subscribe', 'newsletter', 'podcast', 'opinion:', 'editorial:',
        'letters to', 'crossword', 'quiz', 'review:', 'book review',
        'sponsored', 'advertisement', 'partner content'
    ];
    const t = title.toLowerCase();
    return !skip.some(s => t.includes(s));
}

// ===== DECODE HTML ENTITIES =====
function decodeEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&#8217;/g, "'")
        .replace(/&#8216;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .trim();
}

export default async function handler(req) {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=180, s-maxage=180'
    };

    try {
        const fetchPromises = BREAKING_FEEDS.map(async (feed) => {
            try {
                const response = await fetch(feed.url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
                        'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml'
                    },
                    signal: AbortSignal.timeout(12000)
                });
                if (!response.ok) return { name: feed.name, xml: null };
                const xml = await response.text();
                return { name: feed.name, xml };
            } catch (e) {
                return { name: feed.name, xml: null };
            }
        });

        const results = await Promise.all(fetchPromises);
        let allArticles = [];
        let feedStats = {};

        results.forEach(({ name, xml }) => {
            feedStats[name] = 0;
            if (!xml) return;

            const items = xml.split('<item>').slice(1);
            if (items.length === 0) {
                // Try Atom format (<entry>)
                const entries = xml.split('<entry>').slice(1);
                entries.forEach(entry => {
                    const titleMatch =
                        entry.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                        entry.match(/<title[^>]*>(.*?)<\/title>/);
                    const linkMatch =
                        entry.match(/<link[^>]*href="(.*?)"/) ||
                        entry.match(/<link>(.*?)<\/link>/);
                    const pubDateMatch =
                        entry.match(/<updated>(.*?)<\/updated>/) ||
                        entry.match(/<published>(.*?)<\/published>/);

                    if (titleMatch && linkMatch) {
                        const title = decodeEntities(titleMatch[1]);
                        if (title.length > 10 && isRealNews(title)) {
                            allArticles.push({
                                title,
                                link: linkMatch[1].trim(),
                                date: pubDateMatch ? new Date(pubDateMatch[1]).getTime() : Date.now(),
                                source: name
                            });
                            feedStats[name]++;
                        }
                    }
                });
                return;
            }

            items.forEach(item => {
                const titleMatch =
                    item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                    item.match(/<title>(.*?)<\/title>/);
                const linkMatch = item.match(/<link>(.*?)<\/link>/);
                const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
                const descMatch =
                    item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                    item.match(/<description>(.*?)<\/description>/);

                if (titleMatch && linkMatch) {
                    const title = decodeEntities(titleMatch[1]);

                    if (title.length > 10 && isRealNews(title)) {
                        allArticles.push({
                            title,
                            link: linkMatch[1].trim(),
                            date: pubDateMatch
                                ? new Date(pubDateMatch[1]).getTime()
                                : Date.now(),
                            source: name,
                            description: descMatch ? decodeEntities(descMatch[1]).replace(/<[^>]*>/g, '').slice(0, 200) : ''
                        });
                        feedStats[name]++;
                    }
                }
            });
        });

        // Newest first
        allArticles.sort((a, b) => b.date - a.date);

        // ===== DEDUP: 3 Steps =====

        // Step 1: Exact link dedup
        const seenLinks = new Set();
        let step1 = [];
        for (const a of allArticles) {
            if (!seenLinks.has(a.link)) {
                seenLinks.add(a.link);
                step1.push(a);
            }
        }

        // Step 2: Exact title dedup
        const seenTitles = new Set();
        let step2 = [];
        for (const a of step1) {
            const t = a.title.toLowerCase().trim();
            if (!seenTitles.has(t)) {
                seenTitles.add(t);
                step2.push(a);
            }
        }

        // Step 3: Similar topic dedup (50% keyword overlap)
        let final = [];
        for (const a of step2) {
            let isDup = false;
            for (const existing of final) {
                if (areSimilar(a.title, existing.title)) {
                    isDup = true;
                    break;
                }
            }
            if (!isDup) {
                final.push(a);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            type: 'breaking-news',
            feeds_checked: Object.keys(feedStats).length,
            feeds_active: Object.values(feedStats).filter(v => v > 0).length,
            total_raw: allArticles.length,
            total_after_dedup: final.length,
            feed_stats: feedStats,
            articles: final.slice(0, 40)
        }), { status: 200, headers });

    } catch (error) {
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), { status: 500, headers });
    }
}
