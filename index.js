const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = '27c0df8063c38ebc97100e825ff4cd1c';

app.use(cors());
app.use(express.json());

// Initialize database on startup
db.checkConnection().then(connected => {
    if (connected) {
        db.initDatabase();
    }
});

// In-memory cache with stale-while-revalidate
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes - serve fresh
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
// Reduced list - each search hits 3 stores now (3x API credits)
const POPULAR_SEARCHES = ['iphone', 'samsung', 'laptop'];

async function preCachePopularSearches() {
    console.log('Pre-caching popular searches...');
    for (const query of POPULAR_SEARCHES) {
        try {
            const cacheKey = `search:${query.toLowerCase()}`;
            if (!cache.has(cacheKey)) {
                console.log(`Pre-caching: ${query}`);
                await fetchAndCacheSearch(query);
                // Wait 5 seconds between searches (3 concurrent store requests each)
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (e) {
            console.error(`Failed to pre-cache ${query}:`, e.message);
        }
    }
    console.log('Pre-caching complete');
}

// Scrape a single store and return products
async function scrapeStore(query, store) {
    const fetch = (await import('node-fetch')).default;

    // Stores that require JavaScript rendering (headless browser)
    const jsRenderStores = ['n11', 'vatan', 'mediamarkt', 'pazarama', 'pttavm'];

    const storeConfigs = {
        trendyol: {
            url: `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`,
            parser: parseTrendyolProducts
        },
        hepsiburada: {
            url: `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`,
            parser: parseHepsiburadaProducts
        },
        n11: {
            url: `https://www.n11.com/arama?q=${encodeURIComponent(query)}`,
            parser: parseN11Products
        },
        amazon: {
            url: `https://www.amazon.com.tr/s?k=${encodeURIComponent(query)}`,
            parser: parseAmazonProducts
        },
        pttavm: {
            url: `https://www.pttavm.com/arama?q=${encodeURIComponent(query)}`,
            parser: parsePttavmProducts
        },
        pazarama: {
            url: `https://www.pazarama.com/arama?q=${encodeURIComponent(query)}`,
            parser: parsePazaramaProducts
        },
        teknosa: {
            url: `https://www.teknosa.com/arama/?s=${encodeURIComponent(query)}`,
            parser: parseTeknosaProducts
        },
        vatan: {
            url: `https://www.vatanbilgisayar.com/arama/${encodeURIComponent(query)}/`,
            parser: parseVatanProducts
        },
        mediamarkt: {
            url: `https://www.mediamarkt.com.tr/tr/search.html?query=${encodeURIComponent(query)}`,
            parser: parseMediaMarktProducts
        },
        migros: {
            url: `https://www.migros.com.tr/arama?q=${encodeURIComponent(query)}`,
            parser: parseMigrosProducts
        },
        ciceksepeti: {
            url: `https://www.ciceksepeti.com/arama?q=${encodeURIComponent(query)}`,
            parser: parseCicekSepetiProducts
        }
    };

    const config = storeConfigs[store];
    if (!config) return [];

    try {
        // Add render=true for JavaScript-heavy stores (uses headless browser)
        const needsRender = jsRenderStores.includes(store);
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(config.url)}&country_code=tr${needsRender ? '&render=true' : ''}`;
        console.log(`Scraping ${store}: ${query}${needsRender ? ' (JS render)' : ''}`);

        const response = await fetch(apiUrl, { timeout: 60000 }); // Longer timeout for render
        if (!response.ok) {
            console.log(`${store} scrape failed: ${response.status}`);
            return [];
        }

        const html = await response.text();
        console.log(`${store}: received ${html.length} bytes`);

        const products = config.parser(html);
        console.log(`${store}: parsed ${products.length} products`);
        return products;
    } catch (e) {
        console.error(`${store} error: ${e.message}`);
        return [];
    }
}

async function fetchAndCacheSearch(query) {
    // Scrape stores in smaller batches with longer delays to avoid ScraperAPI rate limiting
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Batch 1: Main e-commerce (2 at a time)
    const [trendyolProducts, hepsiburadaProducts] = await Promise.all([
        scrapeStore(query, 'trendyol'),
        scrapeStore(query, 'hepsiburada')
    ]);

    await delay(500);

    // Batch 2: Amazon + PttAvm
    const [amazonProducts, pttavmProducts] = await Promise.all([
        scrapeStore(query, 'amazon'),
        scrapeStore(query, 'pttavm')
    ]);

    await delay(500);

    // Batch 3: Pazarama + Teknosa
    const [pazaramaProducts, teknosaProducts] = await Promise.all([
        scrapeStore(query, 'pazarama'),
        scrapeStore(query, 'teknosa')
    ]);

    await delay(500);

    // Batch 4: Vatan + MediaMarkt
    const [vatanProducts, mediamarktProducts] = await Promise.all([
        scrapeStore(query, 'vatan'),
        scrapeStore(query, 'mediamarkt')
    ]);

    await delay(500);

    // Batch 5: N11
    const n11Products = await scrapeStore(query, 'n11');

    // Skip specialized stores (Migros for groceries, CicekSepeti for flowers/gifts)
    // They rarely have electronics and cause unnecessary API usage
    const migrosProducts = [];
    const ciceksepetiProducts = [];

    const allProducts = [
        ...trendyolProducts,
        ...hepsiburadaProducts,
        ...amazonProducts,
        ...n11Products,
        ...pttavmProducts,
        ...pazaramaProducts,
        ...teknosaProducts,
        ...vatanProducts,
        ...mediamarktProducts
    ];

    console.log(`Total scraped: ${allProducts.length} (T:${trendyolProducts.length} H:${hepsiburadaProducts.length} A:${amazonProducts.length} N:${n11Products.length} P:${pttavmProducts.length} Z:${pazaramaProducts.length} TK:${teknosaProducts.length} V:${vatanProducts.length} MM:${mediamarktProducts.length})`);

    // Apply smart filtering
    const filtered = smartFilterProducts(query, allProducts);

    // Record prices to database (async, don't wait)
    db.recordPricesBatch(filtered.products).catch(e => {
        console.error('Failed to record prices:', e.message);
    });

    const result = {
        query,
        count: filtered.products.length,
        searchIntent: filtered.searchIntent,
        totalScraped: filtered.totalScraped,
        filteredCount: filtered.filteredCount,
        removedCount: filtered.removedCount,
        lastFetched: Date.now(),
        products: filtered.products
    };

    setCache(`search:${query.toLowerCase()}`, result);
    return result;
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SepetAI Backend', version: '2.0', features: ['multi-store', 'price-history', 'ai-analysis'] });
});

// ==========================================
// PRICE HISTORY ENDPOINTS
// ==========================================

// Get price history for a product
app.get('/api/products/:productId/history', async (req, res) => {
    const { productId } = req.params;
    const days = parseInt(req.query.days) || 30;

    try {
        const data = await db.getPriceHistory(productId, days);
        res.json({
            productId,
            days,
            ...data
        });
    } catch (error) {
        console.error('Price history error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get AI price analysis for a product
app.get('/api/products/:productId/analysis', async (req, res) => {
    const { productId } = req.params;
    const currentPrice = parseFloat(req.query.currentPrice) || 0;

    try {
        const analysis = await db.getSimplePriceAnalysis(productId, currentPrice);

        if (!analysis) {
            return res.json({
                productId,
                hasData: false,
                message: 'Veritabani baglantisi yok veya veri bulunamadi'
            });
        }

        res.json({
            productId,
            hasData: true,
            ...analysis
        });
    } catch (error) {
        console.error('Price analysis error:', error.message);
        res.status(500).json({ error: error.message });
    }
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

// Price refresh endpoint - get current prices for saved products
// Accepts: { products: [{productId, productUrl}] }
app.post('/api/products/refresh', async (req, res) => {
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ error: 'products array required' });
    }

    // Limit to 10 products per request (ScraperAPI credits)
    const items = products.slice(0, 10);
    console.log(`Price refresh for ${items.length} products`);

    const results = [];
    for (const item of items) {
        const productId = item.productId || item;
        const productUrl = item.productUrl || null;

        try {
            // Check price cache first (5 min TTL)
            const priceCacheKey = `price:${productId}`;
            const { data: cachedPrice } = getCached(priceCacheKey);
            if (cachedPrice) {
                results.push(cachedPrice);
                continue;
            }

            // First try: check if product exists in any cached search results
            let priceFromCache = findPriceInSearchCache(productId);
            if (priceFromCache) {
                cache.set(priceCacheKey, { data: priceFromCache, timestamp: Date.now() });
                results.push(priceFromCache);
                continue;
            }

            // Second try: scrape the product page directly
            if (productUrl) {
                const priceData = await scrapeProductPrice(productId, productUrl);
                if (priceData && !priceData.error) {
                    cache.set(priceCacheKey, { data: priceData, timestamp: Date.now() });
                    results.push(priceData);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
            }

            results.push({ productId, error: 'Could not fetch price', lastChecked: Date.now() });
        } catch (e) {
            console.error(`Price refresh failed for ${productId}: ${e.message}`);
            results.push({ productId, error: e.message });
        }
    }

    res.json({ products: results });
});

// Look for product price in existing search cache
function findPriceInSearchCache(productId) {
    for (const [key, item] of cache.entries()) {
        if (!key.startsWith('search:')) continue;
        const age = Date.now() - item.timestamp;
        if (age > CACHE_STALE_TTL) continue;

        const product = item.data?.products?.find(p => p.productId === productId);
        if (product) {
            console.log(`Found price for ${productId} in search cache: ${product.price}`);
            return {
                productId,
                currentPrice: product.price,
                originalPrice: product.originalPrice || null,
                lastChecked: Date.now()
            };
        }
    }
    return null;
}

// Scrape current price from Trendyol product page
async function scrapeProductPrice(productId, productUrl) {
    const fetch = (await import('node-fetch')).default;

    try {
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(productUrl)}&country_code=tr`;
        console.log(`Scraping price for ${productId}: ${productUrl.substring(0, 60)}...`);

        const response = await fetch(apiUrl, { timeout: 30000 });
        if (!response.ok) throw new Error(`ScraperAPI: ${response.status}`);

        const html = await response.text();

        let currentPrice = null;
        let originalPrice = null;

        const pricePatterns = [
            /class="[^"]*prc-dsc[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*product-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*sale-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*price-value[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*TL</i
        ];

        for (const pattern of pricePatterns) {
            const match = html.match(pattern);
            if (match) {
                currentPrice = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
                if (currentPrice > 0) break;
                currentPrice = null;
            }
        }

        const orgPatterns = [
            /class="[^"]*prc-org[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*old-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i
        ];

        for (const pattern of orgPatterns) {
            const match = html.match(pattern);
            if (match) {
                const org = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
                if (org > 0 && currentPrice && org > currentPrice) {
                    originalPrice = org;
                    break;
                }
            }
        }

        if (currentPrice) {
            console.log(`Price for ${productId}: ${currentPrice} TL`);
            return { productId, currentPrice, originalPrice, lastChecked: Date.now() };
        }

        return { productId, error: 'Price not found in HTML', lastChecked: Date.now() };
    } catch (e) {
        console.log(`Scrape failed for ${productId}: ${e.message}`);
        return { productId, error: e.message, lastChecked: Date.now() };
    }
}

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
    'kılıf', 'kilif', 'kapak', 'cam', 'ekran koruyucu', 'koruyucu', 'şarj', 'sarj',
    'adaptör', 'adaptor', 'kablo', 'kordon', 'kayış', 'kayis', 'powerbank',
    'tutucu', 'stand', 'dock', 'temizleyici', 'sticker', 'çıkartma', 'cikartma',
    'aksesuar', 'yedek', 'bağcık', 'bagcik', 'tabanlık', 'tabanlik',
    'bakım', 'bakim', 'fırça', 'firca', 'sprey', 'aparatı', 'aparati',
    'askı', 'aski', 'kumanda', 'mouse pad', 'mousepad', 'jelatin', 'film',
    'broş', 'bros'
];

// Turkish character normalization for matching
function normalizeTurkish(text) {
    return text
        .replace(/ı/g, 'i').replace(/İ/g, 'i')
        .replace(/ö/g, 'o').replace(/Ö/g, 'o')
        .replace(/ü/g, 'u').replace(/Ü/g, 'u')
        .replace(/ş/g, 's').replace(/Ş/g, 's')
        .replace(/ç/g, 'c').replace(/Ç/g, 'c')
        .replace(/ğ/g, 'g').replace(/Ğ/g, 'g');
}

// Extract meaningful keywords from a query (words with 3+ chars)
function extractQueryKeywords(query) {
    const stopWords = ['ve', 'ile', 'icin', 'için', 'bir', 'bu', 'den', 'dan', 'ile', 'gibi', 'kadar', 'en', 'çok', 'cok', 'az', 'ucuz', 'pahalı', 'pahali', 'iyi', 'güzel', 'guzel', 'yeni', 'eski'];
    return query.toLowerCase().trim()
        .split(/\s+/)
        .filter(w => w.length >= 2 && !stopWords.includes(w))
        .map(w => normalizeTurkish(w));
}

// Detect specific model number/version in query
// Returns { brand, model } if found, null otherwise
function detectModelQuery(query) {
    const queryLower = query.toLowerCase().trim();

    // iPhone model patterns: iphone 14, iphone 15, iphone 15 pro, iphone 15 pro max, iphone 16e
    const iphoneMatch = queryLower.match(/iphone\s*(\d{1,2}(?:\s*(?:pro\s*max|pro|plus|mini|e))?)/i);
    if (iphoneMatch) {
        return { brand: 'iphone', model: iphoneMatch[1].replace(/\s+/g, ' ').trim() };
    }

    // Samsung Galaxy patterns: galaxy s24, galaxy s24 ultra, galaxy a55
    const galaxyMatch = queryLower.match(/(?:samsung\s*)?galaxy\s*([a-z]?\d{1,2}(?:\s*(?:ultra|plus|fe))?)/i);
    if (galaxyMatch) {
        return { brand: 'galaxy', model: galaxyMatch[1].replace(/\s+/g, ' ').trim() };
    }

    // iPad patterns: ipad pro, ipad air, ipad mini
    const ipadMatch = queryLower.match(/ipad\s*(pro|air|mini)?(?:\s*(\d+))?(?:\s*m(\d))?/i);
    if (ipadMatch && (ipadMatch[1] || ipadMatch[2] || ipadMatch[3])) {
        const parts = [ipadMatch[1], ipadMatch[2], ipadMatch[3] ? `m${ipadMatch[3]}` : null].filter(Boolean);
        return { brand: 'ipad', model: parts.join(' ').trim() };
    }

    // MacBook patterns
    const macMatch = queryLower.match(/macbook\s*(pro|air)?(?:\s*m(\d))?/i);
    if (macMatch && (macMatch[1] || macMatch[2])) {
        const parts = [macMatch[1], macMatch[2] ? `m${macMatch[2]}` : null].filter(Boolean);
        return { brand: 'macbook', model: parts.join(' ').trim() };
    }

    // Xiaomi patterns: xiaomi 14, redmi note 13
    const xiaomiMatch = queryLower.match(/(?:xiaomi|redmi|poco)\s*([\w]+(?:\s*(?:note|pro|ultra|lite|plus))?\s*\d*)/i);
    if (xiaomiMatch) {
        return { brand: queryLower.match(/(xiaomi|redmi|poco)/i)[1], model: xiaomiMatch[1].trim() };
    }

    return null;
}

// Check if product name matches the specific model from query
// STRICT MATCHING: "iPhone 15" shows only base model, not Pro/Plus variants
function matchesSpecificModel(productName, modelQuery) {
    const nameNorm = normalizeTurkish(productName.toLowerCase());

    // Sub-model variants that should be treated as separate products
    const subModelVariants = ['pro max', 'pro', 'plus', 'mini', 'ultra', 'fe', 'lite'];

    if (modelQuery.brand === 'iphone') {
        // Extract model number from product name
        const nameModelMatch = nameNorm.match(/iphone\s*(\d{1,2})/);
        if (!nameModelMatch) return false;

        const queryModelNum = modelQuery.model.match(/(\d{1,2})/);
        if (!queryModelNum) return true;

        // Model number must match exactly
        if (nameModelMatch[1] !== queryModelNum[1]) return false;

        // Check sub-model (pro max, pro, plus, mini, e)
        const querySubModel = modelQuery.model.replace(/\d+\s*/, '').trim().toLowerCase();

        // Detect if product name has a sub-model variant
        const productSubModel = subModelVariants.find(variant => nameNorm.includes(variant));

        if (querySubModel) {
            // Query specifies sub-model (e.g., "iPhone 15 Pro")
            if (querySubModel === 'pro max') {
                return nameNorm.includes('pro max');
            }
            if (querySubModel === 'pro') {
                // "iPhone 15 Pro" should match Pro but NOT Pro Max
                return nameNorm.includes('pro') && !nameNorm.includes('pro max');
            }
            return nameNorm.includes(querySubModel);
        } else {
            // No sub-model in query (e.g., just "iPhone 15")
            // EXCLUDE products with sub-model variants
            if (productSubModel) {
                return false; // Exclude "iPhone 15 Pro", "iPhone 15 Plus", etc.
            }
            return true; // Keep base model "iPhone 15"
        }
    }

    if (modelQuery.brand === 'galaxy') {
        const nameModelMatch = nameNorm.match(/galaxy\s*([a-z]?\d{1,2})/);
        if (!nameModelMatch) return false;

        const queryModelPart = modelQuery.model.match(/([a-z]?\d{1,2})/);
        if (!queryModelPart) return true;

        if (nameModelMatch[1] !== queryModelPart[1]) return false;

        const querySubModel = modelQuery.model.replace(/[a-z]?\d+\s*/, '').trim().toLowerCase();
        const productSubModel = subModelVariants.find(variant => nameNorm.includes(variant));

        if (querySubModel) {
            if (querySubModel === 'ultra') {
                return nameNorm.includes('ultra');
            }
            return nameNorm.includes(querySubModel);
        } else {
            // No sub-model - exclude Ultra, Plus, FE variants
            if (productSubModel) {
                return false;
            }
            return true;
        }
    }

    // Generic brand+model: just check that all model words appear in product name
    const modelWords = modelQuery.model.split(/\s+/);
    return modelWords.every(word => nameNorm.includes(word));
}

// Calculate how well a product name matches the search query
function calculateQueryRelevance(productName, queryKeywords) {
    if (queryKeywords.length === 0) return 1.0;

    const nameNorm = normalizeTurkish(productName.toLowerCase());
    let matchCount = 0;

    for (const keyword of queryKeywords) {
        if (nameNorm.includes(keyword)) {
            matchCount++;
        }
    }

    return matchCount / queryKeywords.length;
}

function analyzeSearchIntent(query) {
    const queryLower = query.toLowerCase().trim();
    const modelQuery = detectModelQuery(query);

    for (const [category, config] of Object.entries(PRODUCT_CATEGORIES)) {
        const matched = config.keywords.some(keyword => queryLower.includes(keyword));
        if (matched) {
            return {
                category,
                intentLabel: config.intentLabel,
                excludeKeywords: config.excludeKeywords,
                mainProductIndicators: config.mainProductIndicators,
                originalQuery: query,
                queryKeywords: extractQueryKeywords(query),
                modelQuery // specific model filter (e.g., {brand:'iphone', model:'15 pro'})
            };
        }
    }

    return {
        category: 'general',
        intentLabel: 'Genel Arama',
        excludeKeywords: [],
        mainProductIndicators: [],
        originalQuery: query,
        queryKeywords: extractQueryKeywords(query),
        modelQuery
    };
}

function classifyProduct(product, intent) {
    const nameLower = product.name.toLowerCase();

    // Always check query keyword relevance (works for ALL searches)
    const queryRelevance = calculateQueryRelevance(nameLower, intent.queryKeywords);

    // Only filter if NO query keywords match at all AND query has multiple keywords
    // Single keyword searches should be more permissive
    if (intent.queryKeywords.length > 1 && queryRelevance === 0) {
        return { type: 'Alakasız', confidence: 0.8, isRelevant: false };
    }

    // Check if product name contains accessory patterns
    const matchedAccessoryPattern = ACCESSORY_PATTERNS.find(pattern => nameLower.includes(pattern));

    // Check if product should be excluded based on intent
    const matchedExcludeKeyword = intent.excludeKeywords.find(keyword => nameLower.includes(keyword));

    // Check if it has main product indicators (storage, variant names)
    const hasMainIndicator = intent.mainProductIndicators.some(ind => nameLower.includes(ind));

    // Model-specific filtering: if user searched "iphone 15", they want the PHONE, not accessories
    if (intent.modelQuery) {
        if (!matchesSpecificModel(product.name, intent.modelQuery)) {
            return { type: 'Farklı Model', confidence: 0.9, isRelevant: false };
        }

        // CRITICAL: For model-specific searches, STRICTLY exclude accessories
        // Even if product contains "iphone 15", we don't want "iphone 15 kılıf" or "iphone 15 cam"
        if (matchedAccessoryPattern || matchedExcludeKeyword) {
            // Only keep if it has STRONG main product indicators like storage capacity
            // "128GB" or "256GB" indicates it's the actual phone, not an accessory
            const hasStorageIndicator = /\b(64|128|256|512)\s*gb\b/i.test(nameLower) || /\b1\s*tb\b/i.test(nameLower);
            if (!hasStorageIndicator) {
                return { type: 'Aksesuar', confidence: 0.95, isRelevant: false };
            }
        }

        // Model matches and not an accessory - this is the actual product
        return { type: 'Ana Ürün', confidence: 0.95, isRelevant: true };
    }

    // For general searches, include everything that has at least some relevance
    if (intent.category === 'general') {
        const confidence = 0.5 + (queryRelevance * 0.5);
        return { type: 'Ana Ürün', confidence, isRelevant: true };
    }

    // LESS AGGRESSIVE FILTERING: Only filter obvious accessories
    // Include product if it has main indicators OR if name is descriptive enough
    if (matchedExcludeKeyword || matchedAccessoryPattern) {
        // If it has main product indicators, keep it
        if (hasMainIndicator) {
            return { type: 'Ana Ürün', confidence: 0.7, isRelevant: true };
        }
        // If query relevance is high (50%+ keywords match), keep it
        if (queryRelevance >= 0.5) {
            return { type: 'Ana Ürün', confidence: 0.6, isRelevant: true };
        }
        // Only exclude if it's clearly just an accessory
        return { type: 'Aksesuar', confidence: 0.85, isRelevant: false };
    }

    if (hasMainIndicator) {
        return { type: 'Ana Ürün', confidence: 0.9, isRelevant: true };
    }

    // Default - include with query relevance as confidence
    const confidence = 0.5 + (queryRelevance * 0.3);
    return { type: 'Ana Ürün', confidence, isRelevant: true };
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
    console.log(`Search intent: ${intent.intentLabel} (${intent.category}), keywords: [${intent.queryKeywords.join(', ')}], model: ${intent.modelQuery ? `${intent.modelQuery.brand} ${intent.modelQuery.model}` : 'none'}`);

    const analyzed = products.map(product => {
        const classification = classifyProduct(product, intent);
        const discount = analyzeDiscount(product);
        const queryRelevance = calculateQueryRelevance(product.name.toLowerCase(), intent.queryKeywords);

        return {
            ...product,
            relevanceScore: classification.confidence,
            classification: classification.type,
            isRelevant: classification.isRelevant,
            discountStatus: discount.status,
            discountPercentage: discount.discountPercentage || 0,
            shortComment: discount.comment || null,
            _queryRelevance: queryRelevance // internal sorting field
        };
    });

    // Filter: relevant products, sorted by price (cheapest first)
    const relevant = analyzed
        .filter(p => p.isRelevant)
        .sort((a, b) => {
            // Primary sort: price ascending (cheapest first)
            return a.price - b.price;
        })
        .map(p => {
            // Remove internal field from response
            const { _queryRelevance, ...rest } = p;
            return rest;
        });

    const removed = analyzed.filter(p => !p.isRelevant);

    console.log(`Smart filter: ${relevant.length} relevant, ${removed.length} removed`);

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

function parseTrendyolProducts(html) {
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

// ==========================================
// HEPSIBURADA PARSER
// ==========================================
function parseHepsiburadaProducts(html) {
    const products = [];

    // Hepsiburada product cards use data-test-id="product-card-item" or class="productListContent"
    // Product links: href="/[brand]-[product-name]-p-HBCV[id]" or href="/[product-name]-pm-[id]"
    const productLinkRegex = /href="(\/[^"]*-p-([A-Z0-9]+)[^"]*)"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        // Skip duplicate product IDs
        if (productLinks.some(p => p.productId === linkMatch[2])) continue;
        productLinks.push({
            href: linkMatch[1],
            productId: linkMatch[2],
            position: linkMatch.index
        });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = link.position;
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract product name
        const namePatterns = [
            /data-test-id="product-card-name"[^>]*>([^<]+)/i,
            /class="[^"]*product(?:Description|Name|Title)[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        if (!name && link.href) {
            const slug = link.href.split('-p-')[0].replace(/^\//, '');
            name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /data-test-id="price-current-price"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*price-value[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*product-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*TL</i
        ];

        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price
        let originalPrice = null;
        const orgPatterns = [
            /data-test-id="price-old-price"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*(?:old|original)[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="[^"]*line-through[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*TL\s*<\/del>/i
        ];
        for (const pattern of orgPatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                const op = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (op > 0 && price && op > price) { originalPrice = op; break; }
            }
        }

        // Extract image
        let imageUrl = null;
        const imgMatch = cardContent.match(/src="(https:\/\/[^"]*(?:productimages|images\.hepsiburada)[^"]*\.(?:jpg|png|webp)[^"]*)"/i)
            || cardContent.match(/data-src="(https:\/\/[^"]*\.(?:jpg|png|webp)[^"]*)"/i);
        if (imgMatch) imageUrl = imgMatch[1];

        if (!name || !price || price < 1) continue;

        let cleanHref = link.href.replace(/&amp;/g, '&').split('?')[0];
        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: 'https://www.hepsiburada.com' + cleanHref,
            productId: link.productId,
            brand: null,
            seller: null,
            store: 'Hepsiburada'
        });
    }

    console.log(`Hepsiburada parsed: ${products.length} products`);
    return products;
}

// ==========================================
// N11 PARSER
// ==========================================
function parseN11Products(html) {
    const products = [];

    // N11 uses multiple URL patterns:
    // - /urun/[slug]/[id]
    // - /magaza/[seller]/urun/[slug]
    // - Product cards with data-product-id
    const productLinkRegex = /href="(https:\/\/www\.n11\.com\/(?:urun|magaza\/[^/]+\/urun)\/([^"]+))"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const slug = linkMatch[2];
        if (productLinks.some(p => p.slug === slug)) continue;
        if (slug.includes('?') || slug.includes('#')) continue; // Skip query strings
        productLinks.push({
            href: linkMatch[1],
            slug,
            position: linkMatch.index
        });
    }

    console.log(`N11: found ${productLinks.length} product links`);

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 1000);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name - N11 uses various class patterns
        const namePatterns = [
            /class="[^"]*productName[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*prdName[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*product-title[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*pro-name[^"]*"[^>]*>([^<]+)/i,
            /data-product-name="([^"]+)"/i,
            /title="([^"]{15,100})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m && m[1].trim().length > 5) { name = m[1].trim(); break; }
        }

        if (!name) {
            // Extract from slug
            const slugParts = link.slug.split('/')[0].split('?')[0];
            if (slugParts.length > 5) {
                name = slugParts.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        }

        // Extract price - N11 uses various price patterns
        let price = null;
        const pricePatterns = [
            /class="[^"]*newPrice[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*priceContainer[^"]*"[^>]*>[\s\S]*?([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /data-price="([0-9.]+)"/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i,
            /([0-9]{2,3}\.[0-9]{3}(?:\.[0-9]{3})?(?:,[0-9]{2})?)\s*(?:TL|₺)/
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 100 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price
        let originalPrice = null;
        const orgPatterns = [
            /class="[^"]*oldPrice[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*strikePrice[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/del>/i,
            /<s[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/s>/i
        ];
        for (const pattern of orgPatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                const op = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (op > 0 && price && op > price) { originalPrice = op; break; }
            }
        }

        // Extract image - try multiple patterns
        let imageUrl = null;
        const imgPatterns = [
            /src="(https:\/\/[^"]*n11[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-src="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-original="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\/(?:urunler|products?|images?)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i
        ];
        for (const pattern of imgPatterns) {
            const m = cardContent.match(pattern);
            if (m && m[1] && !m[1].includes('logo') && !m[1].includes('icon')) {
                imageUrl = m[1];
                break;
            }
        }

        if (!name || !price || price < 100) continue;

        // Extract product ID from URL
        const idMatch = link.slug.match(/(\d+)(?:$|\/|\?)/);
        const productId = idMatch ? idMatch[1] : link.slug.replace(/[\/\?]/g, '-').slice(0, 50);

        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: link.href,
            productId: 'n11-' + productId,
            brand: null,
            seller: null,
            store: 'N11'
        });
    }

    console.log(`N11 parsed: ${products.length} products`);
    return products;
}

// ==========================================
// AMAZON TR PARSER
// ==========================================
function parseAmazonProducts(html) {
    const products = [];

    // Amazon product cards: data-asin="B0..." or class="s-result-item" with data-asin
    const asinRegex = /data-asin="([A-Z0-9]{10})"/gi;
    const asins = [];
    let asinMatch;

    while ((asinMatch = asinRegex.exec(html)) !== null) {
        if (asins.some(a => a.asin === asinMatch[1])) continue;
        if (asinMatch[1] === '') continue;
        asins.push({
            asin: asinMatch[1],
            position: asinMatch.index
        });
    }

    for (let i = 0; i < asins.length && products.length < 20; i++) {
        const item = asins[i];
        const contentStart = item.position;
        const contentEnd = asins[i + 1]?.position || contentStart + 10000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 10000));

        // Extract name
        const namePatterns = [
            /class="[^"]*a-size-base-plus[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*a-size-medium[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*s-line-clamp[^"]*"[^>]*>\s*(?:<[^>]+>)*\s*([^<]+)/i,
            /aria-label="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m && m[1].trim().length > 5) { name = m[1].trim(); break; }
        }

        // Extract price - Amazon uses class="a-price" with whole and fraction parts
        let price = null;
        const pricePatterns = [
            /class="a-price"[^>]*>.*?class="a-offscreen"[^>]*>([0-9.,]+)\s*TL/is,
            /class="a-offscreen"[^>]*>\s*([0-9.,]+)\s*TL/i,
            /class="[^"]*a-price-whole[^"]*"[^>]*>([0-9.]+)/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*TL</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                let priceStr = m[1].trim();
                // Handle "47.499,00" format
                price = parseFloat(priceStr.replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price (strikethrough)
        let originalPrice = null;
        const orgMatch = cardContent.match(/class="[^"]*a-text-price[^"]*"[^>]*>.*?class="a-offscreen"[^>]*>([0-9.,]+)\s*TL/is);
        if (orgMatch) {
            const op = parseFloat(orgMatch[1].replace(/\./g, '').replace(',', '.'));
            if (op > 0 && price && op > price) originalPrice = op;
        }

        // Extract image
        let imageUrl = null;
        const imgMatch = cardContent.match(/src="(https:\/\/m\.media-amazon\.com\/images[^"]+)"/i)
            || cardContent.match(/src="(https:\/\/[^"]*\.(?:jpg|png|webp)[^"]*)"/i);
        if (imgMatch) imageUrl = imgMatch[1];

        if (!name || !price || price < 1) continue;

        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: `https://www.amazon.com.tr/dp/${item.asin}`,
            productId: 'amz-' + item.asin,
            brand: null,
            seller: null,
            store: 'Amazon'
        });
    }

    console.log(`Amazon parsed: ${products.length} products`);
    return products;
}

// ==========================================
// PTTAVM PARSER
// ==========================================
function parsePttavmProducts(html) {
    const products = [];

    // PTTAvm product links: href="/[product-slug]-p-[product-id]"
    const productLinkRegex = /href="(\/[^"]*-p-(\d+))"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const pid = linkMatch[2];
        if (productLinks.some(p => p.pid === pid)) continue;
        productLinks.push({
            href: linkMatch[1],
            pid,
            position: linkMatch.index
        });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 500);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name
        const namePatterns = [
            /class="[^"]*product[_-]?name[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*product[_-]?title[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i,
            /alt="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        if (!name && link.href) {
            const slug = link.href.split('-p-')[0].replace(/^\//, '');
            name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /class="[^"]*(?:sale|current|new)[_-]?price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /<strong[^>]*>\s*([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/strong>/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price
        let originalPrice = null;
        const orgPatterns = [
            /class="[^"]*(?:old|original|list)[_-]?price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*line-through[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/del>/i,
            /<s[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/s>/i
        ];
        for (const pattern of orgPatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                const op = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (op > 0 && price && op > price) { originalPrice = op; break; }
            }
        }

        // Extract image
        let imageUrl = null;
        const imgMatch = cardContent.match(/src="(https:\/\/cdn-img\.pttavm\.com[^"]*\.(?:jpg|png|webp)[^"]*)"/i)
            || cardContent.match(/data-src="(https:\/\/cdn-img\.pttavm\.com[^"]*\.(?:jpg|png|webp)[^"]*)"/i)
            || cardContent.match(/src="(https:\/\/[^"]*\.(?:jpg|png|webp)[^"]*)"/i);
        if (imgMatch) imageUrl = imgMatch[1];

        if (!name || !price || price < 1) continue;

        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: 'https://www.pttavm.com' + link.href,
            productId: 'ptt-' + link.pid,
            brand: null,
            seller: null,
            store: 'PttAvm'
        });
    }

    // Fallback: try JSON-LD structured data
    if (products.length === 0) {
        const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
        let jsonMatch;
        while ((jsonMatch = jsonLdRegex.exec(html)) !== null) {
            try {
                const data = JSON.parse(jsonMatch[1]);
                if (data['@type'] === 'Product' || (Array.isArray(data) && data[0]?.['@type'] === 'Product')) {
                    const items = Array.isArray(data) ? data : [data];
                    for (const item of items) {
                        if (products.length >= 20) break;
                        const offer = item.offers || item.offers?.[0];
                        const p = parseFloat(offer?.price || offer?.lowPrice || '0');
                        if (item.name && p > 0) {
                            products.push({
                                name: item.name,
                                price: p,
                                originalPrice: null,
                                imageUrl: item.image || null,
                                productUrl: item.url ? (item.url.startsWith('http') ? item.url : 'https://www.pttavm.com' + item.url) : null,
                                productId: 'ptt-' + (item.sku || Math.random().toString(36).slice(2, 10)),
                                brand: null,
                                seller: null,
                                store: 'PttAvm'
                            });
                        }
                    }
                }
            } catch (e) { /* ignore invalid JSON */ }
        }
    }

    console.log(`PttAvm parsed: ${products.length} products`);
    return products;
}

// ==========================================
// PAZARAMA PARSER
// ==========================================
function parsePazaramaProducts(html) {
    const products = [];

    // Pazarama product links: href="/[product-slug]-p-[product-id]"
    const productLinkRegex = /href="(\/[^"]*-p-(\d+))"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const pid = linkMatch[2];
        if (productLinks.some(p => p.pid === pid)) continue;
        productLinks.push({
            href: linkMatch[1],
            pid,
            position: linkMatch.index
        });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 500);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name
        const namePatterns = [
            /class="[^"]*product[_-]?name[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*product[_-]?title[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i,
            /alt="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        if (!name && link.href) {
            const slug = link.href.split('-p-')[0].replace(/^\//, '');
            name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /class="[^"]*(?:sale|current|new|discounted)[_-]?price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price
        let originalPrice = null;
        const orgPatterns = [
            /class="[^"]*(?:old|original|list)[_-]?price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*line-through[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/del>/i,
            /<s[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/s>/i
        ];
        for (const pattern of orgPatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                const op = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (op > 0 && price && op > price) { originalPrice = op; break; }
            }
        }

        // Extract image
        let imageUrl = null;
        const imgMatch = cardContent.match(/src="(https:\/\/img\.pzrmcdn\.com[^"]*\.(?:jpg|png|webp)[^"]*)"/i)
            || cardContent.match(/src="(https:\/\/img\.pzrmcdn\.com[^"]+)"/i)
            || cardContent.match(/data-src="(https:\/\/[^"]*\.(?:jpg|png|webp)[^"]*)"/i)
            || cardContent.match(/src="(https:\/\/[^"]*\.(?:jpg|png|webp)[^"]*)"/i);
        if (imgMatch) imageUrl = imgMatch[1];

        if (!name || !price || price < 1) continue;

        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: 'https://www.pazarama.com' + link.href,
            productId: 'pzr-' + link.pid,
            brand: null,
            seller: null,
            store: 'Pazarama'
        });
    }

    console.log(`Pazarama parsed: ${products.length} products`);
    return products;
}

// ==========================================
// TEKNOSA PARSER
// ==========================================
function parseTeknosaProducts(html) {
    const products = [];

    // Teknosa product cards
    const productLinkRegex = /href="(\/[^"]*-p-[^"]+)"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const href = linkMatch[1];
        if (productLinks.some(p => p.href === href)) continue;
        if (href.includes('/sepet') || href.includes('/uyelik')) continue;
        productLinks.push({
            href,
            position: linkMatch.index
        });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 1000);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name
        const namePatterns = [
            /class="[^"]*product[_-]?name[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*prd-name[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i,
            /alt="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        if (!name && link.href) {
            const slug = link.href.split('-p-')[0].replace(/^\//, '');
            name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /class="[^"]*prc[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price
        let originalPrice = null;
        const orgPatterns = [
            /class="[^"]*(?:old|original)[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/del>/i
        ];
        for (const pattern of orgPatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                const op = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (op > 0 && price && op > price) { originalPrice = op; break; }
            }
        }

        // Extract image - Teknosa uses various CDN patterns
        let imageUrl = null;
        const imgPatterns = [
            /src="(https:\/\/[^"]*teknosa[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]*cdn[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-src="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-lazy="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-original="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\/(?:products?|images?|media)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i
        ];
        for (const pattern of imgPatterns) {
            const m = cardContent.match(pattern);
            if (m && m[1] && !m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('banner')) {
                imageUrl = m[1];
                break;
            }
        }

        if (!name || !price || price < 1) continue;

        const idMatch = link.href.match(/-p-(\d+)/);
        const productId = idMatch ? idMatch[1] : link.href.replace(/\//g, '-');

        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: 'https://www.teknosa.com' + link.href,
            productId: 'tek-' + productId,
            brand: null,
            seller: null,
            store: 'Teknosa'
        });
    }

    console.log(`Teknosa parsed: ${products.length} products`);
    return products;
}

// ==========================================
// VATAN BILGISAYAR PARSER
// ==========================================
function parseVatanProducts(html) {
    const products = [];

    // Vatan product cards
    const productLinkRegex = /href="(https:\/\/www\.vatanbilgisayar\.com\/[^"]+)"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const href = linkMatch[1];
        if (productLinks.some(p => p.href === href)) continue;
        if (href.includes('/sepet') || href.includes('/kategori') || href.includes('/arama')) continue;
        productLinks.push({
            href,
            position: linkMatch.index
        });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 1000);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name
        const namePatterns = [
            /class="[^"]*product-name[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*product__name[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        if (!name) {
            const slug = link.href.replace('https://www.vatanbilgisayar.com/', '').split('/')[0];
            if (slug && slug.length > 5) {
                name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /class="[^"]*product-price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract original price
        let originalPrice = null;
        const orgPatterns = [
            /class="[^"]*(?:old|original)[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            /<del[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)\s*<\/del>/i
        ];
        for (const pattern of orgPatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                const op = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (op > 0 && price && op > price) { originalPrice = op; break; }
            }
        }

        // Extract image - Vatan uses various CDN patterns
        let imageUrl = null;
        const imgPatterns = [
            /src="(https:\/\/[^"]*vatanbilgisayar[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]*cdn[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-src="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-lazy="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\/(?:products?|images?|media)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i
        ];
        for (const pattern of imgPatterns) {
            const m = cardContent.match(pattern);
            if (m && m[1] && !m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('banner')) {
                imageUrl = m[1];
                break;
            }
        }

        if (!name || !price || price < 1) continue;

        // Generate product ID from URL
        const urlParts = link.href.split('/');
        const productId = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || Math.random().toString(36).slice(2, 10);

        products.push({
            name,
            price,
            originalPrice,
            imageUrl,
            productUrl: link.href,
            productId: 'vat-' + productId,
            brand: null,
            seller: null,
            store: 'Vatan'
        });
    }

    console.log(`Vatan parsed: ${products.length} products`);
    return products;
}

// ==========================================
// MEDIAMARKT PARSER
// ==========================================
function parseMediaMarktProducts(html) {
    const products = [];

    // MediaMarkt product cards
    const productLinkRegex = /href="(\/tr\/product\/[^"]+)"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const href = linkMatch[1];
        if (productLinks.some(p => p.href === href)) continue;
        productLinks.push({
            href,
            position: linkMatch.index
        });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 1000);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name
        const namePatterns = [
            /class="[^"]*product-title[^"]*"[^>]*>([^<]+)/i,
            /class="[^"]*product-name[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract image - MediaMarkt uses various CDN patterns
        let imageUrl = null;
        const imgPatterns = [
            /src="(https:\/\/[^"]*mediamarkt[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]*cdn[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-src="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /data-lazy="(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\/(?:products?|images?|media)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i
        ];
        for (const pattern of imgPatterns) {
            const m = cardContent.match(pattern);
            if (m && m[1] && !m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('banner')) {
                imageUrl = m[1];
                break;
            }
        }

        if (!name || !price || price < 1) continue;

        // Extract product ID from URL
        const idMatch = link.href.match(/(\d+)\.html/);
        const productId = idMatch ? idMatch[1] : Math.random().toString(36).slice(2, 10);

        products.push({
            name,
            price,
            originalPrice: null,
            imageUrl,
            productUrl: 'https://www.mediamarkt.com.tr' + link.href,
            productId: 'mm-' + productId,
            brand: null,
            seller: null,
            store: 'MediaMarkt'
        });
    }

    console.log(`MediaMarkt parsed: ${products.length} products`);
    return products;
}

// ==========================================
// MIGROS PARSER
// ==========================================
function parseMigrosProducts(html) {
    const products = [];

    // Migros uses JSON data in the page
    try {
        const jsonMatch = html.match(/"products"\s*:\s*(\[[\s\S]*?\])\s*,\s*"(?:pagination|facets|total)"/i);
        if (jsonMatch) {
            const productsData = JSON.parse(jsonMatch[1]);
            for (const item of productsData.slice(0, 20)) {
                if (item.name && item.shownPrice) {
                    products.push({
                        name: item.name,
                        price: parseFloat(item.shownPrice),
                        originalPrice: item.regularPrice ? parseFloat(item.regularPrice) : null,
                        imageUrl: item.images?.[0]?.urls?.PRODUCT_LIST || item.images?.[0]?.url || null,
                        productUrl: `https://www.migros.com.tr${item.productUrl || item.url || ''}`,
                        productId: 'mig-' + (item.sku || item.productId || Math.random().toString(36).slice(2, 10)),
                        brand: item.brand || null,
                        seller: null,
                        store: 'Migros'
                    });
                }
            }
        }
    } catch (e) {
        // Fallback to HTML parsing
    }

    // Fallback HTML parsing
    if (products.length === 0) {
        const productLinkRegex = /href="(\/[^"]*-p-[^"]+)"/gi;
        const productLinks = [];
        let linkMatch;

        while ((linkMatch = productLinkRegex.exec(html)) !== null) {
            const href = linkMatch[1];
            if (productLinks.some(p => p.href === href)) continue;
            productLinks.push({ href, position: linkMatch.index });
        }

        for (let i = 0; i < productLinks.length && products.length < 20; i++) {
            const link = productLinks[i];
            const contentStart = Math.max(0, link.position - 1000);
            const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
            const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

            const nameMatch = cardContent.match(/class="[^"]*product-name[^"]*"[^>]*>([^<]+)/i);
            const priceMatch = cardContent.match(/>([0-9.,]+)\s*(?:TL|₺)</i);

            if (nameMatch && priceMatch) {
                const price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1) {
                    products.push({
                        name: nameMatch[1].trim(),
                        price,
                        originalPrice: null,
                        imageUrl: null,
                        productUrl: 'https://www.migros.com.tr' + link.href,
                        productId: 'mig-' + Math.random().toString(36).slice(2, 10),
                        brand: null,
                        seller: null,
                        store: 'Migros'
                    });
                }
            }
        }
    }

    console.log(`Migros parsed: ${products.length} products`);
    return products;
}

// ==========================================
// CICEKSEPETI PARSER
// ==========================================
function parseCicekSepetiProducts(html) {
    const products = [];

    // CicekSepeti product links
    const productLinkRegex = /href="(\/[^"]*-[a-z]{2,4}\d+)"/gi;
    const productLinks = [];
    let linkMatch;

    while ((linkMatch = productLinkRegex.exec(html)) !== null) {
        const href = linkMatch[1];
        if (productLinks.some(p => p.href === href)) continue;
        if (href.includes('/kampanya') || href.includes('/kategori')) continue;
        productLinks.push({ href, position: linkMatch.index });
    }

    for (let i = 0; i < productLinks.length && products.length < 20; i++) {
        const link = productLinks[i];
        const contentStart = Math.max(0, link.position - 1000);
        const contentEnd = productLinks[i + 1]?.position || contentStart + 8000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 8000));

        // Extract name
        const namePatterns = [
            /class="[^"]*product[_-]?name[^"]*"[^>]*>([^<]+)/i,
            /title="([^"]{10,})"/i,
            /alt="([^"]{10,})"/i
        ];
        let name = null;
        for (const pattern of namePatterns) {
            const m = cardContent.match(pattern);
            if (m) { name = m[1].trim(); break; }
        }

        // Extract price
        let price = null;
        const pricePatterns = [
            /class="[^"]*price[^"]*"[^>]*>\s*([0-9.]+(?:,[0-9]{2})?)\s*(?:TL|₺)/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*(?:TL|₺)</i
        ];
        for (const pattern of pricePatterns) {
            const m = cardContent.match(pattern);
            if (m) {
                price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 1 && price <= 999999) break;
                price = null;
            }
        }

        // Extract image
        let imageUrl = null;
        const imgMatch = cardContent.match(/src="(https:\/\/[^"]*ciceksepeti[^"]*\.(?:jpg|png|webp)[^"]*)"/i)
            || cardContent.match(/data-src="(https:\/\/[^"]*\.(?:jpg|png|webp)[^"]*)"/i);
        if (imgMatch) imageUrl = imgMatch[1];

        if (!name || !price || price < 1) continue;

        // Extract product ID from URL
        const idMatch = link.href.match(/([a-z]{2,4}\d+)$/i);
        const productId = idMatch ? idMatch[1] : Math.random().toString(36).slice(2, 10);

        products.push({
            name,
            price,
            originalPrice: null,
            imageUrl,
            productUrl: 'https://www.ciceksepeti.com' + link.href,
            productId: 'cs-' + productId,
            brand: null,
            seller: null,
            store: 'CicekSepeti'
        });
    }

    console.log(`CicekSepeti parsed: ${products.length} products`);
    return products;
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Start pre-caching popular searches after 5 seconds
    setTimeout(() => preCachePopularSearches(), 5000);
});
