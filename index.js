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

        // Find a complete product card sample
        const cardStartIdx = html.indexOf('class="product-card"');
        const productCardSample = cardStartIdx > -1 ? html.substring(cardStartIdx, cardStartIdx + 4000) : null;

        // Find how product cards are structured
        const cardCount = (html.match(/class="product-card"/g) || []).length;
        const sellerStoreCardCount = (html.match(/seller-store-product-card/g) || []).length;

        res.json({
            cardCount,
            sellerStoreCardCount,
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

    // Strategy: Find all info-wrapper-div elements (contain brand + name)
    // Then look for the next price element after each info wrapper
    const infoWrapperPositions = [];
    let searchStart = 0;
    while (true) {
        const pos = html.indexOf('info-wrapper', searchStart);
        if (pos === -1) break;
        infoWrapperPositions.push(pos);
        searchStart = pos + 20;
    }

    console.log(`Found ${infoWrapperPositions.length} info-wrapper positions`);

    for (let i = 0; i < infoWrapperPositions.length && products.length < 30; i++) {
        const startPos = infoWrapperPositions[i];
        // Look at content from this wrapper to the next (or 3000 chars)
        const endPos = infoWrapperPositions[i + 1] || startPos + 3000;
        const blockContent = html.substring(startPos, Math.min(endPos, startPos + 3000));

        // Extract brand
        const brandMatch = blockContent.match(/<span[^>]*class="product-brand"[^>]*>([^<]+)/i);
        const brand = brandMatch ? brandMatch[1].trim() : null;

        // Extract product name
        const nameMatch = blockContent.match(/<span[^>]*class="product-name"[^>]*>\s*(?:<!--[^>]*-->)?\s*([^<]+)/i);
        const name = nameMatch ? nameMatch[1].trim() : null;

        // Skip if no name found
        if (!name) continue;

        // Extract price - look for any price pattern in this block or shortly after
        let price = null;
        const pricePatterns = [
            /class="product-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="price-value"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="price-section"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            /class="discounted-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i,
            />([0-9]{1,3}\.[0-9]{3}(?:\.[0-9]{3})?(?:,[0-9]{2})?)\s*TL</i
        ];

        // Also look in a wider range for the price
        const priceSearchContent = html.substring(startPos, Math.min(startPos + 4000, html.length));

        for (const pattern of pricePatterns) {
            const priceMatch = priceSearchContent.match(pattern);
            if (priceMatch) {
                let priceStr = priceMatch[1].replace(/\./g, '').replace(',', '.');
                price = parseFloat(priceStr);
                if (price >= 100 && price <= 500000) {
                    break;
                }
                price = null;
            }
        }

        if (!price) continue;

        // Extract product URL - look before the info-wrapper (in the parent card)
        const cardContext = html.substring(Math.max(0, startPos - 500), startPos + 500);
        const urlMatch = cardContext.match(/href="([^"]*-p-[0-9]+[^"]*)"/i);
        const productUrl = urlMatch ? 'https://www.trendyol.com' + urlMatch[1] : null;

        // Extract image URL
        const imgMatch = cardContext.match(/(?:data-src|src)="(https:\/\/cdn\.dsmcdn\.com[^"]*\/prod[^"]*\.jpg)"/i);
        const imageUrl = imgMatch ? imgMatch[1].replace(/\\u002F/g, '/') : null;

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

    console.log(`Final: ${products.length} products`);
    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
