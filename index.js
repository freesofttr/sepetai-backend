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

    const match = html.match(/__SEARCH_APP_INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
        try {
            const data = JSON.parse(match[1]);
            const items = data?.results?.products || [];

            items.slice(0, 20).forEach(p => {
                if (p.name && p.price) {
                    products.push({
                        name: p.name,
                        price: p.price.sellingPrice || p.price.discountedPrice || 0,
                        originalPrice: p.price.originalPrice !== p.price.sellingPrice ? p.price.originalPrice : null,
                        imageUrl: p.images?.[0] ? `https://cdn.dsmcdn.com/ty${p.images[0]}` : null,
                        productUrl: p.url ? `https://www.trendyol.com${p.url}` : null,
                        brand: p.brand?.name || null,
                        seller: p.merchantName || null,
                        store: 'Trendyol'
                    });
                }
            });
        } catch (e) {
            console.log('JSON parse failed:', e.message);
        }
    }

    if (products.length === 0) {
        const names = [...html.matchAll(/prdct-desc-cntnr-name[^>]*>([^<]+)</g)];
        const prices = [...html.matchAll(/prc-box-(?:dscntd|sllng)[^>]*>([^<]+)</g)];

        for (let i = 0; i < Math.min(names.length, prices.length, 20); i++) {
            const price = parseFloat(prices[i][1].replace(/[^\d,]/g, '').replace(',', '.'));
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
    }

    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
