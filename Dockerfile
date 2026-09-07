# Works as-is on Hugging Face Spaces (Docker SDK), Koyeb, Northflank, Fly and
# plain `docker run`. Port 7860 is the Hugging Face default; every other host
# injects its own PORT, and server.js honours it.
FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

# --use-system-ca matters on a workstation behind TLS-inspecting antivirus.
# It is harmless in a container, so the command stays identical everywhere.
CMD ["node", "--use-system-ca", "server.js"]
