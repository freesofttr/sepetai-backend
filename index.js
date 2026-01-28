const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SepetAI Backend API' });
});

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

    console.log(`Searching for "${q}" on all stores...`);

    try {
        // Try Trendyol API first (faster and more reliable)
        let products = await fetchTrendyolAPI(q);

        if (products.length === 0) {
            console.log('API failed, trying Playwright scraping...');
            // Fallback to scraping
            const [trendyol, hepsiburada, n11] = await Promise.allSettled([
                scrapeTrendyol(q),
                scrapeHepsiburada(q),
                scrapeN11(q)
            ]);

            console.log('Trendyol scrape:', trendyol.status, trendyol.status === 'rejected' ? trendyol.reason : `${trendyol.value?.length} products`);
            console.log('Hepsiburada scrape:', hepsiburada.status, hepsiburada.status === 'rejected' ? hepsiburada.reason : `${hepsiburada.value?.length} products`);
            console.log('N11 scrape:', n11.status, n11.status === 'rejected' ? n11.reason : `${n11.value?.length} products`);

            products = [
                ...(trendyol.status === 'fulfilled' ? trendyol.value : []),
                ...(hepsiburada.status === 'fulfilled' ? hepsiburada.value : []),
                ...(n11.status === 'fulfilled' ? n11.value : [])
            ];
        }

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

// Trendyol API (faster than scraping)
async function fetchTrendyolAPI(query) {
    const fetch = (await import('node-fetch')).default;

    // Try multiple API endpoints
    const endpoints = [
        {
            url: `https://apigw.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll/sr?q=${encodeURIComponent(query)}&qt=${encodeURIComponent(query)}&st=${encodeURIComponent(query)}&os=1&pi=1&culture=tr-TR&pId=0&storefrontId=1&language=tr`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'tr-TR,tr;q=0.9',
                'Origin': 'https://m.trendyol.com',
                'Referer': 'https://m.trendyol.com/'
            }
        },
        {
            url: `https://www.trendyol.com/api/infinite-scroll/sr?q=${encodeURIComponent(query)}&qt=${encodeURIComponent(query)}&st=${encodeURIComponent(query)}&os=1`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'tr-TR,tr;q=0.9'
            }
        }
    ];

    for (const endpoint of endpoints) {
        try {
            console.log(`Trying Trendyol API: ${endpoint.url}`);

            const response = await fetch(endpoint.url, {
                headers: endpoint.headers,
                timeout: 10000
            });

            console.log(`API response status: ${response.status}`);

            if (!response.ok) {
                console.log(`API returned ${response.status}, trying next endpoint...`);
                continue;
            }

            const data = await response.json();
            const apiProducts = data?.result?.products || [];

            console.log(`API returned ${apiProducts.length} products`);

            if (apiProducts.length > 0) {
                return apiProducts.slice(0, 20).map(p => ({
                    name: p.name,
                    price: p.price?.sellingPrice || 0,
                    originalPrice: p.price?.originalPrice !== p.price?.sellingPrice ? p.price?.originalPrice : null,
                    imageUrl: p.images?.[0] ? `https://cdn.dsmcdn.com${p.images[0]}` : null,
                    productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
                    brand: p.brand?.name || null,
                    seller: p.merchantName || null,
                    store: 'Trendyol'
                }));
            }
        } catch (error) {
            console.error(`API error:`, error.message);
        }
    }

    return [];
}

// Trendyol scraper
async function scrapeTrendyol(query) {
    console.log('Starting Trendyol scraper...');
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        console.log('Browser launched');

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'tr-TR'
        });

        const page = await context.newPage();
        const url = `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('Page loaded');

        // Wait for products to load
        try {
            await page.waitForSelector('.p-card-wrppr', { timeout: 10000 });
            console.log('Product cards found');
        } catch (e) {
            console.log('Product cards not found, checking page content...');
            const content = await page.content();
            console.log('Page length:', content.length);
            console.log('Page preview:', content.substring(0, 500));
        }

        // Add random delay to seem more human
        await page.waitForTimeout(2000);

        const products = await page.evaluate(() => {
            const items = document.querySelectorAll('.p-card-wrppr');
            console.log('Found items:', items.length);
            const results = [];

            items.forEach((item, index) => {
                if (index >= 20) return;

                try {
                    const nameEl = item.querySelector('.prdct-desc-cntnr-name');
                    const priceEl = item.querySelector('.prc-box-dscntd') || item.querySelector('.prc-box-sllng');
                    const originalPriceEl = item.querySelector('.prc-box-orgnl');
                    const imageEl = item.querySelector('.p-card-img');
                    const linkEl = item.querySelector('a');
                    const brandEl = item.querySelector('.prdct-desc-cntnr-ttl');
                    const sellerEl = item.querySelector('.merchant-name');

                    if (nameEl && priceEl) {
                        const priceText = priceEl.textContent.replace(/[^\d,]/g, '').replace(',', '.');
                        const originalPriceText = originalPriceEl ?
                            originalPriceEl.textContent.replace(/[^\d,]/g, '').replace(',', '.') : null;

                        results.push({
                            name: nameEl.textContent.trim(),
                            price: parseFloat(priceText) || 0,
                            originalPrice: originalPriceText ? parseFloat(originalPriceText) : null,
                            imageUrl: imageEl ? imageEl.src : null,
                            productUrl: linkEl ? 'https://www.trendyol.com' + linkEl.getAttribute('href') : null,
                            brand: brandEl ? brandEl.textContent.trim() : null,
                            seller: sellerEl ? sellerEl.textContent.trim() : null,
                            store: 'Trendyol'
                        });
                    }
                } catch (e) {
                    // Skip this product
                }
            });

            return results;
        });

        console.log(`Scraped ${products.length} products from Trendyol`);
        return products;
    } catch (error) {
        console.error('Trendyol scraper error:', error.message);
        return [];
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed');
        }
    }
}

// Hepsiburada scraper
async function scrapeHepsiburada(query) {
    console.log('Starting Hepsiburada scraper...');
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'tr-TR'
        });

        const page = await context.newPage();
        const url = `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
            await page.waitForSelector('[data-test-id="product-card-name"]', { timeout: 10000 });
        } catch (e) {
            console.log('Hepsiburada product cards not found');
        }

        await page.waitForTimeout(2000);

        const products = await page.evaluate(() => {
            const items = document.querySelectorAll('li[class*="productListContent"]');
            const results = [];

            items.forEach((item, index) => {
                if (index >= 20) return;

                try {
                    const nameEl = item.querySelector('[data-test-id="product-card-name"]');
                    const priceEl = item.querySelector('[data-test-id="price-current-price"]');
                    const originalPriceEl = item.querySelector('[data-test-id="price-old-price"]');
                    const imageEl = item.querySelector('img');
                    const linkEl = item.querySelector('a');

                    if (nameEl && priceEl) {
                        const priceText = priceEl.textContent.replace(/[^\d,]/g, '').replace(',', '.');
                        const originalPriceText = originalPriceEl ?
                            originalPriceEl.textContent.replace(/[^\d,]/g, '').replace(',', '.') : null;

                        results.push({
                            name: nameEl.textContent.trim(),
                            price: parseFloat(priceText) || 0,
                            originalPrice: originalPriceText ? parseFloat(originalPriceText) : null,
                            imageUrl: imageEl ? imageEl.src : null,
                            productUrl: linkEl ? linkEl.href : null,
                            brand: null,
                            seller: null,
                            store: 'Hepsiburada'
                        });
                    }
                } catch (e) {
                    // Skip
                }
            });

            return results;
        });

        console.log(`Scraped ${products.length} products from Hepsiburada`);
        return products;
    } catch (error) {
        console.error('Hepsiburada scraper error:', error.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

// N11 scraper
async function scrapeN11(query) {
    console.log('Starting N11 scraper...');
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'tr-TR'
        });

        const page = await context.newPage();
        const url = `https://www.n11.com/arama?q=${encodeURIComponent(query)}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
            await page.waitForSelector('.columnContent', { timeout: 10000 });
        } catch (e) {
            console.log('N11 product cards not found');
        }

        await page.waitForTimeout(2000);

        const products = await page.evaluate(() => {
            const items = document.querySelectorAll('.columnContent .pro');
            const results = [];

            items.forEach((item, index) => {
                if (index >= 20) return;

                try {
                    const nameEl = item.querySelector('.productName');
                    const priceEl = item.querySelector('.newPrice ins') || item.querySelector('.price ins');
                    const originalPriceEl = item.querySelector('.oldPrice del');
                    const imageEl = item.querySelector('img');
                    const linkEl = item.querySelector('a');

                    if (nameEl && priceEl) {
                        const priceText = priceEl.textContent.replace(/[^\d,]/g, '').replace(',', '.');
                        const originalPriceText = originalPriceEl ?
                            originalPriceEl.textContent.replace(/[^\d,]/g, '').replace(',', '.') : null;

                        results.push({
                            name: nameEl.textContent.trim(),
                            price: parseFloat(priceText) || 0,
                            originalPrice: originalPriceText ? parseFloat(originalPriceText) : null,
                            imageUrl: imageEl ? imageEl.src : null,
                            productUrl: linkEl ? linkEl.href : null,
                            brand: null,
                            seller: null,
                            store: 'N11'
                        });
                    }
                } catch (e) {
                    // Skip
                }
            });

            return results;
        });

        console.log(`Scraped ${products.length} products from N11`);
        return products;
    } catch (error) {
        console.error('N11 scraper error:', error.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

app.listen(PORT, () => {
    console.log(`SepetAI Backend running on port ${PORT}`);
});
