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

    // Parse seller-store product cards - they have a clean structure:
    // <a class="seller-store-product-card" href="/url-p-123">
    //   <img class="product-image" src="https://cdn...">
    //   <p class="product-name"><strong class="product-brand">Brand</strong>Name</p>
    //   <span class="product-price">16.999 TL</span>
    // </a>

    // Split by seller-store-product-card
    const cardMarker = 'class="seller-store-product-card"';
    const parts = html.split(cardMarker);
    console.log(`Found ${parts.length - 1} seller-store cards`);

    for (let i = 1; i < parts.length && products.length < 30; i++) {
        const cardContent = parts[i].substring(0, 2000);  // Each card content

        // Also get the href from before the marker (in the <a> tag opening)
        const precedingContent = parts[i - 1].slice(-300);
        const hrefMatch = precedingContent.match(/href="([^"]*-p-[0-9]+[^"]*)"\s*$/);
        const productUrl = hrefMatch ? 'https://www.trendyol.com' + hrefMatch[1] : null;

        // Extract brand from <strong class="product-brand">
        const brandMatch = cardContent.match(/class="product-brand"[^>]*>([^<]+)/i);
        const brand = brandMatch ? brandMatch[1].trim() : null;

        // Extract full product name (brand is usually followed by the name)
        // Pattern: <p class="product-name"...><strong...>Brand</strong>Name</p>
        const nameMatch = cardContent.match(/class="product-name"[^>]*>(?:<strong[^>]*>[^<]*<\/strong>)?([^<]+)/i);
        const name = nameMatch ? nameMatch[1].trim() : null;

        // Extract price from <span class="product-price">
        const priceMatch = cardContent.match(/class="product-price"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i);
        let price = null;
        if (priceMatch) {
            price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
        }

        // Extract image URL
        const imgMatch = cardContent.match(/class="product-image"[^>]*src="([^"]+)"/i);
        const imageUrl = imgMatch ? imgMatch[1] : null;

        // Skip if we don't have essential data
        if (!price || price < 100) continue;

        const fullName = brand && name ? `${brand} ${name}` : (name || 'Unknown Product');

        products.push({
            name: fullName,
            price: price,
            originalPrice: null,
            imageUrl: imageUrl,
            productUrl: productUrl,
            brand: brand,
            seller: null,
            store: 'Trendyol'
        });
    }

    // Also try to parse regular product cards if we don't have enough products
    if (products.length < 10) {
        console.log(`Only ${products.length} from seller cards, trying regular cards...`);

        // Find all info-wrapper positions for regular product cards
        const infoWrapperPositions = [];
        let searchPos = 0;
        while (true) {
            const pos = html.indexOf('class="info-wrapper"', searchPos);
            if (pos === -1) break;
            infoWrapperPositions.push(pos);
            searchPos = pos + 20;
        }

        console.log(`Found ${infoWrapperPositions.length} info-wrapper elements`);

        for (let i = 0; i < infoWrapperPositions.length && products.length < 30; i++) {
            const startPos = infoWrapperPositions[i];
            const endPos = infoWrapperPositions[i + 1] || startPos + 3000;
            const block = html.substring(startPos, Math.min(endPos, startPos + 3000));

            // Extract brand - text before any < inside product-brand span
            const brandMatch = block.match(/class="product-brand"[^>]*>([^<]+)/i);
            const brand = brandMatch ? brandMatch[1].trim() : null;

            // Extract product name - handle <!-- --> comment
            // Pattern: class="product-name"...> <!-- -->Actual Name
            const nameMatch = block.match(/class="product-name"[^>]*>(?:\s*<!--[^>]*-->)?\s*([^<]+)/i);
            const name = nameMatch ? nameMatch[1].trim() : null;

            // Extract price from price-section or sale-price
            const priceMatch = block.match(/class="(?:price-section|sale-price)"[^>]*>([0-9.]+(?:,[0-9]{2})?)\s*TL/i);
            let price = null;
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
            }

            // Extract product URL from surrounding context
            const contextStart = Math.max(0, startPos - 500);
            const context = html.substring(contextStart, startPos + 500);
            const urlMatch = context.match(/href="([^"]*-p-[0-9]+[^"]*)"/i);
            const productUrl = urlMatch ? 'https://www.trendyol.com' + urlMatch[1] : null;

            // Extract image URL
            const imgMatch = context.match(/(?:data-src|src)="(https:\/\/cdn\.dsmcdn\.com[^"]*\/prod[^"]*\.jpg)"/i);
            const imageUrl = imgMatch ? imgMatch[1] : null;

            if (name && price && price >= 100 && price <= 500000) {
                // Check if we already have this product
                const exists = products.some(p => p.name.includes(name.substring(0, 20)));
                if (!exists) {
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
        }
    }

    console.log(`Final: ${products.length} products`);
    return products;
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
