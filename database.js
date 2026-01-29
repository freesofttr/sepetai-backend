const { Pool } = require('pg');

// PostgreSQL connection pool
// Railway provides DATABASE_URL automatically when you add a PostgreSQL addon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
    const client = await pool.connect();
    try {
        // Create price_history table
        await client.query(`
            CREATE TABLE IF NOT EXISTS price_history (
                id SERIAL PRIMARY KEY,
                product_id VARCHAR(255) NOT NULL,
                product_name TEXT,
                store VARCHAR(50) NOT NULL,
                price DECIMAL(12,2) NOT NULL,
                original_price DECIMAL(12,2),
                recorded_at TIMESTAMP DEFAULT NOW(),
                day_of_week INT,
                day_of_month INT,
                is_campaign BOOLEAN DEFAULT FALSE,
                campaign_name VARCHAR(100)
            );

            CREATE INDEX IF NOT EXISTS idx_price_history_product_id ON price_history(product_id);
            CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON price_history(recorded_at);
            CREATE INDEX IF NOT EXISTS idx_price_history_store ON price_history(store);
        `);

        // Create products table for tracking unique products
        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                product_id VARCHAR(255) UNIQUE NOT NULL,
                product_name TEXT,
                brand VARCHAR(255),
                category VARCHAR(100),
                image_url TEXT,
                first_seen TIMESTAMP DEFAULT NOW(),
                last_updated TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id);
        `);

        // Create ai_insights table for caching AI analysis
        await client.query(`
            CREATE TABLE IF NOT EXISTS ai_insights (
                id SERIAL PRIMARY KEY,
                product_id VARCHAR(255) NOT NULL,
                insight_type VARCHAR(50),
                insight_data JSONB,
                confidence DECIMAL(3,2),
                generated_at TIMESTAMP DEFAULT NOW(),
                valid_until TIMESTAMP,
                UNIQUE(product_id, insight_type)
            );

            CREATE INDEX IF NOT EXISTS idx_ai_insights_product_id ON ai_insights(product_id);
        `);

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error.message);
        // Don't throw - allow app to run without database
    } finally {
        client.release();
    }
}

// Record a price point for a product
async function recordPrice(productId, productName, store, price, originalPrice = null) {
    if (!process.env.DATABASE_URL) return null;

    try {
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0-6
        const dayOfMonth = now.getDate(); // 1-31

        // Check if we already have a price record for this product/store in the last hour
        const recentCheck = await pool.query(
            `SELECT id FROM price_history
             WHERE product_id = $1 AND store = $2
             AND recorded_at > NOW() - INTERVAL '1 hour'`,
            [productId, store]
        );

        if (recentCheck.rows.length > 0) {
            // Update existing recent record instead of creating duplicate
            await pool.query(
                `UPDATE price_history
                 SET price = $1, original_price = $2, recorded_at = NOW()
                 WHERE id = $3`,
                [price, originalPrice, recentCheck.rows[0].id]
            );
            return recentCheck.rows[0].id;
        }

        // Insert new price record
        const result = await pool.query(
            `INSERT INTO price_history
             (product_id, product_name, store, price, original_price, day_of_week, day_of_month)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [productId, productName, store, price, originalPrice, dayOfWeek, dayOfMonth]
        );

        return result.rows[0].id;
    } catch (error) {
        console.error('Error recording price:', error.message);
        return null;
    }
}

// Record prices for multiple products (batch operation)
async function recordPricesBatch(products) {
    if (!process.env.DATABASE_URL || !products || products.length === 0) return;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const now = new Date();
        const dayOfWeek = now.getDay();
        const dayOfMonth = now.getDate();

        for (const product of products) {
            // Upsert product record
            await client.query(
                `INSERT INTO products (product_id, product_name, brand, image_url, last_updated)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (product_id)
                 DO UPDATE SET product_name = $2, last_updated = NOW()`,
                [product.productId, product.name, product.brand, product.imageUrl]
            );

            // Check for recent price record
            const recentCheck = await client.query(
                `SELECT id FROM price_history
                 WHERE product_id = $1 AND store = $2
                 AND recorded_at > NOW() - INTERVAL '1 hour'`,
                [product.productId, product.store]
            );

            if (recentCheck.rows.length === 0) {
                // Insert new price record
                await client.query(
                    `INSERT INTO price_history
                     (product_id, product_name, store, price, original_price, day_of_week, day_of_month)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [product.productId, product.name, product.store, product.price, product.originalPrice, dayOfWeek, dayOfMonth]
                );
            }
        }

        await client.query('COMMIT');
        console.log(`Recorded prices for ${products.length} products`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error in batch price recording:', error.message);
    } finally {
        client.release();
    }
}

// Get price history for a product
async function getPriceHistory(productId, days = 30) {
    if (!process.env.DATABASE_URL) {
        return { history: [], stats: null };
    }

    try {
        // Get price history
        const historyResult = await pool.query(
            `SELECT
                id, product_id, store, price, original_price,
                recorded_at, day_of_week, day_of_month
             FROM price_history
             WHERE product_id = $1
             AND recorded_at > NOW() - INTERVAL '${days} days'
             ORDER BY recorded_at ASC`,
            [productId]
        );

        // Calculate statistics
        const statsResult = await pool.query(
            `SELECT
                MIN(price) as min_price,
                MAX(price) as max_price,
                AVG(price) as avg_price,
                COUNT(*) as data_points,
                MIN(recorded_at) as first_recorded,
                MAX(recorded_at) as last_recorded
             FROM price_history
             WHERE product_id = $1
             AND recorded_at > NOW() - INTERVAL '${days} days'`,
            [productId]
        );

        // Calculate price by day of week
        const dayOfWeekStats = await pool.query(
            `SELECT
                day_of_week,
                AVG(price) as avg_price,
                COUNT(*) as sample_count
             FROM price_history
             WHERE product_id = $1
             AND recorded_at > NOW() - INTERVAL '${days} days'
             GROUP BY day_of_week
             ORDER BY day_of_week`,
            [productId]
        );

        // Find the best day to buy
        let bestDay = null;
        let bestDayPrice = Infinity;
        for (const row of dayOfWeekStats.rows) {
            if (row.sample_count >= 2 && parseFloat(row.avg_price) < bestDayPrice) {
                bestDayPrice = parseFloat(row.avg_price);
                bestDay = row.day_of_week;
            }
        }

        const stats = statsResult.rows[0];
        const dayNames = ['Pazar', 'Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi'];

        return {
            history: historyResult.rows.map(row => ({
                price: parseFloat(row.price),
                originalPrice: row.original_price ? parseFloat(row.original_price) : null,
                store: row.store,
                recordedAt: row.recorded_at,
                dayOfWeek: row.day_of_week
            })),
            stats: {
                minPrice: stats.min_price ? parseFloat(stats.min_price) : null,
                maxPrice: stats.max_price ? parseFloat(stats.max_price) : null,
                avgPrice: stats.avg_price ? parseFloat(stats.avg_price) : null,
                dataPoints: parseInt(stats.data_points),
                firstRecorded: stats.first_recorded,
                lastRecorded: stats.last_recorded,
                bestDay: bestDay !== null ? {
                    dayOfWeek: bestDay,
                    dayName: dayNames[bestDay],
                    avgPrice: bestDayPrice
                } : null,
                priceByDayOfWeek: dayOfWeekStats.rows.map(row => ({
                    dayOfWeek: row.day_of_week,
                    dayName: dayNames[row.day_of_week],
                    avgPrice: parseFloat(row.avg_price),
                    sampleCount: parseInt(row.sample_count)
                }))
            }
        };
    } catch (error) {
        console.error('Error fetching price history:', error.message);
        return { history: [], stats: null };
    }
}

// Get simple price analysis for a product
async function getSimplePriceAnalysis(productId, currentPrice) {
    if (!process.env.DATABASE_URL) {
        return null;
    }

    try {
        const { history, stats } = await getPriceHistory(productId, 30);

        if (!stats || stats.dataPoints < 3) {
            return {
                hasEnoughData: false,
                message: 'Yeterli fiyat verisi yok',
                dataPoints: stats?.dataPoints || 0
            };
        }

        // Calculate price position (0 = lowest ever, 1 = highest ever)
        const priceRange = stats.maxPrice - stats.minPrice;
        const pricePosition = priceRange > 0
            ? (currentPrice - stats.minPrice) / priceRange
            : 0.5;

        // Calculate recent trend (last 7 days vs previous 7 days)
        const now = new Date();
        const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

        const recentPrices = history.filter(h => new Date(h.recordedAt) >= oneWeekAgo);
        const olderPrices = history.filter(h => {
            const date = new Date(h.recordedAt);
            return date >= twoWeeksAgo && date < oneWeekAgo;
        });

        let trend = 'STABLE';
        let trendChange = 0;
        if (recentPrices.length >= 2 && olderPrices.length >= 2) {
            const recentAvg = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
            const olderAvg = olderPrices.reduce((sum, p) => sum + p.price, 0) / olderPrices.length;
            trendChange = ((recentAvg - olderAvg) / olderAvg) * 100;

            if (trendChange < -5) trend = 'DECREASING';
            else if (trendChange > 5) trend = 'INCREASING';
        }

        // Generate recommendation
        let verdict, reason, confidence;

        if (pricePosition < 0.2) {
            verdict = 'SATIN AL';
            reason = 'Fiyat son 30 gunun en dusuk seviyelerine yakin';
            confidence = 0.85;
        } else if (pricePosition > 0.7 && trend === 'INCREASING') {
            verdict = 'BEKLE';
            reason = 'Fiyat yuksek ve artis trendinde';
            confidence = 0.75;
        } else if (trend === 'DECREASING') {
            verdict = 'BEKLE';
            reason = 'Fiyat dusus trendinde, biraz daha bekleyebilirsin';
            confidence = 0.7;
        } else if (pricePosition < 0.4) {
            verdict = 'SATIN AL';
            reason = 'Fiyat ortalamanin altinda';
            confidence = 0.7;
        } else {
            verdict = 'NORMAL';
            reason = 'Fiyat ortalama seviyede';
            confidence = 0.6;
        }

        return {
            hasEnoughData: true,
            currentPrice,
            priceRange: {
                min: stats.minPrice,
                max: stats.maxPrice,
                avg: Math.round(stats.avgPrice * 100) / 100
            },
            pricePosition: Math.round(pricePosition * 100), // 0-100
            trend: {
                direction: trend,
                changePercent: Math.round(trendChange * 10) / 10
            },
            recommendation: {
                verdict,
                reason,
                confidence
            },
            bestDay: stats.bestDay,
            dataPoints: stats.dataPoints
        };
    } catch (error) {
        console.error('Error in price analysis:', error.message);
        return null;
    }
}

// Check database connection
async function checkConnection() {
    if (!process.env.DATABASE_URL) {
        console.log('DATABASE_URL not set - running without database');
        return false;
    }

    try {
        const client = await pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        console.log('Database connected successfully');
        return true;
    } catch (error) {
        console.error('Database connection failed:', error.message);
        return false;
    }
}

module.exports = {
    pool,
    initDatabase,
    recordPrice,
    recordPricesBatch,
    getPriceHistory,
    getSimplePriceAnalysis,
    checkConnection
};
