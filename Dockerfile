FROM node:20

WORKDIR /usr/src/app

# Install dependencies (better-sqlite3 needs build tools, included in node:20)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
