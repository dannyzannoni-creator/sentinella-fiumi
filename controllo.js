const admin = require('firebase-admin');

// Se siamo su GitHub legge dalla cassaforte segreta, se siamo sul Mac legge il file chiave.json
const credenziali = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./chiave.json');

admin.initializeApp({
    credential: admin.credential.cert(credenziali)
});

const db = admin.firestore();

function trovaStazione(stazioni, cercato) {
    let s = stazioni.find(item =>
        (item.nomestaz && item.nomestaz.toLowerCase() === cercato) ||
        (item.idstazione && item.idstazione === cercato)
    );
    if (!s) {
        s = stazioni.find(item => item.nomestaz && item.nomestaz.toLowerCase().includes(cercato));
    }
    return s;
}

async function recuperaUltimoValoreValido(nomeCercato) {
    const quartoDora = 1000 * 60 * 15;
    const oraBase = Math.floor(Date.now() / quartoDora) * quartoDora;

    for (let tentativo = 0; tentativo <= 8; tentativo++) {
        const tempoRichiesto = oraBase - (tentativo * quartoDora);
        const urlApi = `https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time?variabile=254,0,0/1,-,-,-/B13215&time=${tempoRichiesto}`;

        const risposta = await fetch(urlApi);
        const datiRegione = await risposta.json();
        const stazioni = datiRegione.slice(1);

        const stazione = trovaStazione(stazioni, nomeCercato);

        if (!stazione) {
            return { errore: 'NON_TROVATA' };
        }

        if (stazione.value !== null && stazione.value !== undefined) {
            const minutiFa = tentativo * 15;
            return { stazione, minutiFa };
        }
    }

    return { errore: 'SEMPRE_NULL' };
}

async function controllaFiumi() {
    try {
        console.log("1. Controllo gli allarmi salvati nella Bacheca di Firebase...");
        const listaAllarmi = await db.collection('allarmi').get();

        for (const documento of listaAllarmi.docs) {
            const allarme = documento.data();
            const cercato = String(allarme.stazione).trim().toLowerCase();

            console.log(`🔍 Cerco l'ultimo valore trasmesso per "${allarme.stazione}"...`);
            const risultato = await recuperaUltimoValoreValido(cercato);

            if (risultato.errore === 'NON_TROVATA') {
                console.log(`⚠️ Stazione "${allarme.stazione}" non trovata nell'elenco della Regione.`);
                continue;
            }

            if (risultato.errore === 'SEMPRE_NULL') {
                console.log(`⏳ Il sensore di "${allarme.stazione}" non trasmette dati da oltre 2 ore.`);
                continue;
            }

            const datiStazione = risultato.stazione;
            const livelloAttuale = datiStazione.value;

            console.log(`✅ Trovato! Stazione: ${datiStazione.nomestaz} (ID: ${datiStazione.idstazione})`);
            console.log(`🌊 Livello: ${livelloAttuale} m (dato di circa ${risultato.minutiFa} min fa) | Tua soglia: ${allarme.soglia} m`);

            if (livelloAttuale >= allarme.soglia && !allarme.allarme_inviato) {
                console.log(`🚨 SUPERAMENTO SOGLIA! Invio notifica per ${datiStazione.nomestaz}...`);

                if (allarme.fcm_token) {
                    await admin.messaging().send({
                        token: allarme.fcm_token,
                        notification: {
                            title: `⚠️ Allerta Fiume: ${datiStazione.nomestaz}`,
                            body: `Il livello ha raggiunto ${livelloAttuale} m (Soglia impostata: ${allarme.soglia} m)`
                        },
                        android: {
                            priority: 'high',
                            notification: { sound: 'default' }
                        }
                    });
                    console.log(`📲 Notifica inviata al cellulare!`);
                } else {
                    console.log(`ℹ️ (Nessun telefono ancora collegato, ma aggiorno comunque la Bacheca su Firebase!)`);
                }

                await documento.ref.update({ allarme_inviato: true });
            }
            else if (livelloAttuale < allarme.soglia && allarme.allarme_inviato) {
                await documento.ref.update({ allarme_inviato: false });
                console.log(`📉 Il fiume è sceso sotto soglia: allarme riattivato per il futuro.`);
            } else {
                console.log(`✅ Tutto sotto controllo (o allarme già inviato).`);
            }
        }

        console.log("🏁 Controllo terminato, spengo la Sentinella.");
        process.exit(0); // <--- QUESTO SPEGNE SUBITO IL PALLINO GIALLO E METTE LA SPUNTA VERDE!

    } catch (errore) {
        console.error("Errore durante il controllo:", errore);
        process.exit(1);
    }
}

controllaFiumi();