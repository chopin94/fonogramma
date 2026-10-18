# Fonogramma — auscultazione digitale (PWA)

App web installabile (cellulare e PC) per il **fonendoscopio collegato via jack**:
fonocardiogramma in tempo reale, waterfall ad alto aggiornamento, analisi automatica
dei toni cardiaci e dei rumori respiratori, visite con archivio pazienti e referto.

**▶ Usala subito: https://chopin94.github.io/fonogramma/** — apri il link da Chrome
(Android/PC) o Safari (iPhone) e scegli *Installa app* / *Aggiungi a Home*. Funziona
anche offline. Senza fonendoscopio puoi provarla con il simulatore integrato
(*Ausculta → Regolazioni → Sorgente → Simulatore*).

> ⚠️ Strumento didattico e di supporto all'auscultazione: le analisi automatiche sono
> indicative e non sostituiscono il giudizio clinico. **Non è un dispositivo medico
> certificato.**

## Privacy

Nella versione pubblicata su GitHub Pages **nessun dato lascia il dispositivo**: pazienti,
visite e registrazioni sono salvati solo nel browser (IndexedDB). Non ci sono server,
account, cookie di tracciamento o analytics. Per spostare o conservare i dati usa
*Impostazioni → Esporta / Importa backup* (file JSON: contiene dati sanitari, custodiscilo
con cura). Chi vuole sincronizzare più dispositivi può ospitare il proprio server (sotto).

Riunisce e modernizza i programmi precedenti:

| Programma originale | Cosa è stato ripreso |
|---|---|
| `fonocardiogrammaPCG` (PyQt) | filtri HP/LP Butterworth a pendenza variabile, EQ parametrico a 9 bande (+ import di `eq_preset.json`), inviluppo di Shannon, picchi MAD, classificazione S1/S2/S3/S4, sdoppiamento di S2, energie, sospetto soffio, SQI, waterfall, Holter WAV → tabella battiti/CSV, PDF, anagrafica |
| `cardiogramma` v1–v3 | HRV (SDNN, RMSSD, pNN50), sistole/diastole, qualità del segnale (SNR in banda, centroide) |
| `Cardiogram94` | periodicità per autocorrelazione, registrazione continua e a frammenti |
| `PCGdroid` (React Native) | Web Audio senza AGC/eco/soppressione rumore, struttura a moduli, referto nel browser |

## Funzioni

- **Ausculta cuore**: 4 focolai + punto di Erb su mappa del torace, con posizione, uso di
  campana/membrana, manovre e cosa ascoltare; filtro consigliato applicato automaticamente.
  Tracciato con S1/S2/S3/S4/click/schiocco, sistole evidenziata, inviluppo, ciclo medio.
  Metriche live: FC, ritmo, sistole/diastole, S1/S2, sdoppiamento di S2, toni aggiunti,
  soffio (fase, forma, intensità relativa, tonalità), qualità del segnale.
- **Ausculta torace**: 12 punti anteriori/posteriori, waterfall fino a 500 colonne/s e 768
  righe, frequenza respiratoria, I:E indicativo, crepitii fini/grossolani (IDW, 2CD, fase),
  sibili e ronchi (tracce tonali, polifonia), intensità del murmure e simmetria dx/sx.
- **Registrazione e loop**: registra, oppure salva gli **ultimi N secondi già ascoltati**
  (buffer ad anello); player con loop senza interruzioni (tutto, selezione, 1 o 3 cicli
  cardiaci), rallentatore 0,75×/0,5× a intonazione costante, filtro di ascolto a scelta,
  zoom, tabella battiti/eventi, spettrogramma medio del ciclo, esportazione WAV/CSV.
- **Visita**: anamnesi, parametri vitali, **esame guidato** punto per punto, reperti
  (Levine, forma, timbro, irradiazione…), precompilazione dall'analisi, confronto fra
  focolai (punto di massima intensità del soffio), conclusioni, **referto stampabile/PDF**.
- **Ascolto in cuffia** con limitatore di protezione, riduzione rumore adattiva (cuore),
  simulatore di casi clinici per prova e didattica, lettura di file WAV/MP3 come sorgente.
- **Offline-first**: tutto resta sul dispositivo (IndexedDB); se l'app è servita dal
  proprio server di casa si sincronizza fra cellulare e PC, altrimenti funziona in
  modalità *solo dispositivo* (riconosciuta automaticamente) con backup su file.

## Architettura

```
Telefono / PC (browser)                                    PC di casa (Docker, /home/fonogramma)
┌───────────────────────────────────────────────┐          ┌─────────────────────────────────┐
│ jack → getUserMedia → filtri (IIRFilterNode)   │  HTTPS   │ caddy  :443  certificato locale │
│   → AudioWorklet → worker real-time            │ ───────► │   ├─ /        file della PWA    │
│        (STFT waterfall, min/max, buffer anello)│          │   └─ /api/*   → app (FastAPI)   │
│   → worker analisi (S1–S4, soffi, crepitii…)   │          │ app: SQLite + file WAV in data/ │
│ IndexedDB ⇄ sincronizzazione (PIN)             │          └─────────────────────────────────┘
└───────────────────────────────────────────────┘
```

- `web/` PWA senza dipendenze esterne (moduli ES): `js/dsp` algoritmi, `js/audio` motore,
  worklet, player, `js/workers` elaborazione in background, `js/views` schermate.
- `server/main.py` API di sincronizzazione (last-write-wins), audio, backup zip.
- `Caddyfile` HTTPS con CA interna (necessario per microfono e installazione PWA).

## Pubblicazione su GitHub Pages

Il workflow `.github/workflows/pages.yml` pubblica la cartella `web/` a ogni push su
`main` (in *Settings → Pages* la sorgente deve essere **GitHub Actions**). Non serve
alcuna compilazione: è HTML/JS/CSS puro.

## Server di casa (opzionale, sincronizzazione)

Da Git Bash su Windows (serve l'accesso SSH al PC con Docker, es. `utente@192.168.1.10`):

```bash
./deploy.sh utente@192.168.1.10
```

Lo script crea `/home/fonogramma`, copia i file e lancia `install.sh`, che:
- crea `.env` (IP, porte 80/443 o 8080/8443 se occupate, **PIN** casuale);
- avvia `docker compose` (container `app` e `caddy`), dati in `/home/fonogramma/data`;
- stampa indirizzo, link del certificato e PIN.

Aggiornare: rilanciare `./deploy.sh` (i dati e il PIN restano; i dispositivi ricevono la
nuova versione da soli).

### Primo accesso da ogni dispositivo
1. Apri `http://<ip-del-server>/ca.crt` e installa il certificato come **autorità (CA)**
   (istruzioni dettagliate in *Impostazioni → Certificato HTTPS*), oppure usa un nome
   Tailscale `*.ts.net`, che ha già un certificato valido.
2. Apri `https://<ip-del-server>/` → menu del browser → **Installa app**.
3. *Impostazioni → Server di casa*: inserisci il PIN mostrato dall'installazione.

## Sviluppo locale

```bash
python server/dev.py
```

Apre API + PWA su `http://localhost:8765` (dati in `.devdata/`, esclusa da git).
Per provare la modalità *solo dispositivo* basta servire la sola cartella `web/`,
ad esempio `python -m http.server -d web 8000`.
Nel browser senza fonendoscopio usa *Regolazioni → Sorgente → Simulatore*.

## Licenza

[MIT](LICENSE).
