FROM node:20-bookworm-slim

WORKDIR /app

# Build-Tools fuer better-sqlite3 (natives Modul), falls fuer die
# Ziel-Architektur (z.B. Raspberry Pi/ARM) kein Prebuild vorhanden ist
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
# /data ist bei Home-Assistant-Add-ons automatisch persistenter Speicher
ENV DB_PATH=/data/haushalt.db
EXPOSE 3000

CMD ["node", "src/server.js"]
