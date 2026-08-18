# Gruppo Endine Sviluppo — Conto economico di progetto

Dashboard finanziaria per i progetti immobiliari, con dati salvati su un
database condiviso (Supabase) invece che nel browser: tu e Maurizio vedete
sempre gli stessi dati aggiornati, da qualunque dispositivo.

## 1. Crea il database su Supabase

1. Vai su [supabase.com](https://supabase.com) e accedi (puoi usare l'account GitHub).
2. Crea un nuovo progetto (scegli una password per il database e salvala).
3. Una volta creato, vai su **SQL Editor > New query**, incolla il contenuto
   del file `supabase-setup.sql` (incluso in questa cartella) e premi **Run**.
   Questo crea la tabella dove verranno salvati i dati dei progetti.
4. Vai su **Project Settings > API**. Ti servono due valori:
   - **Project URL**
   - **anon public key**

## 2. Configura le variabili d'ambiente

1. Copia il file `.env.example` e rinominalo in `.env`.
2. Incolla i due valori presi da Supabase:
   ```
   VITE_SUPABASE_URL=https://il-tuo-progetto.supabase.co
   VITE_SUPABASE_ANON_KEY=la-tua-anon-key
   ```

## 3. Carica il codice su GitHub

1. Vai su [github.com](https://github.com) e crea un nuovo repository
   (es. "gruppo-endine-dashboard"), privato o pubblico come preferisci.
2. Carica tutti i file di questa cartella nel repository. Il modo più
   semplice: sulla pagina del repository appena creato, clicca su
   "uploading an existing file" e trascina tutti i file (tranne
   node_modules e dist, che non esistono ancora comunque).
   **Non caricare il file `.env`** (contiene le chiavi private) — è già
   escluso automaticamente dal file `.gitignore`.

## 4. Pubblica su Vercel

1. Vai su [vercel.com](https://vercel.com) e accedi con l'account GitHub.
2. Clicca "Add New… > Project" e seleziona il repository appena creato.
3. Prima di premere "Deploy", apri la sezione **Environment Variables** e
   aggiungi le stesse due variabili che hai messo nel file `.env`:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Premi **Deploy**. Dopo circa un minuto avrai un link fisso (tipo
   `gruppo-endine-dashboard.vercel.app`) da condividere con Maurizio.

## Come funzionano gli aggiornamenti da qui in poi

- **Dati** (costi, unità, capitale inseriti nella dashboard): sono salvati
  su Supabase, sempre sincronizzati per entrambi, ovunque.
- **Codice** (nuove funzionalità o correzioni che ti preparo in chat): ogni
  volta che ti do un file aggiornato, basta caricarlo su GitHub (sostituendo
  il vecchio) — Vercel rileva la modifica e ripubblica automaticamente sullo
  stesso link, senza bisogno di fare nulla su Vercel stesso.

## Sviluppo in locale (opzionale)

```bash
npm install
npm run dev
```
