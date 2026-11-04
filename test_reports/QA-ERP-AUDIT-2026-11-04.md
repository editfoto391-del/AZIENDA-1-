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

## I. Continuazione audit — 4 novembre 2026

Questa sezione aggiorna i risultati precedenti. Nessuna modifica applicativa o ai test è stata effettuata.

### Isolamento e profili

- Per le scritture manuali è stato usato esclusivamente il MongoDB locale QA sulla porta `27018`, database `erp_audit_full_qa_20261104`. Le suite d'integrazione hanno usato il database QA separato `erp_audit_data_qa_20261104`. Non è stato usato il database locale sulla porta `27017`.
- L'RCA di deploy conferma che il Preview punta al database Atlas di produzione. In questa continuazione non è stato eseguito alcun login o POST business sul Preview; sono state evitate anche operazioni che avrebbero potuto aggiornare metadati di sessione/dispositivo. I login Preview descritti nelle sezioni precedenti appartengono alla verifica precedente e non dimostrano l'isolamento del database.
- Le credenziali fornite per i tre profili sono state provate una sola volta ciascuna contro il profilo locale corrispondente; tutte hanno restituito `401`. Nello snapshot QA gli hash delle password aziendali non corrispondono alle credenziali ricevute; l'identificativo owner precompilato non corrisponde a un utente presente. Non sono stati effettuati ulteriori tentativi. Un account owner QA separato ha consentito la verifica locale dell'interfaccia.

### Fattura, PDF, pagamenti e report

- Nell'interfaccia locale QA sono stati creati un cliente di prova e la fattura **43**: 2 unità × R85 = **R170**. Le richieste di creazione cliente, creazione fattura e lettura fattura hanno restituito HTTP 200. Il record persistito è `issued`, con saldo dovuto R170.
- È stato registrato un pagamento di prova di **R50** e poi stornato dall'interfaccia. La fattura è rimasta con R170 dovuti; il record di pagamento risulta stornato.
- La UI ha completato il download PDF. Il PDF di una pagina è stato controllato visivamente: numero fattura, cliente, quantità, prezzo unitario, totale e saldo corrispondono ai dati QA. Il PDF è composto da un'immagine raster e non contiene testo selezionabile.
- Il report giornaliero ha incluso la fattura per R170. Il totale fatturato mensile è passato da R2.472,50 a R2.642,50. Una lettura della funzione report sul database QA ha restituito la fattura 43 anche per la settimana 2–8 novembre e per il mese di novembre. La visualizzazione dei dettagli settimanali nella UI non è stata verificata nuovamente.
- Il precedente errore **Network Error** non è stato riprodotto nell'ambiente locale, quindi non è stato possibile attribuirne o correggerne la causa. Sul Preview è stato verificato soltanto il preflight CORS; non è stato inviato un POST per non scrivere sul database di produzione. L'errore originale resta aperto.

### Test automatici aggiuntivi

- Raccolta corrente: **384 test** (rispetto ai 383 riportati nella verifica precedente).
- Selezione backend isolata: **269 passed**, 5 warning.
- Cinque suite d'integrazione precedentemente escluse: **99 passed, 5 failed, 11 deselected**. Gli 11 casi che avrebbero contattato provider LLM reali sono stati esclusi per evitare chiamate a pagamento. Nessun test è stato indebolito o modificato.
- Le cinque asserzioni fallite confrontano lo snapshot QA corrente con baseline rigide: stock totale **5154 vs 5155**; Candy **9 vs 10**; clienti **268 vs 266**; totale dashboard fatturato **R2472,50 vs R0**; fatture di apertura **37 vs 26**. Le differenze sono coerenti con dati preesistenti e artefatti QA; non costituiscono una regressione applicativa confermata.
- Totale dei test backend effettivamente eseguiti nelle due selezioni: **368 passati, 5 falliti per mismatch di baseline**. Gli altri 11 casi sono stati deliberatamente esclusi.
- Frontend: **15 passed**. Build completata con il warning Vite preesistente sui chunk oltre 500 kB.

### Copertura rimasta e decisione

- Il flusso manuale UI di fattura, generazione PDF, pagamento e storno è verificato su QA. Le suite backend eseguite coprono inoltre report finanziari, tenancy/permessi e varie aree d'inventario, produzione, paghe e integrazione.
- Non sono stati completati flussi manuali UI con scritture per tutti e tre i profili, né i flussi completi di acquisto/GRV, intercompany, produzione, inventario, presenze e paghe. L'accesso ai due profili aziendali resta bloccato dal mismatch delle credenziali QA.
- L'Assistant non è stato esposto: rimane non raggiungibile dalla UI. Sono stati evitati i test che avrebbero effettuato chiamate reali a provider LLM.
- Nessun difetto applicativo confermato è stato modificato in questa continuazione. Stato conclusivo: **PARTIALLY VERIFIED**; Network Error Preview, test provider, accessi ai profili QA e flussi manuali residui sono blocker documentati, non risultati passati.

## J. Continuazione su staging isolato — 4 novembre 2026

Questa sezione documenta la successiva sessione pratica. Per gli elementi elencati qui, sostituisce le conclusioni precedenti della sezione I che indicavano l'impossibilità di usare account QA o di completare i flussi manuali. Le altre limitazioni della sezione I restano valide.

### Ambiente e account QA

- Prima delle scritture è stato verificato MongoDB su `127.0.0.1:27018`, replica set `qa-rs`, server `127.0.0.1:27018`; il database manuale usato è `erp_staging_qa_20261104`. Frontend e API hanno ascoltato esclusivamente su `127.0.0.1:3014` e `127.0.0.1:8014`. Le operazioni manuali di questa sezione hanno raggiunto l'API loopback; nessuna connessione Atlas o database live è stata usata. Non sono stati copiati dati reali.
- Il frontend è stato avviato in modalità QA con `.env.qa.local`; CORS del processo locale è stato limitato all'origine frontend loopback. Non sono state modificate configurazioni live. È possibile che il primo caricamento del precedente tentativo UI abbia effettuato una richiesta GET al Preview a causa della configurazione Vite; la destinazione di quella singola richiesta non è stata accertata. Non sono state inserite credenziali né inviate POST business in quel tentativo. In questa sessione le richieste osservate sono state verso `127.0.0.1:8014`.
- Sono disponibili account temporanei QA separati: **SUPERIQFOAM OWNER**, **IQFOAM MANUFACTURING** e **IQFOAM WHOLESALERS**. Login API e `/auth/me` sono stati verificati per tutti; i profili attivi corrispondevano agli account. L'Owner ha cambiato azienda sui tre profili; i due account aziendali non autorizzati a cambiare profilo hanno ricevuto `403`. Le credenziali temporanee sono conservate fuori dal repository e non sono riportate qui. Le credenziali originariamente fornite non sono state riutilizzate per questi nuovi account.
- Clienti sentinella QA e le scritture seguenti sono rimasti nei rispettivi tenant. I dati non sono stati letti o scritti sul Preview o sulla produzione. Nessuna cancellazione, migrazione distruttiva o seed aziendale è stata eseguita.

### Fattura, PDF e pagamenti

- Nell'interfaccia del tenant SUPERIQFOAM QA è stata emessa la fattura sintetica **01** per **R85**. Il PDF è stato generato e scaricato; il file verificato è un PDF valido di una pagina. Il precedente flusso separato della fattura 43 riportato nella sezione I appartiene a un altro snapshot QA.
- È stato registrato un pagamento parziale sintetico di **R25** con metodo **Cash**, senza selezionare un conto di incasso; la fattura è risultata con **R60** residui. La richiesta pagamento ha restituito HTTP 200.
- Lo storno tramite UI con causale sintetica ha restituito HTTP 200; il pagamento risulta stornato, l'importo pagato è tornato a zero e il residuo fattura a **R85**.
- La UI mostra opzioni statiche nel selettore dei conti d'incasso. Nessuna è stata selezionata o salvata; il flusso Cash non ne richiede una. I bonifici restano da verificare solo dopo aver configurato opzioni sintetiche dedicate.
- Il precedente **Network Error** non è stato riprodotto sulla configurazione locale QA corretta; non è stato possibile attribuirne o correggerne la causa sul Preview, che non è stato usato per scritture.

### Acquisti, fornitori, GRV e stock

- È stato aggiunto un fornitore sintetico e registrato un acquisto QA di **2** unità a **R5** ciascuna, totale **R10**; la richiesta `POST /api/buyings` ha restituito HTTP 200.
- È stato creato il GRV sintetico `GRV-2026-0001`, ispezionato e confermato. La UI ha mostrato `completed`; le richieste di creazione, ispezione e conferma hanno restituito HTTP 200.
- Il ledger del tenant SUPERIQFOAM QA contiene la movimentazione del GRV per **+2** unità dell'articolo `QA-SYNTHETIC-50`. La pagina Stock mostra **101** unità complessive per l'articolo QA, coerenti con il saldo precedente di 99 più la ricezione accettata.
- La generazione PDF del GRV, gli ordini d'acquisto e il completamento di altri casi di discrepanza/resi non sono stati verificati.

### Produzione, presenze e paghe

- È stato salvato dalla UI un record produzione sintetico per **1 blocco White** con nota QA; `POST /api/production/daily` ha restituito HTTP 200 e il riepilogo ha mostrato 1 blocco nel giorno/settimana/mese selezionati.
- È stato creato un dipendente sintetico QA e registrata una presenza per il 4 novembre 2026. `POST /api/employees` e `POST /api/attendance` hanno restituito HTTP 200; il riepilogo UI ha mostrato 1 presenza giornaliera, settimanale e mensile.
- La schermata paghe è stata aperta in sola lettura; non è stato salvato alcun importo o roster salariale. L'azione di visualizzazione paghe non ha prodotto un prospetto UI verificabile. Nessun record o regola salariale di Ayanda Tailor o Asive Tailor è stato modificato. I test automatici mirati di calcolo salariale e integrazione presenze sono riportati sotto.

### Intercompany e copertura residua

- La pagina Intercompany è stata caricata; sono disponibili i profili fornitore IQFOAM MANUFACTURING e IQFOAM WHOLESALERS. Il selettore prodotto non ha esposto articoli utilizzabili nello staging corrente, quindi non è stato inviato alcun ordine intercompany.
- I login e il cambio azienda sono stati verificati, ma non è stata completata una sessione UI completa con ciascun account aziendale. Non sono stati verificati tutti i permessi di ogni endpoint.
- Restano da completare: catalogo e flusso intercompany sintetici, acquisti d'ordine e casi GRV negativi/discrepanti, inventario/consumi di produzione, calcolo paghe UI, copertura manuale per tutti i profili, Assistant e restante copertura di pagine/controlli. I test LLM che contattano provider esterni restano esclusi.

### Test automatici e modifiche

- Eseguita selezione backend isolata di **80 test**: **80 passed**, 4 warning di deprecazione. Include GRV, tenancy/cambio profilo, paghe/salary math, piecework, roster, merge presenze-paghe, riepilogo presenze e report finanziari.
- Frontend: **15 passed**, 0 failed.
- Nessun sorgente applicativo, regola salariale o test è stato modificato. Nessun commit, push, deploy o publish è stato eseguito. Il report è stato aggiornato localmente; le altre modifiche preesistenti e i file locali non pertinenti non sono stati alterati.

**Stato complessivo:** **PARTIALLY VERIFIED**. Staging isolato e flussi sintetici di fattura/PDF/pagamento/storno, acquisto/GRV, produzione giornaliera e presenza sono verificati. Il Network Error sul Preview e i flussi indicati come residui restano aperti; non sono dichiarati superati.
