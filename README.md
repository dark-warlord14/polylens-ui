# PolyLens UI

A high-performance, automated web dashboard for Polymarket discovery. Converted from the PolyLens Chrome extension into a professional, scalable static web application.

## 🚀 Key Features
- **Alpha Dashboard:** Advanced real-time filtering for Polymarket opportunities based on ROI, probability, and liquidity.
- **Automated 10-Min Sync:** Data is automatically updated every 10 minutes via GitHub Actions with a built-in validation safety net.
- **Native Web Architecture:** Built using idiomatic native Web APIs (`fetch`, `localStorage`). No extension shims or heavy frameworks.
- **Pre-calculated Analytics:** Category and outcome counts are pre-calculated during the sync process for instant UI responsiveness.
- **Cloudflare Pages Optimized:** Designed for global deployment on Cloudflare's CDN, capable of serving 10k+ concurrent users.

## 🛠 Local Development

### Using Docker (Recommended)
Run the entire stack locally with a single command:
```bash
docker-compose up
```
The app will be available at `http://localhost:8080`.

### Manual Setup
1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Fetch latest data:**
   ```bash
   npm run sync
   ```
3. **Start local server:**
   ```bash
   npm run serve
   ```

## 🚢 Deployment
This project is optimized for **Cloudflare Pages** with GitHub Integration.

1.  **Build command:** *(Leave this field blank)*
2.  **Build output directory:** `src`
3.  **Root directory:** `/`

Once connected, the included GitHub Action (`.github/workflows/sync-data.yml`) will automatically update the data every 10 minutes, and Cloudflare Pages will deploy the new static content.

## 📂 Project Structure
- `src/`: The frontend application (HTML/CSS/JS).
- `src/data/`: Static JSON data storage (auto-generated).
- `scripts/`: Internal Node.js automation (Sync & Validation).
- `.github/workflows/`: Automation engine for data updates.

## ✅ Security & Scale
- **No Secrets Exposed:** All API interactions happen in the GitHub Action runner.
- **Data Integrity:** `validate.js` ensures corrupt or empty data never reaches production.
- **Global Scalability:** 100% static architecture allows for near-infinite scaling via CDN.
