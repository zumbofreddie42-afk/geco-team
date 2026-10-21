# Geco Team · Area riservata

App per Geco Corporate: due amministratori (Giorgio e Fortunato) assegnano progetti, attività e memo al team, e decidono chi vede ogni progetto. Il team aggiorna la percentuale delle proprie attività e riceve le notifiche sul telefono.

- **Dati e accessi:** Supabase (le regole su chi vede cosa sono nel database, `supabase/schema.sql`).
- **Pubblicazione:** Vercel, con le funzioni in `api/` per gli account, le notifiche e i promemoria del mattino.
- **Notifiche:** sul telefono (l'app si installa dalla schermata Home); se non è installata, arriva un'email (Resend, facoltativo).
- **Modalità prova:** senza le impostazioni di Supabase l'app funziona solo nel browser, con le 8 persone e nessun progetto. Serve per provarla.

## Attivazione (una volta sola, circa 30 minuti)

### 1. Supabase (database e accessi)
1. Vai su [supabase.com](https://supabase.com), crea un account e poi un **New project** (nome `geco-team`, regione **Frankfurt** per avere i dati in Europa, salva la password del database).
2. Apri **SQL Editor → New query**, incolla tutto il file `supabase/schema.sql` e premi **Run**. Deve dire "Success".
3. **Authentication → Sign In / Providers → Email**: lascia attivo l'accesso con email e **disattiva "Allow new users to sign up"** (gli account li creano solo gli amministratori).
4. **Project Settings → API**: copia *Project URL*, la chiave *anon public* e la chiave *service_role* (questa è segreta).

### 2. I due amministratori
1. **Authentication → Users → Add user → Create new user**: crea Giorgio con la sua email e una password provvisoria, spunta **Auto Confirm User**. Ripeti per Fortunato.
2. Nello **SQL Editor** esegui (cambia le due email):
   ```sql
   insert into public.profiles (id, name, email, role, color)
   select id, 'Giorgio', email, 'admin', '#0b1f3f' from auth.users where email = 'EMAIL-DI-GIORGIO';
   insert into public.profiles (id, name, email, role, color)
   select id, 'Fortunato', email, 'admin', '#1d3a6b' from auth.users where email = 'EMAIL-DI-FORTUNATO';
   ```
Le altre sei persone le aggiungono poi gli amministratori dall'app (**Persone → Aggiungi persona**).

### 3. GitHub e Vercel
1. Su GitHub crea un repository vuoto chiamato `geco-team` (privato) e collegalo a questa cartella:
   `git remote add origin https://github.com/TUO-UTENTE/geco-team.git` e poi `git push -u origin main`.
2. Su [vercel.com](https://vercel.com): **Add New → Project → Import** del repository `geco-team`.
3. Prima di premere Deploy apri **Environment Variables** e inserisci i valori di `.env.example`:
   - da Supabase: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`;
   - dal file `.env.local` di questa cartella (già generato): `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`;
   - `APP_URL` = l'indirizzo che Vercel darà all'app (lo puoi correggere dopo il primo deploy).
4. **Deploy.** Da qui in poi ogni push su `main` pubblica da solo.
5. I promemoria del mattino partono da soli ogni giorno alle 7–8 (Vercel Cron, `vercel.json`).

### 4. Email di riserva (facoltativo)
Per mandare le email serve un dominio verificato su [resend.com](https://resend.com): aggiungi `gecocorporate.com` in **Domains** e inserisci i record DNS che indica (va fatto da chi gestisce il dominio). Poi crea una **API Key** e imposta su Vercel `RESEND_API_KEY` e `EMAIL_FROM` (es. `Geco Team <team@gecocorporate.com>`). Senza questi valori le notifiche arrivano solo sul telefono.

### 5. Sul telefono di ognuno
1. Apri l'indirizzo dell'app ed entra con email e password.
2. **iPhone:** Condividi → **Aggiungi alla schermata Home**, poi apri l'app dall'icona. **Android:** menu ⋮ → **Installa app**.
3. Tocca **Attiva** nel riquadro "Attiva le notifiche" e conferma.

## Per lo sviluppo
- `npm install`, poi `npm run dev` (modalità prova su http://localhost:5174).
- `npm run check` = test (logica, regole del database in un Postgres di prova, funzioni server) + build. Deve essere verde prima di ogni commit.
- Per collegare Supabase in locale crea `.env.local` con `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
