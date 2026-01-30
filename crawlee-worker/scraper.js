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

// Anti-detection: Realistic user agents (Chrome 122-125 - latest versions)
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
];

// Screen resolutions for fingerprinting
const SCREEN_CONFIGS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 }
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * GLOBAL Turkish Price Parser - Used by all store parsers
 * Handles formats: 3.499,00 TL | 49.999,99 TL | 1.234.567,89 TL
 * Returns 0 for invalid prices or prices outside reasonable range
 */
function parseTurkishPriceGlobal(text) {
    if (!text) return 0;

    // Extract Turkish price pattern: digits with dot separators, comma decimal
    // Pattern matches: 3.499,00 or 49.999,99 or 1.234.567,89
    const pricePattern = /(\d{1,3}(?:\.\d{3})*),(\d{2})/;
    const match = text.match(pricePattern);

    if (match) {
        const integerPart = match[1].replace(/\./g, ''); // Remove thousand separators
        const decimalPart = match[2];
        const price = parseFloat(integerPart + '.' + decimalPart);

        // Sanity check: reasonable price range (10 TL - 500,000 TL)
        if (price >= 10 && price <= 500000) {
            return price;
        }
        return 0;
    }

    // Fallback: Simple number without thousands separator (e.g., "3499,00")
    const simplePattern = /(\d+),(\d{2})/;
    const simpleMatch = text.match(simplePattern);
    if (simpleMatch) {
        const price = parseFloat(simpleMatch[1] + '.' + simpleMatch[2]);
        if (price >= 10 && price <= 500000) {
            return price;
        }
    }

    return 0;
}

function getRandomScreen() {
    return SCREEN_CONFIGS[Math.floor(Math.random() * SCREEN_CONFIGS.length)];
}

// COMPREHENSIVE STEALTH SCRIPT - Bypasses most bot detection
const STEALTH_SCRIPT = `
// 1. Remove webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
delete navigator.__proto__.webdriver;

// 2. Mock plugins (realistic Chrome plugins)
Object.defineProperty(navigator, 'plugins', {
    get: () => {
        const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
        ];
        plugins.item = (i) => plugins[i];
        plugins.namedItem = (name) => plugins.find(p => p.name === name);
        plugins.refresh = () => {};
        return plugins;
    }
});

// 3. Mock mimeTypes
Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
        const mimeTypes = [
            { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: navigator.plugins[0] },
            { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] }
        ];
        mimeTypes.item = (i) => mimeTypes[i];
        mimeTypes.namedItem = (name) => mimeTypes.find(m => m.type === name);
        return mimeTypes;
    }
});

// 4. Chrome object
window.chrome = {
    runtime: {
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {} }
    },
    loadTimes: () => ({
        commitLoadTime: Date.now() / 1000 - 2,
        connectionInfo: 'http/1.1',
        finishDocumentLoadTime: Date.now() / 1000 - 0.5,
        finishLoadTime: Date.now() / 1000 - 0.2,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000 - 1.5,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'unknown',
        requestTime: Date.now() / 1000 - 3,
        startLoadTime: Date.now() / 1000 - 2.5,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false
    }),
    csi: () => ({ pageT: Date.now(), startE: Date.now() - 3000, onloadT: Date.now() - 1000 }),
    app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }
};

// 5. Languages
Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
Object.defineProperty(navigator, 'language', { get: () => 'tr-TR' });

// 6. Hardware concurrency (realistic values)
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => [4, 8, 12, 16][Math.floor(Math.random() * 4)] });

// 7. Device memory
Object.defineProperty(navigator, 'deviceMemory', { get: () => [4, 8, 16][Math.floor(Math.random() * 3)] });

// 8. Platform
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

// 9. Permissions API
const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
if (originalQuery) {
    window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery(parameters);
    };
}

// 10. WebGL Vendor/Renderer (realistic values)
const getParameterProxyHandler = {
    apply: function(target, thisArg, args) {
        const param = args[0];
        const gl = thisArg;
        if (param === 37445) return 'Google Inc. (Intel)'; // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'; // UNMASKED_RENDERER_WEBGL
        return Reflect.apply(target, thisArg, args);
    }
};
try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
        const origGetParameter = gl.getParameter.bind(gl);
        gl.getParameter = new Proxy(origGetParameter, getParameterProxyHandler);
        WebGLRenderingContext.prototype.getParameter = new Proxy(
            WebGLRenderingContext.prototype.getParameter,
            getParameterProxyHandler
        );
    }
} catch (e) {}

// 11. Canvas fingerprint randomization
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(type) {
    if (this.width === 0 || this.height === 0) return originalToDataURL.apply(this, arguments);
    const ctx = this.getContext('2d');
    if (ctx) {
        const imageData = ctx.getImageData(0, 0, Math.min(this.width, 10), Math.min(this.height, 10));
        for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] = imageData.data[i] ^ (Math.random() > 0.5 ? 1 : 0);
        }
        ctx.putImageData(imageData, 0, 0);
    }
    return originalToDataURL.apply(this, arguments);
};

// 12. Disable automation flags
Object.defineProperty(document, 'hidden', { get: () => false });
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });

// 13. Console.debug trap (some sites use this)
const originalDebug = console.debug;
console.debug = function() {
    if (arguments[0]?.includes?.('automation') || arguments[0]?.includes?.('webdriver')) return;
    return originalDebug.apply(this, arguments);
};

// 14. Notification permission
Object.defineProperty(Notification, 'permission', { get: () => 'default' });

// 15. Connection type
if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 + Math.floor(Math.random() * 100) });
}
`;

// Random delay helper - reduced for speed
function randomDelay(min = 300, max = 800) {
    return Math.floor(Math.random() * (max - min) + min);
}

// Sites that need extra anti-bot handling
const HIGH_PROTECTION_SITES = ['hepsiburada', 'n11', 'mediamarkt', 'vatan'];

// Human-like typing simulation
async function humanType(page, selector, text) {
    await page.click(selector);
    await page.waitForTimeout(randomDelay(200, 400));
    for (const char of text) {
        await page.keyboard.type(char, { delay: randomDelay(50, 150) });
    }
}

// Accept cookie consent popups
async function handleCookieConsent(page) {
    const cookieSelectors = [
        '#onetrust-accept-btn-handler',
        '[data-testid="GDPR-accept"]',
        '.cookie-consent-accept',
        '#accept-cookie',
        '.accept-cookies',
        'button[class*="accept"]',
        'button[class*="cookie"]',
        '[class*="CookieConsent"] button',
        '#CybotCookiebotDialogBodyButtonAccept',
        '.cc-accept',
        '[data-action="accept"]'
    ];

    for (const selector of cookieSelectors) {
        try {
            const btn = await page.$(selector);
            if (btn) {
                await btn.click();
                await page.waitForTimeout(500);
                console.log('Cookie consent accepted');
                return true;
            }
        } catch (e) {}
    }
    return false;
}

// Detect if page is blocked by bot protection
async function detectBotBlock(page) {
    return await page.evaluate(() => {
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const title = document.title?.toLowerCase() || '';

        // Common bot protection indicators
        const blockIndicators = [
            'robot değilim',
            'ben robot değilim',
            'captcha',
            'erişim engellendi',
            'access denied',
            'blocked',
            'bot detected',
            'unusual traffic',
            'please verify',
            'security check',
            'datadome',
            'challenge',
            'checking your browser',
            'please wait'
        ];

        for (const indicator of blockIndicators) {
            if (bodyText.includes(indicator) || title.includes(indicator)) {
                return { blocked: true, reason: indicator };
            }
        }

        // Check for CAPTCHA iframes
        const captchaIframes = document.querySelectorAll('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
        if (captchaIframes.length > 0) {
            return { blocked: true, reason: 'CAPTCHA iframe detected' };
        }

        // Check for DataDome specific
        const datadome = document.querySelector('[class*="datadome"], #datadome');
        if (datadome) {
            return { blocked: true, reason: 'DataDome detected' };
        }

        return { blocked: false };
    });
}

// Block fingerprinting and tracking scripts
const BLOCKED_URLS = [
    '**/datadome.co/**',
    '**/cdn.datadome.**',
    '**/fingerprint**',
    '**/imperva/**',
    '**/distil/**',
    '**/bot-detect**',
    '**/recaptcha/**',
    '**/hcaptcha/**'
];

// Store configurations with multiple fallback selectors
const STORE_CONFIGS = {
    trendyol: {
        // Sort by best match for relevance
        searchUrl: (q) => `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`,
        waitSelector: '.p-card-wrppr, .p-card-chldrn-cntnr, .product-card, [data-id]',
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

        // Helper: Parse Turkish price format (3.499,00 or 49.999,99)
        function parseTurkishPrice(text) {
            if (!text) return 0;

            // Extract proper Turkish price pattern: 3.499,00 or 49.999,99 or 1.234.567,89
            const pricePattern = /(\d{1,3}(?:\.\d{3})*),(\d{2})/;
            const match = text.match(pricePattern);

            if (match) {
                // Remove dots from integer part, use comma as decimal
                const integerPart = match[1].replace(/\./g, '');
                const decimalPart = match[2];
                return parseFloat(integerPart + '.' + decimalPart);
            }

            // Fallback: Simple number without thousands separator (e.g., "3499,00")
            const simplePattern = /(\d+),(\d{2})/;
            const simpleMatch = text.match(simplePattern);
            if (simpleMatch) {
                return parseFloat(simpleMatch[1] + '.' + simpleMatch[2]);
            }

            return 0;
        }

        // STRATEGY 0: Try to extract from JSON-LD structured data first (most reliable)
        try {
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLdScripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    // Check for ItemList (search results)
                    if (data['@type'] === 'ItemList' && data.itemListElement) {
                        console.log('Trendyol: Found JSON-LD ItemList with', data.itemListElement.length, 'items');
                        data.itemListElement.forEach((item, i) => {
                            if (products.length >= 30) return;
                            const product = item.item || item;
                            if (product && product.offers) {
                                const urlMatch = (product.url || product['@id'] || '').match(/-p-(\d+)/);
                                if (urlMatch && !seenIds.has(urlMatch[1])) {
                                    seenIds.add(urlMatch[1]);
                                    const price = parseFloat(product.offers?.price || product.offers?.lowPrice) || 0;
                                    if (price >= 10 && price <= 500000) {
                                        products.push({
                                            name: product.name || 'Trendyol Ürünü',
                                            price,
                                            originalPrice: null,
                                            imageUrl: product.image || null,
                                            productUrl: product.url || 'https://www.trendyol.com' + (product['@id'] || ''),
                                            productId: 'ty-' + urlMatch[1],
                                            store: 'Trendyol'
                                        });
                                    }
                                }
                            }
                        });
                    }
                    // Check for single Product
                    if (data['@type'] === 'Product' && data.offers) {
                        const urlMatch = (data.url || window.location.href).match(/-p-(\d+)/);
                        if (urlMatch && !seenIds.has(urlMatch[1])) {
                            seenIds.add(urlMatch[1]);
                            const price = parseFloat(data.offers?.price || data.offers?.lowPrice) || 0;
                            if (price >= 10 && price <= 500000) {
                                products.push({
                                    name: data.name || 'Trendyol Ürünü',
                                    price,
                                    originalPrice: null,
                                    imageUrl: data.image || null,
                                    productUrl: data.url || window.location.href,
                                    productId: 'ty-' + urlMatch[1],
                                    store: 'Trendyol'
                                });
                            }
                        }
                    }
                } catch (e) {}
            }
            if (products.length > 0) {
                console.log('Trendyol: JSON-LD extracted', products.length, 'products');
            }
        } catch (e) {
            console.log('Trendyol: JSON-LD parsing failed', e.message);
        }

        // STRATEGY 0.5: Check for __SEARCH_APP_INITIAL_STATE__ in window
        try {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                if (text.includes('__SEARCH_APP_INITIAL_STATE__') || text.includes('searchData') || text.includes('"products":')) {
                    // Try to extract JSON from the script
                    const jsonMatch = text.match(/(?:__SEARCH_APP_INITIAL_STATE__|window\.__INITIAL_STATE__|searchData)\s*=\s*({[\s\S]*?});?\s*(?:<\/script>|$)/);
                    if (jsonMatch) {
                        try {
                            const data = JSON.parse(jsonMatch[1]);
                            const productList = data?.searchData?.result?.products || data?.products || data?.result?.products || [];
                            console.log('Trendyol: Found inline JSON with', productList.length, 'products');
                            productList.forEach(p => {
                                if (products.length >= 30) return;
                                const productId = String(p.id || p.contentId || '');
                                if (productId && !seenIds.has(productId)) {
                                    seenIds.add(productId);
                                    const price = p.price?.sellingPrice || p.price?.discountedPrice || p.price?.originalPrice || 0;
                                    if (price >= 10 && price <= 500000) {
                                        products.push({
                                            name: p.name || p.brand?.name + ' ' + p.name || 'Trendyol Ürünü',
                                            price,
                                            originalPrice: p.price?.originalPrice > price ? p.price.originalPrice : null,
                                            imageUrl: p.images?.[0] || p.image || null,
                                            productUrl: `https://www.trendyol.com${p.url || ''}`,
                                            productId: 'ty-' + productId,
                                            store: 'Trendyol'
                                        });
                                    }
                                }
                            });
                        } catch (e) {}
                    }
                }
            }
            if (products.length > 0) {
                console.log('Trendyol: Inline JSON extracted', products.length, 'products');
                return products;
            }
        } catch (e) {
            console.log('Trendyol: Inline JSON parsing failed', e.message);
        }

        // STRATEGY 1: Direct card-based approach with EXPANDED selectors (2025 Trendyol)
        const cardSelectors = [
            // 2025 Trendyol selectors (newer structure)
            '[data-testid="product-card"]',
            'div[class*="product-card"]',
            'div[class*="p-card"]',
            '.p-card-wrppr',
            '.p-card-chldrn-cntnr',
            // Generic product selectors
            '[data-id]',
            '.product-card',
            'div[class*="prdct"]',
            '[class*="ProductCard"]',
            '[class*="srchPrdctCrd"]',
            'article[class*="product"]',
            'div[class*="search-product"]',
            '.search-product-card',
            '[data-testid*="product"]',
            '[data-product-id]',
            'li[class*="product"]',
            // Fallback: Any container with product link
            'div:has(> a[href*="-p-"])'
        ];

        let cards = [];
        for (const selector of cardSelectors) {
            try {
                const found = document.querySelectorAll(selector);
                if (found.length > 2) {
                    cards = Array.from(found);
                    console.log(`Trendyol: Found ${cards.length} cards with ${selector}`);
                    break;
                }
            } catch (e) {}
        }

        // If still no cards, try to find any element with product link inside
        if (cards.length === 0) {
            const allLinks = document.querySelectorAll('a[href*="-p-"]');
            const uniqueParents = new Set();
            allLinks.forEach(link => {
                let parent = link.parentElement;
                for (let i = 0; i < 7 && parent; i++) {
                    // Look for a container that has both image and price
                    if (parent.querySelector('img') && parent.textContent?.match(/\d+[.,]\d{2}/)) {
                        uniqueParents.add(parent);
                        break;
                    }
                    parent = parent.parentElement;
                }
            });
            cards = Array.from(uniqueParents);
            console.log(`Trendyol: Found ${cards.length} cards via parent traversal`);
        }

        // Process cards directly
        cards.forEach((card, index) => {
            if (products.length >= 30) return;

            try {
                // Find product link
                const link = card.querySelector('a[href*="-p-"]');
                if (!link) return;

                const href = link.getAttribute('href') || '';
                const productIdMatch = href.match(/-p-(\d+)/);
                if (!productIdMatch) return;

                const productId = productIdMatch[1];
                if (seenIds.has(productId)) return;
                seenIds.add(productId);

                // Find price - Try EXPANDED selectors (2025 update)
                let price = 0;
                const priceSelectors = [
                    // 2025 Trendyol selectors
                    '[data-testid="price"]',
                    '[data-testid="selling-price"]',
                    'span[class*="prcBox"]',
                    'div[class*="prcBox"]',
                    '.prc-box-dscntd',
                    '.prc-box-sllng',
                    '.prc-cntnr .prc',
                    '[class*="price"] span',
                    '.product-price',
                    '[data-price]',
                    '[class*="Price"]',
                    '[class*="prc"]',
                    'span[class*="selling"]',
                    'div[class*="discounted"]',
                    '[class*="salePrice"]',
                    '[class*="currentPrice"]',
                    '.price-box span',
                    // Generic: any span/div with TL text
                    'span',
                    'div'
                ];

                for (const pSel of priceSelectors) {
                    const priceEl = card.querySelector(pSel);
                    if (priceEl) {
                        const parsed = parseTurkishPrice(priceEl.textContent);
                        if (parsed >= 5 && parsed <= 500000) {
                            price = parsed;
                            break;
                        }
                    }
                }

                // Fallback: Search all text for price pattern
                if (!price) {
                    const cardText = card.textContent || '';
                    // Match prices like "3.499,00" or "49.999,99 TL"
                    const priceMatches = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})(?:\s*TL)?/g);
                    if (priceMatches) {
                        for (const match of priceMatches) {
                            const parsed = parseTurkishPrice(match);
                            if (parsed >= 5 && parsed <= 500000) {
                                price = parsed;
                                break;
                            }
                        }
                    }
                }

                // Skip products without valid price
                if (!price || price < 5 || price > 500000) return;

                // Find product name - EXPANDED strategies
                let name = '';
                const nameSelectors = [
                    '.prdct-desc-cntnr-name',
                    '.product-desc-sub-text',
                    'span[class*="prdct-desc"]',
                    '[class*="product-name"]',
                    '[class*="productName"]',
                    '.prdct-desc-cntnr span:first-child',
                    'h3',
                    'h2',
                    // New 2024/2025 selectors
                    '[class*="ProductName"]',
                    '[class*="product-title"]',
                    '[class*="title"]',
                    '[data-testid*="name"]',
                    '[data-testid*="title"]',
                    'a[title]',
                    '.product-info span',
                    '[class*="description"]'
                ];

                for (const sel of nameSelectors) {
                    const nameEl = card.querySelector(sel);
                    if (nameEl && nameEl.textContent?.trim().length > 3) {
                        name = nameEl.textContent.trim();
                        break;
                    }
                }

                // Fallback: link title or combine available text
                if (!name || name.length < 5) {
                    name = link.getAttribute('title') || '';
                }
                if (!name || name.length < 5) {
                    // Get brand + description
                    const brand = card.querySelector('.prdct-desc-cntnr-ttl, .product-brand')?.textContent?.trim() || '';
                    const desc = card.querySelector('.prdct-desc-cntnr-name, .product-name')?.textContent?.trim() || '';
                    name = (brand + ' ' + desc).trim();
                }
                if (!name || name.length < 3) {
                    name = 'Trendyol Ürünü';
                }

                // Find image
                let imageUrl = null;
                const imgEl = card.querySelector('img');
                if (imgEl) {
                    imageUrl = imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-original') || null;
                    // Handle lazy loading placeholder
                    if (imageUrl && imageUrl.includes('placeholder')) {
                        imageUrl = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-original') || null;
                    }
                }

                // Find original price
                let originalPrice = null;
                const origPriceEl = card.querySelector('.prc-box-orgnl, .prc-org, [class*="oldPrice"], [class*="original-price"]');
                if (origPriceEl) {
                    const parsed = parseTurkishPrice(origPriceEl.textContent);
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
            } catch (e) {
                console.log('Trendyol parse error:', e.message);
            }
        });

        // STRATEGY 2: If no cards found, try link-based approach
        if (products.length === 0) {
            console.log('Trendyol: Card strategy failed, trying link-based approach');
            const productLinks = document.querySelectorAll('a[href*="-p-"]');

            productLinks.forEach((link, index) => {
                if (products.length >= 30) return;

                try {
                    const href = link.getAttribute('href') || '';
                    const productIdMatch = href.match(/-p-(\d+)/);
                    if (!productIdMatch) return;

                    const productId = productIdMatch[1];
                    if (seenIds.has(productId)) return;
                    seenIds.add(productId);

                    // Go up the DOM tree to find card container
                    let card = link.closest('.p-card-wrppr') ||
                               link.closest('[class*="p-card"]') ||
                               link.closest('[class*="product"]') ||
                               link.parentElement?.parentElement?.parentElement;
                    if (!card) card = link.parentElement || link;

                    // Find price
                    let price = 0;
                    const priceEl = card.querySelector('.prc-box-dscntd, .prc-box-sllng, [class*="prc"]');
                    if (priceEl) {
                        price = parseTurkishPrice(priceEl.textContent);
                    }

                    // Fallback: regex in card text
                    if (!price) {
                        const cardText = card.textContent || '';
                        const priceMatch = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/);
                        if (priceMatch) {
                            price = parseTurkishPrice(priceMatch[0]);
                        }
                    }

                    if (!price || price < 5 || price > 500000) return;

                    // Get name
                    let name = link.getAttribute('title') ||
                               card.querySelector('.prdct-desc-cntnr-name')?.textContent?.trim() ||
                               card.querySelector('[class*="product-name"]')?.textContent?.trim() ||
                               'Trendyol Ürünü';

                    // Get image
                    const imgEl = card.querySelector('img');
                    let imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || null;

                    products.push({
                        name: name.substring(0, 200),
                        price,
                        originalPrice: null,
                        imageUrl,
                        productUrl: href.startsWith('http') ? href : 'https://www.trendyol.com' + href,
                        productId: 'ty-' + productId,
                        store: 'Trendyol'
                    });
                } catch (e) {}
            });
        }

        console.log(`Trendyol: Total ${products.length} products found`);
        return products;
    });
}

async function parseHepsiburada(page) {
    return await page.evaluate(() => {
        const products = [];
        const seenIds = new Set();

        // Helper: Parse Turkish price format
        function parseTurkishPrice(text) {
            if (!text) return 0;
            const match = text.match(/(\d{1,3}(?:\.\d{3})*),(\d{2})/);
            if (match) {
                const price = parseFloat(match[1].replace(/\./g, '') + '.' + match[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            const simple = text.match(/(\d+),(\d{2})/);
            if (simple) {
                const price = parseFloat(simple[1] + '.' + simple[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            return 0;
        }

        // STRATEGY 1: Modern Hepsiburada card selectors (2024/2025)
        const cardSelectors = [
            '[data-test-id="product-card-item"]',
            'li[class*="productListContent"]',
            'div[class*="moria-ProductCard"]',
            '[class*="product-card"]',
            '[class*="ProductCard"]',
            'article[class*="product"]',
            '.search-item',
            '[data-productid]',
            'li[class*="search"]'
        ];

        let cards = [];
        for (const selector of cardSelectors) {
            try {
                const found = document.querySelectorAll(selector);
                if (found.length > 2) {
                    cards = Array.from(found);
                    console.log(`Hepsiburada: Found ${cards.length} cards with ${selector}`);
                    break;
                }
            } catch (e) {}
        }

        // Process cards
        cards.forEach((card) => {
            if (products.length >= 25) return;

            try {
                // Find product link
                const link = card.querySelector('a[href*="-p-"], a[href*="/p-"]') || card.querySelector('a');
                if (!link) return;

                const href = link.getAttribute('href') || '';
                const productIdMatch = href.match(/-p-([A-Z0-9]+)/i) || href.match(/\/p-([A-Z0-9]+)/i);
                if (!productIdMatch) return;

                const productId = productIdMatch[1];
                if (seenIds.has(productId)) return;
                seenIds.add(productId);

                // Find price - expanded selectors
                let price = 0;
                const priceSelectors = [
                    '[data-test-id="price-current-price"]',
                    '[class*="price-value"]',
                    '[class*="currentPrice"]',
                    '[class*="sale-price"]',
                    '[class*="ProductCard"] [class*="price"]',
                    '.price-new',
                    '.product-price',
                    '[class*="Price"]',
                    'span[class*="price"]'
                ];

                for (const sel of priceSelectors) {
                    const priceEl = card.querySelector(sel);
                    if (priceEl) {
                        const parsed = parseTurkishPrice(priceEl.textContent);
                        if (parsed > 0) {
                            price = parsed;
                            break;
                        }
                    }
                }

                // Fallback: regex in card text
                if (!price) {
                    const cardText = card.textContent || '';
                    const priceMatches = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/g);
                    if (priceMatches) {
                        for (const match of priceMatches) {
                            const parsed = parseTurkishPrice(match);
                            if (parsed > 0) {
                                price = parsed;
                                break;
                            }
                        }
                    }
                }

                if (!price || price <= 0) return;

                // Find name - expanded selectors
                let name = '';
                const nameSelectors = [
                    '[data-test-id="product-card-name"]',
                    '[class*="product-title"]',
                    '[class*="productName"]',
                    '[class*="ProductCard"] h3',
                    '[class*="title"]',
                    '.product-name',
                    'h3',
                    'h2',
                    'a[title]'
                ];

                for (const sel of nameSelectors) {
                    const nameEl = card.querySelector(sel);
                    if (nameEl) {
                        const text = nameEl.textContent?.trim() || nameEl.getAttribute('title') || '';
                        if (text.length > 5) {
                            name = text;
                            break;
                        }
                    }
                }

                if (!name) name = link.getAttribute('title') || link.textContent?.trim() || 'Hepsiburada Ürünü';

                // Find image
                const imgEl = card.querySelector('img');
                let imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-original') || null;

                // Original price
                let originalPrice = null;
                const origPriceEl = card.querySelector('[data-test-id="price-old-price"], [class*="oldPrice"], [class*="old-price"], del');
                if (origPriceEl) {
                    const parsed = parseTurkishPrice(origPriceEl.textContent);
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
            } catch (e) {}
        });

        // STRATEGY 2: Fallback - link-based approach
        if (products.length === 0) {
            console.log('Hepsiburada: Card strategy failed, trying link-based approach');
            const productLinks = document.querySelectorAll('a[href*="-p-"]');

            productLinks.forEach((link) => {
                if (products.length >= 25) return;

                try {
                    const href = link.getAttribute('href') || '';
                    const productIdMatch = href.match(/-p-([A-Z0-9]+)/i);
                    if (!productIdMatch) return;

                    const productId = productIdMatch[1];
                    if (seenIds.has(productId)) return;
                    seenIds.add(productId);

                    // Go up to find card container
                    let card = link;
                    for (let i = 0; i < 6 && card.parentElement; i++) {
                        card = card.parentElement;
                        if (card.querySelector('[class*="price"]') && card.querySelector('img')) break;
                    }

                    // Find price
                    let price = 0;
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    if (priceEl) {
                        price = parseTurkishPrice(priceEl.textContent);
                    }

                    if (!price) {
                        const cardText = card.textContent || '';
                        const priceMatch = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
                        if (priceMatch) {
                            price = parseTurkishPrice(priceMatch[0]);
                        }
                    }

                    if (!price || price <= 0) return;

                    // Find name
                    const name = link.getAttribute('title') ||
                                 card.querySelector('h3, h2, [class*="title"]')?.textContent?.trim() ||
                                 'Hepsiburada Ürünü';

                    // Find image
                    const imgEl = card.querySelector('img');
                    const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || null;

                    products.push({
                        name: name.substring(0, 200),
                        price,
                        originalPrice: null,
                        imageUrl,
                        productUrl: href.startsWith('http') ? href : 'https://www.hepsiburada.com' + href,
                        productId: 'hb-' + productId,
                        store: 'Hepsiburada'
                    });
                } catch (e) {}
            });
        }

        console.log(`Hepsiburada: Total ${products.length} products found`);
        return products;
    });
}

async function parseAmazon(page) {
    return await page.evaluate(() => {
        const products = [];

        // Helper: Parse Turkish price format
        function parseTurkishPrice(text) {
            if (!text) return 0;
            const match = text.match(/(\d{1,3}(?:\.\d{3})*),(\d{2})/);
            if (match) {
                const price = parseFloat(match[1].replace(/\./g, '') + '.' + match[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            const simple = text.match(/(\d+),(\d{2})/);
            if (simple) {
                const price = parseFloat(simple[1] + '.' + simple[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            return 0;
        }

        document.querySelectorAll('[data-component-type="s-search-result"]').forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a.a-link-normal.s-no-outline');
                const priceWholeEl = card.querySelector('.a-price-whole');
                const priceFractionEl = card.querySelector('.a-price-fraction');
                const originalPriceEl = card.querySelector('.a-text-price .a-offscreen');
                const imgEl = card.querySelector('img.s-image');

                if (!link || !priceWholeEl) return;

                // Try multiple selectors for product name (Amazon changes their HTML often)
                let productName = '';
                const nameSelectors = [
                    'h2.a-size-mini span.a-text-normal',
                    'h2 span.a-text-normal',
                    'h2.s-line-clamp-2 span',
                    'h2 a span',
                    '.a-size-base-plus.a-color-base.a-text-normal',
                    '.a-size-medium.a-color-base.a-text-normal',
                    'h2 span',
                    '.a-link-normal .a-text-normal'
                ];

                for (const selector of nameSelectors) {
                    const el = card.querySelector(selector);
                    if (el && el.textContent && el.textContent.trim().length > 5) {
                        productName = el.textContent.trim();
                        break;
                    }
                }

                // Fallback: try to get name from link title or image alt
                if (!productName || productName.length < 5) {
                    const linkTitle = link.getAttribute('title');
                    const imgAlt = imgEl?.getAttribute('alt');
                    productName = linkTitle || imgAlt || '';
                }

                // Skip if still no valid name
                if (!productName || productName.length < 5) return;

                const href = link.getAttribute('href') || '';

                // Parse price - Amazon uses separate whole/fraction elements
                // priceWhole might be "48.998" (with dot as thousands separator)
                const priceWhole = priceWholeEl.textContent?.replace(/[^\d]/g, '') || '0';
                const priceFraction = priceFractionEl?.textContent?.replace(/[^\d]/g, '') || '00';
                const price = parseFloat(priceWhole + '.' + priceFraction);

                // Skip unreasonable prices
                if (!price || price < 10 || price > 500000) return;

                let originalPrice = null;
                if (originalPriceEl) {
                    originalPrice = parseTurkishPrice(originalPriceEl.textContent);
                }

                const asin = card.getAttribute('data-asin');

                if (asin) {
                    products.push({
                        name: productName,
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
        const seenIds = new Set();

        // Helper: Parse Turkish price format
        function parseTurkishPrice(text) {
            if (!text) return 0;
            const match = text.match(/(\d{1,3}(?:\.\d{3})*),(\d{2})/);
            if (match) {
                const price = parseFloat(match[1].replace(/\./g, '') + '.' + match[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            const simple = text.match(/(\d+),(\d{2})/);
            if (simple) {
                const price = parseFloat(simple[1] + '.' + simple[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            return 0;
        }

        // STRATEGY 1: Modern N11 card selectors (2024/2025)
        const cardSelectors = [
            '.columnContent',
            '.listView',
            '[class*="productItem"]',
            '[class*="product-card"]',
            '.product-card',
            'li[class*="column"]',
            '[data-product-id]',
            'article[class*="product"]',
            '.search-result-item'
        ];

        let cards = [];
        for (const selector of cardSelectors) {
            try {
                const found = document.querySelectorAll(selector);
                if (found.length > 2) {
                    cards = Array.from(found);
                    console.log(`N11: Found ${cards.length} cards with ${selector}`);
                    break;
                }
            } catch (e) {}
        }

        // Process cards
        cards.forEach((card) => {
            if (products.length >= 25) return;

            try {
                // Find product link
                const link = card.querySelector('a.card-link, a.plink, a[href*="/urun/"]') || card.querySelector('a');
                if (!link) return;

                const href = link.getAttribute('href') || '';
                // N11 URL pattern: /urun/urun-adi-123456
                const productIdMatch = href.match(/\/urun\/[^\/]+-(\d+)/) || href.match(/\/(\d+)(?:\?|$)/);
                if (!productIdMatch) return;

                const productId = productIdMatch[1];
                if (seenIds.has(productId)) return;
                seenIds.add(productId);

                // Find price - expanded selectors
                let price = 0;
                const priceSelectors = [
                    '.newPrice ins',
                    '.price ins',
                    '.price-new',
                    '.newPrice',
                    '[class*="currentPrice"]',
                    '[class*="sale-price"]',
                    '.product-price',
                    '[class*="Price"] ins',
                    'ins[class*="price"]'
                ];

                for (const sel of priceSelectors) {
                    const priceEl = card.querySelector(sel);
                    if (priceEl) {
                        const parsed = parseTurkishPrice(priceEl.textContent);
                        if (parsed > 0) {
                            price = parsed;
                            break;
                        }
                    }
                }

                // Fallback: regex in card text
                if (!price) {
                    const cardText = card.textContent || '';
                    const priceMatches = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/g);
                    if (priceMatches) {
                        for (const match of priceMatches) {
                            const parsed = parseTurkishPrice(match);
                            if (parsed > 0) {
                                price = parsed;
                                break;
                            }
                        }
                    }
                }

                if (!price || price <= 0) return;

                // Find name - expanded selectors
                let name = '';
                const nameSelectors = [
                    '.productName',
                    '.pro-name',
                    '[class*="product-title"]',
                    '[class*="productTitle"]',
                    '.product-name',
                    'h3',
                    'h2',
                    'a[title]'
                ];

                for (const sel of nameSelectors) {
                    const nameEl = card.querySelector(sel);
                    if (nameEl) {
                        const text = nameEl.textContent?.trim() || nameEl.getAttribute('title') || '';
                        if (text.length > 5) {
                            name = text;
                            break;
                        }
                    }
                }

                if (!name) name = link.getAttribute('title') || link.textContent?.trim() || 'N11 Ürünü';

                // Find image
                const imgEl = card.querySelector('img');
                let imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-original') || imgEl?.getAttribute('data-lazy') || null;

                // Original price
                let originalPrice = null;
                const origPriceEl = card.querySelector('.oldPrice, .price del, .price-old, [class*="oldPrice"]');
                if (origPriceEl) {
                    const parsed = parseTurkishPrice(origPriceEl.textContent);
                    if (parsed > price) originalPrice = parsed;
                }

                products.push({
                    name: name.substring(0, 200),
                    price,
                    originalPrice,
                    imageUrl,
                    productUrl: href.startsWith('http') ? href : 'https://www.n11.com' + href,
                    productId: 'n11-' + productId,
                    store: 'N11'
                });
            } catch (e) {}
        });

        // STRATEGY 2: Link-based fallback
        if (products.length === 0) {
            console.log('N11: Card strategy failed, trying link-based approach');
            const productLinks = document.querySelectorAll('a[href*="/urun/"]');

            productLinks.forEach((link) => {
                if (products.length >= 25) return;

                try {
                    const href = link.getAttribute('href') || '';
                    const productIdMatch = href.match(/\/urun\/[^\/]+-(\d+)/);
                    if (!productIdMatch) return;

                    const productId = productIdMatch[1];
                    if (seenIds.has(productId)) return;
                    seenIds.add(productId);

                    // Go up to find card container
                    let card = link;
                    for (let i = 0; i < 6 && card.parentElement; i++) {
                        card = card.parentElement;
                        if (card.querySelector('[class*="price"]') && card.querySelector('img')) break;
                    }

                    // Find price
                    let price = 0;
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"], ins');
                    if (priceEl) {
                        price = parseTurkishPrice(priceEl.textContent);
                    }

                    if (!price) {
                        const cardText = card.textContent || '';
                        const priceMatch = cardText.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
                        if (priceMatch) {
                            price = parseTurkishPrice(priceMatch[0]);
                        }
                    }

                    if (!price || price <= 0) return;

                    // Find name
                    const name = link.getAttribute('title') ||
                                 card.querySelector('h3, h2, [class*="name"]')?.textContent?.trim() ||
                                 'N11 Ürünü';

                    // Find image
                    const imgEl = card.querySelector('img');
                    const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || null;

                    products.push({
                        name: name.substring(0, 200),
                        price,
                        originalPrice: null,
                        imageUrl,
                        productUrl: href.startsWith('http') ? href : 'https://www.n11.com' + href,
                        productId: 'n11-' + productId,
                        store: 'N11'
                    });
                } catch (e) {}
            });
        }

        console.log(`N11: Total ${products.length} products found`);
        return products;
    });
}

async function parseTeknosa(page) {
    return await page.evaluate(() => {
        const products = [];

        // Helper: Parse Turkish price format
        function parseTurkishPrice(text) {
            if (!text) return 0;
            const match = text.match(/(\d{1,3}(?:\.\d{3})*),(\d{2})/);
            if (match) {
                const price = parseFloat(match[1].replace(/\./g, '') + '.' + match[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            const simple = text.match(/(\d+),(\d{2})/);
            if (simple) {
                const price = parseFloat(simple[1] + '.' + simple[2]);
                return (price >= 10 && price <= 500000) ? price : 0;
            }
            return 0;
        }

        // Try multiple container selectors for Teknosa (they change HTML often)
        const containerSelectors = [
            '.product-list-item',
            '.prd',
            '.product-card',
            '[data-product-id]',
            '.plp-product-card',
            '.product-item'
        ];

        let cards = [];
        for (const selector of containerSelectors) {
            const found = document.querySelectorAll(selector);
            if (found.length > 0) {
                cards = found;
                break;
            }
        }

        cards.forEach((card, index) => {
            if (index >= 25) return;
            try {
                const link = card.querySelector('a[href*="/p-"], a[href*="urun"], a');

                // Try multiple selectors for product name
                let productName = '';
                const nameSelectors = [
                    '.prd-name',
                    '.product-name',
                    '.product-title',
                    '.title',
                    '[data-product-name]',
                    'h3',
                    'h2',
                    '.name',
                    'a[title]'
                ];

                for (const selector of nameSelectors) {
                    const el = card.querySelector(selector);
                    if (el) {
                        const text = el.textContent?.trim() || el.getAttribute('title') || '';
                        if (text.length > 5) {
                            productName = text;
                            break;
                        }
                    }
                }

                // Fallback: try link title or image alt
                if (!productName || productName.length < 5) {
                    const linkTitle = link?.getAttribute('title');
                    const imgEl = card.querySelector('img');
                    const imgAlt = imgEl?.getAttribute('alt');
                    productName = linkTitle || imgAlt || '';
                }

                // Try multiple selectors for price
                let priceEl = null;
                const priceSelectors = ['.prc', '.product-price', '.price', '.current-price', '[data-price]', '.amount'];
                for (const selector of priceSelectors) {
                    priceEl = card.querySelector(selector);
                    if (priceEl && priceEl.textContent?.match(/\d/)) break;
                }

                const originalPriceEl = card.querySelector('.old-prc, .old-price, .list-price, .was-price, del');
                const imgEl = card.querySelector('img');

                if (!link || !priceEl) return;

                const href = link.getAttribute('href') || '';
                const price = parseTurkishPrice(priceEl.textContent);

                // Skip unreasonable prices or no valid name
                if (!price || price < 10 || price > 500000) return;
                if (!productName || productName.length < 5) return;

                let originalPrice = null;
                if (originalPriceEl) {
                    originalPrice = parseTurkishPrice(originalPriceEl.textContent);
                }

                const productIdMatch = href.match(/-p-(\d+)|\/(\d+)\?|product\/(\d+)/);
                const productId = productIdMatch ? (productIdMatch[1] || productIdMatch[2] || productIdMatch[3]) : Math.random().toString(36).slice(2);

                products.push({
                    name: productName,
                    price,
                    originalPrice: originalPrice > price ? originalPrice : null,
                    imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-lazy') || null,
                    productUrl: href.startsWith('http') ? href : 'https://www.teknosa.com' + href,
                    productId: 'tek-' + productId,
                    store: 'Teknosa'
                });
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
    const screen = getRandomScreen();
    const isHighProtection = HIGH_PROTECTION_SITES.includes(store);

    // Extract Chrome version from user agent for headers
    const chromeVersion = userAgent.match(/Chrome\/(\d+)/)?.[1] || '125';

    console.log(`${store}: Starting scrape (high protection: ${isHighProtection})`);

    // High protection sites need longer timeouts
    const timeoutSecs = isHighProtection ? 60 : 40;
    const navTimeoutSecs = isHighProtection ? 35 : 25;

    const crawler = new PlaywrightCrawler({
        maxConcurrency: 1,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: timeoutSecs,
        navigationTimeoutSecs: navTimeoutSecs,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-setuid-sandbox',
                    // Anti-detection args
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-infobars',
                    '--disable-background-networking',
                    '--disable-breakpad',
                    '--disable-component-update',
                    '--disable-domain-reliability',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--no-first-run',
                    '--password-store=basic',
                    '--use-mock-keychain',
                    '--ignore-certificate-errors',
                    '--ignore-certificate-errors-spki-list',
                    `--window-size=${screen.width},${screen.height}`,
                    '--start-maximized',
                    // Timezone
                    '--lang=tr-TR',
                    '--accept-lang=tr-TR,tr,en-US,en'
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
                // NOTE: Script blocking disabled as it can break page rendering
                // The stealth script should be enough to bypass fingerprinting
                // Block only analytics/tracking, not security scripts
                if (isHighProtection) {
                    await page.route('**/*', async (route) => {
                        const url = route.request().url().toLowerCase();
                        // Only block obvious analytics, not security scripts
                        const blockedPatterns = [
                            'google-analytics',
                            'googletagmanager',
                            'facebook.com/tr',
                            'doubleclick.net',
                            'go-mpulse.net'
                        ];

                        const shouldBlock = blockedPatterns.some(pattern => url.includes(pattern));

                        if (shouldBlock) {
                            await route.abort();
                        } else {
                            await route.continue();
                        }
                    });
                }

                // === CDP MODE ENHANCEMENTS ===
                try {
                    // Get CDP session for deeper control
                    const client = await page.context().newCDPSession(page);

                    // Enable CDP domains
                    await client.send('Runtime.enable');
                    await client.send('Network.enable');

                    // Hide webdriver at CDP level
                    await client.send('Page.addScriptToEvaluateOnNewDocument', {
                        source: `
                            // CDP-level stealth
                            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                            // Override permissions query
                            const originalQuery = window.navigator.permissions.query;
                            window.navigator.permissions.query = (parameters) => (
                                parameters.name === 'notifications' ?
                                    Promise.resolve({ state: Notification.permission }) :
                                    originalQuery(parameters)
                            );

                            // Mask automation
                            window.navigator.permissions.query = async (params) => {
                                if (params.name === 'notifications') {
                                    return { state: 'prompt', onchange: null };
                                }
                                return { state: 'granted', onchange: null };
                            };
                        `
                    });

                    // Emulate realistic timezone
                    await client.send('Emulation.setTimezoneOverride', {
                        timezoneId: 'Europe/Istanbul'
                    });

                    // Set realistic geolocation (Istanbul)
                    await client.send('Emulation.setGeolocationOverride', {
                        latitude: 41.0082,
                        longitude: 28.9784,
                        accuracy: 100
                    });

                } catch (cdpError) {
                    console.log('CDP setup warning:', cdpError.message);
                }
                // === END CDP ENHANCEMENTS ===

                // Set realistic viewport with device scale factor
                await page.setViewportSize({
                    width: screen.width,
                    height: screen.height
                });

                // Inject comprehensive stealth script BEFORE page loads
                await page.addInitScript(STEALTH_SCRIPT);

                // Set extra HTTP headers
                await page.setExtraHTTPHeaders({
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'max-age=0',
                    'Sec-Ch-Ua': `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not-A.Brand";v="99"`,
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent': userAgent
                });

                // Emulate timezone
                await page.context().addCookies([{
                    name: 'timezone',
                    value: 'Europe/Istanbul',
                    domain: new URL(config.searchUrl(query)).hostname,
                    path: '/'
                }]).catch(() => {});
            }
        ],
        async requestHandler({ page, request }) {
            console.log(`Scraping ${store}: ${request.url}`);

            // For high protection sites, add extra delay and behaviors
            if (isHighProtection) {
                console.log(`${store}: High protection mode - adding human simulation`);

                // Initial wait - let page fully load
                await page.waitForTimeout(randomDelay(2000, 3000));

                // Handle cookie consent first
                await handleCookieConsent(page);

                // Quick mouse movements to appear human (faster)
                for (let i = 0; i < 3; i++) {
                    await page.mouse.move(
                        Math.random() * screen.width * 0.8 + 50,
                        Math.random() * screen.height * 0.6 + 50,
                        { steps: 5 }
                    );
                    await page.waitForTimeout(randomDelay(150, 300));
                }

                // Faster scroll pattern
                const scrollSteps = [0.2, 0.4, 0.6, 0.8, 0.5];
                for (const step of scrollSteps) {
                    await page.evaluate((s) => {
                        window.scrollTo({
                            top: document.body.scrollHeight * s,
                            behavior: 'smooth'
                        });
                    }, step);
                    await page.waitForTimeout(randomDelay(400, 700));
                }

                // Brief wait for dynamic content
                await page.waitForTimeout(randomDelay(1000, 1500));
            }

            // Initial delay - human-like page load observation
            await page.waitForTimeout(randomDelay(1000, 2000));

            // Wait for products to load
            let selectorFound = false;
            try {
                await page.waitForSelector(config.waitSelector, { timeout: 20000 });
                selectorFound = true;
            } catch (e) {
                console.log(`${store}: Primary selector timeout, trying fallback...`);
                // Try waiting for any content
                try {
                    await page.waitForSelector('body', { timeout: 5000 });
                } catch (e2) {}
            }

            // Wait for JS rendering and dynamic content
            await page.waitForTimeout(randomDelay(2000, 3000));

            // TRENDYOL SPECIFIC: ULTRA AGGRESSIVE scrolling to trigger lazy loading
            if (store === 'trendyol') {
                console.log('Trendyol: Performing ULTRA aggressive scroll for lazy-loaded products...');

                // Wait for initial page load
                await page.waitForTimeout(2000);

                // Method 1: Scroll down in 10 steps (doubled from 5)
                for (let i = 1; i <= 10; i++) {
                    await page.evaluate((step) => {
                        window.scrollTo({
                            top: document.body.scrollHeight * (step / 10),
                            behavior: 'smooth'
                        });
                    }, i);
                    await page.waitForTimeout(randomDelay(600, 1000));
                }

                // Method 2: Scroll to absolute bottom
                await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
                await page.waitForTimeout(1500);

                // Method 3: Scroll back to top slowly
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
                await page.waitForTimeout(1000);

                // Method 4: Scroll to middle and wait for lazy load
                await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight * 0.3, behavior: 'smooth' }));
                await page.waitForTimeout(1500);
                await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight * 0.6, behavior: 'smooth' }));
                await page.waitForTimeout(1500);
                await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight * 0.9, behavior: 'smooth' }));
                await page.waitForTimeout(1500);

                // Method 5: Trigger intersection observer by scrolling element by element
                await page.evaluate(() => {
                    const cards = document.querySelectorAll('.p-card-wrppr, [class*="product"], [data-id]');
                    cards.forEach((card, i) => {
                        if (i < 30) {
                            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    });
                });
                await page.waitForTimeout(2000);

                // Final scroll to top to see all products
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
                await page.waitForTimeout(1000);

                console.log('Trendyol: Scroll complete, waiting for content...');
                await page.waitForTimeout(randomDelay(2000, 3000));
            }

            // Human-like scrolling behavior - gradual scroll with pauses
            const scrollSteps = [0.2, 0.4, 0.6, 0.8, 0.5, 0.3]; // Scroll pattern
            for (const step of scrollSteps) {
                await page.evaluate((s) => {
                    window.scrollTo({
                        top: document.body.scrollHeight * s,
                        behavior: 'smooth'
                    });
                }, step);
                await page.waitForTimeout(randomDelay(400, 800));
            }

            // Small random mouse movements (anti-bot)
            try {
                await page.mouse.move(
                    100 + Math.random() * 200,
                    100 + Math.random() * 200
                );
                await page.waitForTimeout(randomDelay(100, 300));
                await page.mouse.move(
                    300 + Math.random() * 400,
                    200 + Math.random() * 300
                );
            } catch (e) {}

            // Wait a bit more for lazy-loaded images
            await page.waitForTimeout(randomDelay(500, 1000));

            // Check for bot block before parsing
            if (isHighProtection) {
                const blockStatus = await detectBotBlock(page);
                if (blockStatus.blocked) {
                    console.log(`${store}: BOT BLOCKED - Reason: ${blockStatus.reason}`);
                    // Try to screenshot for debugging
                    try {
                        const screenshotPath = `/tmp/${store}-blocked-${Date.now()}.png`;
                        await page.screenshot({ path: screenshotPath });
                        console.log(`${store}: Screenshot saved to ${screenshotPath}`);
                    } catch (e) {}
                    return;
                }
            }

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
