/**
 * SepetAI Crawlee + Playwright Scraper
 * Tüm mağazalar için gerçek browser ile scraping
 */

const { PlaywrightCrawler, Configuration, purgeDefaultStorages } = require('crawlee');
const path = require('path');
const fs = require('fs');

// Create unique storage path for this process to avoid conflicts
const UNIQUE_ID = `${process.pid}-${Date.now()}`;
const STORAGE_DIR = process.env.CRAWLEE_STORAGE_DIR || path.join(__dirname, 'storage');
const UNIQUE_STORAGE_DIR = path.join(STORAGE_DIR, UNIQUE_ID);

// Ensure storage directories exist
try {
    fs.mkdirSync(path.join(UNIQUE_STORAGE_DIR, 'request_queues'), { recursive: true });
    fs.mkdirSync(path.join(UNIQUE_STORAGE_DIR, 'key_value_stores'), { recursive: true });
    fs.mkdirSync(path.join(UNIQUE_STORAGE_DIR, 'datasets'), { recursive: true });
} catch (e) {
    console.log('Storage dirs may already exist');
}

// Configure Crawlee to use unique storage
Configuration.getGlobalConfig().set('storageClientOptions', {
    localDataDirectory: UNIQUE_STORAGE_DIR
});

// Store configurations
const STORE_CONFIGS = {
    trendyol: {
        searchUrl: (q) => `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`,
        waitSelector: '.p-card-wrppr',
        parser: parseTrendyol
    },
    hepsiburada: {
        searchUrl: (q) => `https://www.hepsiburada.com/ara?q=${encodeURIComponent(q)}`,
        waitSelector: '[data-test-id="product-card-item"]',
        parser: parseHepsiburada
    },
    amazon: {
        searchUrl: (q) => `https://www.amazon.com.tr/s?k=${encodeURIComponent(q)}`,
        waitSelector: '[data-component-type="s-search-result"]',
        parser: parseAmazon
    },
    n11: {
        searchUrl: (q) => `https://www.n11.com/arama?q=${encodeURIComponent(q)}`,
        waitSelector: '.columnContent',
        parser: parseN11
    },
    teknosa: {
        searchUrl: (q) => `https://www.teknosa.com/arama/?s=${encodeURIComponent(q)}`,
        waitSelector: '.product-list-item',
        parser: parseTeknosa
    },
    vatan: {
        searchUrl: (q) => `https://www.vatanbilgisayar.com/arama/${encodeURIComponent(q)}/`,
        waitSelector: '.product-list__content',
        parser: parseVatan
    },
    mediamarkt: {
        searchUrl: (q) => `https://www.mediamarkt.com.tr/tr/search.html?query=${encodeURIComponent(q)}`,
        waitSelector: '[data-test="mms-product-card"]',
        parser: parseMediaMarkt
    },
    pttavm: {
        searchUrl: (q) => `https://www.pttavm.com/arama?q=${encodeURIComponent(q)}`,
        waitSelector: '.product-card',
        parser: parsePttAvm
    },
    pazarama: {
        searchUrl: (q) => `https://www.pazarama.com/arama?q=${encodeURIComponent(q)}`,
        waitSelector: '.product-card',
        parser: parsePazarama
    }
};

// Parser Functions
async function parseTrendyol(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('.p-card-wrppr').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('.prdct-desc-cntnr-name');
                const priceEl = card.querySelector('.prc-box-dscntd') || card.querySelector('.prc-box-sllng');
                const originalPriceEl = card.querySelector('.prc-box-orgnl');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/-p-(\d+)/);
                const productId = productIdMatch ? productIdMatch[1] : null;

                if (price && price > 0 && productId) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.trendyol.com' + href,
                        productId: 'ty-' + productId,
                        store: 'Trendyol'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parseHepsiburada(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('[data-test-id="product-card-item"]').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('[data-test-id="product-card-name"]');
                const priceEl = card.querySelector('[data-test-id="price-current-price"]');
                const originalPriceEl = card.querySelector('[data-test-id="price-old-price"]');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/-p-([A-Z0-9]+)/i);
                const productId = productIdMatch ? productIdMatch[1] : Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.hepsiburada.com' + href,
                        productId: 'hb-' + productId,
                        store: 'Hepsiburada'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parseAmazon(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('[data-component-type="s-search-result"]').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a.a-link-normal.s-no-outline');
                const nameEl = card.querySelector('h2 span');
                const priceWholeEl = card.querySelector('.a-price-whole');
                const priceFractionEl = card.querySelector('.a-price-fraction');
                const originalPriceEl = card.querySelector('.a-text-price .a-offscreen');
                const imgEl = card.querySelector('img.s-image');

                if (!link || !priceWholeEl) return;

                const href = link.getAttribute('href') || '';
                const priceWhole = priceWholeEl.textContent?.replace(/[^\d]/g, '') || '0';
                const priceFraction = priceFractionEl?.textContent?.replace(/[^\d]/g, '') || '00';
                const price = parseFloat(priceWhole + '.' + priceFraction);

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const asin = card.getAttribute('data-asin');

                if (price && price > 0 && asin) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || null,
                        productUrl: 'https://www.amazon.com.tr/dp/' + asin,
                        productId: 'amz-' + asin,
                        store: 'Amazon'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parseN11(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('.columnContent .card-link, .listView .plink').forEach((link, index) => {
            if (index >= 25) return;
            try {
                const card = link.closest('.columnContent') || link.closest('.listView');
                if (!card) return;

                const nameEl = card.querySelector('.productName, .pro-name');
                const priceEl = card.querySelector('.newPrice ins, .price ins, .price-new');
                const originalPriceEl = card.querySelector('.oldPrice, .price del, .price-old');
                const imgEl = card.querySelector('img');

                if (!priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/\/(\d+)(?:\?|$)/);
                const productId = productIdMatch ? productIdMatch[1] : Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-original') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.n11.com' + href,
                        productId: 'n11-' + productId,
                        store: 'N11'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parseTeknosa(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('.product-list-item, .prd').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('.prd-name, .product-name');
                const priceEl = card.querySelector('.prc, .product-price');
                const originalPriceEl = card.querySelector('.old-prc, .old-price');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/-p-(\d+)/);
                const productId = productIdMatch ? productIdMatch[1] : Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-lazy') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.teknosa.com' + href,
                        productId: 'tek-' + productId,
                        store: 'Teknosa'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parseVatan(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('.product-list__content .product-list__item, .product-list-item').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('.product-list__product-name, .product-name');
                const priceEl = card.querySelector('.product-list__price, .product-price');
                const originalPriceEl = card.querySelector('.product-list__price--old, .old-price');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const urlParts = href.split('/');
                const productId = urlParts[urlParts.length - 1] || Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.vatanbilgisayar.com' + href,
                        productId: 'vat-' + productId,
                        store: 'Vatan'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parseMediaMarkt(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('[data-test="mms-product-card"], .product-card').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('[data-test="product-title"], .product-title');
                const priceEl = card.querySelector('[data-test="price"], .price');
                const originalPriceEl = card.querySelector('[data-test="rrp"], .rrp');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/(\d+)\.html/);
                const productId = productIdMatch ? productIdMatch[1] : Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.mediamarkt.com.tr' + href,
                        productId: 'mm-' + productId,
                        store: 'MediaMarkt'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parsePttAvm(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('.product-card, .urun-card').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('.product-name, .urun-adi');
                const priceEl = card.querySelector('.product-price, .fiyat');
                const originalPriceEl = card.querySelector('.old-price, .eski-fiyat');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/\/(\d+)/);
                const productId = productIdMatch ? productIdMatch[1] : Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.pttavm.com' + href,
                        productId: 'ptt-' + productId,
                        store: 'PttAvm'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

async function parsePazarama(page) {
    return await page.evaluate(() => {
        const products = [];
        document.querySelectorAll('.product-card, .ProductCard').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a');
                const nameEl = card.querySelector('.product-name, .ProductCard__name');
                const priceEl = card.querySelector('.product-price, .ProductCard__price');
                const originalPriceEl = card.querySelector('.old-price, .ProductCard__oldPrice');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const priceText = priceEl.textContent || '';
                const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));

                let originalPrice = null;
                if (originalPriceEl) {
                    const origText = originalPriceEl.textContent || '';
                    originalPrice = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                }

                const productIdMatch = href.match(/\/p\/([^/]+)/);
                const productId = productIdMatch ? productIdMatch[1] : Math.random().toString(36).slice(2);

                if (price && price > 0) {
                    products.push({
                        name: nameEl?.textContent?.trim() || 'Unknown',
                        price,
                        originalPrice: originalPrice > price ? originalPrice : null,
                        imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                        productUrl: href.startsWith('http') ? href : 'https://www.pazarama.com' + href,
                        productId: 'pzr-' + productId,
                        store: 'Pazarama'
                    });
                }
            } catch (e) {}
        });
        return products;
    });
}

// Main scraper function
async function scrapeStore(store, query) {
    const config = STORE_CONFIGS[store];
    if (!config) {
        console.error(`Unknown store: ${store}`);
        return [];
    }

    const products = [];

    const crawler = new PlaywrightCrawler({
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 45,
        navigationTimeoutSecs: 30,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-setuid-sandbox'
                ]
            }
        },
        async requestHandler({ page, request }) {
            console.log(`Scraping ${store}: ${request.url}`);

            // Wait for products to load
            try {
                await page.waitForSelector(config.waitSelector, { timeout: 15000 });
            } catch (e) {
                console.log(`${store}: Selector not found, trying to parse anyway`);
            }

            // Additional wait for JS rendering
            await page.waitForTimeout(2000);

            // Scroll to trigger lazy loading
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight / 2);
            });
            await page.waitForTimeout(1000);

            // Parse products
            const parsed = await config.parser(page);
            products.push(...parsed);
            console.log(`${store}: Found ${parsed.length} products`);
        },
        failedRequestHandler({ request }) {
            console.error(`${store}: Request failed: ${request.url}`);
        }
    });

    try {
        await crawler.run([config.searchUrl(query)]);
    } catch (e) {
        console.error(`${store} crawler error: ${e.message}`);
    }

    return products;
}

// Export for use in main backend
module.exports = { scrapeStore, STORE_CONFIGS };

// Cleanup function to remove unique storage directory
async function cleanup() {
    try {
        await purgeDefaultStorages();
        // Remove unique storage directory
        fs.rmSync(UNIQUE_STORAGE_DIR, { recursive: true, force: true });
    } catch (e) {
        // Ignore cleanup errors
    }
}

// CLI mode - run directly
if (require.main === module) {
    const store = process.argv[2];
    const query = process.argv[3];

    if (!store || !query) {
        console.error('Usage: node scraper.js <store> <query>');
        console.error('Stores:', Object.keys(STORE_CONFIGS).join(', '));
        process.exit(1);
    }

    (async () => {
        try {
            console.log(`Starting scrape: ${store} - "${query}"`);
            const products = await scrapeStore(store, query);

            // Output as JSON for parent process
            console.log('RESULT_START');
            console.log(JSON.stringify(products));
            console.log('RESULT_END');

            // Cleanup
            await cleanup();
            process.exit(0);
        } catch (e) {
            console.error('Scraper error:', e.message);
            await cleanup();
            process.exit(1);
        }
    })();
}
