# Use Playwright base image with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy main package files
COPY package*.json ./
RUN npm install --production

# Copy crawlee-worker and install its dependencies
COPY crawlee-worker/package*.json ./crawlee-worker/
RUN cd crawlee-worker && npm install --production

# Install Playwright browsers explicitly for Crawlee
RUN cd crawlee-worker && npx playwright install chromium

# Copy all source files
COPY . .

# Create storage directory with proper permissions
RUN mkdir -p /app/crawlee-worker/storage/request_queues && \
    mkdir -p /app/crawlee-worker/storage/key_value_stores && \
    mkdir -p /app/crawlee-worker/storage/datasets && \
    chmod -R 777 /app/crawlee-worker/storage

# Set environment variables for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CRAWLEE_STORAGE_DIR=/app/crawlee-worker/storage
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
