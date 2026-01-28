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

    // Split HTML by product cards to keep name/price aligned
    // Product cards are <a> tags with class="product-card"
    const cardSplits = html.split(/(?=<a[^>]*class="[^"]*product-card[^"]*")/i);
    console.log(`Split into ${cardSplits.length} parts`);

    for (let i = 1; i < cardSplits.length && products.length < 30; i++) {
        const card = cardSplits[i];
        // Limit card to reasonable size (until next major element)
        const cardContent = card.substring(0, 5000);

        // Extract brand
        const brandMatch = cardContent.match(/<span[^>]*class="product-brand"[^>]*>([^<]+)/i);
        const brand = brandMatch ? brandMatch[1].trim() : null;

        // Extract product name
        const nameMatch = cardContent.match(/<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)/i);
        const name = nameMatch ? nameMatch[1].trim() : null;

        // Extract price - try multiple patterns
        // Pattern 1: product-price class (16.999 TL)
        // Pattern 2: price-section class (9.899,01 TL)
        let price = null;
        const pricePatterns = [
            /class="product-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="price-section"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            />([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{2})?)\s*TL/i  // General pattern for formatted prices
        ];

        for (const pattern of pricePatterns) {
            const priceMatch = cardContent.match(pattern);
            if (priceMatch) {
                // Convert Turkish format: 16.999 -> 16999 or 9.899,01 -> 9899.01
                let priceStr = priceMatch[1].replace(/\./g, '').replace(',', '.');
                price = parseFloat(priceStr);
                if (price >= 100 && price <= 500000) {
                    break;
                }
                price = null;  // Invalid price, try next pattern
            }
        }

        // Extract product URL
        const urlMatch = card.match(/href="([^"]*-p-[0-9]+[^"]*)"/i);
        const productUrl = urlMatch ? 'https://www.trendyol.com' + urlMatch[1] : null;

        // Extract image URL
        const imgMatch = cardContent.match(/(?:data-src|src)="(https:\/\/cdn\.dsmcdn\.com\/[^"]*(?:zoom|product)[^"]*)"/i);
        const imageUrl = imgMatch ? imgMatch[1].replace(/\\u002F/g, '/') : null;

        if (name && price) {
            products.push({
                name: brand ? `${brand} ${name}` : name,
                price: price,
                originalPrice: null,
                imageUrl: imageUrl,
                productUrl: productUrl,
                brand: brand,
                seller: null,
                store: 'Trendyol'
            });
        }
    }

    console.log(`Final: ${products.length} products`);
    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
