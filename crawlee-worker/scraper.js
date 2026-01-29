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

// Anti-detection: Realistic user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Random delay helper
function randomDelay(min = 500, max = 1500) {
    return Math.floor(Math.random() * (max - min) + min);
}

// Store configurations with multiple fallback selectors
const STORE_CONFIGS = {
    trendyol: {
        searchUrl: (q) => `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`,
        waitSelector: '.p-card-wrppr, .product-card, [class*="product"]',
        parser: parseTrendyol
    },
    hepsiburada: {
        searchUrl: (q) => `https://www.hepsiburada.com/ara?q=${encodeURIComponent(q)}`,
        waitSelector: '[data-test-id="product-card-item"], .product-card, .productListContent',
        parser: parseHepsiburada
    },
    amazon: {
        searchUrl: (q) => `https://www.amazon.com.tr/s?k=${encodeURIComponent(q)}`,
        waitSelector: '[data-component-type="s-search-result"], .s-result-item',
        parser: parseAmazon
    },
    n11: {
        searchUrl: (q) => `https://www.n11.com/arama?q=${encodeURIComponent(q)}`,
        waitSelector: '.columnContent, .listView, .product-card',
        parser: parseN11
    },
    teknosa: {
        searchUrl: (q) => `https://www.teknosa.com/arama/?s=${encodeURIComponent(q)}`,
        waitSelector: '.product-list-item, .prd, .product-card',
        parser: parseTeknosa
    },
    vatan: {
        searchUrl: (q) => `https://www.vatanbilgisayar.com/arama/${encodeURIComponent(q)}/`,
        waitSelector: '.product-list__content, .product-list-item, .product-card',
        parser: parseVatan
    },
    mediamarkt: {
        searchUrl: (q) => `https://www.mediamarkt.com.tr/tr/search.html?query=${encodeURIComponent(q)}`,
        waitSelector: '[data-test="mms-product-card"], .product-card, .product-tile',
        parser: parseMediaMarkt
    },
    pttavm: {
        searchUrl: (q) => `https://www.pttavm.com/arama?q=${encodeURIComponent(q)}`,
        waitSelector: '.product-card, .product-item, .urun-card',
        parser: parsePttAvm
    },
    pazarama: {
        searchUrl: (q) => `https://www.pazarama.com/arama?q=${encodeURIComponent(q)}`,
        waitSelector: '.product-card, .ProductCard, [class*="product"]',
        parser: parsePazarama
    }
};

// Parser Functions
async function parseTrendyol(page) {
    return await page.evaluate(() => {
        const products = [];
        const seenIds = new Set();

        // Strategy 1: Find all product links first, then work backwards to find cards
        const productLinks = document.querySelectorAll('a[href*="-p-"]');

        productLinks.forEach((link, index) => {
            if (products.length >= 25) return;

            try {
                const href = link.getAttribute('href') || '';
                const productIdMatch = href.match(/-p-(\d+)/);
                if (!productIdMatch) return;

                const productId = productIdMatch[1];
                if (seenIds.has(productId)) return;
                seenIds.add(productId);

                // Find the card container (go up the DOM tree)
                let card = link.closest('[class*="p-card"], [class*="product"], [class*="prdct"]') || link.parentElement?.parentElement;
                if (!card) card = link;

                // Find price - try multiple patterns
                let price = 0;
                const priceSelectors = [
                    '.prc-box-dscntd', '.prc-box-sllng', '[class*="prc"]',
                    '[class*="price"]', '[class*="Price"]', '.price'
                ];

                for (const sel of priceSelectors) {
                    const priceEl = card.querySelector(sel);
                    if (priceEl) {
                        const priceText = priceEl.textContent || '';
                        const parsed = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));
                        if (parsed > 0) {
                            price = parsed;
                            break;
                        }
                    }
                }

                // Fallback: regex search in card text
                if (!price) {
                    const cardText = card.textContent || '';
                    // Match Turkish price format: 1.234,56 TL or 1234,56 TL
                    const priceMatch = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/);
                    if (priceMatch) {
                        price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
                    }
                }

                if (!price || price <= 0) return;

                // Find product name
                let name = '';
                const nameSelectors = [
                    '.prdct-desc-cntnr-name', '[class*="product-name"]', '[class*="productName"]',
                    '.prdct-desc-cntnr span', '[class*="name"]', 'h3', 'h2'
                ];
                for (const sel of nameSelectors) {
                    const nameEl = card.querySelector(sel);
                    if (nameEl && nameEl.textContent?.trim()) {
                        name = nameEl.textContent.trim();
                        break;
                    }
                }
                if (!name) {
                    // Use link title or text content
                    name = link.getAttribute('title') || link.textContent?.trim() || 'Unknown';
                }

                // Find image
                const imgEl = card.querySelector('img');
                let imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-original') || null;

                // Find original price
                let originalPrice = null;
                const origPriceEl = card.querySelector('.prc-box-orgnl, [class*="originalPrice"], [class*="old-price"]');
                if (origPriceEl) {
                    const origText = origPriceEl.textContent || '';
                    const parsed = parseFloat(origText.replace(/[^\d,]/g, '').replace(',', '.'));
                    if (parsed > price) originalPrice = parsed;
                }

                products.push({
                    name: name.substring(0, 200),
                    price,
                    originalPrice,
                    imageUrl,
                    productUrl: href.startsWith('http') ? href : 'https://www.trendyol.com' + href,
                    productId: 'ty-' + productId,
                    store: 'Trendyol'
                });
            } catch (e) {}
        });

        return products;
    });
}

async function parseHepsiburada(page) {
    return await page.evaluate(() => {
        const products = [];
        const seenIds = new Set();

        // Strategy: Find all product links first
        const productLinks = document.querySelectorAll('a[href*="-p-"], a[href*="/p-"]');

        productLinks.forEach((link) => {
            if (products.length >= 25) return;

            try {
                const href = link.getAttribute('href') || '';
                const productIdMatch = href.match(/-p-([A-Z0-9]+)/i) || href.match(/\/p-([A-Z0-9]+)/i);
                if (!productIdMatch) return;

                const productId = productIdMatch[1];
                if (seenIds.has(productId)) return;
                seenIds.add(productId);

                // Find the card container
                let card = link.closest('[data-test-id="product-card-item"], [class*="product"], [class*="Product"]') || link.parentElement?.parentElement;
                if (!card) card = link;

                // Find price
                let price = 0;
                const priceSelectors = [
                    '[data-test-id="price-current-price"]', '[class*="currentPrice"]',
                    '[class*="price"]', '[class*="Price"]', '.price'
                ];

                for (const sel of priceSelectors) {
                    const priceEl = card.querySelector(sel);
                    if (priceEl) {
                        const priceText = priceEl.textContent || '';
                        const parsed = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));
                        if (parsed > 0) {
                            price = parsed;
                            break;
                        }
                    }
                }

                // Fallback: regex
                if (!price) {
                    const cardText = card.textContent || '';
                    const priceMatch = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/);
                    if (priceMatch) {
                        price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
                    }
                }

                if (!price || price <= 0) return;

                // Find name
                let name = '';
                const nameSelectors = [
                    '[data-test-id="product-card-name"]', '[class*="productName"]',
                    '[class*="product-title"]', '[class*="name"]', 'h3', 'h2'
                ];
                for (const sel of nameSelectors) {
                    const nameEl = card.querySelector(sel);
                    if (nameEl && nameEl.textContent?.trim()) {
                        name = nameEl.textContent.trim();
                        break;
                    }
                }
                if (!name) name = link.getAttribute('title') || link.textContent?.trim() || 'Unknown';

                // Find image
                const imgEl = card.querySelector('img');
                let imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || null;

                // Original price
                let originalPrice = null;
                const origPriceEl = card.querySelector('[data-test-id="price-old-price"], [class*="oldPrice"], [class*="old-price"]');
                if (origPriceEl) {
                    const parsed = parseFloat(origPriceEl.textContent?.replace(/[^\d,]/g, '').replace(',', '.') || '0');
                    if (parsed > price) originalPrice = parsed;
                }

                products.push({
                    name: name.substring(0, 200),
                    price,
                    originalPrice,
                    imageUrl,
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
    const userAgent = getRandomUserAgent();

    const crawler = new PlaywrightCrawler({
        maxConcurrency: 1,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 50,
        navigationTimeoutSecs: 35,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--window-size=1920,1080'
                ]
            }
        },
        browserPoolOptions: {
            useFingerprints: false,
            preLaunchHooks: [
                async (pageId, launchContext) => {
                    launchContext.launchOptions = launchContext.launchOptions || {};
                }
            ]
        },
        preNavigationHooks: [
            async ({ page }) => {
                // Set realistic viewport
                await page.setViewportSize({ width: 1920, height: 1080 });

                // Set user agent
                await page.setExtraHTTPHeaders({
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                });

                // Stealth: Override webdriver detection
                await page.addInitScript(() => {
                    // Remove webdriver property
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });

                    // Mock plugins
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5]
                    });

                    // Mock languages
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['tr-TR', 'tr', 'en-US', 'en']
                    });

                    // Mock chrome runtime
                    window.chrome = { runtime: {} };

                    // Mock permissions
                    const originalQuery = window.navigator.permissions.query;
                    window.navigator.permissions.query = (parameters) =>
                        parameters.name === 'notifications'
                            ? Promise.resolve({ state: Notification.permission })
                            : originalQuery(parameters);
                });
            }
        ],
        async requestHandler({ page, request }) {
            console.log(`Scraping ${store}: ${request.url}`);

            // Random delay before actions (anti-bot)
            await page.waitForTimeout(randomDelay(1000, 2000));

            // Wait for products to load
            let selectorFound = false;
            try {
                await page.waitForSelector(config.waitSelector, { timeout: 20000 });
                selectorFound = true;
            } catch (e) {
                console.log(`${store}: Primary selector not found`);
            }

            // Additional wait for JS rendering
            await page.waitForTimeout(randomDelay(2000, 3000));

            // Scroll to trigger lazy loading - more human-like
            await page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight / 3, behavior: 'smooth' });
            });
            await page.waitForTimeout(randomDelay(1000, 1500));

            await page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight * 0.6, behavior: 'smooth' });
            });
            await page.waitForTimeout(randomDelay(800, 1200));

            // Parse products
            const parsed = await config.parser(page);

            // Debug: If no products found, log available elements
            if (parsed.length === 0) {
                const debugInfo = await page.evaluate(() => {
                    const body = document.body;
                    // Check for common product container patterns
                    const checks = {
                        'div[class*="product"]': document.querySelectorAll('div[class*="product"]').length,
                        'div[class*="card"]': document.querySelectorAll('div[class*="card"]').length,
                        'a[href*="/p-"]': document.querySelectorAll('a[href*="/p-"]').length,
                        'img': document.querySelectorAll('img').length,
                        '[class*="price"]': document.querySelectorAll('[class*="price"]').length,
                        '[class*="prc"]': document.querySelectorAll('[class*="prc"]').length,
                    };
                    // Get first few class names containing 'product' or 'card'
                    const productClasses = Array.from(document.querySelectorAll('[class*="product"], [class*="card"]'))
                        .slice(0, 5)
                        .map(el => el.className)
                        .filter(c => c);
                    return { checks, productClasses, title: document.title, bodyLength: body.innerHTML.length };
                });
                console.log(`${store}: DEBUG - No products found. Page info:`, JSON.stringify(debugInfo));
            }

            products.push(...parsed);
            console.log(`${store}: Found ${parsed.length} products`);
        },
        failedRequestHandler({ request, error }) {
            console.error(`${store}: Request failed: ${request.url} - ${error?.message || 'Unknown error'}`);
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
