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
        const [trendyol, hepsiburada, n11] = await Promise.allSettled([
            scrapeTrendyol(q),
            scrapeHepsiburada(q),
            scrapeN11(q)
        ]);

        const products = [
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

// Trendyol scraper
async function scrapeTrendyol(query) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'tr-TR'
        });

        const page = await context.newPage();
        const url = `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Wait for products to load
        await page.waitForSelector('.p-card-wrppr', { timeout: 10000 }).catch(() => {});

        // Add random delay to seem more human
        await page.waitForTimeout(1000 + Math.random() * 2000);

        const products = await page.evaluate(() => {
            const items = document.querySelectorAll('.p-card-wrppr');
            const results = [];

            items.forEach((item, index) => {
                if (index >= 20) return; // Limit to 20 products

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
                    console.error('Error parsing product:', e);
                }
            });

            return results;
        });

        return products;
    } finally {
        await browser.close();
    }
}

// Hepsiburada scraper
async function scrapeHepsiburada(query) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'tr-TR'
        });

        const page = await context.newPage();
        const url = `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        await page.waitForSelector('[data-test-id="product-card-name"]', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000 + Math.random() * 2000);

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
                    console.error('Error parsing product:', e);
                }
            });

            return results;
        });

        return products;
    } finally {
        await browser.close();
    }
}

// N11 scraper
async function scrapeN11(query) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'tr-TR'
        });

        const page = await context.newPage();
        const url = `https://www.n11.com/arama?q=${encodeURIComponent(query)}`;

        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        await page.waitForSelector('.columnContent', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000 + Math.random() * 2000);

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
                    console.error('Error parsing product:', e);
                }
            });

            return results;
        });

        return products;
    } finally {
        await browser.close();
    }
}

app.listen(PORT, () => {
    console.log(`SepetAI Backend running on port ${PORT}`);
});
