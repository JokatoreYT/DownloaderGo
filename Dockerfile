FROM nginx:alpine

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js files.json ./

# l'entrypoint ufficiale di nginx sostituisce ${PORT} nel template
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/40-goapi.sh /docker-entrypoint.d/40-goapi.sh
RUN chmod +x /docker-entrypoint.d/40-goapi.sh

# Render imposta PORT da solo; 10000 è il default
ENV PORT=10000 \
    APP_PORT=3000 \
    NGINX_ENVSUBST_FILTER=^PORT$

EXPOSE 10000
