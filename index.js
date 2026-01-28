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

app.get('/api/search/all', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    console.log(`Searching: ${q}`);

    try {
        const fetch = (await import('node-fetch')).default;

        const targetUrl = `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`;
        const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=tr`;

        console.log('Fetching from ScraperAPI...');
        const response = await fetch(apiUrl);

        if (!response.ok) {
            return res.status(500).json({ error: `ScraperAPI: ${response.status}` });
        }

        const html = await response.text();
        console.log(`Got ${html.length} bytes`);

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

    // Method 1: Look for window["__*PROPS"] patterns (new Trendyol format)
    const propsMatches = html.matchAll(/window\["([^"]+)"\]\s*=\s*(\{[^}]+\}|\[[^\]]+\]|"[^"]*")/g);
    for (const match of propsMatches) {
        const key = match[1];
        const value = match[2];
        console.log(`Found window prop: ${key}`);

        if (key.includes('product') || key.includes('search') || key.includes('listing')) {
            try {
                const data = JSON.parse(value);
                console.log(`Parsed ${key}:`, typeof data);
            } catch (e) {
                // Continue
            }
        }
    }

    // Method 2: Look for script tags with JSON data
    const scriptMatches = html.matchAll(/<script[^>]*>([^<]*(?:"products"|"items"|"results")[^<]*)<\/script>/gi);
    for (const match of scriptMatches) {
        const content = match[1];
        // Try to find JSON objects with product data
        const jsonMatch = content.match(/\{[^{}]*"(?:products|items)":\s*\[[\s\S]*?\]\s*[^{}]*\}/);
        if (jsonMatch) {
            try {
                const data = JSON.parse(jsonMatch[0]);
                const items = data.products || data.items || [];
                console.log(`Found ${items.length} products in script tag`);
                if (items.length > 0) {
                    items.slice(0, 20).forEach(p => {
                        products.push({
                            name: p.name || p.title || '',
                            price: p.price?.sellingPrice || p.price?.discountedPrice || p.price || p.sellingPrice || 0,
                            originalPrice: null,
                            imageUrl: p.images?.[0] || p.imageUrl || p.image || null,
                            productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
                            brand: p.brand?.name || p.brand || null,
                            seller: p.merchantName || p.seller || null,
                            store: 'Trendyol'
                        });
                    });
                    if (products.length > 0) return products;
                }
            } catch (e) {
                // Continue
            }
        }
    }

    // Method 3: Extract product data from any JSON in page
    // Look for patterns like {"id":123,"name":"...",price":...}
    const productPatterns = html.matchAll(/\{"id":\d+[^}]*"name":"([^"]+)"[^}]*"price":\{[^}]*"sellingPrice":(\d+(?:\.\d+)?)[^}]*\}/g);
    for (const match of productPatterns) {
        const name = match[1];
        const price = parseFloat(match[2]);
        if (name && price > 0 && products.length < 20) {
            products.push({
                name: name,
                price: price,
                originalPrice: null,
                imageUrl: null,
                productUrl: null,
                brand: null,
                seller: null,
                store: 'Trendyol'
            });
        }
    }

    if (products.length > 0) {
        console.log(`Method 3 found ${products.length} products`);
        return products;
    }

    // Method 4: Try to find any "name" and "sellingPrice" pairs
    const nameMatches = [...html.matchAll(/"name"\s*:\s*"([^"]+)"/g)];
    const priceMatches = [...html.matchAll(/"sellingPrice"\s*:\s*(\d+(?:\.\d+)?)/g)];

    console.log(`Method 4: found ${nameMatches.length} names, ${priceMatches.length} prices`);

    // Filter for product names (usually longer than 10 chars)
    const productNames = nameMatches.filter(m => m[1].length > 10 && !m[1].includes('http'));

    for (let i = 0; i < Math.min(productNames.length, priceMatches.length, 20); i++) {
        const price = parseFloat(priceMatches[i][1]);
        if (price > 0) {
            products.push({
                name: productNames[i][1],
                price: price,
                originalPrice: null,
                imageUrl: null,
                productUrl: null,
                brand: null,
                seller: null,
                store: 'Trendyol'
            });
        }
    }

    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
