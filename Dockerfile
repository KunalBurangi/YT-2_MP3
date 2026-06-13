# Use official Node.js runtime as parent image
FROM node:20-slim

# Install system dependencies (ffmpeg, python3 for yt-dlp, and curl)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Download and install the latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port (Render automatically maps this)
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
