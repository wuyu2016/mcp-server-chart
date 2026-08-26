# Use bookworm for canvas native addon build
FROM node:20-bookworm AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    fonts-wqy-microhei \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f

WORKDIR /app

# Copy package files and install
COPY package.json ./
RUN npm install --no-audit --no-fund

# Copy server code and config
COPY server.js register.cjs defaults.json ./

EXPOSE 3000

CMD ["node", "-r", "./register.cjs", "server.js"]