FROM node:22-slim

# Dépendances système pour Baileys
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Librairies Python pour les bots utilisateurs
RUN pip3 install --break-system-packages \
    requests python-dotenv schedule aiohttp httpx

WORKDIR /app

# Dépendances Node du manager
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Dossier de stockage des bots WA
RUN mkdir -p /app/wa_bots

EXPOSE 8081

CMD ["node", "server-whatsapp.js"]
