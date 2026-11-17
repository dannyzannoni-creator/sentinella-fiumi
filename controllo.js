const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

// Funzione per i decimali (es. 7 -> "7,00")
const fmt = (n) => Number(n).toFixed(2).replace('.', ',');

// Funzione per formattare l'orario nel fuso italiano (GitHub lavora in UTC)
const formatOra = (ms) => {
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
};

// Piccola pausa per distribuire le richieste senza farsi bloccare da ARPAE
const pausa = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Scarica l'ultimissimo punto dal flusso del grafico ARPAE (restituisce valore e orario)
async function leggiUltimoValoreGrafico(idStazione) {
    const adesso = Date.now() + (1000 * 60 * 30);
    const inizio = Date.now() - (1000 * 60 * 60 * 6);
    const url = `https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-time-series?stazione=${encodeURIComponent(idStazione)}&variabile=254,0,0/1,-,-,-/B13215&timeStart=${inizio}&timeEnd=${adesso}&_=${Date.now()}`;

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

        const ultimo = validi[validi.length - 1];
        return { v: Number(ultimo.v.toFixed(2)), t: ultimo.t };
    } catch (e) {
        return null;
    }
}

// Invia notifica ad alta priorità con sirena per svegliare Android
async function inviaPushAndroid(tokens, titolo, messaggio) {
    const listaToken = Array.isArray(tokens) ? tokens.filter(Boolean) : [tokens].filter(Boolean);
    if (listaToken.length === 0) return;

    const payload = {
        notification: { title: titolo, body: messaggio },
        android: {
            priority: "high",
            notification: {
                channelId: "allarme_sirena_v1",
                sound: "sirena.mp3",
                priority: "high",
                defaultSound: false,
                defaultVibrateTimings: true
            }
        },
        tokens: [...new Set(listaToken)]
    };

    const resp = await admin.messaging().sendEachForMulticast(payload);
    console.log(`📨 Push inviata: ${resp.successCount} ricevute, ${resp.failureCount} fallite.`);
}

async function controllaFiumi() {
    console.log("🌊 1. Scarico anagrafica ARPAE...");
    const quarto = 1000 * 60 * 15;
    const oraBase = Math.floor(Date.now() / quarto) * quarto;
    const stazioni = {};

    try {
        for (let i = 0; i <= 2; i++) {
            const timestampQuarto = oraBase - (i * quarto);
            const res = await fetch(`https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time?variabile=254,0,0/1,-,-,-/B13215&time=${timestampQuarto}`);
            const data = await res.json();
            data.slice(1).forEach(s => {
                if (s.idstazione && (!stazioni[s.idstazione] || stazioni[s.idstazione].value === null)) {
                    stazioni[s.idstazione] = s;
                    stazioni[s.idstazione].timestamp_ms = timestampQuarto; // Salviamo l'orario base per sicurezza
                }
            });
        }
    } catch (e) {
        console.error("❌ Errore download anagrafica ARPAE:", e);
        return;
    }

    const [dispositiviSnap, snapAllarmi, statiSnap] = await Promise.all([
        db.collection("dispositivi").get(),
        db.collection("allarmi").get(),
        db.collection("stati_stazioni").get()
    ]);

    const mappaMonitoraggi = {};
    const mappaDeviceIdToToken = {};

    dispositiviSnap.forEach(d => {
        const token = d.id;
        const datiDisp = d.data();
        if (datiDisp.device_id) {
            mappaDeviceIdToToken[datiDisp.device_id] = token;
        }
        (datiDisp.monitorate || []).forEach(idStaz => {
            if (!mappaMonitoraggi[idStaz]) mappaMonitoraggi[idStaz] = [];
            mappaMonitoraggi[idStaz].push(token);
        });
    });

    const statiSalvati = {};
    statiSnap.forEach(d => statiSalvati[d.id] = d.data().livello_allerta || 0);

    const idDaAggiornareDalGrafico = new Set(Object.keys(mappaMonitoraggi));

    snapAllarmi.docs.forEach(d => {
        const al = d.data();
        if (al.idstazione) {
            idDaAggiornareDalGrafico.add(String(al.idstazione));
        } else {
            const trovata = Object.values(stazioni).find(s => (s.nomestaz || '').trim().toLowerCase() === (al.stazione || '').trim().toLowerCase());
            if (trovata) idDaAggiornareDalGrafico.add(String(trovata.idstazione));
        }
    });

    console.log(`⚡ 2. Aggiorno dal grafico in tempo reale tutte le ${idDaAggiornareDalGrafico.size} stazioni monitorate...`);
    const idsArray = Array.from(idDaAggiornareDalGrafico);

    for (let i = 0; i < idsArray.length; i += 5) {
        const lotto = idsArray.slice(i, i + 5);
        await Promise.all(lotto.map(async (idStaz) => {
            const fresco = await leggiUltimoValoreGrafico(idStaz);
            if (fresco !== null && stazioni[idStaz]) {
                stazioni[idStaz].value = fresco.v;
                stazioni[idStaz].timestamp_ms = fresco.t; // Sostituisce l'orario base con quello esatto al millisecondo del grafico
            }
        }));
        if (i + 5 < idsArray.length) await pausa(250);
    }

    console.log("🔔 3. Controllo soglie personalizzate (Campanelle singole per utente)...");
    for (const d of snapAllarmi.docs) {
        const allarme = d.data();
        let staz = allarme.idstazione ? stazioni[allarme.idstazione] : null;
        if (!staz) {
            staz = Object.values(stazioni).find(s => (s.nomestaz || '').trim().toLowerCase() === (allarme.stazione || '').trim().toLowerCase());
        }
        if (!staz || staz.value === null) continue;

        const val = Number(staz.value);
        const soglia = Number(allarme.soglia);
        const tokenProprietario = allarme.fcm_token || (allarme.device_id ? mappaDeviceIdToToken[allarme.device_id] : null);
        if (!tokenProprietario) continue;

        const stringaOrario = staz.timestamp_ms ? ` alle ${formatOra(staz.timestamp_ms)}` : '';

        if (!allarme.allarme_inviato && val >= soglia) {
            console.log(`🚨 SOGLIA CUSTOM SUPERATA: ${staz.nomestaz} (${val}m >= ${soglia}m)`);
            await inviaPushAndroid(
                [tokenProprietario],
                `🚨 Allarme Personalizzato: ${staz.nomestaz}`,
                `Livello attuale: ${fmt(val)} m${stringaOrario} (superata la tua soglia di ${fmt(soglia)} m)`
            );
            await db.collection("allarmi").doc(d.id).update({ allarme_inviato: true });
        } else if (allarme.allarme_inviato && val < soglia) {
            await db.collection("allarmi").doc(d.id).update({ allarme_inviato: false });
        }
    }

    console.log("🚦 4. Controllo soglie ufficiali S1/S2/S3...");
    const batch = db.batch();

    for (const [idStaz, tokens] of Object.entries(mappaMonitoraggi)) {
        if (tokens.length === 0) continue;
        const staz = stazioni[idStaz];
        if (!staz || staz.value === null) continue;

        const val = Number(staz.value);
        const s1 = Number(staz.soglia1) || 0;
        const s2 = Number(staz.soglia2) || 0;
        const s3 = Number(staz.soglia3) || 0;

        const stringaOrario = staz.timestamp_ms ? ` alle ${formatOra(staz.timestamp_ms)}` : '';

        let livelloAttuale = 0;
        if (s3 > 0 && val >= s3) livelloAttuale = 3;
        else if (s2 > 0 && val >= s2) livelloAttuale = 2;
        else if (s1 > 0 && val >= s1) livelloAttuale = 1;

        const livelloPrecedente = statiSalvati[idStaz] || 0;

        if (livelloAttuale > livelloPrecedente) {
            for (let liv = livelloPrecedente + 1; liv <= livelloAttuale; liv++) {
                let nomeSoglia = "", icona = "";
                if (liv === 1 && s1 > 0) { nomeSoglia = `Soglia 1 GIALLA`; icona = "🟡"; }
                else if (liv === 2 && s2 > 0) { nomeSoglia = `Soglia 2 ARANCIONE`; icona = "🟠"; }
                else if (liv === 3 && s3 > 0) { nomeSoglia = `Soglia 3 ROSSA`; icona = "🔴"; }

                if (nomeSoglia) {
                    console.log(`⚠️ SOGLIA UFFICIALE SUPERATA: ${staz.nomestaz} -> ${nomeSoglia} (Attuale: ${val}m)`);
                    await inviaPushAndroid(
                        tokens,
                        `${icona} ${staz.nomestaz}: ${nomeSoglia}`,
                        `Il fiume a ${staz.nomestaz} ha raggiunto ${fmt(val)} m${stringaOrario}.`
                    );
                }
            }
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
    console.log("✅ Controllo completato con successo.");
}

controllaFiumi();