/* ============================================================
   WatchVault — Serveur Node.js
   Port : 3000
   Routes : POST /subscribe · GET /confirm/:token
            GET /download/:token · GET /guide · GET /
============================================================ */

const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const { createObjectCsvWriter } = require('csv-writer');
const csvParser  = require('csv-parser');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const puppeteer  = require('puppeteer');

const app  = express();
const PORT = 3000;

/* ── Chemins ── */
const CSV_PATH = path.join(__dirname, 'subscribers.csv');
const PDF_PATH = path.join(__dirname, 'guide.pdf');
const BASE_URL = process.env.BASE_URL || 'https://watchvault-production.up.railway.app';

/* ── Tokens en mémoire (TTL 24 h) ── */
const confirmTokens  = new Map(); /* token → { expires, email, firstName, lastName, interest } */
const downloadTokens = new Map(); /* token → { expires, email } */

/* ── Configuration Gmail ── */
const GMAIL_USER = process.env.GMAIL_USER || 'elian.lemeur@bright.swiss';
const GMAIL_PASS = process.env.GMAIL_PASS || 'ohrc xomc jtrb aeop';

/* ============================================================
   MIDDLEWARE
============================================================ */
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* Assets statiques pour index.html servi via le serveur */
app.use('/photo', express.static(path.join(__dirname, 'photo')));
app.use('/video',  express.static(path.join(__dirname, 'video')));

/* Sert guide.html via HTTP pour que Puppeteer charge les polices */
app.get('/guide', (req, res) => res.sendFile(path.join(__dirname, 'guide.html')));

/* Sert index.html depuis la racine (cible de la redirection post-confirmation) */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ============================================================
   PDF — Génération avec Puppeteer
============================================================ */
async function generatePdf() {
    console.log('── PDF ───────────────────────────────────');
    console.log('  Lancement Puppeteer...');
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}/guide`, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.pdf({
            path: PDF_PATH,
            format: 'A4',
            printBackground: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 }
        });
        console.log('  ✓ PDF généré →', PDF_PATH);
    } catch (err) {
        console.error('  ✗ Génération PDF échouée :', err.message);
    } finally {
        if (browser) await browser.close();
    }
    console.log('──────────────────────────────────────────');
}

/* ============================================================
   TOKENS — Création
============================================================ */
function createConfirmToken(data) {
    const token   = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    confirmTokens.set(token, { expires, ...data });
    return token;
}

function createDownloadToken(email) {
    const token   = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    downloadTokens.set(token, { expires, email });
    return token;
}

/* ============================================================
   CSV — Initialisation, écriture, mise à jour
============================================================ */
function ensureCsvExists() {
    if (!fs.existsSync(CSV_PATH)) {
        fs.writeFileSync(CSV_PATH, 'Date,Prénom,Nom,Email,Intérêt,Statut\n', 'utf8');
        console.log('subscribers.csv créé.');
        return;
    }
    /* Migration : ajouter la colonne Statut si absente */
    const content = fs.readFileSync(CSV_PATH, 'utf8');
    const header  = content.split('\n')[0] || '';
    if (!header.includes('Statut')) {
        const migrated = content.split('\n').map((line, i) => {
            if (!line.trim()) return line;
            return i === 0 ? line + ',Statut' : line + ',"confirmed"';
        });
        fs.writeFileSync(CSV_PATH, migrated.join('\n'), 'utf8');
        console.log('  ✓ CSV migré — colonne Statut ajoutée (entrées existantes → confirmed)');
    }
}

function isDuplicateEmail(email) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(CSV_PATH)) return resolve(false);
        let found = false;
        fs.createReadStream(CSV_PATH)
            .pipe(csvParser())
            .on('data', row => {
                const rowEmail = (row['Email'] || '').trim().toLowerCase();
                if (rowEmail === email.trim().toLowerCase()) found = true;
            })
            .on('end',   () => resolve(found))
            .on('error', err => reject(err));
    });
}

function appendToCsv(record, retries = 5, delayMs = 500) {
    const line = [
        record.date, record.firstName, record.lastName,
        record.email, record.interest, record.statut
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';

    return new Promise((resolve, reject) => {
        const attempt = (remaining) => {
            fs.appendFile(CSV_PATH, line, 'utf8', err => {
                if (!err) return resolve();
                if (err.code === 'EBUSY' && remaining > 0) {
                    console.warn(`  ⚠ CSV verrouillé, retry dans ${delayMs}ms (${remaining} restantes)`);
                    setTimeout(() => attempt(remaining - 1), delayMs);
                } else { reject(err); }
            });
        };
        attempt(retries);
    });
}

function updateCsvStatus(email, newStatus) {
    if (!fs.existsSync(CSV_PATH)) return;
    const emailLower  = email.toLowerCase();
    const emailQuoted = `"${emailLower}"`;
    const lines       = fs.readFileSync(CSV_PATH, 'utf8').split('\n');
    let updated       = false;

    const newLines = lines.map((line, i) => {
        if (i === 0 || !line.trim() || !line.includes(emailQuoted)) return line;
        updated    = true;
        const parts = line.split(',');
        if (parts.length > 5) parts[5] = `"${newStatus}"`;
        else { while (parts.length < 5) parts.push('""'); parts.push(`"${newStatus}"`); }
        return parts.join(',');
    });

    if (updated) {
        fs.writeFileSync(CSV_PATH, newLines.join('\n'), 'utf8');
        console.log(`  ✓ CSV statut : ${email} → ${newStatus}`);
    }
}

/* ============================================================
   NODEMAILER — Transporter + retry avec backoff exponentiel
============================================================ */
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

async function sendWithRetry(mailOptions, maxRetries = 2) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            console.log(`  → sendMail tentative ${attempt}/${maxRetries + 1} vers : ${mailOptions.to}`);
            const info = await transporter.sendMail(mailOptions);
            console.log(`  ✓ sendMail OK — messageId : ${info.messageId}`);
            console.log(`  ✓ Réponse SMTP             : ${info.response}`);
            return info;
        } catch (err) {
            lastErr = err;
            console.error(`  ✗ sendMail tentative ${attempt} échouée`);
            console.error(`    message      : ${err.message}`);
            console.error(`    code         : ${err.code}`);
            console.error(`    responseCode : ${err.responseCode}`);
            console.error(`    response     : ${err.response}`);
            console.error(`    stack        :\n${err.stack}`);
            if (attempt <= maxRetries) {
                const delay = 2000 * attempt;
                console.log(`  ↻ Retry dans ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

/* ── Email #1 : demande de confirmation double opt-in ── */
async function sendConfirmationRequestEmail(firstName, email, confirmUrl) {
    console.log('── Email #1 — demande confirmation ──────');
    console.log('  GMAIL_USER :', GMAIL_USER);
    console.log('  GMAIL_PASS : ' + (GMAIL_PASS ? `[défini, ${GMAIL_PASS.length} car.]` : '[ABSENT]'));
    console.log('  À          :', email);
    console.log('  Lien       :', confirmUrl);
    console.log('  Vérification SMTP...');
    try {
        await transporter.verify();
        console.log('  ✓ SMTP verify OK — connexion établie');
    } catch (err) {
        console.error('  ✗ SMTP verify ÉCHOUÉ');
        console.error('    message      :', err.message);
        console.error('    code         :', err.code);
        console.error('    responseCode :', err.responseCode);
        console.error('    response     :', err.response);
        console.error('    stack        :\n' + err.stack);
        throw err;
    }
    console.log('  Construction du mail...');

    const info = await sendWithRetry({
        from:    `"WatchVault" <${GMAIL_USER}>`,
        to:      email,
        subject: 'WatchVault — Confirmez votre inscription',
        html: `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F2EDE4;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#FAFAF5;max-width:600px;width:100%;">
        <tr>
          <td style="padding:36px 40px 24px;border-bottom:1px solid rgba(74,127,212,.25);">
            <span style="font-family:Georgia,serif;font-size:22px;color:#0D0D0D;letter-spacing:.12em;">
              Watch<span style="color:#4A7FD4;">VAULT</span>
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 20px;">
            <p style="font-family:Georgia,serif;font-size:26px;font-weight:300;color:#0D0D0D;margin:0 0 20px;">
              Bonjour ${firstName},
            </p>
            <p style="font-family:Arial,sans-serif;font-size:15px;color:#555;line-height:1.75;margin:0 0 24px;">
              Merci de votre intérêt pour WatchVault. Pour finaliser votre inscription
              et recevoir votre guide exclusif <em>L'Art d'Investir dans les Montres de Prestige</em>,
              confirmez votre adresse email en cliquant ci-dessous.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td>
                  <a href="${confirmUrl}"
                     style="display:inline-block;background:#4A7FD4;color:#ffffff;
                            font-family:Arial,sans-serif;font-size:12px;font-weight:500;
                            letter-spacing:.12em;text-transform:uppercase;
                            padding:16px 32px;text-decoration:none;">
                    Confirmer mon inscription →
                  </a>
                </td>
              </tr>
            </table>
            <p style="font-family:Arial,sans-serif;font-size:11.5px;color:#aaa;margin:0 0 6px;">
              Ou copiez ce lien dans votre navigateur :
            </p>
            <p style="font-family:monospace;font-size:10.5px;color:#4A7FD4;margin:0 0 24px;word-break:break-all;">
              ${confirmUrl}
            </p>
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border-left:3px solid rgba(74,127,212,.3);background:rgba(74,127,212,.04);margin:0 0 20px;">
              <tr>
                <td style="padding:12px 16px;">
                  <span style="font-family:Arial,sans-serif;font-size:11px;color:#888;">
                    ⏱ Ce lien est valable <strong>24 heures</strong>.
                    Après confirmation, vous recevrez votre guide PDF exclusif.
                  </span>
                </td>
              </tr>
            </table>
            <p style="font-family:Arial,sans-serif;font-size:13px;color:#888;line-height:1.7;margin:0;">
              Si vous n'avez pas rempli ce formulaire, ignorez simplement cet email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(74,127,212,.2);">
            <p style="font-family:Arial,sans-serif;font-size:11px;color:#AAAAAA;margin:0;">
              © 2024 WatchVault · Tous droits réservés
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`
    });
    console.log('  ✓ messageId :', info.messageId);
    console.log('──────────────────────────────────────────');
}

/* ── Email #2 : confirmation réussie + lien PDF ── */
async function sendConfirmedEmail(firstName, email, interest, downloadUrl) {
    console.log('── Email #2 — confirmed + PDF ───────────');
    console.log('  À       :', email);
    console.log('  PDF URL :', downloadUrl);

    const interestLabels = {
        acheter:  'Acheter une montre',
        vendre:   'Vendre une montre',
        investir: 'Investir dans l\'horlogerie',
        explorer: 'Explorer la collection'
    };
    const interestLabel = interestLabels[interest] || interest || 'Explorer la collection';

    const info = await sendWithRetry({
        from:    `"WatchVault" <${GMAIL_USER}>`,
        to:      email,
        subject: 'WatchVault — Inscription confirmée & votre guide PDF vous attend',
        html: `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F2EDE4;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#FAFAF5;max-width:600px;width:100%;">
        <tr>
          <td style="padding:36px 40px 24px;border-bottom:1px solid rgba(74,127,212,.25);">
            <span style="font-family:Georgia,serif;font-size:22px;color:#0D0D0D;letter-spacing:.12em;">
              Watch<span style="color:#4A7FD4;">VAULT</span>
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 20px;">
            <p style="font-family:Georgia,serif;font-size:26px;font-weight:300;color:#0D0D0D;margin:0 0 20px;">
              Bienvenue, ${firstName} !
            </p>
            <p style="font-family:Arial,sans-serif;font-size:15px;color:#555;line-height:1.75;margin:0 0 16px;">
              Votre inscription à WatchVault est maintenant confirmée.
              Vous recevrez en avant-première nos nouvelles acquisitions,
              alertes de prix et invitations à nos ventes privées exclusives.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="margin:24px 0;border-left:3px solid #4A7FD4;background:rgba(74,127,212,.05);">
              <tr>
                <td style="padding:14px 20px;">
                  <span style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#4A7FD4;">
                    Votre intérêt
                  </span><br>
                  <span style="font-family:Georgia,serif;font-size:16px;color:#0D0D0D;">${interestLabel}</span>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="margin:0 0 28px;border:1px solid rgba(74,127,212,.2);background:#fff;">
              <tr>
                <td style="padding:22px 26px;">
                  <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#4A7FD4;margin:0 0 8px;">
                    Guide Exclusif WatchVault
                  </p>
                  <p style="font-family:Georgia,serif;font-size:17px;color:#0D0D0D;margin:0 0 6px;">
                    L'Art d'Investir dans les Montres de Prestige
                  </p>
                  <p style="font-family:Arial,sans-serif;font-size:12px;color:#555;margin:0 0 18px;line-height:1.6;">
                    7 pages · 5 manufactures · tableau des prix · critères d'authenticité
                  </p>
                  <a href="${downloadUrl}"
                     style="display:inline-block;background:#4A7FD4;color:#ffffff;
                            font-family:Arial,sans-serif;font-size:11px;font-weight:500;
                            letter-spacing:.12em;text-transform:uppercase;
                            padding:13px 26px;text-decoration:none;">
                    Télécharger le guide PDF →
                  </a>
                  <p style="font-family:Arial,sans-serif;font-size:10.5px;color:#aaa;margin:10px 0 0;">
                    ⏱ Lien valable 24 heures
                  </p>
                </td>
              </tr>
            </table>
            <p style="font-family:Arial,sans-serif;font-size:13px;color:#888;line-height:1.7;margin:0;">
              Pour toute question :
              <a href="mailto:experts@watchvault.com" style="color:#4A7FD4;text-decoration:none;">
                experts@watchvault.com
              </a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(74,127,212,.2);">
            <p style="font-family:Arial,sans-serif;font-size:11px;color:#AAAAAA;margin:0;">
              © 2024 WatchVault · Tous droits réservés
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`
    });
    console.log('  ✓ messageId :', info.messageId);
    console.log('──────────────────────────────────────────');
}

/* ============================================================
   ROUTE POST /subscribe
============================================================ */
app.post('/subscribe', async (req, res) => {
    console.log('\n════════════════════════════════════════');
    console.log('► POST /subscribe reçu');
    console.log('  Body brut :', JSON.stringify(req.body));

    const firstName = (req.body.firstName || req.body.firstname || '').trim();
    const lastName  = (req.body.lastName  || req.body.lastname  || '').trim();
    const email     = (req.body.email     || '').trim();
    const interest  = (req.body.interest  || req.body.intent    || 'explorer').trim();

    console.log('  Champs extraits →', { firstName, lastName, email, interest });

    if (!firstName || !lastName || !email) {
        return res.status(400).json({
            success: false,
            message: 'Les champs Prénom, Nom et Email sont obligatoires.'
        });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }
    console.log('  ✓ Validation OK');

    let duplicate;
    try {
        duplicate = await isDuplicateEmail(email);
    } catch (err) {
        console.error('  ✗ Erreur lecture CSV :', err.message);
        return res.status(500).json({ success: false, message: 'Erreur lecture CSV.' });
    }

    if (duplicate) {
        console.warn('  ✗ [409] Email déjà inscrit :', email);
        return res.status(409).json({
            success: false,
            message: 'Cette adresse email est déjà inscrite.'
        });
    }

    /* ── Sauvegarde CSV avec statut "pending" ── */
    try {
        const date = new Date().toISOString().slice(0, 10);
        await appendToCsv({
            date, firstName, lastName,
            email: email.toLowerCase(), interest, statut: 'pending'
        });
        console.log('  ✓ CSV écrit — statut : pending');
    } catch (err) {
        console.error('  ✗ Erreur écriture CSV :', err.message);
        return res.status(500).json({ success: false, message: 'Erreur écriture CSV.' });
    }

    /* ── Token + email de confirmation ── */
    const confirmToken = createConfirmToken({
        email: email.toLowerCase(), firstName, lastName, interest
    });
    const confirmUrl = `${BASE_URL}/confirm/${confirmToken}`;
    console.log('  ✓ Token de confirmation créé');

    console.log('  → Appel sendConfirmationRequestEmail...');
    try {
        if (GMAIL_USER && GMAIL_PASS) {
            await sendConfirmationRequestEmail(firstName, email, confirmUrl);
            console.log('  ✓ sendConfirmationRequestEmail terminé sans erreur');
        } else {
            console.warn('  ⚠ Email ignoré : GMAIL_USER ou GMAIL_PASS absent');
        }
    } catch (err) {
        console.error('  ✗ Échec total envoi email #1');
        console.error('    message :', err.message);
        console.error('    code    :', err.code);
        console.error('    stack   :\n' + err.stack);
        /* L'entrée est déjà dans le CSV — on ne bloque pas la réponse */
    }

    console.log('  ✓ [200] En attente de confirmation');
    console.log('════════════════════════════════════════\n');
    return res.status(200).json({
        success: true,
        pending: true,
        message: 'Vérifiez votre email pour confirmer votre inscription.'
    });
});

/* ============================================================
   ROUTE GET /confirm/:token
============================================================ */
app.get('/confirm/:token', async (req, res) => {
    console.log('\n════════════════════════════════════════');
    console.log('► GET /confirm/', req.params.token);

    const entry = confirmTokens.get(req.params.token);

    if (!entry) {
        console.warn('  ✗ Token inconnu');
        return res.status(404).send(`
            <html><head><meta charset="UTF-8"></head>
            <body style="font-family:Arial,sans-serif;text-align:center;padding:80px 20px;background:#FAFAF5;">
              <p style="font-size:2rem;color:#4A7FD4;margin-bottom:16px;">Watch<strong>VAULT</strong></p>
              <h2 style="color:#C62828;margin-bottom:12px;">Lien invalide</h2>
              <p style="color:#555;">Ce lien de confirmation n'existe pas ou a déjà été utilisé.</p>
            </body></html>`);
    }

    if (new Date() > entry.expires) {
        confirmTokens.delete(req.params.token);
        console.warn('  ✗ Token expiré pour :', entry.email);
        return res.status(410).send(`
            <html><head><meta charset="UTF-8"></head>
            <body style="font-family:Arial,sans-serif;text-align:center;padding:80px 20px;background:#FAFAF5;">
              <p style="font-size:2rem;color:#4A7FD4;margin-bottom:16px;">Watch<strong>VAULT</strong></p>
              <h2 style="color:#C62828;margin-bottom:12px;">Lien expiré</h2>
              <p style="color:#555;">Ce lien de confirmation a expiré (24 h).<br>
              Veuillez soumettre le formulaire à nouveau.</p>
            </body></html>`);
    }

    const { email, firstName, lastName, interest } = entry;
    confirmTokens.delete(req.params.token); /* usage unique */

    /* ── Mise à jour du statut CSV ── */
    try {
        updateCsvStatus(email, 'confirmed');
    } catch (err) {
        console.error('  ✗ Erreur mise à jour CSV :', err.message);
    }

    /* ── Token de téléchargement PDF ── */
    const dlToken     = createDownloadToken(email);
    const downloadUrl = `${BASE_URL}/download/${dlToken}`;

    /* ── Email #2 : confirmation + lien PDF ── */
    try {
        if (GMAIL_USER && GMAIL_PASS) {
            await sendConfirmedEmail(firstName, email, interest, downloadUrl);
        }
    } catch (err) {
        console.error('  ✗ Échec envoi email #2 :', err.message);
    }

    console.log(`  ✓ Confirmation réussie — ${email}`);
    console.log('════════════════════════════════════════\n');

    res.redirect(`${BASE_URL}/?confirmed=true`);
});

/* ============================================================
   ROUTE GET /download/:token
============================================================ */
app.get('/download/:token', (req, res) => {
    const entry = downloadTokens.get(req.params.token);

    if (!entry) {
        return res.status(404).send('Lien de téléchargement invalide.');
    }
    if (new Date() > entry.expires) {
        downloadTokens.delete(req.params.token);
        return res.status(410).send('Ce lien a expiré (24 h). Veuillez vous réinscrire.');
    }
    if (!fs.existsSync(PDF_PATH)) {
        return res.status(503).send('Le guide PDF n\'est pas encore disponible. Réessayez dans quelques instants.');
    }

    console.log(`  ✓ Téléchargement PDF — email : ${entry.email}`);
    res.download(PDF_PATH, 'WatchVault-Guide-Investissement.pdf');
});

/* ============================================================
   GESTION DES ERREURS GLOBALES
============================================================ */
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route non trouvée.' });
});

app.use((err, req, res, next) => {
    console.error('Erreur non gérée :', err.message);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
});

/* ============================================================
   DÉMARRAGE
============================================================ */
ensureCsvExists();

app.listen(PORT, async () => {
    console.log(`WatchVault server → http://localhost:${PORT}`);
    console.log(`CSV subscribers   → ${CSV_PATH}`);
    if (!GMAIL_USER) console.warn('⚠  GMAIL_USER non défini — emails désactivés.');
    await generatePdf();
});
