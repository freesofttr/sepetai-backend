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
            console.log(`ScraperAPI error: ${response.status}`);
            return res.status(500).json({ error: `ScraperAPI: ${response.status}` });
        }

        const html = await response.text();
        console.log(`Got ${html.length} bytes`);

        // Debug: check what patterns exist in HTML
        const hasSearchState = html.includes('__SEARCH_APP_INITIAL_STATE__');
        const hasProductCard = html.includes('p-card-wrppr');
        const hasProductName = html.includes('prdct-desc-cntnr-name');
        const hasPrice = html.includes('prc-box');
        console.log(`Debug: searchState=${hasSearchState}, productCard=${hasProductCard}, productName=${hasProductName}, price=${hasPrice}`);

        // Log a sample of HTML for debugging
        if (!hasSearchState && !hasProductCard) {
            console.log('HTML sample (first 2000 chars):', html.substring(0, 2000));
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

    // Method 1: Try to find __SEARCH_APP_INITIAL_STATE__
    let match = html.match(/__SEARCH_APP_INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
        console.log('Found __SEARCH_APP_INITIAL_STATE__');
        try {
            const data = JSON.parse(match[1]);
            const items = data?.results?.products || data?.products || [];
            console.log(`Parsed JSON, found ${items.length} items`);

            items.slice(0, 20).forEach(p => {
                if (p.name && p.price) {
                    products.push({
                        name: p.name,
                        price: p.price.sellingPrice || p.price.discountedPrice || p.price || 0,
                        originalPrice: p.price.originalPrice !== p.price.sellingPrice ? p.price.originalPrice : null,
                        imageUrl: p.images?.[0] ? `https://cdn.dsmcdn.com/ty${p.images[0]}` : null,
                        productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
                        brand: p.brand?.name || null,
                        seller: p.merchantName || null,
                        store: 'Trendyol'
                    });
                }
            });
            if (products.length > 0) return products;
        } catch (e) {
            console.log('JSON parse failed:', e.message);
        }
    }

    // Method 2: Try window.__PRODUCT_SEARCH_STATE__
    match = html.match(/window\.__PRODUCT_SEARCH_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
        console.log('Found __PRODUCT_SEARCH_STATE__');
        try {
            const data = JSON.parse(match[1]);
            const items = data?.products || [];
            items.slice(0, 20).forEach(p => {
                products.push({
                    name: p.name || p.title || '',
                    price: p.price?.sellingPrice || p.sellingPrice || p.price || 0,
                    originalPrice: null,
                    imageUrl: p.imageUrl || p.image || null,
                    productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
                    brand: p.brand || null,
                    seller: p.seller || null,
                    store: 'Trendyol'
                });
            });
            if (products.length > 0) return products;
        } catch (e) {
            console.log('JSON parse failed:', e.message);
        }
    }

    // Method 3: Search for any JSON with products array
    const jsonMatches = html.matchAll(/"products"\s*:\s*\[([\s\S]*?)\]/g);
    for (const m of jsonMatches) {
        try {
            const arr = JSON.parse('[' + m[1] + ']');
            if (arr.length > 0 && arr[0].name) {
                console.log(`Found products array with ${arr.length} items`);
                arr.slice(0, 20).forEach(p => {
                    products.push({
                        name: p.name || '',
                        price: p.price?.sellingPrice || p.price || 0,
                        originalPrice: null,
                        imageUrl: null,
                        productUrl: null,
                        brand: null,
                        seller: null,
                        store: 'Trendyol'
                    });
                });
                if (products.length > 0) return products;
            }
        } catch (e) {
            // Continue trying
        }
    }

    // Method 4: Regex fallback for HTML elements
    console.log('Trying regex fallback...');
    const names = [...html.matchAll(/prdct-desc-cntnr-name[^>]*>([^<]+)</g)];
    const prices = [...html.matchAll(/prc-box-(?:dscntd|sllng)[^>]*>([^<]+)</g)];
    console.log(`Regex found: ${names.length} names, ${prices.length} prices`);

    for (let i = 0; i < Math.min(names.length, prices.length, 20); i++) {
        const priceStr = prices[i][1].replace(/[^\d,]/g, '').replace(',', '.');
        const price = parseFloat(priceStr);
        if (price > 0) {
            products.push({
                name: names[i][1].trim(),
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
