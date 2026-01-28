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

// Helper function to fetch via ScraperAPI
async function fetchWithScraperAPI(url, options = {}) {
    const fetch = (await import('node-fetch')).default;

    const params = new URLSearchParams({
        api_key: SCRAPER_API_KEY,
        url: url,
        render: 'true',  // Enable JavaScript rendering
        country_code: 'tr'  // Use Turkish IP
    });

    const scraperUrl = `${SCRAPER_API_URL}?${params.toString()}`;
    console.log(`Fetching via ScraperAPI: ${url}`);

    const response = await fetch(scraperUrl, {
        timeout: 60000,  // 60 second timeout for rendered pages
        ...options
    });

    if (!response.ok) {
        throw new Error(`ScraperAPI returned ${response.status}`);
    }

    return response;
}

// Search products
app.get('/api/search', async (req, res) => {
    const { q, store = 'trendyol' } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    console.log(`Searching for "${q}" on ${store}...`);

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

        console.log(`Found ${products.length} products`);
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

// Search all stores
app.get('/api/search/all', async (req, res) => {
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    console.log(`Searching for "${q}" on all stores with ScraperAPI...`);

    try {
        // Try all stores in parallel with ScraperAPI
        const [trendyol, hepsiburada, n11] = await Promise.allSettled([
            scrapeTrendyol(q),
            scrapeHepsiburada(q),
            scrapeN11(q)
        ]);

        console.log('Trendyol:', trendyol.status, trendyol.status === 'rejected' ? trendyol.reason?.message : `${trendyol.value?.length} products`);
        console.log('Hepsiburada:', hepsiburada.status, hepsiburada.status === 'rejected' ? hepsiburada.reason?.message : `${hepsiburada.value?.length} products`);
        console.log('N11:', n11.status, n11.status === 'rejected' ? n11.reason?.message : `${n11.value?.length} products`);

        let products = [
            ...(trendyol.status === 'fulfilled' ? trendyol.value : []),
            ...(hepsiburada.status === 'fulfilled' ? hepsiburada.value : []),
            ...(n11.status === 'fulfilled' ? n11.value : [])
        ];

        console.log(`Found ${products.length} total products`);

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

// Trendyol scraper with ScraperAPI
async function scrapeTrendyol(query) {
    console.log('Starting Trendyol scraper with ScraperAPI...');

    try {
        const url = `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url);
        const html = await response.text();

        console.log(`Trendyol HTML length: ${html.length}`);

        // Check if we got blocked
        if (html.includes('Bir dakika') || html.includes('captcha')) {
            console.log('Trendyol returned captcha page');
            return [];
        }

        // Parse products from HTML
        const products = parseTrendyolProducts(html);
        console.log(`Parsed ${products.length} products from Trendyol`);

        return products;
    } catch (error) {
        console.error('Trendyol scraper error:', error.message);
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

            return products;
        } catch (e) {
            console.log('Failed to parse Trendyol JSON:', e.message);
        }
    }

    // Fallback: Parse HTML directly
    const productRegex = /<div[^>]*class="[^"]*p-card-wrppr[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;
    const matches = html.match(productRegex) || [];

    matches.slice(0, 20).forEach(match => {
        try {
            const nameMatch = match.match(/prdct-desc-cntnr-name[^>]*>([^<]+)</);
            const priceMatch = match.match(/prc-box-(?:dscntd|sllng)[^>]*>([^<]+)</);
            const originalPriceMatch = match.match(/prc-box-orgnl[^>]*>([^<]+)</);
            const imageMatch = match.match(/src="(https:\/\/cdn\.dsmcdn\.com[^"]+)"/);
            const linkMatch = match.match(/href="([^"]+)"/);
            const brandMatch = match.match(/prdct-desc-cntnr-ttl[^>]*>([^<]+)</);

            if (nameMatch && priceMatch) {
                const priceText = priceMatch[1].replace(/[^\d,]/g, '').replace(',', '.');
                const originalPriceText = originalPriceMatch ?
                    originalPriceMatch[1].replace(/[^\d,]/g, '').replace(',', '.') : null;

                products.push({
                    name: nameMatch[1].trim(),
                    price: parseFloat(priceText) || 0,
                    originalPrice: originalPriceText ? parseFloat(originalPriceText) : null,
                    imageUrl: imageMatch ? imageMatch[1] : null,
                    productUrl: linkMatch ? `https://www.trendyol.com${linkMatch[1]}` : null,
                    brand: brandMatch ? brandMatch[1].trim() : null,
                    seller: null,
                    store: 'Trendyol'
                });
            }
        } catch (e) {
            // Skip this product
        }
    });

    return products;
}

// Hepsiburada scraper with ScraperAPI
async function scrapeHepsiburada(query) {
    console.log('Starting Hepsiburada scraper with ScraperAPI...');

    try {
        const url = `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url);
        const html = await response.text();

        console.log(`Hepsiburada HTML length: ${html.length}`);

        // Check if we got blocked
        if (html.includes('captcha') || html.includes('robot')) {
            console.log('Hepsiburada returned captcha page');
            return [];
        }

        // Parse products from HTML
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
    const jsonMatch = html.match(/__SEARCH_RESULT_INITIAL_STATE__\s*=\s*({.*?});/s) ||
                      html.match(/window\.__remixContext\s*=\s*({.*?});/s);

    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const items = data?.products || data?.loaderData?.['routes/_main.ara']?.products || [];

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

            return products;
        } catch (e) {
            console.log('Failed to parse Hepsiburada JSON:', e.message);
        }
    }

    // Fallback: Parse HTML with regex
    // Look for product cards
    const nameRegex = /data-test-id="product-card-name"[^>]*>([^<]+)</gi;
    const priceRegex = /data-test-id="price-current-price"[^>]*>([^<]+)</gi;

    const names = [...html.matchAll(nameRegex)];
    const prices = [...html.matchAll(priceRegex)];

    const minLength = Math.min(names.length, prices.length, 20);

    for (let i = 0; i < minLength; i++) {
        const priceText = prices[i][1].replace(/[^\d,]/g, '').replace(',', '.');

        products.push({
            name: names[i][1].trim(),
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

// N11 scraper with ScraperAPI
async function scrapeN11(query) {
    console.log('Starting N11 scraper with ScraperAPI...');

    try {
        const url = `https://www.n11.com/arama?q=${encodeURIComponent(query)}`;
        const response = await fetchWithScraperAPI(url);
        const html = await response.text();

        console.log(`N11 HTML length: ${html.length}`);

        // Check if we got blocked
        if (html.includes('captcha') || html.includes('robot')) {
            console.log('N11 returned captcha page');
            return [];
        }

        // Parse products from HTML
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

    // N11 uses standard HTML structure
    // Look for product items
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
