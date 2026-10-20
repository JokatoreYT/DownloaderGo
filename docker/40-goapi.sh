#!/bin/sh
# Avvia il backend Node in background (con riavvio automatico se crasha)
cd /app || exit 1
( while true; do node server.js; echo "[goapi] backend terminato, riavvio..."; sleep 1; done ) &
