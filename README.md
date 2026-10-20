# GoAPI

Proxy in streaming per link pubblici Google Drive. Nessun file viene salvato sul server.

## Deploy su Render
1. Carica questa cartella su un repo GitHub.
2. Render > New > Web Service > seleziona il repo (Build: `npm install`, Start: `node server.js`) oppure usa `render.yaml`.

## Uso
```bash
# 1) ottieni la key (valida 10 minuti, una per IP)
curl https://TUO-SERVIZIO.onrender.com/api/get-key

# 2) aggiungi un file all'indice
curl -X POST https://TUO-SERVIZIO.onrender.com/api/index \
  -H "x-api-key: LA_TUA_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://drive.google.com/file/d/ID/view","name":"mio-file.zip"}'

# 3) leggi l'indice
curl -H "x-api-key: LA_TUA_KEY" https://TUO-SERVIZIO.onrender.com/api/index

# 4) scarica
curl -OJ https://TUO-SERVIZIO.onrender.com/downs/LA_TUA_KEY/mio-file.zip
```

Variabile opzionale: `STRICT_IP=1` limita anche il download all'IP che ha creato la key.
