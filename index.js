const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = '27c0df8063c38ebc97100e825ff4cd1c';

app.use(cors());
app.use(express.json());

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

        res.json({
            htmlLength: html.length,
            patterns,
            scriptCount: scripts.length,
            largestScriptLength: largestScript ? largestScript.length : 0,
            hasJsonArray: !!jsonArrayMatch,
            tlPriceExamples: priceNumbers.slice(0, 10),
            htmlContainsProduct: html.toLowerCase().includes('product'),
            htmlContainsSearch: html.toLowerCase().includes('search'),
            hasNextData: !!stateScriptMatch,
            hasNuxtData: !!nuxtDataMatch,
            hasProductInScripts,
            sampleEnd: html.substring(Math.max(0, html.length - 5000)),
            sampleMiddle: html.substring(Math.floor(html.length / 2), Math.floor(html.length / 2) + 2000)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/all', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    console.log(`Searching: ${q}`);

    try {
        const fetch = (await import('node-fetch')).default;

        const targetUrl = `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`;
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=tr`;

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

        res.json({ query: q, count: products.length, products });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

function parseProducts(html) {
    const products = [];

    // Trendyol HTML structure (2024-2025):
    // - Product cards have class "product-card"
    // - Brand: <span class="product-brand">Samsung
    // - Name: <span class="product-name">Galaxy A36...
    // - Price: >149,90 TL (comma as decimal)
    // - Image: data-src or src in img tags within product cards
    // - URL: href in <a> tags within product cards

    // Extract product information using HTML patterns
    // Pattern for brand-name combinations
    const brandNamePattern = /<span[^>]*class="product-brand"[^>]*>([^<]+)(?:<[^>]*>)*<\/span>\s*<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)/gi;

    // Simpler patterns for individual elements
    const brandPattern = /<span[^>]*class="product-brand"[^>]*>([^<]+)/gi;
    const namePattern = /<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)/gi;

    // Price pattern: matches >149,90 TL or >1.499,90 TL format
    const pricePattern = />(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*TL/g;

    // Image pattern for product images
    const imagePattern = /(?:data-src|src)="(https:\/\/cdn\.dsmcdn\.com[^"]*(?:zoom|product)[^"]*)"/gi;

    // URL pattern for product links
    const urlPattern = /href="(\/[^"]*-p-\d+[^"]*)"/gi;

    // Extract all matches
    const brands = [...html.matchAll(brandPattern)].map(m => m[1].trim());
    const names = [...html.matchAll(namePattern)].map(m => m[1].trim());
    const prices = [...html.matchAll(pricePattern)].map(m => {
        // Convert Turkish number format (1.234,56) to standard (1234.56)
        let priceStr = m[1].replace(/\./g, '').replace(',', '.');
        return parseFloat(priceStr);
    }).filter(p => p >= 10 && p <= 500000);
    const images = [...html.matchAll(imagePattern)].map(m => m[1].replace(/\\u002F/g, '/'));
    const urls = [...html.matchAll(urlPattern)].map(m => 'https://www.trendyol.com' + m[1]);

    console.log(`Parsed: ${brands.length} brands, ${names.length} names, ${prices.length} prices, ${images.length} images, ${urls.length} urls`);

    // Combine brand and name for full product name
    const fullNames = [];
    for (let i = 0; i < Math.min(brands.length, names.length); i++) {
        fullNames.push(`${brands[i]} ${names[i]}`);
    }

    // If combined names are less than prices, try using names only
    const productNames = fullNames.length > 0 ? fullNames : names;

    console.log(`Final: ${productNames.length} product names, ${prices.length} prices`);

    // Build product list
    const count = Math.min(productNames.length, prices.length, 30);
    for (let i = 0; i < count; i++) {
        products.push({
            name: productNames[i] || `Ürün ${i + 1}`,
            price: prices[i],
            originalPrice: null,
            imageUrl: images[i] || null,
            productUrl: urls[i] || null,
            brand: brands[i] || null,
            seller: null,
            store: 'Trendyol'
        });
    }

    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
