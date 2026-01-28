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
        // Add wait parameter for ScraperAPI to wait longer for JS rendering
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=tr&wait_for_selector=.p-card-wrppr`;

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

        res.json({
            htmlLength: html.length,
            patterns,
            scriptCount: scripts.length,
            largestScriptLength: largestScript ? largestScript.length : 0,
            hasJsonArray: !!jsonArrayMatch,
            tlPriceExamples: priceNumbers.slice(0, 10),
            htmlContainsProduct: html.toLowerCase().includes('product'),
            htmlContainsSearch: html.toLowerCase().includes('search'),
            sampleMiddle: html.substring(Math.floor(html.length / 2), Math.floor(html.length / 2) + 3000)
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

    // Try multiple price patterns
    const pricePatterns = [
        /"sellingPrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"discountedPrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"salePrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"price"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"value"\s*:\s*(\d+(?:\.\d+)?)/g,
    ];

    let allPrices = [];
    for (const pattern of pricePatterns) {
        const matches = [...html.matchAll(pattern)];
        if (matches.length > 0) {
            console.log(`Found ${matches.length} prices with pattern ${pattern.source}`);
            // Filter reasonable prices (10 TL - 500000 TL)
            const validPrices = matches.map(m => parseFloat(m[1])).filter(p => p >= 10 && p <= 500000);
            if (validPrices.length > allPrices.length) {
                allPrices = validPrices;
            }
        }
    }

    // Try multiple name patterns
    const namePatterns = [
        /"name"\s*:\s*"([^"]{10,200})"/g,
        /"title"\s*:\s*"([^"]{10,200})"/g,
        /"productName"\s*:\s*"([^"]{10,200})"/g,
    ];

    let allNames = [];
    for (const pattern of namePatterns) {
        const matches = [...html.matchAll(pattern)];
        if (matches.length > 0) {
            console.log(`Found ${matches.length} names with pattern ${pattern.source}`);
            // Filter for product-like names (not URLs, not short strings)
            const validNames = matches.map(m => m[1]).filter(n =>
                !n.includes('http') &&
                !n.includes('\\u') &&
                n.length > 10 &&
                /[a-zA-ZğüşıöçĞÜŞİÖÇ]/.test(n)
            );
            if (validNames.length > allNames.length) {
                allNames = validNames;
            }
        }
    }

    console.log(`Final: ${allNames.length} names, ${allPrices.length} prices`);

    // Match names with prices
    for (let i = 0; i < Math.min(allNames.length, allPrices.length, 20); i++) {
        products.push({
            name: allNames[i],
            price: allPrices[i],
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
