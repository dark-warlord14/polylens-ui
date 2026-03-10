/**
 * validate.js
 * Ensures the generated data files are valid and not empty.
 */
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../src/data/cache.json');

try {
    if (!fs.existsSync(CACHE_PATH)) {
        throw new Error("cache.json does not exist!");
    }

    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

    // Validation Rules
    if (!data.deals || !Array.isArray(data.deals)) {
        throw new Error("Invalid data format: 'deals' array is missing.");
    }

    if (data.deals.length < 100) {
        throw new Error(`Data looks suspicious: only ${data.deals.length} deals found. Aborting push to protect production.`);
    }

    if (!data.timestamp || Date.now() - data.timestamp > 3600000) {
        throw new Error("Timestamp is missing or too old.");
    }

    console.log(`Validation Passed: ${data.deals.length} deals ready for production.`);
    process.exit(0);
} catch (e) {
    console.error("Validation Failed:", e.message);
    process.exit(1);
}
