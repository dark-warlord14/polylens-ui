# Use Node.js for syncing and serving
FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src
COPY scripts ./scripts

# Expose port
EXPOSE 8080

# Run sync then serve
CMD ["npm", "run", "dev"]
