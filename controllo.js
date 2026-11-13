const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

async function controllaFiumi() {
    console.log("🌊 Avvio controllo ARPAE...");

    const quarto = 1000 * 60 * 15;
    const oraBase = Math.floor(Date.now() / quarto) * quarto;
    const stazioni = {};

    try {
        for (let i = 0; i <= 2; i++) {
            const res = await fetch(`https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time?variabile=254,0,0/1,-,-,-/B13215&time=${oraBase - (i * quarto)}`);
            const data = await res.json();
            data.slice(1).forEach(s => {
                if (s.idstazione && (!stazioni[s.idstazione] || stazioni[s.idstazione].value === null)) {
                    stazioni[s.idstazione] = s;
                }
            });
        }
    } catch (e) {
        console.error("Errore download ARPAE:", e);
        return;
    }

    // 1. CONTROLLO SOGLIE PERSONALIZZATE DELL'UTENTE (MANTENUTO INALTERATO)
    console.log("🔍 Controllo soglie personalizzate...");
    const snapAllarmi = await db.collection("allarmi").where("allarme_inviato", "==", false).get();

    for (const d of snapAllarmi.docs) {
        const allarme = d.data();
        const staz = Object.values(stazioni).find(s => (s.nomestaz || '').replace(/'/g, "\\'") === allarme.stazione);

        if (staz && staz.value !== null && staz.value >= allarme.soglia && allarme.fcm_token) {
            console.log(`🚨 ALLARME CUSTOM SUPERATO: ${allarme.stazione} (${staz.value}m >= ${allarme.soglia}m)`);

            try {
                await admin.messaging().send({
                    notification: {
                        title: "🌊 Sentinella: Soglia Personalizzata!",
                        body: `Il fiume a ${allarme.stazione} ha raggiunto ${staz.value} m.`
                    },
                    token: allarme.fcm_token
                });
                await db.collection("allarmi").doc(d.id).update({ allarme_inviato: true });
            } catch (e) { console.error("Errore invio push custom:", e); }
        }
    }

    // 2. NUOVO CONTROLLO SOGLIE AUTOMATICHE (S1, S2, S3)
    console.log("🔍 Controllo soglie ufficiali per le stazioni monitorate...");
    const dispositiviSnap = await db.collection("dispositivi").get();
    const mappaMonitoraggi = {}; // Mappa { idStazione: [token1, token2] }

    dispositiviSnap.forEach(d => {
        const token = d.id;
        (d.data().monitorate || []).forEach(idStaz => {
            if (!mappaMonitoraggi[idStaz]) mappaMonitoraggi[idStaz] = [];
            mappaMonitoraggi[idStaz].push(token);
        });
    });

    // Legge lo stato precedente per non fare "spam"
    const statiSnap = await db.collection("stati_stazioni").get();
    const statiSalvati = {};
    statiSnap.forEach(d => statiSalvati[d.id] = d.data().livello_allerta || 0);

    const batch = db.batch(); // Salva tutti i nuovi stati assieme alla fine

    for (const [idStaz, tokens] of Object.entries(mappaMonitoraggi)) {
        if (tokens.length === 0) continue;
        const staz = stazioni[idStaz];
        if (!staz || staz.value === null) continue;

        const val = Number(staz.value);
        const s1 = Number(staz.soglia1) || 999;
        const s2 = Number(staz.soglia2) || 999;
        const s3 = Number(staz.soglia3) || 999;

        // Calcola in che fascia ci troviamo ora
        let livelloAttuale = 0, nomeSoglia = "", coloreIcona = "";
        if (staz.soglia3 > 0 && val >= s3) { livelloAttuale = 3; nomeSoglia = "Soglia 3 (Rossa)"; coloreIcona = "🔴"; }
        else if (staz.soglia2 > 0 && val >= s2) { livelloAttuale = 2; nomeSoglia = "Soglia 2 (Arancione)"; coloreIcona = "🟠"; }
        else if (staz.soglia1 > 0 && val >= s1) { livelloAttuale = 1; nomeSoglia = "Soglia 1 (Gialla)"; coloreIcona = "🟡"; }

        const livelloPrecedente = statiSalvati[idStaz] || 0;

        // Se l'acqua è salita di livello (es. da Verde a Giallo, o da Giallo ad Arancione)
        if (livelloAttuale > livelloPrecedente) {
            console.log(`⚠️ SUPERAMENTO: ${staz.nomestaz} -> ${nomeSoglia} (${val}m)`);

            try {
                await admin.messaging().sendEachForMulticast({
                    notification: {
                        title: `${coloreIcona} Allerta Ufficiale: ${staz.nomestaz}`,
                        body: `Il livello ha raggiunto ${val} m, superando la ${nomeSoglia}!`
                    },
                    tokens: tokens
                });
                console.log(`✅ Push ufficiale inviata.`);
            } catch (e) { console.error("Errore invio push ufficiale:", e); }
        }

        // Memorizza il nuovo stato (sia che salga, sia che scenda) per le prossime letture
        if (livelloAttuale !== livelloPrecedente) {
            const docRef = db.collection("stati_stazioni").doc(idStaz);
            batch.set(docRef, { livello_allerta: livelloAttuale }, { merge: true });
        }
    }

    await batch.commit();
    console.log("🏁 Controllo completato.");
}

controllaFiumi();