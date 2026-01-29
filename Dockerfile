# Use Playwright base image with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy main package files
COPY package*.json ./
RUN npm install --production

# Copy crawlee-worker and install its dependencies
COPY crawlee-worker/package*.json ./crawlee-worker/
RUN cd crawlee-worker && npm install --production

# Copy all source files
COPY . .

# Set environment variables for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CRAWLEE_STORAGE_DIR=/app/crawlee-worker/storage
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
