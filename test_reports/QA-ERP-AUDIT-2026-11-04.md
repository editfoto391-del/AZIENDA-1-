# SUPER IQ-FOAM ERP — QA audit

**Data:** 4 novembre 2026  
**Esito:** **PARTIALLY VERIFIED**  
**Deploy/publish/commit:** non eseguiti.

## A. Inventario applicazione

- **28** componenti pagina in `frontend/src/pages/`.
- **34** dichiarazioni `<Route>` in `frontend/src/App.js` (incluso il fallback).
- **270** dichiarazioni di endpoint `@api.*` in `backend/server.py`.
- Il numero di controlli interattivi non è stato contato: cambia in base a ruolo e dati caricati.
- Le pagine non equivalgono a funzionalità verificate: i test browser indicati sotto sono smoke test di rendering/navigation, salvo diversa indicazione.

### Stato funzionale per pagina/modulo

| Area/pagina | Stato | Copertura pratica |
|---|---|---|
| Login e profili | PASS | Accesso ai tre profili; nomi azienda corretti. |
| Dashboard | PASS | Visualizzata per i tre profili; sola lettura. |
| Customers | PASS | Pagina caricata; operazioni di scrittura non eseguite. |
| Suppliers | PASS | Pagina caricata; sola lettura. |
| Client Payments | PASS | Pagina caricata; pagamenti non registrati. |
| Buyings | PASS | Pagina caricata; nessun acquisto creato. |
| Intercompany | PASS | Pagina caricata; nessuna richiesta creata. |
| Invoice List / Express Invoices | PASS | Pagine caricate; fatture e PDF non creati/generati. |
| Invoice Editor | NOT TESTED | Non è stata inviata o salvata una fattura. |
| Orders | PASS | Pagina caricata; nessun ordine modificato. |
| Finished Stock | PASS | Pagina caricata. Quantità manuale `-1` respinta dalla UI senza POST di movimento. |
| Production | PASS | Pagina caricata; nessuna produzione avviata. |
| Chemical Stock / Usage Log | PASS | Pagine caricate; nessun consumo o aggiornamento registrato. |
| Chemical Inventory | PASS | Pagina caricata; nessuna modifica. |
| Company Inventory | PASS | Pagina caricata; nessuna modifica. |
| Warehouses | BLOCKED | `/warehouses` ha riportato alla dashboard; magazzini A/B/C non testati. |
| Attendance | PASS | Pagina caricata; nessuna presenza registrata. |
| Fleet | PASS | Pagina caricata; nessun veicolo modificato. |
| Expenses | PASS | Pagina caricata; nessuna spesa registrata. |
| Costs | PASS | Pagina caricata; calcoli verificati soltanto nei test automatici. |
| GRV | PASS | Pagina caricata; nessun GRV creato/confermato. |
| Daily Report | PASS | Pagina caricata; nessun dato registrato. |
| Settings | PASS | Pagina caricata; impostazioni non modificate. |
| Workflow Builder | PASS | Pagina caricata come profilo owner; workflow non modificati/eseguiti. |
| Express Client Payments | PASS | Pagina caricata; nessun pagamento modificato. |
| Assistant | BLOCKED | Il componente esiste ma non è importato, instradato o raggiungibile dal menu. Vedere finding 1. |
| Auth Callback | NOT TESTED | Flusso Google non avviato. |
| Shared Invoice / Shared Warehouse Report | NOT TESTED | Richiedono link/token di condivisione non forniti. |

`PASS` sulle pagine sopra significa soltanto che la route ha renderizzato; non certifica ogni controllo, API, calcolo o documento della pagina.

## B. Profili e autenticazione pratica

| Profilo atteso | Esito |
|---|---|
| IQFOAM MANUFACTURING | Login riuscito; dashboard e nome profilo corrispondenti. |
| IQFOAM WHOLESALERS | Login riuscito; dashboard e nome profilo corrispondenti. |
| SUPERIQFOAM / owner | Login riuscito. L'interfaccia ha chiesto una scelta di benvenuto “BIG BOSS” prima della dashboard. |

Verificati inoltre: refresh con sessione ancora attiva, logout e reindirizzamento da `/stock` alla selezione workspace dopo logout. La navigazione ha mostrato le pagine e il contesto dei rispettivi workspace; **non** è stato tentato un accesso incrociato a record privati.

**Limite importante:** non è stato possibile confermare che il database del Preview sia isolato. Perciò non sono state create, modificate o eliminate fatture, pagamenti, clienti, stock, presenze o altri dati aziendali. L'autenticazione ha inevitabilmente inviato le richieste di login/sessione/dispositivo e logout; non sono state inviate richieste di scrittura business. Non è possibile affermare che il Preview non abbia aggiornato metadati di sessione/dispositivo.

## C. Test automatici e build

- Backend: **269 passed**, 5 warning di deprecazione.
- Backend raccolta totale: **383 test**.
- Frontend: **15 passed**, 0 failed.
- Build frontend: **completata**.
- Lint: `flake8` non installato nell'ambiente; `frontend/package.json` non definisce uno script lint.

Comandi eseguiti:

```text
cd backend && REACT_APP_BACKEND_URL=https://iqfoam-business.preview.emergentagent.com ../.venv/bin/python -m pytest --collect-only -q
→ 383 tests collected

cd backend && ../.venv/bin/python -m pytest -n 0 \
  --ignore=tests/test_google_auth_assistant.py \
  --ignore=tests/test_iqfoam_erp.py \
  --ignore=tests/test_iter2_customers_ob_assistant.py \
  --ignore=tests/test_iter3_auth_assistant_data_edit.py \
  --ignore=tests/test_phase_a_integrity.py
→ 269 passed, 5 warnings

cd frontend && yarn test
→ 15 passed, 0 failed

cd frontend && yarn build
→ build completata; avviso Vite per chunk minificati oltre 500 kB
```

Le cinque suite escluse contengono chiamate HTTP verso il Preview e/o pulizia diretta di database. Non sono state eseguite perché l'isolamento del database remoto non è dimostrato. Quindi **114 test non sono stati eseguiti**. I 269 test eseguiti coprono unità e integrazioni isolate/mocked, incluse tenancy, paghe, report finanziari, ricette di produzione e stock negativo fattura.

## D. Test pratici e integrità

- Smoke test di sola lettura su dashboard, clienti, fornitori, pagamenti, acquisti, intercompany, fatture express, ordini, stock, produzione, inventario chimico/aziendale, presenze, flotta, spese, costi, GRV, report giornaliero, impostazioni e workflow builder.
- Stock manuale: `-1` ha mostrato “Quantity cannot be negative”; il registro ha avuto solo una GET, nessuna POST a `/stock/.../movements`.
- Stock zero: coperto dal test backend isolato; non inviato al Preview per non creare una movimentazione remota.
- La suite isolata `test_invoice_negative_stock.py` verifica che la fattura senza conferma venga rifiutata in caso di carenza e che il percorso con conferma autorizzi il negativo.
- PDF, registrazione/reversal di pagamenti, creazione fatture, acquisti, spese, produzione reale e report alimentati da nuovi eventi **non** sono stati provati sul Preview.
- La console Preview ha mostrato warning React di nesting/hydration su `Intercompany` e `ChemicalInventory`: la traccia mostra uno `<span>` introdotto dal plugin Visual Edits dentro `<option>`. Non è stata riprodotta una regressione nel bundle di produzione.
- Non sono state effettuate misure di performance API o test di carico.

## E. Finding e questioni aperte

1. **Assistant non raggiungibile dalla UI** — `Assistant.jsx` e gli endpoint `/assistant/*` esistono, ma il componente non è registrato in `App.js` e non compare in `Layout.jsx`. Non modificato: esporre conversazioni basate sui dati aziendali e chiamate LLM richiede conferma di ruoli/visibilità e costi.
2. **Warning React in Preview/dev** — il plugin Visual Edits sembra iniettare wrapper `<span>` nei figli degli `<option>` su Intercompany e Chemical Inventory. Pagine renderizzate; causa esterna all'HTML JSX sorgente, non corretta né verificata su un browser del bundle di produzione.
3. **Chunk frontend grandi** — build segnala chunk sopra 500 kB; non bloccante, ma da valutare per caricamento/performance.
4. **Database Preview non verificato** — impedisce test end-to-end che scrivono dati e una verifica live conclusiva dell'isolamento multi-company.

## F. Sicurezza e autorizzazioni

- Login, persistenza dopo refresh, logout e redirect protetto verificati dal browser.
- Test isolati di tenancy e permessi inclusi nei 269 pass.
- Isolamento dei record tra aziende e enforcement di ogni singolo endpoint non certificati end-to-end sul Preview.
- Suite live di autenticazione/API escluse per il rischio di scritture o pulizia remota.
- Nessun test di penetrazione o exploit eseguito; questo audit non è una certificazione di sicurezza.

## G. Stato finale

**PARTIALLY VERIFIED.** Le pagine principali renderizzano, tutti e tre i login riescono e i test isolati eseguiti passano. Restano 114 test live non eseguiti, i flussi aziendali di scrittura/PDF non verificati, l'isolamento del database remoto non confermato e l'Assistant non accessibile dalla UI. **Non pronto per dichiarazione di verifica completa; nessun deploy autorizzato o effettuato.**

## H. Stato repository

Branch: `feature/multicompany-erp`. Il worktree era già sporco prima dell'audit; le modifiche preesistenti sono state lasciate intatte. Nessun commit, push, merge, deploy o modifica alla configurazione live è stato eseguito.
