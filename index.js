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

        // Find price containers specifically
        const priceBoxMatches = html.match(/class="[^"]*price[^"]*"[^>]*>[^<]*</gi) || [];
        const priceWrapperMatches = html.match(/class="[^"]*prc[^"]*"[^>]*>[^<]*</gi) || [];

        // Look for selling/discounted price patterns
        const sellingMatches = html.match(/sellingPrice[^}]*}/gi) || [];

        // Find product card with surrounding context
        const productCardSample = html.match(/product-card[\s\S]{0,3000}?(?=product-card|$)/i);

        res.json({
            htmlLength: html.length,
            patterns,
            scriptCount: scripts.length,
            largestScriptLength: largestScript ? largestScript.length : 0,
            hasJsonArray: !!jsonArrayMatch,
            tlPriceExamples: priceNumbers.slice(0, 10),
            priceBoxSamples: priceBoxMatches.slice(0, 10),
            prcWrapperSamples: priceWrapperMatches.slice(0, 10),
            sellingPriceSamples: sellingMatches.slice(0, 3),
            productCardSample: productCardSample ? productCardSample[0].substring(0, 2000) : null,
            htmlContainsProduct: html.toLowerCase().includes('product'),
            htmlContainsSearch: html.toLowerCase().includes('search'),
            hasNextData: !!stateScriptMatch,
            hasNuxtData: !!nuxtDataMatch,
            hasProductInScripts
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

    // Parse each product card as a whole unit to keep data aligned
    // Split by product card boundaries
    const cardPattern = /<div[^>]*class="[^"]*product-card[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*product-card[^"]*"|<\/section>|$)/gi;
    const cards = html.match(cardPattern) || [];

    console.log(`Found ${cards.length} product cards`);

    // Alternative: split by the info-wrapper which contains product details
    if (cards.length === 0) {
        // Try finding product blocks by the title structure
        const titleBlocks = html.split(/<div[^>]*data-testid="info-wrapper-div"[^>]*class="info-wrapper"/i);
        console.log(`Found ${titleBlocks.length - 1} title blocks`);

        for (let i = 1; i < titleBlocks.length && products.length < 30; i++) {
            const block = titleBlocks[i];

            // Extract brand
            const brandMatch = block.match(/<span[^>]*class="product-brand"[^>]*>([^<]+)/i);
            const brand = brandMatch ? brandMatch[1].trim() : null;

            // Extract product name
            const nameMatch = block.match(/<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)/i);
            const name = nameMatch ? nameMatch[1].trim() : null;

            // Extract price (look in the block or shortly after)
            const priceMatch = block.match(/>(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*TL/);
            let price = null;
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
            }

            if (name && price && price >= 100) {
                products.push({
                    name: brand ? `${brand} ${name}` : name,
                    price: price,
                    originalPrice: null,
                    imageUrl: null,
                    productUrl: null,
                    brand: brand,
                    seller: null,
                    store: 'Trendyol'
                });
            }
        }
    }

    // If still no products, try extracting data from structured elements
    if (products.length === 0) {
        // Extract paired brand-name-price sequences
        const infoPattern = /<span[^>]*class="product-brand"[^>]*>([^<]+)[\s\S]*?<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)[\s\S]*?>(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*TL/gi;

        let match;
        while ((match = infoPattern.exec(html)) !== null && products.length < 30) {
            const brand = match[1].trim();
            const name = match[2].trim();
            const price = parseFloat(match[3].replace(/\./g, '').replace(',', '.'));

            if (name && price >= 100) {
                products.push({
                    name: `${brand} ${name}`,
                    price: price,
                    originalPrice: null,
                    imageUrl: null,
                    productUrl: null,
                    brand: brand,
                    seller: null,
                    store: 'Trendyol'
                });
            }
        }
    }

    // Final fallback: extract any reasonable price-name pairs
    if (products.length === 0) {
        const brandPattern = /<span[^>]*class="product-brand"[^>]*>([^<]+)/gi;
        const namePattern = /<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)/gi;
        const pricePattern = />(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/g;

        const brands = [...html.matchAll(brandPattern)].map(m => m[1].trim());
        const names = [...html.matchAll(namePattern)].map(m => m[1].trim());
        const prices = [...html.matchAll(pricePattern)].map(m =>
            parseFloat(m[1].replace(/\./g, '').replace(',', '.'))
        ).filter(p => p >= 100);

        console.log(`Fallback: ${brands.length} brands, ${names.length} names, ${prices.length} prices`);

        const count = Math.min(names.length, prices.length, 30);
        for (let i = 0; i < count; i++) {
            products.push({
                name: brands[i] ? `${brands[i]} ${names[i]}` : names[i],
                price: prices[i],
                originalPrice: null,
                imageUrl: null,
                productUrl: null,
                brand: brands[i] || null,
                seller: null,
                store: 'Trendyol'
            });
        }
    }

    console.log(`Final: ${products.length} products`);
    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
