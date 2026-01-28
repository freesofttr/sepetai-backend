const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ScraperAPI configuration
const SCRAPER_API_KEY = '27c0df8063c38ebc97100e825ff4cd1c';
const SCRAPER_API_URL = 'http://api.scraperapi.com';

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SepetAI Backend API with ScraperAPI' });
});

// Helper function to fetch via ScraperAPI (without rendering - faster)
async function fetchWithScraperAPI(url, useRender = false) {
    const fetch = (await import('node-fetch')).default;

    const params = new URLSearchParams({
        api_key: SCRAPER_API_KEY,
        url: url,
        country_code: 'tr'
    });

    // Only add render if needed (much slower)
    if (useRender) {
        params.set('render', 'true');
    }

    const scraperUrl = `${SCRAPER_API_URL}?${params.toString()}`;
    console.log(`Fetching via ScraperAPI (render=${useRender}): ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), useRender ? 45000 : 20000);

    try {
        const response = await fetch(scraperUrl, {
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`ScraperAPI returned ${response.status}`);
        }

        return response;
    } catch (error) {
        clearTimeout(timeout);
        throw error;
    }
}

// Search all stores - optimized for speed
app.get('/api/search/all', async (req, res) => {
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    console.log(`Searching for "${q}"...`);
    const startTime = Date.now();

    try {
        // Try Trendyol first (usually fastest and most reliable)
        let products = await scrapeTrendyol(q);

        // If Trendyol got results, return immediately
        if (products.length > 0) {
            console.log(`Trendyol returned ${products.length} products in ${Date.now() - startTime}ms`);
            return res.json({
                query: q,
                count: products.length,
                products
            });
        }

        // Try other stores in parallel if Trendyol failed
        console.log('Trendyol returned 0, trying other stores...');
        const [hepsiburada, n11] = await Promise.allSettled([
            scrapeHepsiburada(q),
            scrapeN11(q)
        ]);

        products = [
            ...(hepsiburada.status === 'fulfilled' ? hepsiburada.value : []),
            ...(n11.status === 'fulfilled' ? n11.value : [])
        ];

        console.log(`Found ${products.length} total products in ${Date.now() - startTime}ms`);

        res.json({
            query: q,
            count: products.length,
            products
        });
    } catch (error) {
        console.error('Scraping error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search single store
app.get('/api/search', async (req, res) => {
    const { q, store = 'trendyol' } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    try {
        let products = [];

        switch (store.toLowerCase()) {
            case 'trendyol':
                products = await scrapeTrendyol(q);
                break;
            case 'hepsiburada':
                products = await scrapeHepsiburada(q);
                break;
            case 'n11':
                products = await scrapeN11(q);
                break;
            default:
                products = await scrapeTrendyol(q);
        }

        res.json({
            query: q,
            store,
            count: products.length,
            products
        });
    } catch (error) {
        console.error('Scraping error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Trendyol scraper - tries fast method first, then with render
async function scrapeTrendyol(query) {
    console.log('Starting Trendyol scraper...');

    // Try mobile API first (fastest, no scraping needed)
    try {
        const apiProducts = await fetchTrendyolMobileAPI(query);
        if (apiProducts.length > 0) {
            console.log(`Trendyol API returned ${apiProducts.length} products`);
            return apiProducts;
        }
    } catch (e) {
        console.log('Trendyol API failed:', e.message);
    }

    // Try scraping without render first (faster)
    try {
        const url = `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url, false);
        const html = await response.text();

        console.log(`Trendyol HTML length (no render): ${html.length}`);

        if (!html.includes('Bir dakika') && !html.includes('captcha')) {
            const products = parseTrendyolProducts(html);
            if (products.length > 0) {
                console.log(`Parsed ${products.length} products from Trendyol (no render)`);
                return products;
            }
        }
    } catch (e) {
        console.log('Trendyol no-render failed:', e.message);
    }

    // Last resort: try with render (slower but more reliable)
    try {
        const url = `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url, true);
        const html = await response.text();

        console.log(`Trendyol HTML length (with render): ${html.length}`);

        if (!html.includes('Bir dakika') && !html.includes('captcha')) {
            const products = parseTrendyolProducts(html);
            console.log(`Parsed ${products.length} products from Trendyol (with render)`);
            return products;
        }
    } catch (e) {
        console.log('Trendyol with-render failed:', e.message);
    }

    return [];
}

// Trendyol mobile API (fastest method)
async function fetchTrendyolMobileAPI(query) {
    const fetch = (await import('node-fetch')).default;

    const params = new URLSearchParams({
        api_key: SCRAPER_API_KEY,
        url: `https://public.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll/sr?q=${encodeURIComponent(query)}&qt=${encodeURIComponent(query)}&st=${encodeURIComponent(query)}&os=1&pi=1&culture=tr-TR&userGenderId=1&pId=0&scoringAlgorithmId=2&categoryRelevancyEnabled=false&isLegalRequirementConfirmed=false&searchStrategyType=DEFAULT&productStampType=TypeA`,
        country_code: 'tr'
    });

    const response = await fetch(`${SCRAPER_API_URL}?${params.toString()}`, {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
    }

    const text = await response.text();

    try {
        const data = JSON.parse(text);
        const apiProducts = data?.result?.products || [];

        return apiProducts.slice(0, 20).map(p => ({
            name: p.name || '',
            price: p.price?.sellingPrice || p.price?.discountedPrice || 0,
            originalPrice: p.price?.originalPrice !== p.price?.sellingPrice ? p.price?.originalPrice : null,
            imageUrl: p.images?.[0] ? `https://cdn.dsmcdn.com/ty${p.images[0].replace('/ty', '')}` : null,
            productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
            brand: p.brand?.name || null,
            seller: p.merchantName || null,
            store: 'Trendyol'
        }));
    } catch (e) {
        console.log('Failed to parse Trendyol API response');
        return [];
    }
}

// Parse Trendyol products from HTML
function parseTrendyolProducts(html) {
    const products = [];

    // Find JSON data in page (Trendyol embeds product data as JSON)
    const jsonMatch = html.match(/__SEARCH_APP_INITIAL_STATE__\s*=\s*({.*?});/s);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const items = data?.results?.products || [];

            items.slice(0, 20).forEach(p => {
                products.push({
                    name: p.name || '',
                    price: p.price?.sellingPrice || p.price?.discountedPrice || 0,
                    originalPrice: p.price?.originalPrice !== p.price?.sellingPrice ? p.price?.originalPrice : null,
                    imageUrl: p.images?.[0] ? `https://cdn.dsmcdn.com/ty${p.images[0].replace('/ty', '')}` : null,
                    productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
                    brand: p.brand?.name || null,
                    seller: p.merchantName || null,
                    store: 'Trendyol'
                });
            });

            if (products.length > 0) return products;
        } catch (e) {
            console.log('Failed to parse Trendyol JSON:', e.message);
        }
    }

    // Fallback: Parse HTML directly with regex
    const nameMatches = [...html.matchAll(/prdct-desc-cntnr-name[^>]*>([^<]+)</g)];
    const priceMatches = [...html.matchAll(/prc-box-(?:dscntd|sllng)[^>]*>([^<]+)</g)];

    const minLength = Math.min(nameMatches.length, priceMatches.length, 20);

    for (let i = 0; i < minLength; i++) {
        const priceText = priceMatches[i][1].replace(/[^\d,]/g, '').replace(',', '.');
        products.push({
            name: nameMatches[i][1].trim(),
            price: parseFloat(priceText) || 0,
            originalPrice: null,
            imageUrl: null,
            productUrl: null,
            brand: null,
            seller: null,
            store: 'Trendyol'
        });
    }

    return products;
}

// Hepsiburada scraper
async function scrapeHepsiburada(query) {
    console.log('Starting Hepsiburada scraper...');

    try {
        const url = `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url, false);
        const html = await response.text();

        console.log(`Hepsiburada HTML length: ${html.length}`);

        if (html.includes('captcha') || html.includes('robot')) {
            console.log('Hepsiburada returned captcha page');
            return [];
        }

        const products = parseHepsiburadaProducts(html);
        console.log(`Parsed ${products.length} products from Hepsiburada`);

        return products;
    } catch (error) {
        console.error('Hepsiburada scraper error:', error.message);
        return [];
    }
}

// Parse Hepsiburada products from HTML
function parseHepsiburadaProducts(html) {
    const products = [];

    // Try to find JSON data
    const jsonMatch = html.match(/__SEARCH_RESULT__\s*=\s*({.*?});/s) ||
                      html.match(/window\.__remixContext\s*=\s*({[\s\S]*?});/);

    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const items = data?.products || [];

            items.slice(0, 20).forEach(p => {
                products.push({
                    name: p.name || p.productName || '',
                    price: p.price || p.salePrice || 0,
                    originalPrice: p.originalPrice !== p.price ? p.originalPrice : null,
                    imageUrl: p.image || p.imageUrl || null,
                    productUrl: p.url ? `https://www.hepsiburada.com${p.url}` : null,
                    brand: p.brand || null,
                    seller: p.merchantName || null,
                    store: 'Hepsiburada'
                });
            });

            if (products.length > 0) return products;
        } catch (e) {
            console.log('Failed to parse Hepsiburada JSON:', e.message);
        }
    }

    // Fallback: Parse HTML with regex
    const nameMatches = [...html.matchAll(/data-test-id="product-card-name"[^>]*>([^<]+)</g)];
    const priceMatches = [...html.matchAll(/data-test-id="price-current-price"[^>]*>([^<]+)</g)];

    const minLength = Math.min(nameMatches.length, priceMatches.length, 20);

    for (let i = 0; i < minLength; i++) {
        const priceText = priceMatches[i][1].replace(/[^\d,]/g, '').replace(',', '.');
        products.push({
            name: nameMatches[i][1].trim(),
            price: parseFloat(priceText) || 0,
            originalPrice: null,
            imageUrl: null,
            productUrl: null,
            brand: null,
            seller: null,
            store: 'Hepsiburada'
        });
    }

    return products;
}

// N11 scraper
async function scrapeN11(query) {
    console.log('Starting N11 scraper...');

    try {
        const url = `https://www.n11.com/arama?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url, false);
        const html = await response.text();

        console.log(`N11 HTML length: ${html.length}`);

        if (html.includes('captcha') || html.includes('robot')) {
            console.log('N11 returned captcha page');
            return [];
        }

        const products = parseN11Products(html);
        console.log(`Parsed ${products.length} products from N11`);

        return products;
    } catch (error) {
        console.error('N11 scraper error:', error.message);
        return [];
    }
}

// Parse N11 products from HTML
function parseN11Products(html) {
    const products = [];

    const productBlocks = html.split('class="columnContent"');

    productBlocks.slice(1, 21).forEach(block => {
        try {
            const nameMatch = block.match(/class="productName"[^>]*>([^<]+)</);
            const priceMatch = block.match(/<ins[^>]*>([^<]+)</);
            const originalPriceMatch = block.match(/<del[^>]*>([^<]+)</);
            const imageMatch = block.match(/src="([^"]+\.(?:jpg|png|webp)[^"]*)"/i);
            const linkMatch = block.match(/href="(https:\/\/www\.n11\.com[^"]+)"/);

            if (nameMatch && priceMatch) {
                const priceText = priceMatch[1].replace(/[^\d,]/g, '').replace(',', '.');
                const originalPriceText = originalPriceMatch ?
                    originalPriceMatch[1].replace(/[^\d,]/g, '').replace(',', '.') : null;

                products.push({
                    name: nameMatch[1].trim(),
                    price: parseFloat(priceText) || 0,
                    originalPrice: originalPriceText ? parseFloat(originalPriceText) : null,
                    imageUrl: imageMatch ? imageMatch[1] : null,
                    productUrl: linkMatch ? linkMatch[1] : null,
                    brand: null,
                    seller: null,
                    store: 'N11'
                });
            }
        } catch (e) {
            // Skip this product
        }
    });

    return products;
}

app.listen(PORT, () => {
    console.log(`SepetAI Backend running on port ${PORT} with ScraperAPI`);
});
