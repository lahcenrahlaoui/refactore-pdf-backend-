# Dockerfile
# Official Playwright image with Chromium + all OS libraries pre-installed.
# The tag MUST match the playwright version in package.json exactly.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

# Set working directory
WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY package.json package-lock.json ./

# Install production dependencies only.
# Skip browser download — the base image already has Chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

# Copy the rest of the source
COPY . .

# Render injects PORT at runtime; default to 3000 for local Docker runs
ENV PORT=3000
EXPOSE 3000

# Start the server
CMD ["node", "index.js"]