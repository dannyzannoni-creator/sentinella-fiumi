const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

// Scarica l'ultimissimo punto del grafico della singola stazione (tempo reale)
async function leggiUltimoValoreGrafico(idStazione) {
    const adesso = Date.now() + (1000 * 60 * 30);
    const inizio = Date.now() - (1000 * 60 * 60 * 6); // Ultime 6 ore
    const url = `https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-time-series?stazione=${encodeURIComponent(idStazione)}&variabile=254,0,0/1,-,-,-/B13215&timeStart=${inizio}&timeEnd=${adesso}&_=${Date.now()}`;

    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const dati = await res.json();
        if (!Array.isArray(dati) || dati.length === 0) return null;

        const validi = dati
            .map(p => ({
                t: Number(p.t ?? p.time ?? p.timestamp ?? p[0]),
                v: (p.v !== undefined ? p.v : (p.value !== undefined ? p.value : p[1]))
            }))
            .filter(p => Number.isFinite(p.t) && p.v !== null && p.v !== undefined && !isNaN(Number(p.v)))
            .map(p => ({ t: p.t, v: Number(p.v) }))
            .sort((a, b) => a.t - b.t);

        if (validi.length === 0) return null;
        return Number(validi[validi.length - 1].v.toFixed(2));
    } catch (e) {
        return null;
    }
}

async function inviaPushAndroid(tokens, titolo, messaggio) {
    const listaToken = Array.isArray(tokens) ? tokens.filter(Boolean) : [tokens].filter(Boolean);
    if (listaToken.length === 0) return;

    const payload = {
        notification: { title: titolo, body: messaggio },
        android: {
            priority: "high",
            notification: {
                channelId: "allerta_fiumi_high",
                sound: "default",
                priority: "high",
                defaultSound: true,
                defaultVibrateTimings: true
            }
        },
        tokens: [...new Set(listaToken)]
    };

    const resp = await admin.messaging().sendEachForMulticast(payload);
    console.log(`📨 Push inviata: ${resp.successCount} ricevute, ${resp.failureCount} fallite.`);
}

async function controllaFiumi() {
    console.log("🌊 1. Scarico anagrafica e soglie stazioni ARPAE...");
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
        console.error("Errore download anagrafica ARPAE:", e);
        return;
    }

    // Raccoglie tutti i token e tutte le stazioni da monitorare
    const dispositiviSnap = await db.collection("dispositivi").get();
    const mappaMonitoraggi = {}; // { idStazione: [token1, token2] }
    const tuttiTokenDispositivi = [];

    dispositiviSnap.forEach(d => {
        const token = d.id;
        tuttiTokenDispositivi.push(token);
        (d.data().monitorate || []).forEach(idStaz => {
            if (!mappaMonitoraggi[idStaz]) mappaMonitoraggi[idStaz] = [];
            mappaMonitoraggi[idStaz].push(token);
        });
    });

    const snapAllarmi = await db.collection("allarmi").get();

    // Costruisce la lista unica delle stazioni che ci interessano davvero per interrogarne il grafico in tempo reale
    const idDaAggiornareDalGrafico = new Set(Object.keys(mappaMonitoraggi));
    snapAllarmi.docs.forEach(d => {
        const al = d.data();
        if (al.idstazione) idDaAggiornareDalGrafico.add(String(al.idstazione));
        else {
            const trovata = Object.values(stazioni).find(s => (s.nomestaz || '').trim().toLowerCase() === (al.stazione || '').trim().toLowerCase());
            if (trovata) idDaAggiornareDalGrafico.add(String(trovata.idstazione));
        }
    });

    console.log(`⚡ 2. Aggiorno dal grafico in tempo reale ${idDaAggiornareDalGrafico.size} stazioni...`);
    const idsArray = Array.from(idDaAggiornareDalGrafico);
    for (let i = 0; i < idsArray.length; i += 10) {
        const lotto = idsArray.slice(i, i + 10);
        await Promise.all(lotto.map(async (idStaz) => {
            const valFresco = await leggiUltimoValoreGrafico(idStaz);
            if (valFresco !== null && stazioni[idStaz]) {
                stazioni[idStaz].value = valFresco;
            }
        }));
    }

    // 3. CONTROLLO SOGLIE PERSONALIZZATE (🔔)
    console.log("🔍 3. Controllo soglie personalizzate...");
    for (const d of snapAllarmi.docs) {
        const allarme = d.data();
        let staz = allarme.idstazione ? stazioni[allarme.idstazione] : null;
        if (!staz) {
            staz = Object.values(stazioni).find(s => (s.nomestaz || '').trim().toLowerCase() === (allarme.stazione || '').trim().toLowerCase());
        }
        if (!staz || staz.value === null) continue;

        const val = Number(staz.value);
        const soglia = Number(allarme.soglia);
        const tokenDest = allarme.fcm_token ? [allarme.fcm_token] : tuttiTokenDispositivi;

        if (!allarme.allarme_inviato && val >= soglia) {
            console.log(`🚨 SOGLIA CUSTOM SUPERATA: ${staz.nomestaz} (${val}m >= ${soglia}m)`);
            await inviaPushAndroid(
                tokenDest,
                `🔔 Allarme: ${staz.nomestaz}`,
                `Livello attuale: ${val} m (superata la tua soglia di ${soglia} m)`
            );
            await db.collection("allarmi").doc(d.id).update({ allarme_inviato: true });
        } else if (allarme.allarme_inviato && val < soglia) {
            // Auto-reset quando il fiume torna sotto la tua soglia
            await db.collection("allarmi").doc(d.id).update({ allarme_inviato: false });
        }
    }

    // 4. CONTROLLO SOGLIE UFFICIALI AUTOMATICHE (S1, S2, S3)
    console.log("🔍 4. Controllo soglie ufficiali S1/S2/S3...");
    const statiSnap = await db.collection("stati_stazioni").get();
    const statiSalvati = {};
    statiSnap.forEach(d => statiSalvati[d.id] = d.data().livello_allerta || 0);

    const batch = db.batch();

    for (const [idStaz, tokens] of Object.entries(mappaMonitoraggi)) {
        if (tokens.length === 0) continue;
        const staz = stazioni[idStaz];
        if (!staz || staz.value === null) continue;

        const val = Number(staz.value);
        const s1 = Number(staz.soglia1) || 0;
        const s2 = Number(staz.soglia2) || 0;
        const s3 = Number(staz.soglia3) || 0;

        let livelloAttuale = 0, nomeSoglia = "", icona = "";
        if (s3 > 0 && val >= s3) { livelloAttuale = 3; nomeSoglia = `Soglia 3 ROSSA (${s3}m)`; icona = "🔴"; }
        else if (s2 > 0 && val >= s2) { livelloAttuale = 2; nomeSoglia = `Soglia 2 ARANCIONE (${s2}m)`; icona = "🟠"; }
        else if (s1 > 0 && val >= s1) { livelloAttuale = 1; nomeSoglia = `Soglia 1 GIALLA (${s1}m)`; icona = "🟡"; }

        const livelloPrecedente = statiSalvati[idStaz] || 0;

        if (livelloAttuale > livelloPrecedente) {
            console.log(`⚠️ SOGLIA UFFICIALE SUPERATA: ${staz.nomestaz} -> ${nomeSoglia} (Attuale: ${val}m)`);
            await inviaPushAndroid(
                tokens,
                `${icona} ${staz.nomestaz}: ${nomeSoglia}`,
                `Il fiume ${staz.corso_acqua || ''} a ${staz.nomestaz} ha raggiunto ${val} m.`
            );
        }

        if (livelloAttuale !== livelloPrecedente) {
            batch.set(db.collection("stati_stazioni").doc(idStaz), {
                stazione: staz.nomestaz,
                livello_allerta: livelloAttuale,
                ultimo_valore: val,
                aggiornato_il: new Date().toISOString()
            }, { merge: true });
        }
    }

    await batch.commit();
    console.log("🏁 Controllo completato con successo.");
}

controllaFiumi();