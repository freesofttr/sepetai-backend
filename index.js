const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = '27c0df8063c38ebc97100e825ff4cd1c';

app.use(cors());
app.use(express.json());

// Simple in-memory cache (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return item.data;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
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
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`Cache hit for: ${q}`);
        return res.json(cached);
    }

    console.log(`Searching: ${q}`);

    try {
        const fetch = (await import('node-fetch')).default;

        const targetUrl = `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`;
        // Try without render first (faster), only use render if needed
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&country_code=tr`;

        const response = await fetch(apiUrl);
        if (!response.ok) {
            return res.status(500).json({ error: `ScraperAPI: ${response.status}` });
        }

        const html = await response.text();
        console.log(`Got ${html.length} bytes`);

        // Debug: what price-related patterns exist?
        const hasSellingPrice = html.includes('sellingPrice');
        const hasDiscountedPrice = html.includes('discountedPrice');
        const hasOriginalPrice = html.includes('originalPrice');
        const hasPriceValue = html.includes('"price":');
        const hasFiyat = html.includes('fiyat');
        console.log(`Price patterns: selling=${hasSellingPrice}, discounted=${hasDiscountedPrice}, original=${hasOriginalPrice}, price=${hasPriceValue}, fiyat=${hasFiyat}`);

        // Log a section that might contain product data
        const priceSection = html.match(/.{0,200}price.{0,200}/i);
        if (priceSection) {
            console.log('Price context:', priceSection[0].substring(0, 300));
        }

        const products = parseProducts(html);
        console.log(`Found ${products.length} products`);

        const result = { query: q, count: products.length, products };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

function parseProducts(html) {
    const products = [];

    // New approach: Find all product links first, then extract info
    // Product links have pattern: href="/brand/product-name-p-123456?..."
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

    // Process each product link
    for (let i = 0; i < productLinks.length && products.length < 30; i++) {
        const link = productLinks[i];

        // Skip if we already have this product ID
        if (products.some(p => p.productId === link.productId)) continue;

        // Get content after this link (the product card content)
        const contentStart = link.position;
        const contentEnd = productLinks[i + 1]?.position || contentStart + 5000;
        const cardContent = html.substring(contentStart, Math.min(contentEnd, contentStart + 5000));

        // Extract brand from product-brand span
        const brandMatch = cardContent.match(/class="product-brand"[^>]*>([^<]+)/i);
        const brand = brandMatch ? brandMatch[1].trim() : null;

        // Extract product name - handle <!-- --> comment
        const nameMatch = cardContent.match(/class="product-name"[^>]*>(?:\s*<!--[\s\S]*?-->)?\s*([^<]+)/i);
        let name = nameMatch ? nameMatch[1].trim() : null;

        // If no name found, try to extract from href
        if (!name && link.href) {
            // href format: /brand/product-name-here-p-123
            const hrefParts = link.href.split('/');
            if (hrefParts.length >= 3) {
                const productSlug = hrefParts[2].split('-p-')[0];
                name = productSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        }

        // Extract price - try multiple patterns
        let price = null;
        const pricePatterns = [
            /class="price-section"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="single-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="sale-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="discounted-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            />([0-9]{2,3}\.[0-9]{3}(?:\.[0-9]{3})?)\s*TL</i,  // Match 47.999 TL
            />([0-9]+\.[0-9]{3})\s*TL/i  // Simpler pattern
        ];

        for (const pattern of pricePatterns) {
            const priceMatch = cardContent.match(pattern);
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
                if (price >= 100 && price <= 500000) break;
                price = null;
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

        // Skip if we don't have essential data
        if (!name || !price || price < 100) continue;

        const productUrl = 'https://www.trendyol.com' + link.href.replace(/&amp;/g, '&');
        const fullName = brand && !name.toLowerCase().startsWith(brand.toLowerCase())
            ? `${brand} ${name}`
            : name;

        console.log(`Product: "${fullName.substring(0, 40)}..." Price: ${price} URL: ${productUrl.substring(0, 50)}...`);

        products.push({
            name: fullName,
            price: price,
            originalPrice: null,
            imageUrl: imageUrl,
            productUrl: productUrl,
            productId: link.productId,
            brand: brand,
            seller: null,
            store: 'Trendyol'
        });
    }

    console.log(`Final: ${products.length} products`);
    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
