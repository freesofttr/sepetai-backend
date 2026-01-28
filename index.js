const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = '27c0df8063c38ebc97100e825ff4cd1c';

app.use(cors());
app.use(express.json());

// In-memory cache with stale-while-revalidate
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes - serve fresh
const CACHE_STALE_TTL = 2 * 60 * 60 * 1000; // 2 hours - serve stale while revalidating

function getCached(key) {
    const item = cache.get(key);
    if (!item) return { data: null, isStale: false };

    const age = Date.now() - item.timestamp;
    if (age > CACHE_STALE_TTL) {
        cache.delete(key);
        return { data: null, isStale: false };
    }

    return {
        data: item.data,
        isStale: age > CACHE_TTL
    };
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

// Pre-cache popular searches on startup
const POPULAR_SEARCHES = ['iphone', 'samsung', 'laptop', 'kulaklık', 'ayakkabı', 'parfüm'];

async function preCachePopularSearches() {
    console.log('Pre-caching popular searches...');
    for (const query of POPULAR_SEARCHES) {
        try {
            const cacheKey = `search:${query.toLowerCase()}`;
            if (!cache.has(cacheKey)) {
                console.log(`Pre-caching: ${query}`);
                await fetchAndCacheSearch(query);
                // Wait 2 seconds between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (e) {
            console.error(`Failed to pre-cache ${query}:`, e.message);
        }
    }
    console.log('Pre-caching complete');
}

async function fetchAndCacheSearch(query) {
    const fetch = (await import('node-fetch')).default;
    const targetUrl = `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`;
    const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&country_code=tr`;

    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`ScraperAPI: ${response.status}`);

    const html = await response.text();
    const rawProducts = parseProducts(html);

    // Apply smart filtering
    const filtered = smartFilterProducts(query, rawProducts);

    const result = {
        query,
        count: filtered.products.length,
        searchIntent: filtered.searchIntent,
        totalScraped: filtered.totalScraped,
        filteredCount: filtered.filteredCount,
        removedCount: filtered.removedCount,
        products: filtered.products
    };

    setCache(`search:${query.toLowerCase()}`, result);
    return result;
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SepetAI Backend' });
});

// Debug endpoint to see raw HTML structure
app.get('/api/debug/html', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    try {
        const fetch = (await import('node-fetch')).default;
        const targetUrl = `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`;
        // ScraperAPI with render and premium for better JS execution
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=tr`;

        const response = await fetch(apiUrl);
        const html = await response.text();

        // Search for various data patterns in HTML
        const patterns = {
            sellingPrice: (html.match(/"sellingPrice"/g) || []).length,
            price: (html.match(/"price"/g) || []).length,
            discountedPrice: (html.match(/"discountedPrice"/g) || []).length,
            pCardWrppr: (html.match(/p-card-wrppr/g) || []).length,
            productCard: (html.match(/product-card/gi) || []).length,
            TL: (html.match(/TL/g) || []).length,
            prcBox: (html.match(/prc-box/g) || []).length,
        };

        // Find all script content
        const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
        const largestScript = scripts.sort((a, b) => b.length - a.length)[0];

        // Look for JSON arrays that might be product data
        const jsonArrayMatch = html.match(/\[\s*\{[^[\]]*"id"[^[\]]*\}\s*(?:,\s*\{[^[\]]*\})*\s*\]/);

        // Find any number patterns that could be prices (3-6 digit numbers)
        const priceNumbers = html.match(/>\s*(\d{2,3}(?:[\.,]\d{2})?)\s*TL/g) || [];

        // Search for state/data script tags
        const stateScriptMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        const nuxtDataMatch = html.match(/<script[^>]*>window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/i);

        // Look for any large JSON embedded in script tags
        const allScriptContent = scripts.map(s => s.replace(/<\/?script[^>]*>/gi, '')).join('\n');
        const hasProductInScripts = allScriptContent.includes('product');

        // Find price containers specifically
        const priceBoxMatches = html.match(/class="[^"]*price[^"]*"[^>]*>[^<]*</gi) || [];
        const priceWrapperMatches = html.match(/class="[^"]*prc[^"]*"[^>]*>[^<]*</gi) || [];

        // Look for selling/discounted price patterns
        const sellingMatches = html.match(/sellingPrice[^}]*}/gi) || [];

        // Find embedded JSON data
        const jsonDataMatch = html.match(/window\["__[^"]*searchResult[^"]*"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i);
        const searchStateMatch = html.match(/window\["__SEARCH[^"]*"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i);

        // Find product info in script tags
        const productScripts = html.match(/<script[^>]*>[\s\S]*?(?:productId|"id":\d+)[\s\S]*?<\/script>/gi) || [];

        // Find sample of seller-store card with full content
        const sellerCardIdx = html.indexOf('seller-store-product-card-price');
        const sellerCardSample = sellerCardIdx > -1 ? html.substring(Math.max(0, sellerCardIdx - 1500), sellerCardIdx + 500) : null;

        // Find sample of regular product card (info-wrapper)
        const infoWrapperIdx = html.indexOf('class="info-wrapper"');
        const infoWrapperSample = infoWrapperIdx > -1 ? html.substring(infoWrapperIdx, infoWrapperIdx + 2000) : null;

        // Find context BEFORE info-wrapper to see where href is
        const infoWrapperContext = infoWrapperIdx > -1 ? html.substring(Math.max(0, infoWrapperIdx - 2000), infoWrapperIdx + 500) : null;

        // Find all href patterns with product IDs
        const productHrefMatches = html.match(/href="[^"]*-p-[0-9]+[^"]*"/gi) || [];

        res.json({
            hasJsonData: !!jsonDataMatch,
            hasSearchState: !!searchStateMatch,
            productScriptCount: productScripts.length,
            sellerCardSample,
            infoWrapperSample,
            htmlLength: html.length,
            patterns,
            scriptCount: scripts.length,
            largestScriptLength: largestScript ? largestScript.length : 0,
            hasJsonArray: !!jsonArrayMatch,
            tlPriceExamples: priceNumbers.slice(0, 10),
            priceBoxSamples: priceBoxMatches.slice(0, 10),
            prcWrapperSamples: priceWrapperMatches.slice(0, 10),
            sellingPriceSamples: sellingMatches.slice(0, 3),
            htmlContainsProduct: html.toLowerCase().includes('product'),
            htmlContainsSearch: html.toLowerCase().includes('search'),
            hasNextData: !!stateScriptMatch,
            hasNuxtData: !!nuxtDataMatch,
            hasProductInScripts,
            infoWrapperContext,
            productHrefCount: productHrefMatches.length,
            productHrefSamples: productHrefMatches.slice(0, 5)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/all', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    // Check cache first
    const cacheKey = `search:${q.toLowerCase()}`;
    const { data: cached, isStale } = getCached(cacheKey);

    if (cached) {
        console.log(`Cache ${isStale ? 'STALE' : 'HIT'} for: ${q}`);

        // If stale, return cached data immediately but refresh in background
        if (isStale) {
            // Don't await - let it run in background
            fetchAndCacheSearch(q).catch(e => console.error('Background refresh failed:', e.message));
        }

        return res.json(cached);
    }

    console.log(`Cache MISS - Searching: ${q}`);

    try {
        const result = await fetchAndCacheSearch(q);
        res.json(result);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// SMART PRODUCT FILTERING
// ==========================================

const PRODUCT_CATEGORIES = {
    phone: {
        keywords: ['iphone', 'samsung galaxy', 'telefon', 'cep telefon', 'xiaomi', 'huawei', 'pixel', 'oppo', 'realme', 'oneplus', 'redmi', 'poco', 'iphone 15', 'iphone 14', 'iphone 16', 'galaxy s', 'galaxy a'],
        excludeKeywords: ['kılıf', 'kilif', 'cam', 'ekran koruyucu', 'şarj', 'sarj', 'adaptör', 'adaptor', 'kablo', 'kordon', 'powerbank', 'tutucu', 'stand', 'temizleyici', 'sticker', 'çıkartma', 'cikartma', 'aksesuar', 'batarya', 'pil', 'lens', 'kapak', 'arka kapak', 'koruma', 'pencere', 'cam filmi', 'jelatin', 'tampon', 'bumper', 'cüzdan', 'cuzdan'],
        intentLabel: 'Telefon',
        mainProductIndicators: ['gb', 'tb', '128', '256', '512', '1tb', 'pro', 'pro max', 'ultra', 'plus', 'lite', 'note']
    },
    tablet: {
        keywords: ['ipad', 'tablet', 'samsung tab', 'galaxy tab'],
        excludeKeywords: ['kılıf', 'kilif', 'kalem', 'pencil', 'klavye', 'keyboard', 'cam', 'ekran koruyucu', 'stand', 'çanta', 'canta', 'şarj', 'sarj', 'adaptör', 'adaptor', 'koruyucu'],
        intentLabel: 'Tablet',
        mainProductIndicators: ['gb', 'wifi', 'cellular', 'pro', 'air', 'mini', '64', '128', '256']
    },
    laptop: {
        keywords: ['laptop', 'notebook', 'bilgisayar', 'macbook', 'thinkpad', 'ideapad', 'vivobook', 'zenbook', 'gaming laptop'],
        excludeKeywords: ['çanta', 'canta', 'kılıf', 'kilif', 'stand', 'soğutucu', 'sogutcu', 'mouse pad', 'mousepad', 'sticker', 'webcam', 'tutucu', 'koruyucu', 'temizleyici'],
        intentLabel: 'Laptop',
        mainProductIndicators: ['i5', 'i7', 'i9', 'ryzen', 'ram', 'ssd', 'intel', 'amd', 'ekran', 'ghz', 'core']
    },
    headphones: {
        keywords: ['kulaklık', 'kulaklik', 'airpods', 'earbuds', 'headphone', 'earphone', 'bluetooth kulaklık'],
        excludeKeywords: ['kılıf', 'kilif', 'yedek', 'uç', 'uc', 'sünger', 'sunger', 'kablo', 'şarj kutusu', 'aksesuar', 'adaptör', 'adaptor'],
        intentLabel: 'Kulaklık',
        mainProductIndicators: ['bluetooth', 'kablosuz', 'anc', 'gürültü', 'gurultu', 'tws', 'wireless']
    },
    shoes: {
        keywords: ['ayakkabı', 'ayakkabi', 'sneaker', 'spor ayakkabı', 'bot', 'çizme', 'cizme', 'terlik', 'sandalet'],
        excludeKeywords: ['bakım', 'bakim', 'sprey', 'boya', 'tabanlık', 'tabanlik', 'bağcık', 'bagcik', 'fırça', 'firca', 'temizleyici', 'koruyucu', 'yıkama', 'yikama'],
        intentLabel: 'Ayakkabı',
        mainProductIndicators: ['numara', 'beden']
    },
    watch: {
        keywords: ['saat', 'akıllı saat', 'akilli saat', 'apple watch', 'smartwatch', 'kol saati'],
        excludeKeywords: ['kordon', 'kayış', 'kayis', 'cam', 'ekran koruyucu', 'kılıf', 'kilif', 'şarj', 'sarj', 'stand', 'dock', 'aksesuar'],
        intentLabel: 'Saat',
        mainProductIndicators: ['mm', 'gps', 'cellular', 'bluetooth', 'series']
    },
    perfume: {
        keywords: ['parfüm', 'parfum', 'edp', 'edt', 'eau de'],
        excludeKeywords: ['deodorant', 'roll-on', 'vücut losyonu', 'vucut losyonu', 'sabun', 'duş jeli', 'dus jeli'],
        intentLabel: 'Parfüm',
        mainProductIndicators: ['ml', 'edp', 'edt', 'eau de parfum', 'eau de toilette']
    },
    tv: {
        keywords: ['televizyon', 'tv', 'smart tv', 'led tv', 'oled', 'qled'],
        excludeKeywords: ['kumanda', 'stand', 'askı', 'aski', 'duvar aparatı', 'aparati', 'kablo', 'hdmi', 'cam', 'ekran koruyucu'],
        intentLabel: 'Televizyon',
        mainProductIndicators: ['inç', 'inc', 'inch', 'cm', '4k', 'uhd', 'full hd', 'smart']
    },
    gaming: {
        keywords: ['playstation', 'ps5', 'ps4', 'xbox', 'nintendo', 'switch', 'konsol'],
        excludeKeywords: ['kılıf', 'kilif', 'koruyucu', 'stand', 'şarj', 'sarj', 'sticker', 'çıkartma', 'cikartma', 'çanta', 'canta', 'temizleyici'],
        intentLabel: 'Oyun Konsolu',
        mainProductIndicators: ['konsol', 'bundle', 'edition', 'dijital', 'digital', 'slim', 'pro']
    }
};

// Accessory patterns - items that are almost always accessories
const ACCESSORY_PATTERNS = [
    'kılıf', 'kilif', 'cam', 'ekran koruyucu', 'koruyucu', 'şarj', 'sarj',
    'adaptör', 'adaptor', 'kablo', 'kordon', 'kayış', 'kayis', 'powerbank',
    'tutucu', 'stand', 'dock', 'temizleyici', 'sticker', 'çıkartma', 'cikartma',
    'aksesuar', 'yedek', 'bağcık', 'bagcik', 'tabanlık', 'tabanlik',
    'bakım', 'bakim', 'fırça', 'firca', 'sprey', 'aparatı', 'aparati',
    'askı', 'aski', 'kumanda', 'mouse pad', 'mousepad', 'jelatin', 'film'
];

function analyzeSearchIntent(query) {
    const queryLower = query.toLowerCase().trim();

    for (const [category, config] of Object.entries(PRODUCT_CATEGORIES)) {
        const matched = config.keywords.some(keyword => queryLower.includes(keyword));
        if (matched) {
            return {
                category,
                intentLabel: config.intentLabel,
                excludeKeywords: config.excludeKeywords,
                mainProductIndicators: config.mainProductIndicators,
                originalQuery: query
            };
        }
    }

    return {
        category: 'general',
        intentLabel: 'Genel Arama',
        excludeKeywords: [],
        mainProductIndicators: [],
        originalQuery: query
    };
}

function classifyProduct(product, intent) {
    const nameLower = product.name.toLowerCase();

    // Check if product name contains accessory patterns
    const matchedAccessoryPattern = ACCESSORY_PATTERNS.find(pattern => nameLower.includes(pattern));

    // Check if product should be excluded based on intent
    const matchedExcludeKeyword = intent.excludeKeywords.find(keyword => nameLower.includes(keyword));

    // Check if it has main product indicators
    const hasMainIndicator = intent.mainProductIndicators.some(ind => nameLower.includes(ind));

    if (intent.category === 'general') {
        return { type: 'Ana Ürün', confidence: 0.7, isRelevant: true };
    }

    if (matchedExcludeKeyword || matchedAccessoryPattern) {
        // If it ALSO has main product indicators AND the name is long enough (real products have longer names)
        if (hasMainIndicator && nameLower.length > 40 && !matchedAccessoryPattern) {
            return { type: 'Ana Ürün', confidence: 0.6, isRelevant: true };
        }
        return { type: 'Aksesuar', confidence: 0.85, isRelevant: false };
    }

    if (hasMainIndicator) {
        return { type: 'Ana Ürün', confidence: 0.9, isRelevant: true };
    }

    // Default - probably relevant but lower confidence
    return { type: 'Ana Ürün', confidence: 0.65, isRelevant: true };
}

function analyzeDiscount(product) {
    if (!product.originalPrice || product.originalPrice <= product.price) {
        return { hasDiscount: false, discountPercentage: 0, status: 'normal', comment: null };
    }

    const discountPercent = Math.round((product.originalPrice - product.price) / product.originalPrice * 100);

    if (discountPercent > 70) {
        return {
            hasDiscount: true,
            discountPercentage: discountPercent,
            status: 'suspicious',
            comment: 'Şüpheli indirim oranı'
        };
    }

    if (discountPercent >= 20) {
        return {
            hasDiscount: true,
            discountPercentage: discountPercent,
            status: 'good_deal',
            comment: `%${discountPercent} indirim`
        };
    }

    return {
        hasDiscount: true,
        discountPercentage: discountPercent,
        status: 'minor_discount',
        comment: `%${discountPercent} indirim`
    };
}

function smartFilterProducts(query, products) {
    const intent = analyzeSearchIntent(query);
    console.log(`Search intent: ${intent.intentLabel} (${intent.category})`);

    const analyzed = products.map(product => {
        const classification = classifyProduct(product, intent);
        const discount = analyzeDiscount(product);

        return {
            ...product,
            relevanceScore: classification.confidence,
            classification: classification.type,
            isRelevant: classification.isRelevant,
            discountStatus: discount.status,
            discountPercentage: discount.discountPercentage || 0,
            shortComment: discount.comment || null
        };
    });

    // Filter: relevant products first, sorted by confidence
    const relevant = analyzed
        .filter(p => p.isRelevant)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const removed = analyzed.filter(p => !p.isRelevant);

    console.log(`Smart filter: ${relevant.length} relevant, ${removed.length} accessories removed`);

    return {
        searchIntent: intent.intentLabel,
        totalScraped: products.length,
        filteredCount: relevant.length,
        removedCount: removed.length,
        products: relevant
    };
}

// ==========================================
// HTML PARSING
// ==========================================

function parseProducts(html) {
    const products = [];

    // Find all product links: href="/brand/product-name-p-123456?..."
    const productLinkRegex = /href="(\/[^"]*-p-([0-9]+)[^"]*)"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        productLinks.push({
            href: linkMatch[1],
            productId: linkMatch[2],
            position: linkMatch.index
        });
    }

    console.log(`Found ${productLinks.length} product links`);

    for (let i = 0; i < productLinks.length && products.length < 30; i++) {
        const link = productLinks[i];

        if (products.some(p => p.productId === link.productId)) continue;

        const contentStart = link.position;
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract brand
        const brandMatch = cardContent.match(/class="product-brand"[^>]*>([^<]+)/i);
        const brand = brandMatch ? brandMatch[1].trim() : null;

        // Extract product name
        const nameMatch = cardContent.match(/class="product-name"[^>]*>(?:\s*<!--[\s\S]*?-->)?\s*([^<]+)/i);
        let name = nameMatch ? nameMatch[1].trim() : null;

        if (!name && link.href) {
            const hrefParts = link.href.split('/');
            if (hrefParts.length >= 3) {
                const productSlug = hrefParts[2].split('-p-')[0];
                name = productSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        }

        // Extract current/sale price
        let price = null;
        const pricePatterns = [
            /class="[^"]*sale-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*discounted-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*price-section[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*single-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*price-value[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*TL</i,
            />([0-9]+(?:\.[0-9]+)?)\s*TL</i
        ];

        for (const pattern of pricePatterns) {
            const priceMatch = cardContent.match(pattern);
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original/old price (strikethrough price)
        let originalPrice = null;
        const originalPricePatterns = [
            /class="[^"]*(?:old|original|org)[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*prc-org[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*line-through[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /text-decoration:\s*line-through[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL\s*<\/del>/i
        ];

        for (const pattern of originalPricePatterns) {
            const orgMatch = cardContent.match(pattern);
            if (orgMatch) {
                const orgPrice = parseFloat(orgMatch[1].replace(/\./g, '').replace(',', '.'));
                if (orgPrice > 0 && price && orgPrice > price) {
                    originalPrice = orgPrice;
                    break;
                }
            }
        }

        // Extract image URL
        const imgPatterns = [
            /src="(https:\/\/cdn\.dsmcdn\.com[^"]*\.(?:jpg|png|webp))"/i,
            /data-src="(https:\/\/cdn\.dsmcdn\.com[^"]*\.(?:jpg|png|webp))"/i
        ];
        let imageUrl = null;
        for (const pattern of imgPatterns) {
            const imgMatch = cardContent.match(pattern);
            if (imgMatch) {
                imageUrl = imgMatch[1];
                break;
            }
        }

        if (!name || !price || price < 1) {
            if (i < 5) {
                console.log(`Skipped product ${link.productId}: name=${name ? 'yes' : 'no'}, price=${price}`);
            }
            continue;
        }

        // Clean URL
        let cleanHref = link.href.replace(/&amp;/g, '&');
        cleanHref = cleanHref.split('?')[0];
        const productUrl = 'https://www.trendyol.com' + cleanHref;
        const fullName = brand && !name.toLowerCase().startsWith(brand.toLowerCase())
            ? `${brand} ${name}`
            : name;

        products.push({
            name: fullName,
            price: price,
            originalPrice: originalPrice,
            imageUrl: imageUrl,
            productUrl: productUrl,
            productId: link.productId,
            brand: brand,
            seller: null,
            store: 'Trendyol'
        });
    }

    console.log(`Parsed: ${products.length} products`);
    return products;
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Start pre-caching popular searches after 5 seconds
    setTimeout(() => preCachePopularSearches(), 5000);
});
