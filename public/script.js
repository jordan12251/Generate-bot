const form = document.getElementById('pairingForm');
const submitBtn = document.getElementById('submitBtn');
const codeDisplay = document.getElementById('codeDisplay');
const codeElement = document.getElementById('code');
const statusElement = document.getElementById('status');
const instructionsElement = document.getElementById('instructions');
const timerElement = document.getElementById('timer');
const alertElement = document.getElementById('alert');

let countdownInterval = null;

function showAlert(message, type = 'error') {
    alertElement.textContent = message;
    alertElement.className = 'alert show ' + type;
    setTimeout(() => {
        alertElement.className = 'alert';
    }, 5000);
}

function updateStatus(status) {
    if (status === 'connected') {
        statusElement.textContent = '✅ Connecté';
        statusElement.className = 'status connected';
    } else if (status === 'connecting') {
        statusElement.textContent = '🔄 Connexion en cours...';
        statusElement.className = 'status connecting';
    } else {
        statusElement.textContent = '❌ Déconnecté';
        statusElement.className = 'status disconnected';
    }
}

function startCountdown(seconds) {
    let remaining = seconds;
    
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
    
    countdownInterval = setInterval(() => {
        remaining--;
        timerElement.textContent = `⏰ Expire dans ${remaining} secondes`;
        
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            timerElement.textContent = '⚠️ Code expiré - Générez-en un nouveau';
            timerElement.style.color = '#ff6b6b';
        }
    }, 1000);
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const phoneNumber = document.getElementById('phoneNumber').value.trim();
    
    // Validation
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        showAlert('❌ Numéro invalide (10-15 chiffres requis)');
        return;
    }
    
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Génération...';
    updateStatus('connecting');
    
    try {
        const response = await fetch('/api/generate-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phoneNumber: cleanNumber })
        });
        
        const data = await response.json();
        
        if (data.success) {
            codeElement.textContent = data.code.toUpperCase();
            codeDisplay.classList.add('show');
            instructionsElement.classList.add('show');
            startCountdown(60);
            showAlert('✅ Code généré avec succès!', 'success');
            
            // Réinitialiser le style du timer
            timerElement.style.color = 'white';
        } else {
            showAlert('❌ ' + data.error);
            updateStatus('disconnected');
        }
    } catch (error) {
        showAlert('❌ Erreur de connexion au serveur');
        updateStatus('disconnected');
        console.error('Erreur:', error);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 Générer le code';
    }
});

// Vérifier le statut toutes les 3 secondes
setInterval(async () => {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        updateStatus(data.status);
        
        // Si connecté, afficher un message de confirmation
        if (data.status === 'connected' && !sessionStorage.getItem('connected_shown')) {
            showAlert('✅ Bot connecté avec succès!', 'success');
            sessionStorage.setItem('connected_shown', 'true');
        }
    } catch (error) {
        console.error('Erreur statut:', error);
    }
}, 3000);

// Animation au chargement
window.addEventListener('load', () => {
    document.querySelector('.container').style.animation = 'fadeIn 0.5s ease';
});
