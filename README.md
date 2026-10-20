# GoAPI

nginx (vero, immagine ufficiale) davanti + backend Node che fa da proxy in streaming
per file di Google Drive. Nessun file viene salvato sul server e il link Drive non
viene mai mostrato: dal browser sembra un download diretto dal tuo server.

## Come si usa (dal browser)
1. Apri `https://TUO-SERVIZIO.onrender.com/api/get-key` -> ottieni la tua key (valida 10 minuti, una per IP).
2. Scarica da `https://TUO-SERVIZIO.onrender.com/downs/LA_TUA_KEY/nome-archivio.zip`

`/` mostra la pagina di default originale di nginx.

## files.json (l'indice)
Qui metti il nome con cui vuoi far scaricare l'archivio e il link pubblico di Drive:

```json
{
  "files": [
    { "name": "mio-archivio.zip", "drive": "https://drive.google.com/file/d/ID_FILE/view?usp=sharing" },
    { "name": "altro.7z",         "drive": "https://drive.google.com/file/d/ID_FILE/view?usp=sharing" }
  ]
}
```
- `name`: solo lettere, numeri, `.` `_` `-` (es. `.zip`, `.7z`, `.rar`, qualsiasi estensione).
- Il file di Drive deve essere condiviso come "Chiunque abbia il link".
- Il file viene riletto a ogni richiesta, ma su Render le modifiche arrivano con un nuovo deploy.

### Tenere i link Drive nascosti (consigliato)
Non mettere i link veri in un repo GitHub pubblico. Su Render: Service > Environment >
**Secret Files** > crea `files.json` con il contenuto sopra. GoAPI usa `/etc/secrets/files.json`
al posto di quello nel repo.

## Deploy su Render
1. Carica questa cartella su un repo GitHub (meglio privato).
2. Render > New > Web Service > repo > Runtime: **Docker** (oppure Blueprint con `render.yaml`).

## Opzioni
- `STRICT_IP=1`: il download funziona solo dall'IP che ha creato la key (di default chi ha il link con la key può scaricare).

## Test locale
```bash
docker build -t goapi . && docker run --rm -p 8080:10000 goapi
```
