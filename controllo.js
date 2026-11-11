const admin = require('firebase-admin');

const credenziali = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./chiave.json');

admin.initializeApp({
    credential: admin.credential.cert(credenziali)
});

const db = admin.firestore();

// Scarica una sola volta le ultime 4 letture (1 ora) per avere i dati di TUTTE le 265 stazioni senza "null"
async function scaricaTutteLeStazioniValide() {
    const quartoDora = 1000 * 60 * 15;
    const oraBase = Math.floor(Date.now() / quartoDora) * quartoDora;
    const mappaStazioni = {};

    // Guarda da adesso fino a 1 ora fa: appena trova un valore valido per una stazione, lo tiene
    for (let tentativo = 0; tentativo <= 4; tentativo++) {
        const tempoRichiesto = oraBase - (tentativo * quartoDora);
        const urlApi = `https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time?variabile=254,0,0/1,-,-,-/B13215&time=${tempoRichiesto}`;

        const risposta = await fetch(urlApi);
        const datiRegione = await risposta.json();
        const stazioni = datiRegione.slice(1);

        for (const s of stazioni) {
            if (!s.idstazione) continue;
            // Se non abbiamo ancora salvato questa stazione (o aveva value null), salviamo questo valore valido
            if (!mappaStazioni[s.idstazione] || mappaStazioni[s.idstazione].value === null) {
                mappaStazioni[s.idstazione] = s;
            }
        }
    }
    return Object.values(mappaStazioni);
}

async function controllaFiumi() {
    try {
        console.log("1. Scarico in automatico tutte le 265 stazioni e le loro soglie ufficiali...");
        const tutteLeStazioni = await scaricaTutteLeStazioniValide();
        console.log(`✅ Dati pronti per ${tutteLeStazioni.length} idrometri.`);

        // PARTE A: CONTROLLO AUTOMATICO SOGLIE REGIONE (Gialla, Arancione, Rossa) SU TUTTI I FIUMI
        console.log("\n2. Controllo automatico Soglie Ufficiali (Gialla/Arancione/Rossa) su tutta la Regione...");
        const statoDoc = await db.collection('sistema').doc('stato_fiumi').get();
        const livelliPrecedenti = statoDoc.exists ? statoDoc.data() : {};
        const nuoviLivelli = { ...livelliPrecedenti };

        for (const s of tutteLeStazioni) {
            if (s.value === null || s.value === undefined) continue;

            let gravitaAttuale = 0; // 0 = Normale, 1 = Gialla, 2 = Arancione, 3 = Rossa
            let nomeAllerta = "Normale";

            if (s.soglia3 > 0 && s.value >= s.soglia3) {
                gravitaAttuale = 3;
                nomeAllerta = `🔴 SOGLIA ROSSA (${s.soglia3}m)`;
            } else if (s.soglia2 > 0 && s.value >= s.soglia2) {
                gravitaAttuale = 2;
                nomeAllerta = `🟠 SOGLIA ARANCIONE (${s.soglia2}m)`;
            } else if (s.soglia1 > 0 && s.value >= s.soglia1) {
                gravitaAttuale = 1;
                nomeAllerta = `🟡 SOGLIA GIALLA (${s.soglia1}m)`;
            }

            const gravitaPrecedente = livelliPrecedenti[s.idstazione] || 0;

            // Se il fiume è salito di gravità (es. da Normale a Gialla, o da Gialla a Arancione)
            if (gravitaAttuale > gravitaPrecedente) {
                console.log(`🚨 ALLERTA AUTOMATICA! ${s.nomestaz}: livello ${s.value}m ha superato ${nomeAllerta}`);

                // Invia la notifica a tutti i telefoni iscritti alle allerte automatiche di questa stazione (o di tutta la regione)
                await admin.messaging().send({
                    topic: `stazione_${s.idstazione}`,
                    notification: {
                        title: `⚠️ ${nomeAllerta}: ${s.nomestaz}`,
                        body: `Il fiume ha raggiunto ${s.value} m.`
                    },
                    android: { priority: 'high', notification: { sound: 'default' } }
                });
            }
            nuoviLivelli[s.idstazione] = gravitaAttuale;
        }

        // Salva in automatico su Firebase la fotografia di tutti i 265 fiumi (senza che tu faccia nulla a mano!)
        await db.collection('sistema').doc('stato_fiumi').set(nuoviLivelli);
        console.log("✅ Stato automatico dei 265 fiumi salvato su Firebase!");

        // PARTE B: CONTROLLO SOGLIE PERSONALIZZATE DAGLI UTENTI NELL'APP
        console.log("\n3. Controllo eventuali soglie personalizzate scelte dagli utenti...");
        const listaAllarmi = await db.collection('allarmi').get();

        for (const documento of listaAllarmi.docs) {
            const allarme = documento.data();
            const cercato = String(allarme.stazione).trim().toLowerCase();

            const datiStazione = tutteLeStazioni.find(s =>
                (s.nomestaz && s.nomestaz.toLowerCase() === cercato) ||
                (s.idstazione && s.idstazione === cercato) ||
                (s.nomestaz && s.nomestaz.toLowerCase().includes(cercato))
            );

            if (!datiStazione || datiStazione.value === null) continue;

            if (datiStazione.value >= allarme.soglia && !allarme.allarme_inviato) {
                console.log(`🚨 SOGLIA UTENTE SUPERATA per ${datiStazione.nomestaz}: ${datiStazione.value}m >= ${allarme.soglia}m`);
                if (allarme.fcm_token) {
                    await admin.messaging().send({
                        token: allarme.fcm_token,
                        notification: {
                            title: `⚠️ Soglia Personale: ${datiStazione.nomestaz}`,
                            body: `Livello a ${datiStazione.value} m (Tua soglia: ${allarme.soglia} m)`
                        },
                        android: { priority: 'high', notification: { sound: 'default' } }
                    });
                }
                await documento.ref.update({ allarme_inviato: true });
            } else if (datiStazione.value < allarme.soglia && allarme.allarme_inviato) {
                await documento.ref.update({ allarme_inviato: false });
            }
        }

        console.log("\n🏁 Controllo completato su tutta la Regione!");
        process.exit(0);

    } catch (errore) {
        console.error("Errore:", errore);
        process.exit(1);
    }
}

controllaFiumi();