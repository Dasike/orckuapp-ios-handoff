// ===== Conexion con la API real (orckumangas.com) =====
// api-php/ ya esta subido y respondiendo en vivo (2026-06-22).
const USE_REAL_API = true;
const API_BASE = 'https://orckumangas.com/api-php';
const SITE_BASE = API_BASE.replace(/\/api-php\/?$/, '');

// Las rutas que devuelve la API real son relativas al dominio del sitio (ej. "uploads/covers/x.png"),
// no al lugar donde corre la app. Esta funcion las convierte en URL absolutas.
function siteUrl(relativePath) {
    if (!relativePath) return '';
    if (relativePath.startsWith('http') || relativePath.startsWith('blob:') || relativePath.startsWith('data:')) return relativePath;
    return `${SITE_BASE}/${relativePath}`;
}

let authToken = localStorage.getItem('orcku_token') || null;
let currentUser = JSON.parse(localStorage.getItem('orcku_user') || 'null');

// Sin esto, un fetch() que se queda colgado (conexion movil lenta/inestable, el pedido nunca
// llega a responder pero tampoco rechaza) deja el spinner de carga girando para siempre - sin
// error, sin forma de reintentar, la unica salida era salirse de la pantalla y volver a entrar
// (reportado en el lector: "a veces no carga el capitulo"). 15s es generoso para una conexion
// mala real, pero corta el cuelgue infinito.
const API_TIMEOUT_MS = 15000;

async function apiRequest(path, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), API_TIMEOUT_MS);

    let res;
    try {
        res = await fetch(`${API_BASE}/${path}`, Object.assign({}, options, { headers, signal: timeoutController.signal }));
    } catch (networkErr) {
        if (networkErr.name === 'AbortError') {
            throw new Error('La conexión tardó demasiado. Revisa tu señal e intenta de nuevo.');
        }
        // fetch() rechaza (no llega a responder nada, ni un status HTTP) cuando no hay
        // conexion real: sin internet, DNS caido, o el propio Cloudflare/hosting temporalmente
        // inalcanzable. El navegador reporta esto como el crudo "Failed to fetch", que no dice
        // nada util al usuario -se traduce a un mensaje claro aca, una sola vez, para que
        // todos los lugares de la app que ya muestran err.message lo hereden gratis.
        throw new Error('No se pudo conectar con el servidor. Revisa tu conexión a internet e intenta de nuevo en un momento.');
    } finally {
        clearTimeout(timeoutId);
    }
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && authToken) {
        // El token ya no es valido (expiro de verdad tras mucha inactividad, o se revoco).
        // Se limpia la sesion local para que la UI no quede pidiendo acciones que ya no puede hacer.
        authToken = null;
        currentUser = null;
        localStorage.removeItem('orcku_token');
        localStorage.removeItem('orcku_user');
        renderProfileAuthState();
        loadContinueReading();
    }

    if (!res.ok) throw new Error(data.error || 'Error de conexión con el servidor');
    return data;
}

// Subida de archivos (FormData con File) via XMLHttpRequest en vez de fetch(). Confirmado con
// el usuario: el error de red (antes "Failed to fetch", con XHR "no se pudo conectar") pasaba
// con fotos de Google Photos que solo existen en la nube (no descargadas en el celular) — el
// WebView no puede leer esos bytes para subirlos. Con una captura de pantalla local funciono
// de una. No es un bug de la app, es una limitacion real de Android con archivos "solo nube".
// El mensaje de xhr.onerror de abajo ya avisa de esto en vez de un error generico de red.
function apiUploadFormData(path, formData) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/${path}`);
        if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);

        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch (e) { /* respuesta vacia o no-JSON */ }

            if (xhr.status === 401 && authToken) {
                authToken = null;
                currentUser = null;
                localStorage.removeItem('orcku_token');
                localStorage.removeItem('orcku_user');
                renderProfileAuthState();
                loadContinueReading();
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
            } else {
                reject(new Error(data.error || `Error de conexión con el servidor (HTTP ${xhr.status})`));
            }
        };
        xhr.onerror = () => reject(new Error('No se pudo leer ese archivo para subirlo. Si es una foto de Google Fotos que no está descargada en el celular (solo en la nube), ábrela primero en la galería para descargarla, o adjunta una foto/captura guardada localmente.'));
        xhr.ontimeout = () => reject(new Error('La subida del archivo tardó demasiado y se canceló.'));
        xhr.timeout = 60000;
        xhr.send(formData);
    });
}

function saveSession(token, user) {
    authToken = token;
    currentUser = user;
    localStorage.setItem('orcku_token', token);
    localStorage.setItem('orcku_user', JSON.stringify(user));
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('orcku_token');
    localStorage.removeItem('orcku_user');
    renderProfileAuthState();
    loadContinueReading();
    closeNotificationsPanel();
    document.getElementById('notifications-list-panel').innerHTML = '<p class="empty-grid-msg">Inicia sesión para ver tus notificaciones.</p>';
    updateNotificationBadge(0);
    showNotification('Sesión cerrada.');
    switchScreen('profile');
}

function renderProfileAuthState() {
    const guestView = document.getElementById('profile-guest-view');
    const loggedView = document.getElementById('profile-logged-view');
    if (!guestView || !loggedView) return;

    if (currentUser) {
        guestView.style.display = 'none';
        loggedView.style.display = 'block';
        document.getElementById('profile-username').textContent = currentUser.username;
        document.getElementById('profile-role-badge').textContent = currentUser.role >= 1 ? 'Staff' : 'Lector';
        const vipBadge = document.getElementById('profile-vip-badge');
        const vipBadgeText = document.getElementById('profile-vip-badge-text');
        if (currentUser.is_vip) {
            vipBadge.style.display = 'inline-block';
            vipBadgeText.textContent = 'Juramento del Montaraz activo';
        } else if (currentUser.is_ad_free) {
            vipBadge.style.display = 'inline-block';
            vipBadgeText.textContent = 'Ración de Lembas activa (sin anuncios 24h)';
        } else {
            vipBadge.style.display = 'none';
        }
        // El avatar del header (esquina superior, junto a las Runas) usaba siempre la imagen de
        // muestra hardcodeada en el HTML y nunca se sincronizaba con el avatar real del usuario
        // -bug reportado 2026-06-29-, asi que se actualiza junto con el de la pantalla de Perfil.
        const avatarSrc = currentUser.avatar
            ? (USE_REAL_API ? siteUrl('uploads/avatars/' + currentUser.avatar) : currentUser.avatar)
            : 'images/media_chibi.jpg';
        document.getElementById('profile-avatar-big').src = avatarSrc;
        document.getElementById('user-avatar').src = avatarSrc;
        document.querySelectorAll('.frame-preview-img').forEach(img => { img.src = avatarSrc; });
        document.getElementById('profile-avatar-change-warning').style.display = currentUser.avatar_change_requested ? 'block' : 'none';
        renderProfileBioDisplay();
        document.getElementById('profile-edit-panel').style.display = 'none';
        loadProfileMedals();
        renderDonationBadge();
        renderStreakBadge();
        applyProfileBanner(currentUser.custom_banner_path);
    } else {
        guestView.style.display = 'block';
        loggedView.style.display = 'none';
        applyProfileBanner(null);
        document.getElementById('profile-medals-section').style.display = 'none';
        document.getElementById('user-avatar').src = 'images/media_chibi.jpg';
        document.getElementById('user-avatar').className = '';
        document.querySelectorAll('.frame-preview-img').forEach(img => { img.src = 'images/media_chibi.jpg'; });
        const headerOverlay = document.getElementById('user-avatar-frame');
        headerOverlay.style.display = 'none';
        headerOverlay.src = '';
        activeAvatarFrame = 'none';
        purchasedFrames.clear();
        document.querySelectorAll('#profile-username, #popover-username').forEach(el => {
            Object.keys(NAME_AURAS).forEach(id => el.classList.remove(`name-aura-${id}`));
        });
        activeNameAura = 'none';
        purchasedAuras.clear();
        closeHeaderProfilePopover();
    }
    updateAdminNavTabVisibility();
}

// Banner de perfil personalizable: foto propia del usuario, gratis, sin Tienda (reemplaza los
// banners comprables que nunca se engancharon a la UI). Self-view igual que marcos/auras -solo
// el dueño lo ve en su propio header, así que no hace falta cola de moderación acá.
function applyProfileBanner(path) {
    const strip = document.getElementById('profile-banner-strip');
    if (!strip) return;
    if (path) {
        // Degradado suave solo en el borde inferior -ahi es donde el avatar se superpone al
        // banner, ayuda a que el borde se distinga incluso sobre una foto muy clara o cargada.
        strip.style.backgroundImage = `linear-gradient(180deg, rgba(10,10,20,0) 60%, rgba(10,10,20,.5) 100%), url('${siteUrl(path)}')`;
        strip.classList.add('has-custom-banner');
    } else {
        strip.style.backgroundImage = '';
        strip.classList.remove('has-custom-banner');
    }
    // "Quitar banner" solo tiene sentido si hay uno puesto -vive en el panel de edicion, no
    // directo sobre el banner (ver toggleProfileEditPanel).
    const removeBtn = document.getElementById('profile-edit-remove-banner-btn');
    if (removeBtn) removeBtn.style.display = path ? 'block' : 'none';
}

function triggerProfileBannerUpload() {
    document.getElementById('profile-banner-input').click();
}

async function uploadProfileBanner(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;

    try {
        const formData = new FormData();
        formData.append('file', file);
        const data = await apiUploadFormData('banner_upload.php', formData);
        currentUser.custom_banner_path = data.custom_banner_path;
        saveSession(authToken, currentUser);
        applyProfileBanner(currentUser.custom_banner_path);
        showNotification('Banner de perfil actualizado.');
    } catch (err) {
        showNotification('No se pudo subir el banner: ' + err.message);
    }
}

async function removeProfileBanner() {
    try {
        const formData = new FormData();
        formData.append('remove', '1');
        await apiUploadFormData('banner_upload.php', formData);
        currentUser.custom_banner_path = null;
        saveSession(authToken, currentUser);
        applyProfileBanner(null);
        showNotification('Banner de perfil restaurado al predeterminado.');
    } catch (err) {
        showNotification('No se pudo quitar el banner: ' + err.message);
    }
}

// Popover rapido al tocar el avatar del header: muestra estado de VIP/Lembas y un acceso
// directo al perfil completo, sin tener que cambiar de pantalla solo para ver eso.
async function toggleHeaderProfilePopover() {
    const popover = document.getElementById('header-profile-popover');
    if (!popover) return;

    if (popover.classList.contains('active')) {
        closeHeaderProfilePopover();
        return;
    }

    if (!currentUser) {
        switchScreen('login');
        return;
    }

    // Refresca VIP/Lembas/capitulos leidos antes de mostrar, para que no se vea data vieja si
    // el usuario acaba de comprar algo o de leer un capitulo en esta misma sesion.
    if (authToken) await syncWalletBalance();
    if (!currentUser) return; // syncWalletBalance pudo haber cerrado sesion si el token expiro

    document.getElementById('popover-avatar-img').src = document.getElementById('user-avatar').src;
    document.getElementById('popover-username').textContent = currentUser.username;
    document.getElementById('popover-role-badge').textContent = currentUser.role >= 1 ? 'Staff' : 'Lector';

    const vipRow = document.getElementById('popover-vip-row');
    const vipText = document.getElementById('popover-vip-text');
    if (currentUser.is_vip) {
        vipRow.style.display = 'flex';
        vipText.textContent = 'Juramento del Montaraz activo';
    } else if (currentUser.is_ad_free) {
        vipRow.style.display = 'flex';
        vipText.textContent = 'Ración de Lembas activa (24h)';
    } else {
        vipRow.style.display = 'none';
    }

    document.getElementById('popover-chapters-read').textContent = currentUser.chapters_read ?? 0;

    popover.classList.add('active');
}

function closeHeaderProfilePopover() {
    const popover = document.getElementById('header-profile-popover');
    if (popover) popover.classList.remove('active');
}

function goToProfileFromPopover() {
    closeHeaderProfilePopover();
    switchScreen('profile');
}

const GACHA_MEDAL_INFO = {
    podium: { 1: ['🥇', 'Oro'], 2: ['🥈', 'Plata'], 3: ['🥉', 'Bronce'] },
    top10: ['🎗️', 'Top 10'],
    completed: ['📔', 'Álbum completado'],
};

async function loadProfileMedals() {
    const section = document.getElementById('profile-medals-section');
    const list = document.getElementById('profile-medals-list');
    if (!USE_REAL_API || !authToken) { section.style.display = 'none'; return; }

    try {
        const medals = await apiRequest('gacha_user_medals.php');
        if (medals.length === 0) {
            section.style.display = 'none';
            return;
        }
        section.style.display = 'block';
        list.innerHTML = medals.map(m => {
            let icon, label;
            if (m.medal_tier === 'podium') {
                [icon, label] = GACHA_MEDAL_INFO.podium[m.rank_position];
            } else {
                [icon, label] = GACHA_MEDAL_INFO[m.medal_tier];
            }
            return `
                <div class="profile-medal-badge medal-${m.medal_tier}">
                    <span class="profile-medal-icon">${icon}</span>
                    <span class="profile-medal-label">${label}</span>
                    <span class="profile-medal-season">${m.season_name}</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        section.style.display = 'none';
    }
}

async function saveProfileBio() {
    const bio = document.getElementById('profile-bio-input').value.trim();

    if (!USE_REAL_API) {
        currentUser.bio = bio;
        saveSession(authToken, currentUser);
        renderProfileBioDisplay();
        showNotification('Biografía actualizada (modo demo).');
        return;
    }

    try {
        await apiRequest('user_update.php', {
            method: 'POST',
            body: JSON.stringify({ bio }),
        });
        currentUser.bio = bio;
        saveSession(authToken, currentUser);
        renderProfileBioDisplay();
        showNotification('Biografía actualizada.');
    } catch (err) {
        showNotification('No se pudo guardar la biografía: ' + err.message);
    }
}

// La bio ahora se ve como texto suelto (sin caja), y se edita desde el panel del lápiz junto con
// la foto de perfil y el banner -antes tenía su propia caja+botón "Guardar" siempre visibles,
// que quedaba fea y redundante con separar "ver" de "editar".
function renderProfileBioDisplay() {
    const display = document.getElementById('profile-bio-display');
    if (!display) return;
    display.textContent = currentUser?.bio || '';
    display.style.display = currentUser?.bio ? 'block' : 'none';
}

function toggleProfileEditPanel() {
    const panel = document.getElementById('profile-edit-panel');
    const willOpen = panel.style.display === 'none';
    panel.style.display = willOpen ? 'flex' : 'none';
    if (willOpen) {
        document.getElementById('profile-bio-input').value = currentUser?.bio || '';
    }
}

async function saveProfileBioFromPanel() {
    await saveProfileBio();
    document.getElementById('profile-edit-panel').style.display = 'none';
}

async function handleLoginSubmit() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-submit-btn');

    errorEl.style.display = 'none';

    if (!username || !password) {
        errorEl.textContent = 'Completa tu usuario y contraseña.';
        errorEl.style.display = 'block';
        return;
    }

    if (!USE_REAL_API) {
        // Modo demo: el backend todavia no esta subido, simulamos el login
        saveSession('demo-token', { id: 0, username, avatar: null, role: 0 });
        renderProfileAuthState();
        showNotification('Sesión iniciada (modo demo — el backend real aún no está activo).');
        switchScreen('profile');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Entrando...';
    try {
        const data = await apiRequest('login.php', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        saveSession(data.token, data.user);
        userCoins = data.user.coins ?? userCoins;
        purchasedFrames.clear();
        (data.user.purchased_frames || []).forEach(id => purchasedFrames.add(id));
        if (data.user.active_frame) equipAvatarFrame(data.user.active_frame);
        purchasedAuras.clear();
        (data.user.purchased_auras || []).forEach(id => purchasedAuras.add(id));
        if (data.user.active_aura) equipNameAura(data.user.active_aura);
        updateCoinsDisplay();
        renderProfileAuthState();
        loadContinueReading();
        loadNotifications();
        showNotification(`¡Bienvenido, ${data.user.username}!`);
        switchScreen('profile');
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Iniciar sesión';
    }
}
// Recuperar contraseña: sin envio de correo todavia (decision del usuario), el "envio" del
// codigo lo hace el staff a mano por Discord despues de revisar en phpMyAdmin. Por eso el paso
// 1 siempre muestra el mismo mensaje generico, exista o no la cuenta.
async function handleForgotPasswordRequest() {
    const identifier = document.getElementById('forgot-identifier').value.trim();
    const msgEl = document.getElementById('forgot-request-msg');
    const btn = document.getElementById('forgot-request-btn');

    if (!identifier) {
        msgEl.textContent = 'Escribe tu usuario o correo.';
        msgEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando...';
    try {
        const data = await apiRequest('forgot_password_request.php', {
            method: 'POST',
            body: JSON.stringify({ identifier }),
        });
        msgEl.textContent = data.message;
        msgEl.style.display = 'block';
        document.getElementById('forgot-reset-identifier').value = identifier;
    } catch (err) {
        msgEl.textContent = err.message;
        msgEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Solicitar código';
    }
}

function showForgotResetStep() {
    document.getElementById('forgot-step-request').style.display = 'none';
    document.getElementById('forgot-step-reset').style.display = 'block';
}

async function handleForgotPasswordReset() {
    const identifier = document.getElementById('forgot-reset-identifier').value.trim();
    const token = document.getElementById('forgot-reset-token').value.trim();
    const newPassword = document.getElementById('forgot-reset-password').value;
    const msgEl = document.getElementById('forgot-reset-msg');
    const btn = document.getElementById('forgot-reset-btn');

    msgEl.style.display = 'none';
    if (!identifier || !token || !newPassword) {
        msgEl.textContent = 'Completa usuario, código y la contraseña nueva.';
        msgEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Restableciendo...';
    try {
        const data = await apiRequest('forgot_password_reset.php', {
            method: 'POST',
            body: JSON.stringify({ identifier, token, new_password: newPassword }),
        });
        showNotification(data.message);
        switchScreen('login');
    } catch (err) {
        msgEl.textContent = err.message;
        msgEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Restablecer contraseña';
    }
}
// ===== Fin conexion con la API =====

// State Variables
let userCoins = 25; // Start with 25 Runas so puedan probar comprar un marco o tirar del gacha
let nsfwFilterEnabled = true;
let isAdminMode = false;
let activeAvatarFrame = 'none';
const purchasedFrames = new Set();


// Document Ready
document.addEventListener("DOMContentLoaded", () => {
    updateClock();
    setInterval(updateClock, 1000);

    setupAndroidBackButton();
    setupReaderOptionControls();

    // Set initial coins display
    updateCoinsDisplay();

    // Wire up events
    document.getElementById("nsfw-filter-toggle").addEventListener("change", (e) => {
        nsfwFilterEnabled = e.target.checked;
        applyNsfwFilter();
    });

    document.getElementById("btn-toggle-admin").addEventListener("click", () => {
        toggleAdminMode();
    });

    // Cierra el popover del avatar y el panel de notificaciones del header si se toca afuera
    // (no en su propio botón ni dentro del panel/popover).
    document.addEventListener("click", (e) => {
        const popover = document.getElementById('header-profile-popover');
        const avatarBtn = document.getElementById('header-avatar-wrap');
        if (popover && popover.classList.contains('active') &&
            !popover.contains(e.target) && !avatarBtn.contains(e.target)) {
            closeHeaderProfilePopover();
        }

        const notifPanel = document.getElementById('header-notifications-panel');
        const bellBtn = document.getElementById('header-bell-btn');
        if (notifPanel && notifPanel.classList.contains('active') &&
            !notifPanel.contains(e.target) && !bellBtn.contains(e.target)) {
            closeNotificationsPanel();
        }
    });

    // Apply initial filter state
    applyNsfwFilter();

    // Reflejar si ya hay sesión guardada de una vez anterior
    renderProfileAuthState();

    // Si el backend real ya está activo, reemplaza el catálogo de demo por datos reales
    if (USE_REAL_API) {
        loadGenreChipsFromApi();
        loadCatalogFromApi();
        loadContinueReading();
        loadLatestUpdates();
        loadGalleryPhotos();
        loadHomeGachaBanner();
        if (authToken) syncWalletBalance();
        checkAppVersion();
    }
});

// ===== Forzar actualización de versión (2026-07-18) =====
// Chequeo temprano, apenas abre la app. Fail-open a proposito en cualquier error (sin
// conexion, endpoint caido, o corriendo en el preview de escritorio sin el plugin nativo
// @capacitor/app) -un problema de red nunca debe dejar a todo el mundo afuera de la app.
async function checkAppVersion() {
    try {
        const data = await apiRequest('app_version_check.php');
        const appPlugin = window.Capacitor?.Plugins?.App;
        if (!appPlugin) return;
        const info = await appPlugin.getInfo();
        const currentBuild = parseInt(info.build, 10);
        if (currentBuild < data.min_version_code) {
            const modal = document.getElementById('force-update-modal');
            const messageEl = document.getElementById('force-update-message');
            messageEl.textContent = data.message || 'Hay una nueva versión de la app. Actualiza para seguir usando OrckuApp.';
            modal.classList.add('active');
        }
    } catch (err) {
        // Fail-open: no bloquear si el chequeo mismo falla.
    }
}

// Refresca el balance real de Runas desde el servidor (al abrir la app con sesión guardada,
// o despues de cualquier accion que pudo haber cambiado el saldo en otro dispositivo/sesion).
async function syncWalletBalance() {
    try {
        const data = await apiRequest('wallet_sync.php');
        userCoins = data.coins;
        purchasedFrames.clear();
        (data.purchased_frames || []).forEach(id => purchasedFrames.add(id));
        if (data.active_frame) equipAvatarFrame(data.active_frame);
        purchasedAuras.clear();
        (data.purchased_auras || []).forEach(id => purchasedAuras.add(id));
        if (data.active_aura) equipNameAura(data.active_aura);
        updateCoinsDisplay();
        if (currentUser) {
            currentUser.vip_until = data.vip_until;
            currentUser.ad_free_until = data.ad_free_until;
            currentUser.is_vip = data.is_vip;
            currentUser.is_ad_free = data.is_ad_free;
            currentUser.chapters_read = data.chapters_read;
            currentUser.active_frame = data.active_frame;
            currentUser.purchased_frames = data.purchased_frames;
            currentUser.active_aura = data.active_aura;
            currentUser.purchased_auras = data.purchased_auras;
            currentUser.extra_offline_slots = data.extra_offline_slots;
            currentUser.username_changed_at = data.username_changed_at;
            currentUser.patreon_tier        = data.patreon_tier ?? 0;
            currentUser.patreon_connected   = data.patreon_connected ?? false;
            currentUser.donation_total_usd  = data.donation_total_usd ?? 0;
            currentUser.donation_badge      = data.donation_badge ?? null;
            currentUser.custom_banner_path  = data.custom_banner_path ?? null;
            currentUser.avatar_change_requested = data.avatar_change_requested ?? false;
            currentUser.checkin_streak      = data.checkin_streak ?? 0;
            saveSession(authToken, currentUser);
            renderProfileAuthState();
            renderPatreonConnectArea();
            renderDonationBadge();
            renderStreakBadge();
        }
    } catch (err) {
        // Si falla, se queda con el ultimo valor conocido; no es critico bloquear por esto.
    }
    loadNotifications();
}

// Update android clock
function updateClock() {
    const clockEl = document.getElementById("clock");
    const now = new Date();
    let hours = now.getHours();
    let minutes = now.getMinutes();
    hours = hours < 10 ? '0' + hours : hours;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    clockEl.textContent = `${hours}:${minutes}`;
}

// Update coin displays in UI and refresh frame button affordability states.
function updateCoinsDisplay() {
    document.getElementById("coins-count").textContent = userCoins;
    updateFrameButtonStates();
    updateAuraButtonStates();
}

// Historial simple de pantallas para que el botón/gesto "atrás" de Android navegue
// hacia la pantalla anterior en vez de salir de la app (ver setupAndroidBackButton).
let screenHistory = ['home'];

// Switch between screens
function switchScreen(screenId, navItemElement, fromBackButton) {
    if (!fromBackButton) {
        if (screenHistory[screenHistory.length - 1] !== screenId) {
            screenHistory.push(screenId);
        }
    }

    // Hide all screens
    const screens = document.querySelectorAll(".app-screen");
    screens.forEach(s => {
        s.classList.remove("active");
        s.style.display = "none";
    });

    // Show active screen
    const targetScreen = document.getElementById(`screen-${screenId}`);
    if (targetScreen) {
        targetScreen.style.display = "block";
        // Force reflow for opacity transition
        targetScreen.offsetHeight;
        targetScreen.classList.add("active");
    }

    // Render dinámica por pantalla
    if (screenId === 'store') renderPatreonConnectArea();
    if (screenId === 'missions') loadMissions();

    // Update active nav button
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(n => n.classList.remove("active"));
    
    if (navItemElement) {
        navItemElement.classList.add("active");
    } else {
        // Fallback matching if navigated from elsewhere (like clicking coins badge)
        const nav = document.querySelector(".app-navigation");
        const buttons = nav.querySelectorAll(".nav-item");
        buttons.forEach(btn => {
            if (btn.getAttribute("onclick").includes(`switchScreen('${screenId}'`)) {
                btn.classList.add("active");
            }
        });
    }
}

// Checkin diario (+5 coins/Runas). Real contra el servidor si hay sesión (necesario para que
// las Runas que se usan en el gacha sean una moneda de verdad, no solo un numero local que
// cualquiera podría resetear recargando la app).
let claimedCheckin = false;
async function claimDailyCheckin() {
    if (claimedCheckin) {
        showNotification("Ya reclamaste tu maná diario de hoy.");
        return;
    }

    if (USE_REAL_API && authToken) {
        try {
            const data = await apiRequest('daily_checkin.php', { method: 'POST', body: JSON.stringify({}) });
            userCoins = data.coins;
            if (currentUser) {
                currentUser.checkin_streak = data.checkin_streak;
                saveSession(authToken, currentUser);
                renderStreakBadge();
            }
        } catch (err) {
            showNotification(err.message);
            return;
        }
    } else {
        userCoins += 5;
    }
    updateCoinsDisplay();
    markCheckinCardClaimed();

    showNotification("¡Check-in diario! +5 Runas añadidas.");
}

// Marca la tarjeta de Check-in como reclamada -se usa tanto al reclamar en el momento (arriba)
// como al abrir la pantalla si el check-in de hoy ya se hizo en una sesion anterior (ver
// loadMissions(), que sincroniza esto con missions_list.php en vez de esperar a que el usuario
// toque el boton y el servidor lo rechace).
function markCheckinCardClaimed() {
    claimedCheckin = true;
    const checkinCard = document.getElementById("checkin-card");
    if (!checkinCard) return;
    checkinCard.style.opacity = "0.5";
    const btn = checkinCard.querySelector("button");
    btn.textContent = "Reclamado";
    btn.disabled = true;
}

// ===== Anuncios reales (ExoClick) =====
// Zone IDs reales, creadas en el panel de ExoClick el 2026-07-03 (cuenta del sitio
// orckumangas.com, categoria Adult). Si algun dia hace falta recrear una zona, dejar en 0 acá
// y la app cae sola al comportamiento simulado (timer/banner/intersticial mock) sin romper
// nada, hasta que se pegue el ID nuevo.
const EXOCLICK_ZONE_REWARDED = 5965640;      // Video In-Stream (VAST) - Refuerzo de Runas
const EXOCLICK_ZONE_INTERSTITIAL = 5965642;  // Fullpage Interstitial - cambio de capitulo / ficha
const EXOCLICK_ZONE_NATIVE_BANNER = 5965644; // Recommendation Widget - banner del lector

function exoClickZoneReady(zoneId) {
    return !!zoneId;
}

function userIsAdFree() {
    return !!(currentUser && (currentUser.is_vip || currentUser.is_ad_free));
}

// Carga un <script src> una sola vez y cachea la promesa - si dos anuncios piden el mismo
// script casi al mismo tiempo (ej. intersticial y banner nativo comparten dominio en distintas
// zonas), no lo inserta dos veces.
const _exoClickLoadedScripts = {};
function loadScriptOnce(src) {
    if (!_exoClickLoadedScripts[src]) {
        _exoClickLoadedScripts[src] = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.async = true;
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
    return _exoClickLoadedScripts[src];
}

// Anuncio recompensado (Refuerzo de Runas): reproduce el VAST tag de la zona con Fluid Player
// (el reproductor que recomienda la documentacion de ExoClick para este formato) y llama a
// onComplete() recien en vastVideoEndedCallback - el evento real de "se vio hasta el final",
// no un timer nuestro que se pudiera falsear con solo esperar sin mirar.
function loadExoClickRewarded(zoneId, onComplete) {
    const videoEl = document.getElementById('exoclick-rewarded-video');
    loadScriptOnce('https://cdn.fluidplayer.com/v3/current/fluidplayer.min.js').then(() => {
        videoEl.style.display = 'block';
        fluidPlayer('exoclick-rewarded-video', {
            vastOptions: {
                adList: [{ roll: 'preRoll', vastTag: `https://s.magsrv.com/v1/vast.php?idz=${zoneId}` }],
                vastAdvanced: {
                    vastVideoEndedCallback: () => {
                        videoEl.style.display = 'none';
                        onComplete();
                    },
                    noVastVideoCallback: () => {
                        // Sin relleno (no habia anuncio disponible en este momento) - no se
                        // acredita recompensa porque no se vio nada, se avisa y se cierra.
                        videoEl.style.display = 'none';
                        showNotification('No hay anuncios disponibles en este momento. Intenta en un rato.');
                        document.getElementById('mock-ad-modal').classList.remove('active');
                    },
                },
            },
        });
    }).catch(() => {
        videoEl.style.display = 'none';
        showNotification('No se pudo cargar el anuncio. Intenta de nuevo.');
        document.getElementById('mock-ad-modal').classList.remove('active');
    });
}

// Intersticial (cambio de capitulo / apertura de ficha). La zona esta configurada en el panel
// de ExoClick con "Metodo de Trigger: clic en enlaces con clase especifica"
// (exoclick-interstitial-trigger) - registramos la zona una sola vez (carga del script + push
// "serve") y despues cada llamada solo dispara un clic real sobre el link oculto que tiene esa
// clase; el propio script de ExoClick decide ahi si mostrar el intersticial.
let _exoClickInterstitialReady = false;
function initExoClickInterstitial() {
    if (_exoClickInterstitialReady) return;
    _exoClickInterstitialReady = true;
    loadScriptOnce('https://a.pemsrv.com/ad-provider.js').then(() => {
        (window.AdProvider = window.AdProvider || []).push({ serve: {} });
    });
}

function loadExoClickInterstitial(zoneId) {
    initExoClickInterstitial();
    document.getElementById('exoclick-interstitial-trigger')?.click();
}

// Banner nativo dentro del lector (ver renderStripPages): agrega un <ins> nuevo con el Zone ID
// dentro del contenedor de la pagina actual y le pide a ExoClick que lo sirva. Se hace de
// nuevo en cada capitulo (no una sola vez) porque el contenedor es un elemento nuevo del DOM
// cada vez que se renderiza el lector.
function loadExoClickNativeBanner(zoneId, container) {
    const ins = document.createElement('ins');
    ins.className = 'eas6a97888e20';
    ins.setAttribute('data-zoneid', String(zoneId));
    container.appendChild(ins);
    loadScriptOnce('https://a.magsrv.com/ad-provider.js').then(() => {
        (window.AdProvider = window.AdProvider || []).push({ serve: {} });
    }).catch(() => {});
}

// Cooldown compartido entre los 2 puntos donde aparece un intersticial (cambio de capitulo y
// apertura de ficha) para no encimar dos anuncios seguidos si el usuario navega rapido entre
// pantallas. Valor de partida, ajustar segun feedback real una vez haya anuncios de verdad.
const INTERSTITIAL_COOLDOWN_MS = 3 * 60 * 1000;
let lastInterstitialAt = 0;

function maybeShowInterstitialAd() {
    if (userIsAdFree()) return;
    const now = Date.now();
    if (now - lastInterstitialAt < INTERSTITIAL_COOLDOWN_MS) return;
    lastInterstitialAt = now;

    if (exoClickZoneReady(EXOCLICK_ZONE_INTERSTITIAL)) {
        loadExoClickInterstitial(EXOCLICK_ZONE_INTERSTITIAL);
    } else {
        showMockInterstitial();
    }
}

// Intersticial simulado: mismo look de "anuncio falso" que ya usaba el refuerzo de Runas, para
// poder probar la cadencia/frecuencia de interrupcion ANTES de tener la cuenta real de
// ExoClick. Se cierra solo a los 3s (no bloquea con un boton, un intersticial real tampoco deja
// "elegir no verlo" en los primeros segundos).
function showMockInterstitial() {
    const modal = document.getElementById("mock-interstitial-modal");
    if (!modal) return;
    modal.classList.add("active");
    setTimeout(() => modal.classList.remove("active"), 3000);
}

// Watch Mock Video Ad (+10 coins/Runas)
function watchMockAd() {
    const modal = document.getElementById("mock-ad-modal");
    const timerText = document.getElementById("ad-timer-text");
    const progressFill = document.getElementById("ad-progress-fill");
    // Elementos del look "simulado" (icono/titulo/texto/barra) - se ocultan cuando se usa el
    // video real de ExoClick, que ocupa el mismo modal (#exoclick-rewarded-video).
    const mockParts = ['ad-mock-icon', 'ad-mock-title', 'ad-mock-text', 'ad-mock-progress-wrap']
        .map(id => document.getElementById(id));

    const grantReward = () => {
        modal.classList.remove("active");
        if (USE_REAL_API && authToken) {
            apiRequest('watch_ad_reward.php', { method: 'POST', body: JSON.stringify({}) })
                .then(data => {
                    userCoins = data.coins;
                    updateCoinsDisplay();
                    showNotification("¡Refuerzo completo! +10 Runas añadidas.");
                })
                .catch(err => showNotification(err.message));
        } else {
            userCoins += 10;
            updateCoinsDisplay();
            showNotification("¡Refuerzo completo! +10 Runas añadidas.");
        }
        progressFill.style.transition = "none";
        progressFill.style.width = "0%";
    };

    if (exoClickZoneReady(EXOCLICK_ZONE_REWARDED)) {
        mockParts.forEach(el => el && (el.style.display = 'none'));
        timerText.style.display = 'none';
        modal.classList.add("active");
        loadExoClickRewarded(EXOCLICK_ZONE_REWARDED, grantReward);
        return;
    }

    mockParts.forEach(el => el && (el.style.display = ''));
    timerText.style.display = '';
    modal.classList.add("active");
    progressFill.style.width = "0%";

    let timeLeft = 5; // 5 seconds ad for rapid testing
    timerText.textContent = `Cerrando en ${timeLeft}s`;

    // Animate progress bar
    setTimeout(() => {
        progressFill.style.transition = "width 5s linear";
        progressFill.style.width = "100%";
    }, 100);

    const interval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            timerText.textContent = `Cerrando en ${timeLeft}s`;
        } else {
            clearInterval(interval);
            grantReward();
        }
    }, 1000);
}

// ===== Misiones diarias/semanales (Camara de Runas) =====
// El check-in y el anuncio de arriba en esta misma pantalla ya son sus propias tarjetas de
// accion real -estas son misiones NUEVAS (gacha/comentarios/galeria), calculadas 100% en el
// servidor (missions_list.php recalcula el progreso contra las tablas reales, nunca confia en
// nada que mande el cliente).
async function loadMissions() {
    const guestNotice = document.getElementById('missions-guest-notice');
    const dailySection = document.getElementById('missions-daily-section');
    const weeklySection = document.getElementById('missions-weekly-section');
    if (!guestNotice || !dailySection || !weeklySection) return;

    if (!USE_REAL_API || !authToken) {
        guestNotice.style.display = 'block';
        dailySection.style.display = 'none';
        weeklySection.style.display = 'none';
        return;
    }

    try {
        const data = await apiRequest('missions_list.php');
        guestNotice.style.display = 'none';
        dailySection.style.display = 'block';
        weeklySection.style.display = 'block';

        if (data.checkin_done && !claimedCheckin) markCheckinCardClaimed();

        const daily = data.missions.filter(m => m.scope === 'daily');
        const weekly = data.missions.filter(m => m.scope === 'weekly');
        document.getElementById('missions-daily-list').innerHTML = daily.map(renderMissionCard).join('');
        document.getElementById('missions-weekly-list').innerHTML = weekly.map(renderMissionCard).join('');
    } catch (err) {
        guestNotice.style.display = 'block';
        guestNotice.querySelector('.empty-grid-msg').textContent = 'No se pudieron cargar las misiones: ' + err.message;
        dailySection.style.display = 'none';
        weeklySection.style.display = 'none';
    }
}

function renderMissionCard(m) {
    const pct = Math.round((m.progress / m.target) * 100);
    let btnHtml;
    if (m.claimed) {
        btnHtml = `<button class="btn-action-coin" disabled>Reclamado</button>`;
    } else if (m.claimable) {
        btnHtml = `<button class="btn-action-coin can-claim" onclick="claimMission('${m.id}')">+${m.reward} <i class="fa-solid fa-gem"></i></button>`;
    } else {
        btnHtml = `<span class="badge-event-progress">${m.progress}/${m.target}</span>`;
    }
    return `
        <div class="event-card mission-card ${m.claimed ? 'claimed' : ''}" id="mission-card-${m.id}">
            <div class="event-info">
                <h4><i class="fa-solid ${m.icon}"></i> ${m.label}</h4>
                <p>${m.desc}</p>
                <div class="mission-progress-bar">
                    <div class="mission-progress-bar-fill" style="width:${pct}%"></div>
                </div>
            </div>
            ${btnHtml}
        </div>
    `;
}

async function claimMission(missionId) {
    try {
        const data = await apiRequest('missions_claim.php', {
            method: 'POST',
            body: JSON.stringify({ mission_id: missionId }),
        });
        userCoins = data.coins;
        updateCoinsDisplay();
        showNotification(`¡Misión completada! +${data.reward} Runas.`);
        loadMissions();
    } catch (err) {
        showNotification(err.message);
        loadMissions(); // resincroniza por si el estado mostrado ya estaba desactualizado
    }
}

// NSFW Filter implementation
function applyNsfwFilter() {
    // .cover-wrap cubre las portadas chicas de "Continuar leyendo"/"Últimas actualizaciones"/
    // "Últimos leídos" (Home y Perfil) -antes solo se filtraban las de Biblioteca/Home grid
    // (.manga-cover) y la ficha (.manga-detail-cover), así que esas 3 vistas mostraban la
    // portada +18 sin censurar.
    const adultCovers = document.querySelectorAll(".adult-content .manga-cover img, .adult-content .manga-detail-cover img, .adult-content .cover-wrap img");
    const nsfwToggle = document.getElementById("nsfw-filter-toggle");

    // Sync UI check
    if (nsfwToggle) nsfwToggle.checked = nsfwFilterEnabled;

    adultCovers.forEach(img => img.classList.toggle("blurred", nsfwFilterEnabled));
}

// Toggle Admin Mode from control panel
// El boton "Modo Administrador" vive en el .control-panel del mockup de escritorio
// (display:none en pantallas de celular - ver media query en style.css), asi que nunca fue
// alcanzable desde la app real en un celular. updateAdminNavTabVisibility() es el camino real:
// muestra la pestaña Staff sola si la cuenta logueada de verdad tiene role >= 1 en la base.
function toggleAdminMode() {
    isAdminMode = !isAdminMode;
    const statusEl = document.getElementById("admin-status");
    const btn = document.getElementById("btn-toggle-admin");

    if (isAdminMode) {
        statusEl.textContent = "ON";
        statusEl.style.color = "#c77dff";
        btn.classList.add("admin-active");
        showNotification("Modo Staff activado. Se habilitó el Panel de Control en la app.");
    } else {
        statusEl.textContent = "OFF";
        statusEl.style.color = "";
        btn.classList.remove("admin-active");
        showNotification("Modo Staff desactivado.");
    }
    updateAdminNavTabVisibility();
}

function updateAdminNavTabVisibility() {
    const nav = document.querySelector(".app-navigation");
    const isRealStaff = currentUser && currentUser.role >= 1;
    const shouldShow = isRealStaff || isAdminMode;

    if (shouldShow) {
        if (!document.getElementById("nav-admin-tab")) {
            const adminButton = document.createElement("button");
            adminButton.id = "nav-admin-tab";
            adminButton.className = "nav-item";
            adminButton.setAttribute("onclick", "switchScreen('admin', this); loadAdminGachaPanel(); loadAdminGalleryApprovals(); loadAdminReports('pending'); loadAppVersionAdmin();");
            adminButton.innerHTML = `
                <i class="fa-solid fa-user-shield"></i>
                <span>Staff</span>
            `;
            nav.insertBefore(adminButton, nav.lastElementChild);
        }
    } else {
        const adminButton = document.getElementById("nav-admin-tab");
        if (adminButton) adminButton.remove();

        const activeScreen = document.querySelector(".app-screen.active");
        if (activeScreen && activeScreen.id === "screen-admin") {
            switchScreen("home");
        }
    }
}

// ===== Reportar contenido (comentario/foto de galería/capítulo) =====
// Boton generico reusado en los 3 lugares -el backend valida que el content_id exista de
// verdad antes de encolar, y el UNIQUE en content_reports evita que un mismo usuario spamee
// el mismo reporte varias veces (la segunda vez el server responde already_reported).
async function reportContent(contentType, contentId) {
    if (!contentId) return;
    if (!authToken) {
        showNotification('Inicia sesión para reportar contenido.');
        switchScreen('login');
        return;
    }
    const reason = prompt('¿Por qué reportas este contenido?');
    if (reason === null) return; // Canceló el prompt, no se manda nada.
    if (!reason.trim()) {
        showNotification('Escribe un motivo para poder enviar el reporte.');
        return;
    }
    try {
        const data = await apiRequest('report_content.php', {
            method: 'POST',
            body: JSON.stringify({ content_type: contentType, content_id: contentId, reason }),
        });
        showNotification(data.already_reported ? 'Ya habías reportado esto — el staff ya lo tiene en la cola.' : 'Reporte enviado. Gracias por avisar.');
    } catch (err) {
        showNotification('No se pudo enviar el reporte: ' + err.message);
    }
}

// ===== Panel de Staff: usuarios (suspensiones) =====
let adminUserSearchTimer = null;
function debounceAdminUserSearch() {
    clearTimeout(adminUserSearchTimer);
    adminUserSearchTimer = setTimeout(adminSearchUsers, 350);
}

async function adminSearchUsers() {
    const q = document.getElementById('admin-user-search-input').value.trim();
    const container = document.getElementById('admin-user-search-results');
    if (q.length < 2) {
        container.innerHTML = '';
        return;
    }
    try {
        const data = await apiRequest('admin_user_search.php?q=' + encodeURIComponent(q));
        renderAdminUserSearchResults(data.users);
    } catch (err) {
        container.innerHTML = `<p class="empty-grid-msg">Error: ${err.message}</p>`;
    }
}

function renderAdminUserSearchResults(users) {
    const container = document.getElementById('admin-user-search-results');
    if (users.length === 0) {
        container.innerHTML = '<p class="empty-grid-msg">Sin resultados.</p>';
        return;
    }
    container.innerHTML = users.map(u => {
        const isBanned = u.banned_until && new Date(u.banned_until) > new Date();
        const isVip = u.vip_until && new Date(u.vip_until) > new Date();
        return `
            <div class="admin-user-row">
                <div class="admin-user-info">
                    <strong>${escapeHtml(u.username)}</strong>${u.role >= 1 ? ' <span class="admin-user-staff-badge">Staff</span>' : ''}
                    <span class="admin-user-sub">${escapeHtml(u.email)} · ${u.coins} Runas</span>
                    ${isBanned ? `<span class="admin-user-banned">Suspendido hasta ${new Date(u.banned_until).toLocaleString()}</span>` : ''}
                    ${isVip ? `<span class="admin-user-vip">VIP hasta ${new Date(u.vip_until).toLocaleString()}</span>` : ''}
                </div>
                <div class="admin-user-actions">
                    <button class="btn-admin-submit" onclick="adminRequestAvatarChange(${u.id})" title="Le pide que cambie su foto de perfil pública">Pedir cambio de foto</button>
                    ${isBanned
                        ? `<button class="btn-admin-submit btn-admin-unban" onclick="adminUnbanUser(${u.id})">Quitar suspensión</button>`
                        : `<select id="admin-ban-days-${u.id}" class="admin-input admin-ban-select">
                               <option value="1">1 día</option>
                               <option value="3">3 días</option>
                               <option value="7">7 días</option>
                               <option value="30">30 días</option>
                               <option value="36500">Permanente</option>
                           </select>
                           <button class="btn-admin-submit btn-admin-ban" onclick="adminBanUser(${u.id})">Suspender</button>`}
                    <select id="admin-vip-days-${u.id}" class="admin-input admin-ban-select">
                        <option value="1">1 día</option>
                        <option value="7">7 días</option>
                        <option value="15">15 días</option>
                        <option value="30" selected>30 días</option>
                        <option value="90">90 días</option>
                    </select>
                    <button class="btn-admin-submit btn-admin-vip" onclick="adminGrantVip(${u.id})">Regalar VIP</button>
                    ${isVip ? `<button class="btn-admin-submit btn-admin-unban" onclick="adminRevokeVip(${u.id})">Quitar VIP</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

async function adminRequestAvatarChange(userId) {
    if (!confirm('¿Pedirle a este usuario que cambie su foto de perfil? Le va a llegar una notificación.')) return;
    try {
        await apiRequest('admin_request_avatar_change.php', { method: 'POST', body: JSON.stringify({ user_id: userId }) });
        showNotification('Pedido enviado.');
    } catch (err) {
        showNotification('No se pudo enviar el pedido: ' + err.message);
    }
}

async function adminBanUser(userId) {
    const days = parseInt(document.getElementById(`admin-ban-days-${userId}`).value, 10);
    if (!confirm(`¿Suspender a este usuario por ${days} día(s)?`)) return;
    try {
        await apiRequest('admin_ban_user.php', { method: 'POST', body: JSON.stringify({ user_id: userId, days }) });
        showNotification('Usuario suspendido.');
        adminSearchUsers();
    } catch (err) {
        showNotification('No se pudo suspender: ' + err.message);
    }
}

async function adminUnbanUser(userId) {
    try {
        await apiRequest('admin_ban_user.php', { method: 'POST', body: JSON.stringify({ user_id: userId, unban: true }) });
        showNotification('Suspensión levantada.');
        adminSearchUsers();
    } catch (err) {
        showNotification('No se pudo levantar la suspensión: ' + err.message);
    }
}

async function adminGrantVip(userId) {
    const days = parseInt(document.getElementById(`admin-vip-days-${userId}`).value, 10);
    if (!confirm(`¿Regalar VIP por ${days} día(s) a este usuario?`)) return;
    try {
        await apiRequest('admin_grant_vip.php', { method: 'POST', body: JSON.stringify({ user_id: userId, days }) });
        showNotification('VIP otorgado.');
        adminSearchUsers();
    } catch (err) {
        showNotification('No se pudo otorgar VIP: ' + err.message);
    }
}

async function adminRevokeVip(userId) {
    if (!confirm('¿Quitar el VIP de este usuario?')) return;
    try {
        await apiRequest('admin_grant_vip.php', { method: 'POST', body: JSON.stringify({ user_id: userId, revoke: true }) });
        showNotification('VIP retirado.');
        adminSearchUsers();
    } catch (err) {
        showNotification('No se pudo quitar el VIP: ' + err.message);
    }
}

// ===== Panel de Staff: subir capítulo (2026-07-18) =====
// Flujo en 3 pasos porque el hosting solo acepta 20 archivos por petición (mismo limite que
// gacha_admin_cards_bulk.php): 1) crear el capitulo OCULTO, 2) subir las paginas en tandas de
// 20 en secuencia, 3) recien ahi hacerlo visible. Si algo falla a mitad de camino, el capitulo
// se queda oculto (nunca a medias para un lector) y se ofrece reintentar o cancelarlo.
const CHAPTER_UPLOAD_BATCH_SIZE = 20;

async function searchMangaForChapterUpload(query) {
    const resultsEl = document.getElementById('chapter-upload-manga-results');
    if (!query.trim()) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; return; }
    try {
        const data = await apiRequest(`mangas.php?search=${encodeURIComponent(query)}&page=1`);
        const top = (data.mangas || []).slice(0, 6);
        resultsEl.innerHTML = top.length
            ? top.map(m => `<div class="search-dropdown-item" onclick="selectMangaForChapterUpload(${m.id}, '${m.title.replace(/'/g, "\\'")}')"><span class="search-dropdown-item-title">${m.title}</span></div>`).join('')
            : '<div class="search-dropdown-empty">Sin resultados</div>';
        resultsEl.classList.add('active');
    } catch (err) {
        resultsEl.classList.remove('active');
    }
}

function selectMangaForChapterUpload(mangaId, mangaTitle) {
    document.getElementById('chapter-upload-manga-search').value = mangaTitle;
    document.getElementById('chapter-upload-manga-id').value = mangaId;
    document.getElementById('chapter-upload-manga-results').classList.remove('active');
}

async function startChapterUpload() {
    const mangaId = document.getElementById('chapter-upload-manga-id').value;
    const chapterNumber = document.getElementById('chapter-upload-number').value.trim();
    const title = document.getElementById('chapter-upload-title').value.trim();
    const filesInput = document.getElementById('chapter-upload-files');
    const files = Array.from(filesInput.files || []);
    const progressEl = document.getElementById('chapter-upload-progress');
    const submitBtn = document.getElementById('chapter-upload-submit-btn');

    if (!mangaId) { showNotification('Elige una obra de la lista de resultados.'); return; }
    if (!chapterNumber) { showNotification('Escribe el número de capítulo.'); return; }
    if (files.length === 0) { showNotification('Elige las páginas del capítulo.'); return; }

    submitBtn.disabled = true;
    let chapterId = null;
    try {
        progressEl.textContent = 'Creando capítulo...';
        const created = await apiRequest('chapter_upload_create.php', {
            method: 'POST',
            body: JSON.stringify({ manga_id: mangaId, chapter_number: chapterNumber, title }),
        });
        chapterId = created.chapter_id;

        const totalBatches = Math.ceil(files.length / CHAPTER_UPLOAD_BATCH_SIZE);
        for (let b = 0; b < totalBatches; b++) {
            const startIndex = b * CHAPTER_UPLOAD_BATCH_SIZE;
            const batchFiles = files.slice(startIndex, startIndex + CHAPTER_UPLOAD_BATCH_SIZE);
            progressEl.textContent = `Subiendo páginas ${startIndex + 1}–${startIndex + batchFiles.length} de ${files.length} (lote ${b + 1}/${totalBatches})...`;

            const formData = new FormData();
            formData.append('chapter_id', chapterId);
            formData.append('start_index', startIndex);
            batchFiles.forEach(f => formData.append('pages[]', f));

            const result = await apiUploadFormData('chapter_upload_pages.php', formData);
            if (result.errors && result.errors.length) {
                throw new Error('Algunas páginas fallaron: ' + result.errors.join(', '));
            }
        }

        progressEl.textContent = 'Publicando capítulo...';
        await apiRequest('chapter_upload_finalize.php', {
            method: 'POST',
            body: JSON.stringify({ chapter_id: chapterId }),
        });

        showNotification('Capítulo publicado.');
        progressEl.textContent = '';
        filesInput.value = '';
        document.getElementById('chapter-upload-number').value = '';
        document.getElementById('chapter-upload-title').value = '';
        document.getElementById('chapter-upload-manga-search').value = '';
        document.getElementById('chapter-upload-manga-id').value = '';
    } catch (err) {
        progressEl.textContent = '';
        if (chapterId && confirm(`Falló la subida (${err.message}). El capítulo quedó sin publicar. ¿Borrar lo que se alcanzó a subir para volver a intentar de cero?`)) {
            try {
                await apiRequest('chapter_upload_delete.php', { method: 'POST', body: JSON.stringify({ chapter_id: chapterId }) });
                showNotification('Capítulo a medias borrado. Intenta de nuevo.');
            } catch (delErr) {
                showNotification('No se pudo borrar el capítulo a medias: ' + delErr.message);
            }
        } else {
            showNotification('Error: ' + err.message);
        }
    } finally {
        submitBtn.disabled = false;
    }
}

// ===== Panel de Staff: borrar comentarios =====
// scopeName es opcional: cuando se borra desde el hilo de comentarios abierto (manga/capitulo
// que se esta viendo), se recarga esa lista. Cuando se borra desde la cola de Reportes (donde el
// comentario puede ser de CUALQUIER manga/capitulo, no el que esta abierto ahora), no se pasa
// scopeName -recargar con un scope inventado mostraria comentarios de otra obra por error.
async function adminDeleteComment(commentId, scopeName) {
    if (!confirm('¿Borrar este comentario? Esto también borra sus respuestas. No se puede deshacer.')) return false;
    try {
        await apiRequest('comment_admin_delete.php', { method: 'POST', body: JSON.stringify({ comment_id: commentId }) });
        showNotification('Comentario borrado.');
        if (scopeName) {
            const scope = commentScopes[scopeName];
            loadComments(scopeName, scope.getId());
        }
        return true;
    } catch (err) {
        showNotification('No se pudo borrar el comentario: ' + err.message);
        return false;
    }
}

// Desde la cola de Reportes: solo marca el reporte como resuelto si el borrado realmente se
// confirmo y se completo -si el staff cancela el confirm() o el borrado falla, el reporte se
// queda pendiente en vez de desaparecer sin que se haya hecho nada.
async function adminDeleteReportedComment(commentId, reportId) {
    const deleted = await adminDeleteComment(commentId);
    if (deleted) adminResolveReport(reportId);
}

// ===== Panel de Staff: cola de reportes =====
const ADMIN_REPORT_TYPE_LABELS = { comment: 'Comentario', gallery_photo: 'Foto de Galería', chapter: 'Capítulo' };
let adminReportsCurrentStatus = 'pending';

async function loadAdminReports(status) {
    adminReportsCurrentStatus = status;
    document.getElementById('admin-reports-tab-pending').classList.toggle('active', status === 'pending');
    document.getElementById('admin-reports-tab-resolved').classList.toggle('active', status === 'resolved');

    const list = document.getElementById('admin-reports-list');
    list.innerHTML = '<p class="empty-grid-msg">Cargando...</p>';
    try {
        const data = await apiRequest('admin_reports_list.php?status=' + status);
        renderAdminReports(data.reports);
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">Error: ${err.message}</p>`;
    }
}

function renderAdminReports(reports) {
    const list = document.getElementById('admin-reports-list');
    const countEl = document.getElementById('admin-reports-count');
    if (adminReportsCurrentStatus === 'pending') {
        countEl.textContent = reports.length > 0 ? `(${reports.length})` : '';
    }

    if (reports.length === 0) {
        list.innerHTML = `<p class="empty-grid-msg">No hay reportes ${adminReportsCurrentStatus === 'pending' ? 'pendientes' : 'resueltos'}.</p>`;
        return;
    }

    list.innerHTML = reports.map(r => {
        const typeLabel = ADMIN_REPORT_TYPE_LABELS[r.content_type] || r.content_type;
        const previewText = !r.exists
            ? '(este contenido ya no existe — probablemente ya se borró)'
            : (r.preview ? escapeHtml(r.preview.text || '') + (r.preview.author ? ` — por ${escapeHtml(r.preview.author)}` : '') : '');
        const resolveBtn = r.status === 'pending'
            ? `<button class="btn-admin-submit" onclick="adminResolveReport(${r.id})">Marcar resuelto</button>`
            : '';
        const deleteCommentBtn = (r.status === 'pending' && r.content_type === 'comment' && r.exists)
            ? `<button class="btn-admin-submit btn-admin-ban" onclick="adminDeleteReportedComment(${r.content_id}, ${r.id})">Borrar comentario</button>`
            : '';
        return `
            <div class="admin-report-row">
                <div class="admin-report-info">
                    <strong>${typeLabel} #${r.content_id}</strong>
                    <span class="admin-user-sub">${previewText}</span>
                    ${r.reason ? `<span class="admin-report-reason">Motivo: ${escapeHtml(r.reason)}</span>` : ''}
                    <span class="admin-user-sub">Reportado por ${escapeHtml(r.reporter_username)} · ${timeAgo(r.created_at)}</span>
                </div>
                <div class="admin-user-actions">${deleteCommentBtn}${resolveBtn}</div>
            </div>
        `;
    }).join('');
}

async function adminResolveReport(reportId) {
    try {
        await apiRequest('admin_reports_resolve.php', { method: 'POST', body: JSON.stringify({ report_id: reportId }) });
        loadAdminReports(adminReportsCurrentStatus);
    } catch (err) {
        showNotification('No se pudo marcar como resuelto: ' + err.message);
    }
}

// ===== Galería de fotos (UGC) real, organizada por proyecto =====
// Nota: la descarga en HD por Runas que existía antes (demo, "downloadWaifu") queda en pausa
// a propósito - es parte de la conversación de monetización que el staff todavía no cierra.
let galleryPhotosCache = [];
let galleryCurrentView = 'all';
let galleryMangaFilter = null; // { id, title } o null
let gallerySort = 'recent'; // 'recent' | 'popular'
let galleryPage = 1;
let galleryHasMore = false;
let galleryLoadingMore = false;

// page=1 (defecto) reemplaza la cache - se usa al cambiar filtro/orden o al entrar de nuevo a
// la pantalla. page>1 (desde "Cargar más") la acumula en vez de reemplazarla.
async function loadGalleryPhotos(page = 1) {
    const container = document.getElementById("gallery-grid-container");
    if (!container) return;
    if (page === 1) {
        container.innerHTML = '<p class="empty-grid-msg"><i class="fa-solid fa-spinner fa-spin"></i> Cargando galería...</p>';
    }

    try {
        const params = new URLSearchParams();
        if (galleryMangaFilter) params.set('manga_id', galleryMangaFilter.id);
        if (gallerySort === 'popular') params.set('sort', 'popular');
        params.set('page', page);
        const data = await apiRequest(`gallery_list.php?${params.toString()}`);
        galleryPhotosCache = page === 1 ? data.photos : galleryPhotosCache.concat(data.photos);
        galleryPage = page;
        galleryHasMore = !!data.has_more;
        renderGalleryGrid();
        updateGalleryLoadMoreButton();
    } catch (err) {
        if (page === 1) {
            container.innerHTML = `<p class="empty-grid-msg">No se pudo cargar la galería.<br>${err.message}</p>`;
        } else {
            showNotification('No se pudieron cargar más fotos: ' + err.message);
        }
    }
}

function updateGalleryLoadMoreButton() {
    const btn = document.getElementById('btn-gallery-load-more');
    if (!btn) return;
    btn.style.display = galleryHasMore ? 'block' : 'none';
    btn.textContent = 'Cargar más';
    btn.disabled = false;
}

async function loadMoreGalleryPhotos() {
    if (galleryLoadingMore || !galleryHasMore) return;
    galleryLoadingMore = true;
    const btn = document.getElementById('btn-gallery-load-more');
    if (btn) { btn.textContent = 'Cargando...'; btn.disabled = true; }
    await loadGalleryPhotos(galleryPage + 1);
    galleryLoadingMore = false;
}

function setGallerySort(sort) {
    gallerySort = sort;
    document.getElementById('gallery-sort-recent').classList.toggle('active', sort === 'recent');
    document.getElementById('gallery-sort-popular').classList.toggle('active', sort === 'popular');
    loadGalleryPhotos();
}

function renderGalleryGrid() {
    const container = document.getElementById("gallery-grid-container");
    if (!container) return;

    const filtered = galleryCurrentView === 'all'
        ? galleryPhotosCache
        : galleryPhotosCache.filter(p => (p.uploader_role >= 1 ? 'admin' : 'ugc') === galleryCurrentView);

    if (filtered.length === 0) {
        container.innerHTML = '<p class="empty-grid-msg">Todavía no hay fotos aquí.<br>¡Sé el primero en subir una!</p>';
        return;
    }

    container.innerHTML = filtered.map((photo, index) => {
        const isStaff = photo.uploader_role >= 1;
        // Blur si la foto esta marcada +18 y el filtro NSFW global esta activo (mismo criterio
        // que las portadas). El overlay se quita al tocar (revealGalleryNsfw) sin abrir el visor.
        const blurred = photo.is_nsfw && nsfwFilterEnabled;
        const delay = Math.min(index, 12) * 0.04;
        return `
            <div class="waifu-card" style="animation-delay: ${delay}s" onclick="openGalleryViewer(${photo.id})">
                <div class="waifu-image">
                    <img src="${siteUrl(photo.feed_image)}" alt="${photo.title}" class="${blurred ? 'nsfw-blurred' : ''}" data-photo-id="${photo.id}">
                    ${blurred ? `<div class="gallery-card-nsfw" onclick="revealGalleryNsfw(event, ${photo.id})"><i class="fa-solid fa-eye-slash"></i> +18</div>` : ''}
                    ${photo.is_boosted ? '<span class="gallery-boost-badge"><i class="fa-solid fa-rocket"></i> Destacada</span>' : ''}
                    <span class="uploader-badge ${isStaff ? 'admin' : 'user'}">
                        <i class="fa-solid ${isStaff ? 'fa-shield-halved' : 'fa-user'}"></i> ${isStaff ? 'Staff' : 'Fans'}
                    </span>
                </div>
                <div class="waifu-info">
                    <h4>${photo.title}</h4>
                    ${photo.manga_title ? `<p class="waifu-manga-tag">${photo.manga_title}</p>` : ''}
                    <div class="waifu-stats">
                        <button class="btn-like ${photo.liked_by_me ? 'liked' : ''}" data-photo-id="${photo.id}" onclick="event.stopPropagation(); toggleGalleryLike(${photo.id})">
                            <i class="${photo.liked_by_me ? 'fa-solid' : 'fa-regular'} fa-heart"></i> <span class="like-count">${photo.likes_count}</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Destapa una foto +18 en la grilla (sin abrir el visor). event.stopPropagation evita que el
// mismo tap abra el lightbox de la tarjeta.
function revealGalleryNsfw(event, photoId) {
    event.stopPropagation();
    const img = document.querySelector(`.waifu-image img[data-photo-id="${photoId}"]`);
    if (img) img.classList.remove('nsfw-blurred');
    event.currentTarget.remove();
}

async function toggleGalleryLike(photoId) {
    if (!authToken) {
        showNotification('Inicia sesión para dar like.');
        switchScreen('login');
        return;
    }
    try {
        const result = await apiRequest('gallery_like.php', { method: 'POST', body: JSON.stringify({ photo_id: photoId }) });
        const photo = galleryPhotosCache.find(p => p.id === photoId);
        if (photo) {
            photo.liked_by_me = result.liked;
            photo.likes_count = result.likes_count;
            // Actualiza el boton en el sitio en vez de re-renderizar toda la grilla: evita el
            // parpadeo de imagenes recargando y permite un "pop" que solo se dispara en el click
            // real (si reconstruyeramos el HTML, el pop se repetiria en cada foto ya likeada
            // cada vez que se re-renderiza la grilla por cualquier motivo).
            const btn = document.querySelector(`.btn-like[data-photo-id="${photoId}"]`);
            if (btn) {
                btn.classList.toggle('liked', result.liked);
                btn.querySelector('i').className = (result.liked ? 'fa-solid' : 'fa-regular') + ' fa-heart';
                btn.querySelector('.like-count').textContent = result.likes_count;
                if (result.liked) {
                    btn.classList.remove('like-pop');
                    void btn.offsetWidth;
                    btn.classList.add('like-pop');
                }
            }
        }
        // Si el visor a pantalla completa esta abierto sobre esta misma foto, refleja el cambio
        // ahi tambien (sin tener que cerrarlo y reabrirlo).
        if (galleryViewerCurrentId === photoId) {
            const likeBtn = document.getElementById('gallery-viewer-like');
            likeBtn.classList.toggle('liked', result.liked);
            likeBtn.querySelector('i').className = (result.liked ? 'fa-solid' : 'fa-regular') + ' fa-heart';
            document.getElementById('gallery-viewer-like-count').textContent = result.likes_count;
        }
    } catch (err) {
        showNotification('No se pudo dar like: ' + err.message);
    }
}

// ===== Visor de foto a pantalla completa (lightbox) =====
let galleryViewerCurrentId = null;

function openGalleryViewer(photoId) {
    const photo = galleryPhotosCache.find(p => p.id === photoId);
    if (!photo) return;
    galleryViewerCurrentId = photoId;

    document.getElementById('gallery-viewer-img').src = siteUrl(photo.is_hd_unlocked ? photo.image_path : photo.feed_image);
    document.getElementById('gallery-viewer-title').textContent = photo.title;
    const isStaff = photo.uploader_role >= 1;
    const sub = [`Por ${photo.uploader_username}${isStaff ? ' (Staff)' : ''}`];
    if (photo.manga_title) sub.push(photo.manga_title);
    if (photo.is_nsfw) sub.push('+18');
    if (photo.is_boosted) sub.push('Destacada');
    document.getElementById('gallery-viewer-sub').textContent = sub.join(' · ');

    // Destacar (boost): solo el dueño, solo si no tiene un boost activo ya.
    const isOwner = currentUser && currentUser.id === photo.uploader_id;
    const boostBtn = document.getElementById('gallery-viewer-boost');
    boostBtn.style.display = (isOwner && !photo.is_boosted) ? 'inline-flex' : 'none';

    // Desbloquear HD: solo si hay un preview comprimido distinto del original y todavia no
    // esta desbloqueada para este usuario (el dueño ya viene desbloqueado desde el backend).
    const unlockBtn = document.getElementById('gallery-viewer-unlock-hd');
    unlockBtn.style.display = (photo.preview_path && !photo.is_hd_unlocked) ? 'inline-flex' : 'none';

    // Like
    const likeBtn = document.getElementById('gallery-viewer-like');
    likeBtn.classList.toggle('liked', !!photo.liked_by_me);
    likeBtn.querySelector('i').className = (photo.liked_by_me ? 'fa-solid' : 'fa-regular') + ' fa-heart';
    document.getElementById('gallery-viewer-like-count').textContent = photo.likes_count;

    // Borrar: solo lo ve el dueño de la foto o el staff.
    const canDelete = currentUser && (currentUser.id === photo.uploader_id || (currentUser.role || 0) >= 1);
    document.getElementById('gallery-viewer-delete').style.display = canDelete ? 'inline-flex' : 'none';

    // Reportar: cualquiera logueado que NO sea el dueño (reportar tu propia foto no tiene sentido).
    const canReport = currentUser && currentUser.id !== photo.uploader_id;
    document.getElementById('gallery-viewer-report').style.display = canReport ? 'inline-flex' : 'none';

    // Censura +18: si el filtro global esta activo, arranca tapada hasta que se toque.
    const nsfwOverlay = document.getElementById('gallery-viewer-nsfw');
    const img = document.getElementById('gallery-viewer-img');
    if (photo.is_nsfw && nsfwFilterEnabled) {
        img.classList.add('nsfw-blurred');
        nsfwOverlay.style.display = 'flex';
    } else {
        img.classList.remove('nsfw-blurred');
        nsfwOverlay.style.display = 'none';
    }

    document.getElementById('gallery-viewer-overlay').classList.add('active');
}

function closeGalleryViewer() {
    document.getElementById('gallery-viewer-overlay').classList.remove('active');
    galleryViewerCurrentId = null;
}

function revealGalleryViewerNsfw(event) {
    event.stopPropagation();
    document.getElementById('gallery-viewer-img').classList.remove('nsfw-blurred');
    document.getElementById('gallery-viewer-nsfw').style.display = 'none';
}

// Precio y duracion confirmados por Ockuro (2026-07-01). Deben coincidir con BOOST_COST/BOOST_HOURS en gallery_boost.php.
const GALLERY_BOOST_COST = 15;
const GALLERY_BOOST_HOURS = 24;

async function boostGalleryPhoto(photoId) {
    if (!authToken) {
        showNotification('Inicia sesión para destacar tu foto.');
        switchScreen('login');
        return;
    }
    if (userCoins < GALLERY_BOOST_COST) {
        showNotification(`Runas insuficientes. Necesitas ${GALLERY_BOOST_COST} Runas.`);
        return;
    }
    if (!confirm(`¿Destacar esta foto en la galería por ${GALLERY_BOOST_HOURS}h por ${GALLERY_BOOST_COST} Runas?`)) return;

    try {
        const data = await apiRequest('gallery_boost.php', {
            method: 'POST',
            body: JSON.stringify({ photo_id: photoId }),
        });
        userCoins = data.coins;
        updateCoinsDisplay();
        const photo = galleryPhotosCache.find(p => p.id === photoId);
        if (photo) photo.is_boosted = true;
        showNotification('¡Foto destacada! Aparecerá primero en la galería por ' + GALLERY_BOOST_HOURS + 'h.');
        closeGalleryViewer();
        loadGalleryPhotos();
    } catch (err) {
        showNotification('No se pudo destacar: ' + err.message);
    }
}

// Precio confirmado por Ockuro (2026-07-01). Debe coincidir con HD_UNLOCK_COST en gallery_unlock_hd.php.
const GALLERY_HD_UNLOCK_COST = 10;

async function unlockGalleryPhotoHd(photoId) {
    if (!authToken) {
        showNotification('Inicia sesión para desbloquear la versión HD.');
        switchScreen('login');
        return;
    }
    if (userCoins < GALLERY_HD_UNLOCK_COST) {
        showNotification(`Runas insuficientes. Necesitas ${GALLERY_HD_UNLOCK_COST} Runas.`);
        return;
    }
    if (!confirm(`¿Desbloquear la foto original en calidad completa por ${GALLERY_HD_UNLOCK_COST} Runas?`)) return;

    try {
        const data = await apiRequest('gallery_unlock_hd.php', {
            method: 'POST',
            body: JSON.stringify({ photo_id: photoId }),
        });
        if (typeof data.coins === 'number') {
            userCoins = data.coins;
            updateCoinsDisplay();
        }
        const photo = galleryPhotosCache.find(p => p.id === photoId);
        if (photo) {
            photo.is_hd_unlocked = true;
            photo.image_path = data.image_path;
        }
        document.getElementById('gallery-viewer-img').src = siteUrl(data.image_path);
        document.getElementById('gallery-viewer-unlock-hd').style.display = 'none';
        showNotification('¡Versión HD desbloqueada!');
    } catch (err) {
        showNotification('No se pudo desbloquear: ' + err.message);
    }
}

async function deleteGalleryPhoto(photoId) {
    if (!confirm('¿Seguro que quieres borrar esta foto? No se puede deshacer.')) return;
    try {
        await apiRequest('gallery_delete.php', { method: 'POST', body: JSON.stringify({ id: photoId }) });
        showNotification('Foto borrada.');
        closeGalleryViewer();
        galleryPhotosCache = galleryPhotosCache.filter(p => p.id !== photoId);
        renderGalleryGrid();
    } catch (err) {
        showNotification('No se pudo borrar: ' + err.message);
    }
}

// Busqueda de manga para asociar una foto al subirla ("galeria por proyecto")
let galleryUploadSelectedManga = null;

async function searchMangaForUpload(query) {
    const resultsEl = document.getElementById('gallery-upload-manga-results');
    if (!query.trim()) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; return; }
    try {
        const data = await apiRequest(`mangas.php?search=${encodeURIComponent(query)}&page=1`);
        const top = (data.mangas || []).slice(0, 6);
        resultsEl.innerHTML = top.length
            ? top.map(m => `<div class="search-dropdown-item" onclick="selectMangaForUpload(${m.id}, '${m.title.replace(/'/g, "\\'")}')"><span class="search-dropdown-item-title">${m.title}</span></div>`).join('')
            : '<div class="search-dropdown-empty">Sin resultados</div>';
        resultsEl.classList.add('active');
    } catch (err) {
        resultsEl.classList.remove('active');
    }
}

function selectMangaForUpload(id, title) {
    galleryUploadSelectedManga = { id, title };
    document.getElementById('gallery-upload-manga-search').value = title;
    document.getElementById('gallery-upload-manga-results').classList.remove('active');
}

// Filtro "por proyecto" en la grilla principal de la galería
async function searchMangaForGalleryFilter(query) {
    const resultsEl = document.getElementById('gallery-filter-manga-results');
    if (!query.trim()) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; return; }
    try {
        const data = await apiRequest(`mangas.php?search=${encodeURIComponent(query)}&page=1`);
        const top = (data.mangas || []).slice(0, 6);
        resultsEl.innerHTML = top.length
            ? top.map(m => `<div class="search-dropdown-item" onclick="selectMangaForGalleryFilter(${m.id}, '${m.title.replace(/'/g, "\\'")}')"><span class="search-dropdown-item-title">${m.title}</span></div>`).join('')
            : '<div class="search-dropdown-empty">Sin resultados</div>';
        resultsEl.classList.add('active');
    } catch (err) {
        resultsEl.classList.remove('active');
    }
}

function selectMangaForGalleryFilter(id, title) {
    galleryMangaFilter = { id, title };
    document.getElementById('gallery-filter-manga-search').value = '';
    document.getElementById('gallery-filter-manga-results').classList.remove('active');
    document.getElementById('gallery-filter-active-name').textContent = title;
    document.getElementById('gallery-filter-active-tag').style.display = 'flex';
    loadGalleryPhotos();
}

function clearGalleryMangaFilter() {
    galleryMangaFilter = null;
    document.getElementById('gallery-filter-active-tag').style.display = 'none';
    loadGalleryPhotos();
}

// Banner de gacha en el home (reemplazó al carrusel demo "Recomendado de Hoy"). Se llena con
// la temporada real para no quedar desactualizado cuando cambie o termine.
async function loadHomeGachaBanner() {
    const banner = document.getElementById('gacha-home-banner');
    const titleEl = document.getElementById('gacha-home-banner-title');
    const subtitleEl = document.getElementById('gacha-home-banner-subtitle');
    const gachaTab = document.getElementById('gallery-view-tab-gacha');
    try {
        const data = await apiRequest('gacha_active_season.php');
        if (data.gacha_disabled) {
            const preset = GACHA_STATUS_MESSAGES[data.status] || GACHA_STATUS_MESSAGES.paused;
            titleEl.textContent = preset.title;
            subtitleEl.textContent = data.message || preset.subtitle;
            gachaTab.classList.remove('gacha-tab-live');
        } else if (data.season) {
            titleEl.textContent = data.season.name;
            subtitleEl.textContent = 'Tira y completa el álbum — toca para entrar';
            gachaTab.classList.add('gacha-tab-live');
        } else if (data.next_season) {
            titleEl.textContent = data.next_season.name;
            subtitleEl.textContent = 'Próxima temporada en camino — toca para ver la cuenta atrás';
            gachaTab.classList.remove('gacha-tab-live');
        } else {
            titleEl.textContent = 'Gacha de Galería';
            subtitleEl.textContent = 'Toca para ver el álbum de cartas';
            gachaTab.classList.remove('gacha-tab-live');
        }
        banner.style.display = 'flex';
    } catch (err) {
        banner.style.display = 'none';
    }
}

// Los premios reales quedan debajo de las 24 cartas del album (hay que hacer scroll para
// verlos) - un usuario nuevo entra, ve candados, y se va sin enterarse de que existe un Nitro
// real en juego. Este enlace lo lleva directo ahi sin tener que mover nada de lugar.
function scrollToGachaRewards() {
    document.getElementById('gacha-rewards-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Grid de cartas del album - extraido como funcion propia para reutilizarlo tanto en la
// temporada activa (renderGachaContent) como en el archivo de temporadas pasadas
// (viewArchivedSeason), que necesitan exactamente el mismo render pero con datos distintos.
function buildGachaAlbumGridHtml(cards, owned) {
    return cards.map(card => {
        const qty = owned[card.id] || 0;
        const isOwned = qty > 0;
        const safeName = card.name.replace(/'/g, "\\'");
        const onclickZoom = isOwned ? `onclick="openGachaCardZoom('${card.image_path}', '${safeName}', '${card.rarity}')"` : '';
        return `
            <div class="gacha-card-slot rarity-${card.rarity} ${isOwned ? 'owned' : 'locked'}">
                ${isOwned ? `<img src="${siteUrl(card.image_path)}" alt="${card.name}" ${onclickZoom}>` : '<i class="fa-solid fa-lock"></i>'}
                <span class="gacha-card-name">${isOwned ? card.name : '???'}</span>
                ${qty > 1 ? `<span class="gacha-card-qty">x${qty}</span>` : ''}
                <span class="gacha-card-rarity-tag rarity-${card.rarity}">${GACHA_RARITY_LABELS[card.rarity]}</span>
            </div>
        `;
    }).join('');
}

// ===== Archivo de temporadas pasadas: ver que cartas saco el jugador en albumes ya cerrados =====
async function openGachaArchive() {
    document.getElementById('gacha-archive-overlay').classList.add('active');
    document.getElementById('gacha-archive-list-view').style.display = 'block';
    document.getElementById('gacha-archive-detail-view').style.display = 'none';
    const listEl = document.getElementById('gacha-archive-list');
    listEl.innerHTML = '<p class="empty-grid-msg"><i class="fa-solid fa-spinner fa-spin"></i> Cargando temporadas...</p>';
    try {
        const seasons = await apiRequest('gacha_past_seasons.php');
        if (seasons.length === 0) {
            listEl.innerHTML = '<p class="empty-grid-msg">Todavía no hay temporadas pasadas.<br>Esta es la primera.</p>';
            return;
        }
        listEl.innerHTML = seasons.map(s => `
            <div class="gacha-archive-item" onclick="viewArchivedSeason(${s.id})">
                <div>
                    <h4>${s.name}</h4>
                    <span class="gacha-season-dates">${new Date(s.start_date).toLocaleDateString('es-ES')} – ${new Date(s.end_date).toLocaleDateString('es-ES')}</span>
                </div>
                <i class="fa-solid fa-chevron-right"></i>
            </div>
        `).join('');
    } catch (err) {
        listEl.innerHTML = `<p class="empty-grid-msg">No se pudo cargar el archivo.<br>${err.message}</p>`;
    }
}

async function viewArchivedSeason(seasonId) {
    document.getElementById('gacha-archive-list-view').style.display = 'none';
    const detailView = document.getElementById('gacha-archive-detail-view');
    detailView.style.display = 'block';
    detailView.innerHTML = '<p class="empty-grid-msg"><i class="fa-solid fa-spinner fa-spin"></i> Cargando álbum...</p>';

    try {
        const data = await apiRequest(`gacha_active_season.php?season_id=${seasonId}`);
        const ownedCount = Object.keys(data.owned).length;
        const medals = ['🥇', '🥈', '🥉'];
        detailView.innerHTML = `
            <button class="gacha-archive-back" onclick="document.getElementById('gacha-archive-list-view').style.display='block'; document.getElementById('gacha-archive-detail-view').style.display='none';">
                <i class="fa-solid fa-arrow-left"></i> Temporadas anteriores
            </button>
            <h3>${data.season.name}</h3>
            <span class="gacha-season-dates">Terminó el ${new Date(data.season.end_date).toLocaleDateString('es-ES')}</span>
            <div class="gacha-progress" style="margin-top:14px;">
                <span>${ownedCount} / ${data.cards.length} cartas${data.completed ? ` — completaste el álbum (puesto #${data.completion_rank})` : ''}</span>
                <div class="gacha-progress-bar"><div class="gacha-progress-fill" style="width:${data.cards.length ? (ownedCount / data.cards.length) * 100 : 0}%"></div></div>
            </div>
            <div class="gacha-album-grid" style="margin-top:16px;">${buildGachaAlbumGridHtml(data.cards, data.owned)}</div>
            <div class="gacha-leaderboard" style="margin-top:20px;">
                <h4><i class="fa-solid fa-trophy"></i> Tabla de líderes</h4>
                <div>${data.leaderboard.length === 0
                    ? '<p class="empty-grid-msg">Nadie completó el álbum.</p>'
                    : data.leaderboard.map(row => `
                        <div class="gacha-leaderboard-row">
                            <span>${medals[row.rank_position - 1] || ('#' + row.rank_position)} ${row.username}</span>
                            <span class="gacha-leaderboard-date">${new Date(row.completed_at).toLocaleDateString('es-ES')}</span>
                        </div>
                    `).join('')}</div>
            </div>
        `;
    } catch (err) {
        detailView.innerHTML = `<p class="empty-grid-msg">No se pudo cargar esa temporada.<br>${err.message}</p>`;
    }
}

function closeGachaArchive() {
    document.getElementById('gacha-archive-overlay').classList.remove('active');
}

function goToGachaFromBanner() {
    switchScreen('gallery');
    switchGalleryView('gacha', document.getElementById('gallery-view-tab-gacha'));
}

// Acceso directo desde la ficha de un manga a su galeria filtrada
function viewMangaGallery() {
    if (!activeManga) return;
    switchScreen('gallery');
    selectMangaForGalleryFilter(activeManga.id, activeManga.title);
}

// Filter gallery view
// Antes era filterGallery(): solo filtraba las tarjetas de fan-art por categoria. Ahora la
// pestaña "Álbum" cambia a una vista completamente distinta (el gacha), no solo un filtro,
// asi que se renombro y se le agrego ese caso.
function switchGalleryView(view, tabEl) {
    document.querySelectorAll(".gallery-tab").forEach(t => t.classList.remove("active"));
    (tabEl || event.currentTarget).classList.add("active");

    const gridContainer = document.getElementById("gallery-grid-container");
    const uploadBtn = document.getElementById("btn-upload-photo");
    const gachaSection = document.getElementById("gacha-section");
    const controlsRow = document.getElementById("gallery-controls-row");
    const headerTitle = document.getElementById("gallery-header-title");
    const headerSub = document.getElementById("gallery-header-sub");

    if (view === "gacha") {
        gridContainer.style.display = "none";
        uploadBtn.style.display = "none";
        // El buscador "por proyecto" y el orden Recientes/Populares solo tienen sentido para
        // fan-art (un monton de fotos sueltas) - el album del gacha es un set fijo de cartas
        // enumeradas, ordenarlo o filtrarlo por manga no significa nada. Sin esto, quedaba una
        // caja vacia con solo el toggle de orden flotando, ocupando espacio de pantalla gratis.
        controlsRow.style.display = "none";
        gachaSection.style.display = "block";
        headerTitle.textContent = "Álbum de Colección";
        headerSub.textContent = "Completa las temporadas oficiales y gana premios reales";
        loadGachaSeason();
        return;
    }

    gridContainer.style.display = "grid";
    uploadBtn.style.display = "flex";
    controlsRow.style.display = "flex";
    gachaSection.style.display = "none";
    headerTitle.textContent = "Galería de la Comunidad";
    headerSub.textContent = "Ilustraciones y arte compartidos por el staff y los fans";

    galleryCurrentView = view;
    renderGalleryGrid();
}

// ===== Gacha / Álbum de Galería =====
// Escala Tolkien, fija para siempre (no atada a la tematica de ninguna temporada en
// particular, a diferencia de los nombres futbolero/Mundial que tenia antes - decision del
// usuario 2026-06-26, ver GACHA_SEASONS_PLANNING.md). Los valores internos (common/rare/
// epic/legendary) no cambian -ya estan en la base de datos real-, solo la etiqueta visible.
const GACHA_RARITY_LABELS = { common: 'Hobbit', rare: 'Rohirrim', epic: 'Maiar', legendary: 'Anillo Único' };
const GACHA_RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3 };

let gachaState = null;
let gachaPulling = false;
// Se guarda el refresh del album/leaderboard para correrlo recien cuando se cierra el modal de
// revelado, no antes - si se refresca apenas llega la respuesta, la carta nueva queda visible
// "atras" del overlay semitransparente mientras el tablero todavia esta animando, arruinando
// la sorpresa.
let gachaPendingRefresh = null;

let gachaCountdownInterval = null;

// Mensajes por defecto para cada estado que puede poner el staff (ver
// admin_gacha_set_status.php) - si de paso escribe un mensaje personalizado, ese reemplaza el
// subtitulo de abajo, pero el titulo siempre queda fijo por estado.
const GACHA_STATUS_MESSAGES = {
    coming_soon: { title: '¡Muy pronto!', subtitle: 'Estamos preparando el Gacha — vuelve pronto.' },
    maintenance: { title: 'Estamos puliendo el Gacha', subtitle: 'Volvemos enseguida con los ajustes listos.' },
    paused: { title: 'Gacha en pausa', subtitle: 'Vuelve más tarde.' },
};

async function loadGachaSeason() {
    const noSeasonBox = document.getElementById('gacha-no-season-box');
    const content = document.getElementById('gacha-content');
    if (gachaCountdownInterval) { clearInterval(gachaCountdownInterval); gachaCountdownInterval = null; }

    try {
        const data = await apiRequest('gacha_active_season.php');
        if (data.gacha_disabled) {
            noSeasonBox.style.display = 'block';
            content.style.display = 'none';
            const preset = GACHA_STATUS_MESSAGES[data.status] || GACHA_STATUS_MESSAGES.paused;
            document.getElementById('gacha-no-season-title').textContent = preset.title;
            document.getElementById('gacha-no-season-subtitle').textContent = data.message || preset.subtitle;
            return;
        }
        if (!data.season) {
            noSeasonBox.style.display = 'block';
            content.style.display = 'none';
            document.getElementById('gacha-no-season-title').textContent = 'No hay ningún álbum activo en este momento.';
            renderGachaCountdown(data.next_season || null);
            return;
        }
        gachaState = data;
        noSeasonBox.style.display = 'none';
        content.style.display = 'block';
        renderGachaContent();
    } catch (err) {
        noSeasonBox.style.display = 'block';
        content.style.display = 'none';
        document.getElementById('gacha-no-season-title').textContent = 'No se pudo cargar el álbum.';
        document.getElementById('gacha-no-season-subtitle').textContent = err.message;
    }
}

// Cuenta atrás a la próxima temporada (si el staff ya la dejó programada con una start_date
// futura). Se actualiza solo cada minuto mientras la pestaña Álbum esté abierta.
function renderGachaCountdown(nextSeason) {
    const subtitleEl = document.getElementById('gacha-no-season-subtitle');
    if (!nextSeason) {
        subtitleEl.textContent = 'Próxima temporada en construcción.';
        return;
    }

    const update = () => {
        const diffMs = new Date(nextSeason.start_date).getTime() - Date.now();
        if (diffMs <= 0) {
            subtitleEl.textContent = `"${nextSeason.name}" está por abrir. ¡Actualiza la pantalla!`;
            return;
        }
        const days = Math.floor(diffMs / 86400000);
        const hours = Math.floor((diffMs % 86400000) / 3600000);
        subtitleEl.textContent = `Próxima apertura: "${nextSeason.name}" en ${days}d ${hours}h`;
    };
    update();
    gachaCountdownInterval = setInterval(update, 60000);
}

function renderGachaContent() {
    const { season, cards, owned, completed, completion_rank, leaderboard, pulls_since_legendary } = gachaState;

    document.getElementById('gacha-season-name').textContent = season.name;
    document.getElementById('gacha-season-dates').textContent = `Termina el ${new Date(season.end_date).toLocaleDateString('es-ES')}`;
    // El saldo de Runas ya se muestra siempre arriba en el header global de la app - mostrarlo
    // otra vez aca adentro era un duplicado exacto del mismo numero, sin ningun motivo.

    // Barra de pity del Maiar (cada 15 tiradas): mostrarla motiva en vez de generar
    // desconfianza ("¿esto está trucado?") - decision tomada tras consultar el diseño con otra
    // IA (ver GACHA_SEASONS_PLANNING.md, Ronda 2). El pity del Anillo Único (80) a propósito NO
    // se muestra aqui: con un numero tan grande se siente mas a grindeo que a emocion.
    const pityBar = document.getElementById('gacha-pity-bar');
    if (pulls_since_legendary !== null && pulls_since_legendary !== undefined) {
        const intoCircle = pulls_since_legendary % 15;
        const left = 15 - intoCircle;
        pityBar.style.display = 'flex';
        document.getElementById('gacha-pity-bar-fill').style.width = `${(intoCircle / 15) * 100}%`;
        const text = document.getElementById('gacha-pity-bar-text');
        if (left === 1) {
            pityBar.classList.add('imminent');
            text.textContent = '¡PRÓXIMA TIRADA MAIAR ASEGURADA!';
        } else {
            pityBar.classList.remove('imminent');
            text.textContent = `Maiar garantizado en: ${left} tiradas`;
        }
    } else {
        pityBar.style.display = 'none';
    }

    const ownedCount = Object.keys(owned).length;
    document.getElementById('gacha-progress-text').textContent = `${ownedCount} / ${cards.length} cartas`;
    document.getElementById('gacha-progress-fill').style.width = cards.length ? `${(ownedCount / cards.length) * 100}%` : '0%';

    document.getElementById('gacha-album-grid').innerHTML = buildGachaAlbumGridHtml(cards, owned);

    document.getElementById('gacha-rewards-list').innerHTML = `
        <div class="gacha-reward-row">🥇 1er lugar: ${season.reward_1st || '—'}</div>
        <div class="gacha-reward-row">🥈 2do lugar: ${season.reward_2nd || '—'}</div>
        <div class="gacha-reward-row">🥉 3er lugar: ${season.reward_3rd || '—'}</div>
    `;

    const leaderboardList = document.getElementById('gacha-leaderboard-list');
    if (leaderboard.length === 0) {
        leaderboardList.innerHTML = '<p class="empty-grid-msg">Nadie ha completado el álbum todavía. ¡Sé el primero!</p>';
    } else {
        const medals = ['🥇', '🥈', '🥉'];
        leaderboardList.innerHTML = leaderboard.map(row => `
            <div class="gacha-leaderboard-row">
                <span>${medals[row.rank_position - 1] || ('#' + row.rank_position)} ${row.username}</span>
                <span class="gacha-leaderboard-date">${new Date(row.completed_at).toLocaleDateString('es-ES')}</span>
            </div>
        `).join('');
    }

    const pullButtons = [1, 5, 10].map(n => document.getElementById(`btn-gacha-pull-${n}`));
    [1, 5, 10].forEach(n => {
        const costEl = document.getElementById(`gacha-pull-cost-${n}`);
        if (costEl) costEl.textContent = season.pull_cost * n;
    });
    if (completed) {
        pullButtons.forEach(b => { if (b) b.disabled = true; });
        pullButtons[0].innerHTML = `<i class="fa-solid fa-check"></i> Álbum completo${completion_rank ? ' (puesto #' + completion_rank + ')' : ''}`;
    } else {
        pullButtons.forEach(b => { if (b) b.disabled = false; });
        pullButtons[0].innerHTML = `Tirar x1 (<span id="gacha-pull-cost-1">${season.pull_cost}</span>)`;
    }
}

async function performGachaPull(count) {
    if (gachaPulling || !gachaState) return;
    if (!authToken) {
        showNotification('Inicia sesión para tirar del gacha.');
        switchScreen('login');
        return;
    }

    gachaPulling = true;
    const buttons = [1, 5, 10].map(n => document.getElementById(`btn-gacha-pull-${n}`));
    buttons.forEach(b => { if (b) b.disabled = true; });

    try {
        const result = await apiRequest('gacha_pull.php', { method: 'POST', body: JSON.stringify({ count }) });
        userCoins = result.coins;
        updateCoinsDisplay();

        if (result.vip_granted_until && currentUser) {
            currentUser.vip_until = result.vip_granted_until;
            currentUser.is_vip = true;
            currentUser.is_ad_free = true;
            saveSession(authToken, currentUser);
            renderProfileAuthState();
            showNotification('¡Álbum completado! Ganaste el Juramento del Montaraz por 30 días.');
        }

        // wasOwned se calcula carta por carta, en el orden en que llegaron, para que un
        // duplicado dentro del mismo lote (ej: sale la misma carta dos veces en un x10) se
        // marque bien como duplicado desde la segunda en adelante.
        const cardsWithOwnedFlag = result.cards.map(card => {
            const wasOwned = !!gachaState.owned[card.id];
            gachaState.owned[card.id] = (gachaState.owned[card.id] || 0) + 1;
            return { card, wasOwned };
        });

        if (result.completed) {
            gachaState.completed = true;
            gachaState.completion_rank = result.rank;
        }
        gachaState.pulls_since_legendary = result.pulls_since_legendary;

        // El album/leaderboard de fondo no se refresca todavia (ver nota en gachaPendingRefresh)
        // - se guarda para correrlo cuando el jugador cierre el modal de revelado.
        gachaPendingRefresh = () => {
            renderGachaContent();
            if (result.completed) loadGachaSeason(); // refresca la tabla de lideres con la entrada nueva
        };

        // En un lote x5/x10 el tablero decide una sola vez, mostrando la carta de mayor rareza
        // obtenida en el lote (la mas emocionante), y despues se revela la cuadricula completa.
        const headline = result.cards.reduce(
            (best, c) => (GACHA_RARITY_ORDER[c.rarity] > GACHA_RARITY_ORDER[best.rarity] ? c : best),
            result.cards[0]
        );

        playGachaBoardAnimation(headline.rarity, headline.forced, () => {
            if (result.cards.length === 1) {
                showGachaReveal(cardsWithOwnedFlag[0].card, cardsWithOwnedFlag[0].wasOwned, result.completed, result.rank);
            } else {
                showGachaRevealMulti(cardsWithOwnedFlag, result.completed, result.rank);
            }
        });
    } catch (err) {
        showNotification(err.message);
    } finally {
        gachaPulling = false;
        if (!(gachaState && gachaState.completed)) {
            buttons.forEach(b => { if (b) b.disabled = false; });
        }
    }
}

function showGachaReveal(card, wasOwned, completed, rank) {
    document.getElementById('gacha-board-row').style.display = 'none';
    document.getElementById('gacha-reveal-img').style.display = 'block';
    document.getElementById('gacha-reveal-multi-grid').style.display = 'none';
    document.getElementById('gacha-reveal-img').src = siteUrl(card.image_path);
    document.getElementById('gacha-reveal-name').textContent = card.name;
    const mangaEl = document.getElementById('gacha-reveal-manga');
    mangaEl.textContent = card.manga_title ? `De: ${card.manga_title}` : '';
    mangaEl.style.display = card.manga_title ? 'block' : 'none';
    const rarityEl = document.getElementById('gacha-reveal-rarity');
    rarityEl.style.display = 'inline-block';
    rarityEl.textContent = GACHA_RARITY_LABELS[card.rarity];
    rarityEl.className = 'gacha-rarity-badge rarity-' + card.rarity;
    document.getElementById('gacha-reveal-duplicate').style.display = wasOwned ? 'block' : 'none';

    applyGachaRarityFx(card.rarity);
    document.getElementById('gacha-reveal-overlay').classList.add('active');

    if (completed) {
        setTimeout(() => showNotification(`¡Álbum completo! Quedaste en el puesto #${rank} de la temporada.`), 600);
    }
}

// Resultado de una tirada x5/x10: en vez de la carta unica, se pinta una cuadricula con todas
// las cartas del lote de una vez (mas rapido de revisar que pasarlas una por una). Si alguna
// del lote es el Anillo Unico, el lote entero se gana la entrada especial igual que una tirada
// sencilla legendaria.
function showGachaRevealMulti(cardsWithOwnedFlag, completed, rank) {
    document.getElementById('gacha-board-row').style.display = 'none';
    document.getElementById('gacha-reveal-img').style.display = 'none';
    document.getElementById('gacha-reveal-manga').style.display = 'none';
    document.getElementById('gacha-reveal-rarity').style.display = 'none';
    document.getElementById('gacha-reveal-duplicate').style.display = 'none';
    document.getElementById('gacha-reveal-name').textContent = `¡${cardsWithOwnedFlag.length} cartas obtenidas!`;

    const grid = document.getElementById('gacha-reveal-multi-grid');
    grid.style.display = 'grid';
    grid.innerHTML = cardsWithOwnedFlag.map(({ card, wasOwned }) => {
        const safeName = card.name.replace(/'/g, "\\'");
        return `
        <div class="gacha-reveal-mini-card rarity-${card.rarity}" onclick="openGachaCardZoom('${card.image_path}', '${safeName}', '${card.rarity}')">
            <img src="${siteUrl(card.image_path)}" alt="${card.name}">
            ${wasOwned ? '<span class="gacha-reveal-mini-dup">x2+</span>' : ''}
            <span class="gacha-reveal-mini-name">${card.name}</span>
        </div>
    `;
    }).join('');

    const headlineRarity = cardsWithOwnedFlag.reduce(
        (best, { card }) => (GACHA_RARITY_ORDER[card.rarity] > GACHA_RARITY_ORDER[best] ? card.rarity : best),
        cardsWithOwnedFlag[0].card.rarity
    );
    applyGachaRarityFx(headlineRarity);
    document.getElementById('gacha-reveal-overlay').classList.add('active');

    if (completed) {
        setTimeout(() => showNotification(`¡Álbum completo! Quedaste en el puesto #${rank} de la temporada.`), 600);
    }
}

// "Ruleta" antes de revelar el resultado: una fila de cajas se va iluminando en cadena, cada
// vez mas lento (como una tragamonedas frenando), hasta que se detiene y recien ahi se pinta
// la carta/cuadricula real. El resultado ya esta decidido por el servidor desde antes - esto es
// puro efecto visual para la suspenso, no cambia nada de la logica del sorteo.
let gachaBoardCancelled = false;

// "El Perímetro de la Tierra Media": anillo de 12 casillas sobre un grid 4x4, en vez de una
// fila recta. Posiciones [col, row] (0-3) de cada casilla, en orden de recorrido - ver el ASCII
// de referencia en GACHA_SEASONS_PLANNING.md (Ronda 2):
//   [0] [1] [2] [3]
//   [11]        [4]
//   [10]        [5]
//   [9] [8] [7] [6]
const GACHA_BOARD_POSITIONS = [
    [0, 0], [1, 0], [2, 0], [3, 0],
    [3, 1], [3, 2], [3, 3],
    [2, 3], [1, 3], [0, 3],
    [0, 2], [0, 1],
];
const GACHA_TILE_STEP = 56; // 50px de casilla + 6px de separacion, igual que en el CSS

// Tablero de suspenso antes de mostrar el resultado real: la ficha da una vuelta completa (12
// pasos) y sigue hasta una casilla de aterrizaje elegida al azar, que ya viene pintada con la
// rareza verdadera que decidio el servidor - las otras 11 casillas son solo relleno/adorno, no
// significan nada. Si la tirada vino del asegurado (pity), se avisa con un cartelito al caer.
function playGachaBoardAnimation(finalRarity, forcedType, onDone) {
    gachaBoardCancelled = false;
    const overlay = document.getElementById('gacha-reveal-overlay');
    const boardRow = document.getElementById('gacha-board-row');
    const grid = document.getElementById('gacha-board-grid');
    const token = document.getElementById('gacha-board-token');
    const securedLabel = document.getElementById('gacha-board-secured');

    document.getElementById('gacha-reveal-img').style.display = 'none';
    document.getElementById('gacha-reveal-multi-grid').style.display = 'none';
    document.getElementById('gacha-reveal-manga').style.display = 'none';
    document.getElementById('gacha-reveal-rarity').style.display = 'none';
    document.getElementById('gacha-reveal-duplicate').style.display = 'none';
    document.getElementById('gacha-reveal-name').textContent = '';
    GACHA_RARITY_FX_CLASSES.forEach(c => overlay.classList.remove(c));
    document.getElementById('gacha-fx-layer').innerHTML = '';
    clearGachaParticles();
    securedLabel.classList.remove('show');

    const decoyPool = ['common', 'common', 'common', 'rare', 'rare', 'common', 'epic', 'common', 'rare', 'common', 'rare'];
    const landingIndex = Math.floor(Math.random() * GACHA_BOARD_POSITIONS.length);

    grid.querySelectorAll('.gacha-board-tile').forEach(t => t.remove());
    const tiles = GACHA_BOARD_POSITIONS.map(([col, row], i) => {
        const tile = document.createElement('div');
        const rarity = (i === landingIndex) ? finalRarity : decoyPool[i % decoyPool.length];
        tile.className = `gacha-board-tile rarity-${rarity}`;
        tile.style.left = `${col * GACHA_TILE_STEP}px`;
        tile.style.top = `${row * GACHA_TILE_STEP}px`;
        grid.insertBefore(tile, token);
        return tile;
    });

    token.style.left = '0px';
    token.style.top = '0px';
    boardRow.style.display = 'block';
    overlay.classList.add('active');

    let step = 0;
    // Una vuelta completa (12 pasos) y sigue hasta la casilla de aterrizaje, para que siempre
    // se sienta como un recorrido y no un salto directo a la respuesta.
    const totalSteps = GACHA_BOARD_POSITIONS.length + landingIndex;

    function tick() {
        if (gachaBoardCancelled) return;
        const tileIndex = step % GACHA_BOARD_POSITIONS.length;
        if (step > 0) tiles[(step - 1) % GACHA_BOARD_POSITIONS.length].classList.add('passed');
        const [col, row] = GACHA_BOARD_POSITIONS[tileIndex];
        token.style.left = `${col * GACHA_TILE_STEP}px`;
        token.style.top = `${row * GACHA_TILE_STEP}px`;
        if (step < totalSteps) {
            step++;
            const progress = step / totalSteps;
            const delay = 60 + Math.pow(progress, 2) * 220; // arranca rapido y frena al acercarse
            setTimeout(tick, delay);
        } else {
            setTimeout(() => {
                if (gachaBoardCancelled) return;
                tiles[landingIndex].classList.add('landed');
                if (forcedType) securedLabel.classList.add('show');
                setTimeout(() => {
                    if (gachaBoardCancelled) return;
                    boardRow.style.display = 'none';
                    onDone();
                }, forcedType ? 700 : 450);
            }, 200);
        }
    }
    tick();
}

// Zoom de una carta: click en una miniatura del album o de un lote x5/x10 para verla grande.
function openGachaCardZoom(imagePath, name, rarity) {
    document.getElementById('gacha-card-zoom-img').src = siteUrl(imagePath);
    const caption = document.getElementById('gacha-card-zoom-caption');
    caption.innerHTML = `${name} <span class="gacha-rarity-badge rarity-${rarity}">${GACHA_RARITY_LABELS[rarity]}</span>`;
    document.getElementById('gacha-card-zoom-overlay').classList.add('active');
}

function closeGachaCardZoom() {
    document.getElementById('gacha-card-zoom-overlay').classList.remove('active');
}

// Entrada de cada rareza al revelar el resultado (ver el CSS de cada *-reveal en style.css):
// Hobbit = brillo calido simple, Rohirrim = destello de acero, Maiar = resplandor dorado +
// chispitas, Anillo Unico = apagon + anillo que se dibuja + explosion + vibracion + mas
// chispitas que ninguna. Secuencias rediseñadas tras consultar con otra IA (ver
// GACHA_SEASONS_PLANNING.md, Ronda 2) - el HTML de cada efecto se genera aqui en
// #gacha-fx-layer, la coreografia (timing de cada etapa) vive en el CSS de cada *-reveal.
const GACHA_RARITY_FX_CLASSES = ['common-reveal', 'rare-reveal', 'epic-reveal', 'legendary-reveal'];

function applyGachaRarityFx(rarity) {
    const overlay = document.getElementById('gacha-reveal-overlay');
    const fxLayer = document.getElementById('gacha-fx-layer');
    GACHA_RARITY_FX_CLASSES.forEach(c => overlay.classList.remove(c));
    overlay.classList.add(rarity + '-reveal');
    clearGachaParticles();
    fxLayer.innerHTML = '';

    if (rarity === 'common') {
        fxLayer.innerHTML = '<div class="gacha-fx-door"></div>';
        spawnGachaParticles(5, '🍃', 'gacha-leaf');
    } else if (rarity === 'rare') {
        fxLayer.innerHTML = '<div class="gacha-fx-sword-cut"></div>';
    } else if (rarity === 'epic') {
        // Anillo de runas: spans en circulo (trigonometria simple), sin libreria de particulas.
        const runeChars = ['ᚱ', 'ᛟ', 'ᚺ', 'ᛁ', 'ᚦ', 'ᛗ', 'ᛉ', 'ᛒ'];
        const runeSpans = runeChars.map((ch, i) => {
            const angle = (i / runeChars.length) * Math.PI * 2;
            const x = Math.cos(angle) * 45;
            const y = Math.sin(angle) * 45;
            return `<span class="gacha-fx-rune" style="transform:translate(${x}px, ${y}px)">${ch}</span>`;
        }).join('');
        fxLayer.innerHTML = `<div class="gacha-fx-rune-ring">${runeSpans}</div><div class="gacha-fx-whiteflash"></div>`;
        setTimeout(() => { if (!gachaBoardCancelled) spawnGachaParticles(8, '✨'); }, 1050);
    } else if (rarity === 'legendary') {
        fxLayer.innerHTML = `
            <div class="gacha-fx-blackout"></div>
            <svg class="gacha-fx-ring" viewBox="0 0 90 90">
                <circle class="gacha-fx-ring-track" cx="45" cy="45" r="40"></circle>
                <circle class="gacha-fx-ring-draw" cx="45" cy="45" r="40" stroke-dasharray="251"></circle>
            </svg>
        `;
        setTimeout(() => { if (!gachaBoardCancelled) spawnGachaParticles(16, '✨'); }, 1750);
        // El haptics es lo unico de esta secuencia que una pagina web normal no podria hacer -
        // un golpe fuerte y seco justo cuando la carta "explota". Si el plugin no esta
        // disponible (navegador de escritorio, por ejemplo) simplemente no pasa nada.
        setTimeout(() => {
            try {
                window.Capacitor?.Plugins?.Haptics?.impact({ style: 'HEAVY' });
            } catch (err) { /* sin haptics disponible, no es critico */ }
        }, 1950);
    }
    // Rohirrim (rara) no usa particulas de JS, solo el corte de espada + sacudida del CSS.
}

function spawnGachaParticles(count, emoji, extraClass) {
    const card = document.getElementById('gacha-reveal-card');
    for (let i = 0; i < count; i++) {
        const particle = document.createElement('span');
        particle.className = 'gacha-sparkle' + (extraClass ? ' ' + extraClass : '');
        particle.textContent = emoji;
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.animationDelay = `${Math.random() * 0.8}s`;
        particle.style.fontSize = `${10 + Math.random() * 14}px`;
        card.appendChild(particle);
    }
}

function clearGachaParticles() {
    document.querySelectorAll('.gacha-sparkle').forEach(el => el.remove());
}

function closeGachaReveal() {
    gachaBoardCancelled = true; // si cerraron en medio del tablero, no dejarlo terminar y reabrir el modal solo
    const overlay = document.getElementById('gacha-reveal-overlay');
    overlay.classList.remove('active');
    GACHA_RARITY_FX_CLASSES.forEach(c => overlay.classList.remove(c));
    document.getElementById('gacha-board-row').style.display = 'none';
    clearGachaParticles();
    if (gachaPendingRefresh) {
        const fn = gachaPendingRefresh;
        gachaPendingRefresh = null;
        fn();
    }
}
// ===== Fin Gacha / Álbum de Galería =====

// ===== Administración del gacha (Panel del Staff) =====
let adminGachaActiveSeasonId = null;

// Estado del Gacha controlado por el staff (ver admin_gacha_set_status.php) - deja
// activar/desactivar el Gacha con un mensaje explicando por que, sin necesitar un cambio de
// codigo cada vez que quieran pulirlo o anunciar que se viene una temporada nueva.
async function loadGachaStatusAdmin() {
    const statusSelect = document.getElementById('gacha-admin-status');
    const messageInput = document.getElementById('gacha-admin-status-message');
    if (!statusSelect) return;
    try {
        const data = await apiRequest('admin_gacha_set_status.php');
        statusSelect.value = data.status;
        messageInput.value = data.message || '';
    } catch (err) {
        showNotification('No se pudo cargar el estado del Gacha: ' + err.message);
    }
}

async function adminSetGachaStatus() {
    const status = document.getElementById('gacha-admin-status').value;
    const message = document.getElementById('gacha-admin-status-message').value.trim();
    try {
        await apiRequest('admin_gacha_set_status.php', { method: 'POST', body: JSON.stringify({ status, message }) });
        showNotification('Estado del Gacha actualizado.');
    } catch (err) {
        showNotification('No se pudo actualizar el estado: ' + err.message);
    }
}

async function loadAppVersionAdmin() {
    const input = document.getElementById('app-version-min-code');
    if (!input) return;
    try {
        const data = await apiRequest('app_version_check.php');
        input.value = data.min_version_code;
        document.getElementById('app-version-message').value = data.message || '';
    } catch (err) {
        showNotification('No se pudo cargar la versión mínima: ' + err.message);
    }
}

async function adminSetAppVersion() {
    const minVersionCode = parseInt(document.getElementById('app-version-min-code').value, 10);
    const message = document.getElementById('app-version-message').value.trim();
    if (!minVersionCode || minVersionCode <= 0) {
        showNotification('Escribe un versionCode válido.');
        return;
    }
    if (!confirm(`¿Bloquear a cualquiera con una versión menor a ${minVersionCode}? Asegúrate de que el APK nuevo ya esté publicado en la descarga directa antes de confirmar.`)) return;
    try {
        await apiRequest('admin_app_version_set.php', { method: 'POST', body: JSON.stringify({ min_version_code: minVersionCode, message }) });
        showNotification('Versión mínima actualizada.');
    } catch (err) {
        showNotification('No se pudo actualizar: ' + err.message);
    }
}

async function loadAdminGachaPanel() {
    const currentBox = document.getElementById('admin-gacha-current');
    if (!currentBox) return;

    loadGachaStatusAdmin();

    try {
        const seasons = await apiRequest('gacha_admin_seasons.php');
        const active = seasons.find(s => s.is_active);
        if (!active) {
            currentBox.innerHTML = '<p class="empty-grid-msg">No hay ninguna temporada activa. Crea una abajo.</p>';
            adminGachaActiveSeasonId = null;
            document.getElementById('admin-gacha-cards-list').innerHTML = '';
            document.getElementById('admin-gacha-completions-list').innerHTML = '';
            return;
        }
        adminGachaActiveSeasonId = active.id;
        currentBox.innerHTML = `
            <p><strong>${active.name}</strong> — ${active.card_count} carta(s) — ${new Date(active.start_date).toLocaleDateString('es-ES')} a ${new Date(active.end_date).toLocaleDateString('es-ES')}</p>
            <p style="color:var(--text-muted); font-size:12.5px;">Costo por tirada: ${active.pull_cost} Runas</p>
        `;
        loadAdminGachaCards();
        loadAdminGachaCompletions();
    } catch (err) {
        currentBox.innerHTML = `<p class="empty-grid-msg">No se pudo cargar (¿eres staff? ¿ya subiste los endpoints del gacha?): ${err.message}</p>`;
    }
}

async function adminCreateGachaSeason() {
    const name = document.getElementById('gacha-admin-name').value.trim();
    const start = document.getElementById('gacha-admin-start').value;
    const end = document.getElementById('gacha-admin-end').value;
    const cost = document.getElementById('gacha-admin-cost').value;
    const reward1 = document.getElementById('gacha-admin-reward1').value.trim();
    const reward2 = document.getElementById('gacha-admin-reward2').value.trim();
    const reward3 = document.getElementById('gacha-admin-reward3').value.trim();

    if (!name || !start || !end) {
        showNotification('Completa nombre, fecha de inicio y fecha de fin.');
        return;
    }

    try {
        await apiRequest('gacha_admin_seasons.php', {
            method: 'POST',
            body: JSON.stringify({
                name, start_date: start, end_date: end, pull_cost: cost,
                reward_1st: reward1, reward_2nd: reward2, reward_3rd: reward3,
            }),
        });
        showNotification('Temporada creada.');
        document.getElementById('gacha-admin-name').value = '';
        document.getElementById('gacha-admin-reward1').value = '';
        document.getElementById('gacha-admin-reward2').value = '';
        document.getElementById('gacha-admin-reward3').value = '';
        loadAdminGachaPanel();
    } catch (err) {
        showNotification('No se pudo crear la temporada: ' + err.message);
    }
}

// Cache local de las cartas cargadas, para poder leer/actualizar campos al guardar sin
// tener que volver a pedirle todo al servidor por cada cambio chiquito.
let adminGachaCardsCache = [];

async function loadAdminGachaCards() {
    const list = document.getElementById('admin-gacha-cards-list');
    if (!adminGachaActiveSeasonId) { list.innerHTML = ''; return; }

    try {
        adminGachaCardsCache = await apiRequest(`gacha_admin_cards.php?season_id=${adminGachaActiveSeasonId}`);
        renderAdminGachaCardsList();
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">${err.message}</p>`;
    }
}

function renderAdminGachaCardsList() {
    const list = document.getElementById('admin-gacha-cards-list');
    if (adminGachaCardsCache.length === 0) {
        list.innerHTML = '<p class="empty-grid-msg">Esta temporada todavía no tiene cartas. Sube las imágenes arriba.</p>';
        return;
    }
    list.innerHTML = adminGachaCardsCache.map(card => `
        <div class="admin-gacha-card-row">
            <img src="${siteUrl(card.image_path)}" alt="${card.name}">
            <div class="admin-gacha-card-fields">
                <input type="text" class="admin-input" id="gacha-card-name-${card.id}" value="${card.name.replace(/"/g, '&quot;')}" placeholder="Nombre del personaje">
                <select class="admin-input" id="gacha-card-rarity-${card.id}">
                    <option value="common" ${card.rarity === 'common' ? 'selected' : ''}>Hobbit</option>
                    <option value="rare" ${card.rarity === 'rare' ? 'selected' : ''}>Rohirrim</option>
                    <option value="epic" ${card.rarity === 'epic' ? 'selected' : ''}>Maiar</option>
                    <option value="legendary" ${card.rarity === 'legendary' ? 'selected' : ''}>Anillo Único</option>
                </select>
                <div style="position:relative;">
                    <input type="text" class="admin-input" id="gacha-card-manga-${card.id}" placeholder="Manga (opcional)" value="${(card.manga_title || '').replace(/"/g, '&quot;')}" autocomplete="off" oninput="searchMangaForGachaCard(${card.id}, this.value)">
                    <input type="hidden" id="gacha-card-manga-id-${card.id}" value="${card.manga_id || ''}">
                    <div class="search-dropdown" id="gacha-card-manga-results-${card.id}"></div>
                </div>
            </div>
            <div class="admin-card-buttons">
                <button class="btn-admin-act approve" onclick="adminSaveGachaCard(${card.id})">Guardar</button>
                <button class="btn-admin-act reject" onclick="adminDeleteGachaCard(${card.id})">Borrar</button>
            </div>
        </div>
    `).join('');
}

async function adminBulkUploadGachaCards() {
    if (!adminGachaActiveSeasonId) {
        showNotification('No hay una temporada activa todavía. Crea una arriba primero.');
        return;
    }
    const fileInput = document.getElementById('gacha-admin-bulk-files');
    const files = fileInput.files;
    if (!files || files.length === 0) {
        showNotification('Elige al menos una imagen.');
        return;
    }
    if (files.length > 20) {
        showNotification(`Elegiste ${files.length} imágenes, pero el servidor solo acepta 20 por tanda. Sube primero 20 y el resto después.`);
        return;
    }

    const formData = new FormData();
    formData.append('season_id', adminGachaActiveSeasonId);
    for (const file of files) formData.append('files[]', file);

    const btn = document.getElementById('gacha-admin-bulk-submit-btn');
    btn.disabled = true;
    btn.textContent = `Subiendo ${files.length} imágenes...`;
    try {
        const result = await apiUploadFormData('gacha_admin_cards_bulk.php', formData);
        showNotification(`${result.created.length} cartas subidas.` + (result.errors.length ? ` ${result.errors.length} con error.` : ''));
        if (result.errors.length) console.warn(result.errors);
        fileInput.value = '';
        loadAdminGachaCards();
        loadAdminGachaPanel();
    } catch (err) {
        showNotification('No se pudo subir el lote: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Subir todas';
    }
}

async function searchMangaForGachaCard(cardId, query) {
    const resultsEl = document.getElementById(`gacha-card-manga-results-${cardId}`);
    if (!query.trim()) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; return; }
    try {
        const data = await apiRequest(`mangas.php?search=${encodeURIComponent(query)}&page=1`);
        const top = (data.mangas || []).slice(0, 6);
        resultsEl.innerHTML = top.length
            ? top.map(m => `<div class="search-dropdown-item" onclick="selectMangaForGachaCard(${cardId}, ${m.id}, '${m.title.replace(/'/g, "\\'")}')"><span class="search-dropdown-item-title">${m.title}</span></div>`).join('')
            : '<div class="search-dropdown-empty">Sin resultados</div>';
        resultsEl.classList.add('active');
    } catch (err) {
        resultsEl.classList.remove('active');
    }
}

function selectMangaForGachaCard(cardId, mangaId, mangaTitle) {
    document.getElementById(`gacha-card-manga-${cardId}`).value = mangaTitle;
    document.getElementById(`gacha-card-manga-id-${cardId}`).value = mangaId;
    document.getElementById(`gacha-card-manga-results-${cardId}`).classList.remove('active');
}

async function adminSaveGachaCard(id) {
    const name = document.getElementById(`gacha-card-name-${id}`).value.trim();
    const rarity = document.getElementById(`gacha-card-rarity-${id}`).value;
    const mangaIdField = document.getElementById(`gacha-card-manga-id-${id}`);
    // Si borraron el texto del manga a mano sin elegir uno nuevo de la lista, no mandar un
    // manga_id viejo que ya no corresponde a lo que se ve en el campo.
    const mangaSearchText = document.getElementById(`gacha-card-manga-${id}`).value.trim();
    const mangaId = mangaSearchText ? (mangaIdField.value || null) : null;

    if (!name) {
        showNotification('El nombre no puede quedar vacío.');
        return;
    }

    try {
        await apiRequest('gacha_admin_card_update.php', {
            method: 'POST',
            body: JSON.stringify({ id, name, rarity, manga_id: mangaId }),
        });
        showNotification(`"${name}" guardado.`);
        loadAdminGachaCards();
    } catch (err) {
        showNotification('No se pudo guardar: ' + err.message);
    }
}

async function adminDeleteGachaCard(id) {
    if (!confirm('¿Borrar esta carta de la temporada?')) return;
    try {
        await apiRequest('gacha_admin_card_delete.php', { method: 'POST', body: JSON.stringify({ id }) });
        loadAdminGachaCards();
        loadAdminGachaPanel();
    } catch (err) {
        showNotification('No se pudo borrar: ' + err.message);
    }
}

async function loadAdminGachaCompletions() {
    const list = document.getElementById('admin-gacha-completions-list');
    if (!adminGachaActiveSeasonId) { list.innerHTML = ''; return; }

    try {
        const completions = await apiRequest(`gacha_admin_completions.php?season_id=${adminGachaActiveSeasonId}`);
        if (completions.length === 0) {
            list.innerHTML = '<p class="empty-grid-msg">Nadie ha completado el álbum todavía.</p>';
            return;
        }
        const medals = ['🥇', '🥈', '🥉'];
        list.innerHTML = completions.map(c => `
            <div class="admin-approval-card">
                <div class="admin-approval-info">
                    <h4>${medals[c.rank_position - 1] || ('#' + c.rank_position)} ${c.username}</h4>
                    <p>${new Date(c.completed_at).toLocaleDateString('es-ES')} — ${c.reward_granted ? 'Premio ya entregado' : 'Premio pendiente'}</p>
                </div>
                <div class="admin-card-buttons">
                    ${c.reward_granted ? '' : `<button class="btn-admin-act approve" onclick="adminMarkRewardGranted(${c.id})">Marcar entregado</button>`}
                </div>
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">${err.message}</p>`;
    }
}

async function adminMarkRewardGranted(id) {
    try {
        await apiRequest('gacha_admin_completions.php', { method: 'POST', body: JSON.stringify({ id }) });
        loadAdminGachaCompletions();
    } catch (err) {
        showNotification('No se pudo marcar: ' + err.message);
    }
}
// ===== Fin administración del gacha =====

// Eleccion +18 obligatoria al subir: null hasta que el usuario elige una de las dos opciones.
let galleryUploadNsfw = null;

function setUploadNsfw(value) {
    galleryUploadNsfw = value;
    document.getElementById('gallery-nsfw-no').classList.toggle('active', value === 0);
    document.getElementById('gallery-nsfw-yes').classList.toggle('active', value === 1);
}

// Open Upload Photo Modal
function openUploadModal() {
    if (!authToken) {
        showNotification('Inicia sesión para subir una foto.');
        switchScreen('login');
        return;
    }
    document.getElementById("gallery-upload-title").value = '';
    document.getElementById("gallery-upload-manga-search").value = '';
    document.getElementById("gallery-upload-file").value = '';
    galleryUploadSelectedManga = null;
    galleryUploadNsfw = null;
    document.getElementById('gallery-nsfw-no').classList.remove('active');
    document.getElementById('gallery-nsfw-yes').classList.remove('active');
    document.getElementById("upload-waifu-modal").classList.add("active");
}

// Close Upload Photo Modal
function closeUploadModal() {
    document.getElementById("upload-waifu-modal").classList.remove("active");
}

// Submit Photo (real, sube a gallery_upload.php). El proyecto y la marca +18 son obligatorios:
// son justo la informacion que la regla de la galeria exige para no rechazar la foto.
async function submitGalleryPhoto() {
    const title = document.getElementById("gallery-upload-title").value.trim();
    const fileInput = document.getElementById("gallery-upload-file");
    const file = fileInput.files[0];
    const btn = document.getElementById("gallery-upload-submit-btn");

    if (!title || !file) {
        showNotification('Completa el título y elige una imagen.');
        return;
    }
    if (!galleryUploadSelectedManga) {
        showNotification('Tienes que elegir de qué manga/proyecto es la foto.');
        return;
    }
    if (galleryUploadNsfw === null) {
        showNotification('Indica si la foto es +18 o no.');
        return;
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('manga_id', galleryUploadSelectedManga.id);
    formData.append('is_nsfw', String(galleryUploadNsfw));
    formData.append('file', file);

    btn.disabled = true;
    try {
        const result = await apiUploadFormData('gallery_upload.php', formData);
        closeUploadModal();
        showNotification(result.message);
        loadGalleryPhotos();
    } catch (err) {
        showNotification('No se pudo subir la foto: ' + err.message);
    } finally {
        btn.disabled = false;
    }
}

// Cola real de moderación de la galería (require_admin del lado del servidor)
async function loadAdminGalleryApprovals() {
    const container = document.getElementById("admin-approval-container");
    if (!container) return;

    try {
        const data = await apiRequest('gallery_list.php?status=pending');
        const pending = data.photos;
        if (pending.length === 0) {
            container.innerHTML = '<p class="empty-grid-msg">No hay imágenes en cola de moderación.</p>';
            return;
        }
        container.innerHTML = pending.map(item => `
            <div class="admin-approval-card">
                <img src="${siteUrl(item.feed_image)}" alt="Preview">
                <div class="admin-approval-info">
                    <h4>${item.title} ${item.is_nsfw ? '<span class="admin-nsfw-tag">+18</span>' : ''}</h4>
                    <p>Por: ${item.uploader_username}${item.manga_title ? ' — ' + item.manga_title : ''}</p>
                </div>
                <div class="admin-card-buttons">
                    <button class="btn-admin-act approve" onclick="adminModerateGalleryPhoto(${item.id}, 'approve')">Aprobar</button>
                    <button class="btn-admin-act reject" onclick="adminModerateGalleryPhoto(${item.id}, 'reject')">Rechazar</button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = `<p class="empty-grid-msg">${err.message}</p>`;
    }
}

async function adminModerateGalleryPhoto(id, action) {
    try {
        await apiRequest('gallery_admin_moderate.php', { method: 'POST', body: JSON.stringify({ id, action }) });
        showNotification(action === 'approve' ? 'Foto aprobada e incorporada a la galería pública.' : 'Foto rechazada.');
        loadAdminGalleryApprovals();
        loadGalleryPhotos();
    } catch (err) {
        showNotification('No se pudo procesar: ' + err.message);
    }
}

// Marcos overlay estilo Discord (WebP con alpha): se montan encima del circulo y sobresalen.
// Corona Alada de Gondor eliminada (arte mal generado, pendiente rediseño).
// Precios confirmados por Ockuro (2026-07-01).
const AVATAR_OVERLAY_FRAMES = {
    barad:    { file: 'frame-barad.webp',    label: 'Anillo de Barad-dûr',        cssClass: 'frame-overlay-barad'    },
    lorien:   { file: 'frame-lorien.webp',   label: 'Hojas de Lórien',            cssClass: 'frame-overlay-lorien'   },
    concilio: { file: 'frame-concilio.webp', label: 'Las Réplicas del Concilio',  cssClass: 'frame-overlay-concilio' },
    // Exclusivo del Patreon Tier 4 ("El Concilio Blanco") — imposible de conseguir con Runas,
    // ver EXCLUSIVE_FRAMES en store_buy_frame.php. No tiene entrada en FRAME_COSTS a propósito.
    anor:     { file: 'frame-anor.webp',     label: 'Llama Blanca de Anor',       cssClass: 'frame-overlay-anor'     },
};

// Marcos de borde CSS (sin overlay): todos los tipos en un mapa nombre→label.
// Borde Estirable y Fuego Amatista eliminados (2026-06-29): la imagen de muestra vertical se
// recortaba mal sin importar object-position, se sacaron de la Tienda.
const AVATAR_BORDER_FRAMES = {
    earendil: 'Luz de Eärendil',
    portador: 'Marca del Portador',
    muertos:  'Niebla de los Muertos',
    palantir: 'Brillo del Palantír',
    sauron:   'Ojo de Sauron',
};

const FRAME_COSTS = {
    earendil: 15, portador: 20, muertos: 20, palantir: 25,
    sauron: 25, barad: 40, lorien: 40, concilio: 40,
};

function getFrameLabel(frameType) {
    return AVATAR_BORDER_FRAMES[frameType] || AVATAR_OVERLAY_FRAMES[frameType]?.label || frameType;
}

// Pulso de confirmación al comprar/equipar un ítem de tienda. Se dispara explícitamente desde
// buyAvatarFrame/buyNameAura (no desde updateFrameButtonStates, que corre en cada render de la
// pantalla) para que la animación solo se vea en el momento real de la compra.
function flashStorePurchase(card) {
    if (!card) return;
    card.classList.remove('store-purchase-flash');
    void card.offsetWidth;
    card.classList.add('store-purchase-flash');
}

// Actualiza el estado visual (Comprar/Equipar/En uso/asequible) de todos los botones del grid.
function updateFrameButtonStates() {
    document.querySelectorAll('.store-item.frame-item[data-frame-id]').forEach(card => {
        const id = card.dataset.frameId;
        const cost = FRAME_COSTS[id] ?? 0;
        const btn = card.querySelector('.btn-buy-store');
        if (!btn) return;

        btn.classList.remove('can-afford', 'btn-owned', 'btn-equipped');
        card.classList.remove('frame-in-use');

        if (activeAvatarFrame === id) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> En uso';
            btn.classList.add('btn-equipped');
            card.classList.add('frame-in-use');
        } else if (purchasedFrames.has(id)) {
            btn.innerHTML = 'Equipar';
            btn.classList.add('btn-owned');
        } else if (userCoins >= cost) {
            btn.innerHTML = `<i class="fa-solid fa-gem"></i> ${cost} Runas`;
            btn.classList.add('can-afford');
        } else {
            btn.innerHTML = `<i class="fa-solid fa-gem"></i> ${cost} Runas`;
        }
    });
    renderExclusiveFrameCard();
}

// La tarjeta del marco exclusivo de Patreon Tier 4 vive oculta en el HTML (no es "invisible por
// CSS nada más": si no se posee, no tiene sentido mostrar un marco que no se puede comprar ni
// aunque se junten Runas). Solo aparece una vez que patreon_oauth.php/patreon_webhook.php lo
// otorgaron de verdad al llegar a tier 4.
function renderExclusiveFrameCard() {
    const card = document.getElementById('item-frame-anor');
    if (!card) return;
    const owned = purchasedFrames.has('anor');
    card.style.display = owned ? 'block' : 'none';
    if (!owned) return;

    const btn = card.querySelector('.btn-buy-store');
    btn.classList.remove('btn-equipped', 'btn-owned');
    card.classList.remove('frame-in-use');
    if (activeAvatarFrame === 'anor') {
        btn.innerHTML = '<i class="fa-solid fa-check"></i> En uso';
        btn.classList.add('btn-equipped');
        card.classList.add('frame-in-use');
    } else {
        btn.innerHTML = 'Equipar';
        btn.classList.add('btn-owned');
    }
}

// ===== Auras de nombre de usuario =====
// Mismo patron que los marcos de avatar (compra -> backend real -> equipado, un solo slot activo).
const NAME_AURAS = {
    rohan:    'Estandarte de Rohan',
    ithilien: 'Susurro de Ithilien',
    erebor:   'Oro de Erebor',
    nazgul:   'Sombra Nazgûl',
    valinor:  'Luz de Valinor',
};
const AURA_COSTS = { rohan: 10, ithilien: 15, erebor: 20, nazgul: 25, valinor: 35 };

let activeNameAura = 'none';
const purchasedAuras = new Set();

function updateAuraButtonStates() {
    document.querySelectorAll('.store-item.aura-item[data-aura-id]').forEach(card => {
        const id = card.dataset.auraId;
        const cost = AURA_COSTS[id] ?? 0;
        const btn = card.querySelector('.btn-buy-store');
        if (!btn) return;

        btn.classList.remove('can-afford', 'btn-owned', 'btn-equipped');
        card.classList.remove('frame-in-use');

        if (activeNameAura === id) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> En uso';
            btn.classList.add('btn-equipped');
            card.classList.add('frame-in-use');
        } else if (purchasedAuras.has(id)) {
            btn.innerHTML = 'Equipar';
            btn.classList.add('btn-owned');
        } else if (userCoins >= cost) {
            btn.innerHTML = `<i class="fa-solid fa-gem"></i> ${cost} Runas`;
            btn.classList.add('can-afford');
        } else {
            btn.innerHTML = `<i class="fa-solid fa-gem"></i> ${cost} Runas`;
        }
    });
}

async function buyNameAura(auraId, cost) {
    if (activeNameAura === auraId) {
        showNotification("Ya tienes equipada esta aura de nombre.");
        return;
    }
    if (!authToken) {
        showNotification('Inicia sesión para comprar o equipar auras de nombre.');
        switchScreen('login');
        return;
    }
    const alreadyOwned = purchasedAuras.has(auraId);
    if (!alreadyOwned && userCoins < cost) {
        showNotification(`Runas insuficientes. Necesitas ${cost} Runas.`);
        return;
    }
    if (!alreadyOwned && !confirm(`¿Comprar y equipar '${NAME_AURAS[auraId]}' por ${cost} Runas?`)) return;

    try {
        const data = await apiRequest('store_buy_aura.php', {
            method: 'POST',
            body: JSON.stringify({ aura_id: auraId }),
        });
        userCoins = data.coins;
        purchasedAuras.clear();
        data.purchased_auras.forEach(id => purchasedAuras.add(id));
        updateCoinsDisplay();
        equipNameAura(data.active_aura);
        if (currentUser) {
            currentUser.active_aura = data.active_aura;
            currentUser.purchased_auras = data.purchased_auras;
            saveSession(authToken, currentUser);
        }
        showNotification(alreadyOwned
            ? `Aura '${NAME_AURAS[auraId]}' equipada.`
            : `¡Aura '${NAME_AURAS[auraId]}' equipada!`);
        flashStorePurchase(document.getElementById(`item-aura-${auraId}`));
    } catch (err) {
        showNotification(err.message);
    }
}

// Aplica la clase de aura al username en perfil + popover del header (self-view, igual que
// los marcos de avatar no se propagan a comentarios ni a otros lugares hoy).
function equipNameAura(auraId) {
    const targets = [document.getElementById('profile-username'), document.getElementById('popover-username')];
    targets.forEach(el => {
        if (!el) return;
        Object.keys(NAME_AURAS).forEach(id => el.classList.remove(`name-aura-${id}`));
        if (auraId && auraId !== 'none') el.classList.add(`name-aura-${auraId}`);
    });
    activeNameAura = auraId;
    updateAuraButtonStates();
}


// ===== Cambio de nombre de usuario (de pago) =====
// Precio confirmado por Ockuro (2026-07-01). Debe coincidir con
// USERNAME_CHANGE_COST en change_username.php.
const USERNAME_CHANGE_COST = 30;

async function changeUsername() {
    if (!authToken) {
        showNotification('Inicia sesión para cambiar tu nombre de usuario.');
        switchScreen('login');
        return;
    }
    const newUsername = prompt(
        `Nuevo nombre de usuario (3-20 caracteres: letras, números o _). Costo: ${USERNAME_CHANGE_COST} Runas.`,
        currentUser?.username || ''
    );
    if (!newUsername) return;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(newUsername)) {
        showNotification('Nombre inválido: usa 3-20 caracteres (letras, números o guion bajo).');
        return;
    }
    if (currentUser && newUsername.toLowerCase() === currentUser.username.toLowerCase()) {
        showNotification('Ese ya es tu nombre de usuario actual.');
        return;
    }
    if (userCoins < USERNAME_CHANGE_COST) {
        showNotification(`Runas insuficientes. Necesitas ${USERNAME_CHANGE_COST} Runas.`);
        return;
    }
    if (!confirm(`¿Cambiar tu nombre de usuario a '${newUsername}' por ${USERNAME_CHANGE_COST} Runas? No podrás repetirlo por un tiempo.`)) return;

    try {
        const data = await apiRequest('change_username.php', {
            method: 'POST',
            body: JSON.stringify({ username: newUsername }),
        });
        userCoins = data.coins;
        updateCoinsDisplay();
        if (currentUser) {
            currentUser.username = data.username;
            currentUser.username_changed_at = data.username_changed_at;
            saveSession(authToken, currentUser);
        }
        const profileUsernameEl = document.getElementById('profile-username');
        const popoverUsernameEl = document.getElementById('popover-username');
        if (profileUsernameEl) profileUsernameEl.textContent = data.username;
        if (popoverUsernameEl) popoverUsernameEl.textContent = data.username;
        showNotification('¡Nombre de usuario actualizado!');
    } catch (err) {
        showNotification(err.message);
    }
}

// ===== Remover marco/aura equipados =====
async function unequipAvatarFrame() {
    if (!authToken) {
        showNotification('Inicia sesión para remover tu marco de avatar.');
        switchScreen('login');
        return;
    }
    if (activeAvatarFrame === 'none' || !activeAvatarFrame) {
        showNotification('No tienes ningún marco equipado.');
        return;
    }
    try {
        await apiRequest('unequip_avatar_frame.php', { method: 'POST', body: JSON.stringify({}) });
        equipAvatarFrame('none');
        if (currentUser) { currentUser.active_frame = null; saveSession(authToken, currentUser); }
        showNotification('Marco de avatar removido.');
    } catch (err) {
        showNotification('No se pudo remover el marco: ' + err.message);
    }
}

async function unequipNameAura() {
    if (!authToken) {
        showNotification('Inicia sesión para remover tu aura de nombre.');
        switchScreen('login');
        return;
    }
    if (activeNameAura === 'none' || !activeNameAura) {
        showNotification('No tienes ninguna aura equipada.');
        return;
    }
    try {
        await apiRequest('unequip_name_aura.php', { method: 'POST', body: JSON.stringify({}) });
        equipNameAura('none');
        if (currentUser) { currentUser.active_aura = null; saveSession(authToken, currentUser); }
        showNotification('Aura de nombre removida.');
    } catch (err) {
        showNotification('No se pudo remover el aura: ' + err.message);
    }
}

// ===== Foto de perfil (avatar, publica -a diferencia del banner, la ve todo el mundo) =====
function triggerAvatarUpload() {
    if (!confirm('Tu foto de perfil es PÚBLICA (la ve todo el mundo en tus comentarios). No subas contenido inapropiado -el staff puede pedirte que la cambies si incumple las normas.\n\n¿Continuar?')) return;
    document.getElementById('avatar-upload-input').click();
}

async function uploadAvatar(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const data = await apiUploadFormData('avatar_upload.php', formData);
        if (currentUser) {
            currentUser.avatar = data.avatar;
            currentUser.avatar_change_requested = false;
            saveSession(authToken, currentUser);
        }
        renderProfileAuthState();
        showNotification('Foto de perfil actualizada.');
    } catch (err) {
        showNotification('No se pudo subir la foto: ' + err.message);
    }
}

// ===== Mis Fotos (fotos subidas a Galería, cualquier estado) =====
const MY_PHOTO_STATUS_LABELS = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' };
async function loadMyPhotos() {
    const list = document.getElementById('my-photos-list');
    if (!authToken) { list.innerHTML = '<p class="empty-grid-msg">Inicia sesión para ver tus fotos.</p>'; return; }
    list.innerHTML = '<p class="empty-grid-msg">Cargando...</p>';
    try {
        const data = await apiRequest('gallery_list.php?mine=1');
        if (data.photos.length === 0) {
            list.innerHTML = '<p class="empty-grid-msg">Todavía no subiste ninguna foto a la Galería.</p>';
            return;
        }
        list.innerHTML = data.photos.map(p => `
            <div class="my-photo-item">
                <img src="${siteUrl(p.feed_image)}" alt="${escapeHtml(p.title)}" loading="lazy">
                <span class="my-photo-status ${p.status}">${MY_PHOTO_STATUS_LABELS[p.status] || p.status}</span>
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">Error: ${err.message}</p>`;
    }
}

// ===== Cambiar contraseña =====
function openChangePassword() {
    if (!authToken) {
        showNotification('Inicia sesión para cambiar tu contraseña.');
        switchScreen('login');
        return;
    }
    document.getElementById('change-password-current').value = '';
    document.getElementById('change-password-new').value = '';
    switchScreen('change-password');
}

async function submitChangePassword() {
    const currentPassword = document.getElementById('change-password-current').value;
    const newPassword = document.getElementById('change-password-new').value;
    if (!currentPassword || !newPassword) {
        showNotification('Completa ambos campos.');
        return;
    }
    if (newPassword.length < 6) {
        showNotification('La nueva contraseña debe tener al menos 6 caracteres.');
        return;
    }
    try {
        await apiRequest('change_password.php', {
            method: 'POST',
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
        });
        showNotification('Contraseña actualizada. Se cerró sesión en tus otros dispositivos.');
        switchScreen('profile');
    } catch (err) {
        showNotification(err.message);
    }
}

// ===== Sesiones activas =====
async function loadSessions() {
    if (!authToken) {
        showNotification('Inicia sesión para ver tus sesiones activas.');
        switchScreen('login');
        return;
    }
    const list = document.getElementById('sessions-list');
    list.innerHTML = '<p class="empty-grid-msg">Cargando...</p>';
    try {
        const data = await apiRequest('list_sessions.php');
        if (data.sessions.length === 0) {
            list.innerHTML = '<p class="empty-grid-msg">No hay sesiones activas.</p>';
            return;
        }
        list.innerHTML = data.sessions.map(s => `
            <div class="session-item ${s.is_current ? 'is-current' : ''}">
                <div class="session-info">
                    ${s.is_current ? '<span class="session-current-tag">Este dispositivo</span><br>' : ''}
                    Expira: ${new Date(s.expires_at).toLocaleDateString()}
                </div>
                ${s.is_current ? '' : `<button class="btn-admin-submit btn-admin-ban" onclick="revokeSession(${s.id})">Cerrar</button>`}
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">Error: ${err.message}</p>`;
    }
}

async function revokeSession(sessionId) {
    try {
        await apiRequest('revoke_session.php', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) });
        loadSessions();
    } catch (err) {
        showNotification('No se pudo cerrar la sesión: ' + err.message);
    }
}

async function revokeAllOtherSessions() {
    if (!confirm('¿Cerrar sesión en todos tus otros dispositivos?')) return;
    try {
        await apiRequest('revoke_session.php', { method: 'POST', body: JSON.stringify({ all_others: true }) });
        showNotification('Se cerró sesión en tus otros dispositivos.');
        loadSessions();
    } catch (err) {
        showNotification('No se pudo completar: ' + err.message);
    }
}

// ===== Eliminar cuenta =====
function openDeleteAccount() {
    if (!authToken) {
        showNotification('Inicia sesión para eliminar tu cuenta.');
        switchScreen('login');
        return;
    }
    document.getElementById('delete-account-password').value = '';
    switchScreen('delete-account');
}

async function submitDeleteAccount() {
    const password = document.getElementById('delete-account-password').value;
    if (!password) {
        showNotification('Ingresá tu contraseña para confirmar.');
        return;
    }
    if (!confirm('Esto es DEFINITIVO. Tu cuenta se elimina para siempre y no vas a poder volver a entrar. ¿Estás segurо?')) return;

    try {
        await apiRequest('delete_account.php', { method: 'POST', body: JSON.stringify({ password }) });
        showNotification('Tu cuenta fue eliminada.');
        logout();
    } catch (err) {
        showNotification(err.message);
    }
}

// ===== Historial de transacciones =====
async function loadTransactions() {
    if (!authToken) {
        showNotification('Inicia sesión para ver tu historial de transacciones.');
        switchScreen('login');
        return;
    }
    const list = document.getElementById('transactions-list');
    list.innerHTML = '<p class="empty-grid-msg">Cargando...</p>';
    try {
        const data = await apiRequest('transactions_list.php');
        if (data.transactions.length === 0) {
            list.innerHTML = '<p class="empty-grid-msg">Todavía no hay movimientos registrados.</p>';
            return;
        }
        list.innerHTML = data.transactions.map(t => `
            <div class="transaction-item">
                <div>
                    <div class="transaction-reason">${escapeHtml(t.reason)}</div>
                    <div class="transaction-date">${new Date(t.created_at).toLocaleString()}</div>
                </div>
                <div class="transaction-delta ${t.delta >= 0 ? 'positive' : 'negative'}">${t.delta >= 0 ? '+' : ''}${t.delta}</div>
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">Error: ${err.message}</p>`;
    }
}

// ===== Notificaciones (centro dentro de la app, sin push real -ver CLAUDE.md) =====
const NOTIFICATION_ICONS = {
    new_chapter: 'fa-book',
    comment_reply: 'fa-reply',
    comment_deleted: 'fa-trash',
    gallery_approved: 'fa-circle-check',
    gallery_rejected: 'fa-circle-xmark',
    avatar_change_requested: 'fa-triangle-exclamation',
};

async function toggleNotificationsPanel() {
    const panel = document.getElementById('header-notifications-panel');
    if (!authToken) {
        showNotification('Inicia sesión para ver tus notificaciones.');
        return;
    }
    const willOpen = !panel.classList.contains('active');
    panel.classList.toggle('active');
    if (willOpen) await loadNotifications();
}

function closeNotificationsPanel() {
    document.getElementById('header-notifications-panel').classList.remove('active');
}

async function loadNotifications() {
    const list = document.getElementById('notifications-list-panel');
    try {
        const data = await apiRequest('notifications_list.php');
        updateNotificationBadge(data.unread_count);
        if (data.notifications.length === 0) {
            list.innerHTML = '<p class="empty-grid-msg">No tienes notificaciones.</p>';
            return;
        }
        list.innerHTML = data.notifications.map((n, index) => `
            <div class="notification-item ${n.is_read ? '' : 'unread'}" style="animation-delay: ${Math.min(index, 8) * 0.03}s" onclick="markNotificationRead(${n.id})">
                <div class="notification-item-icon type-${n.type}"><i class="fa-solid ${NOTIFICATION_ICONS[n.type] || 'fa-bell'}"></i></div>
                <div class="notification-item-body">
                    <p class="notification-item-msg">${escapeHtml(n.message)}</p>
                    <span class="notification-item-time">${timeAgo(n.created_at)}</span>
                </div>
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = `<p class="empty-grid-msg">Error: ${err.message}</p>`;
    }
}

function updateNotificationBadge(count) {
    const badge = document.getElementById('header-bell-badge');
    if (count > 0) {
        badge.textContent = count > 9 ? '9+' : count;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

async function markNotificationRead(id) {
    try {
        await apiRequest('notifications_mark_read.php', { method: 'POST', body: JSON.stringify({ notification_id: id }) });
        loadNotifications();
    } catch (err) {
        // silencioso -no es critico si esto falla, la notificacion se queda marcada como no leida
    }
}

async function markAllNotificationsRead() {
    try {
        await apiRequest('notifications_mark_read.php', { method: 'POST', body: JSON.stringify({ all: true }) });
        loadNotifications();
    } catch (err) {
        showNotification('No se pudo marcar todo como leído: ' + err.message);
    }
}

async function clearReadNotifications() {
    try {
        await apiRequest('notifications_clear_read.php', { method: 'POST' });
        loadNotifications();
    } catch (err) {
        showNotification('No se pudieron borrar las notificaciones: ' + err.message);
    }
}

// Compra/equipa un marco de avatar. La compra (si no se tenia el marco) y el equipado siempre
// quedan guardados en el backend (tabla user_avatar_frames + users.active_avatar_frame), no solo
// en memoria del navegador, para que sobrevivan a cerrar sesion / reinstalar / cambiar de celular.
async function buyAvatarFrame(frameType, cost) {
    if (activeAvatarFrame === frameType) {
        showNotification("Ya tienes equipado este marco de avatar.");
        return;
    }
    if (!authToken) {
        showNotification('Inicia sesión para comprar o equipar marcos de avatar.');
        switchScreen('login');
        return;
    }
    const alreadyOwned = purchasedFrames.has(frameType);
    if (!alreadyOwned && userCoins < cost) {
        showNotification(`Runas insuficientes. Necesitas ${cost} Runas.`);
        return;
    }
    if (!alreadyOwned && !confirm(`¿Comprar y equipar '${getFrameLabel(frameType)}' por ${cost} Runas?`)) return;

    try {
        const data = await apiRequest('store_buy_frame.php', {
            method: 'POST',
            body: JSON.stringify({ frame_id: frameType }),
        });
        userCoins = data.coins;
        purchasedFrames.clear();
        data.purchased_frames.forEach(id => purchasedFrames.add(id));
        updateCoinsDisplay();
        equipAvatarFrame(data.active_frame);
        if (currentUser) {
            currentUser.active_frame = data.active_frame;
            currentUser.purchased_frames = data.purchased_frames;
            saveSession(authToken, currentUser);
        }
        showNotification(alreadyOwned
            ? `Marco '${getFrameLabel(frameType)}' equipado.`
            : `¡Marco '${getFrameLabel(frameType)}' equipado!`);
        flashStorePurchase(document.getElementById(`item-frame-${frameType}`));
    } catch (err) {
        showNotification(err.message);
    }
}

// Aplica el marco a header y perfil a la vez, limpiando primero el anterior.
// Un solo marco activo a la vez, sin importar el tipo.
function equipAvatarFrame(frameType) {
    const headerAvatar = document.getElementById("user-avatar");
    const profileAvatar = document.getElementById("profile-avatar-big");
    const headerOverlay = document.getElementById("user-avatar-frame");
    const profileOverlay = document.getElementById("profile-avatar-frame");

    headerAvatar.className = "";
    profileAvatar.className = "";
    [headerOverlay, profileOverlay].forEach(el => {
        el.className = 'avatar-frame-overlay';
        el.style.display = 'none';
        el.src = '';
    });

    if (AVATAR_BORDER_FRAMES[frameType]) {
        const cls = `frame-${frameType}-border`;
        headerAvatar.classList.add(cls);
        profileAvatar.classList.add(cls);
    } else if (AVATAR_OVERLAY_FRAMES[frameType]) {
        const { file, cssClass } = AVATAR_OVERLAY_FRAMES[frameType];
        const src = `images/frames/${file}`;
        [headerOverlay, profileOverlay].forEach(el => {
            el.src = src;
            el.style.display = 'block';
            el.classList.add(cssClass);
        });
        // El borde fino del circulo de abajo choca con el arte del overlay -se oculta-.
        headerAvatar.classList.add('has-overlay-frame');
        profileAvatar.classList.add('has-overlay-frame');
    }

    activeAvatarFrame = frameType;
    updateFrameButtonStates();
}

// Genre / search filtering on Home grid
let currentGenreFilter = 'all';
let searchDebounceTimer = null;
let homeFilterTimer = null;
function debounceFilterHomeGrid() {
    clearTimeout(homeFilterTimer);
    homeFilterTimer = setTimeout(filterHomeGrid, 300);
}

function setGenreFilter(filter, btnEl) {
    currentGenreFilter = filter;
    document.querySelectorAll('#genre-chips-row .genre-chip').forEach(c => c.classList.remove('active'));
    btnEl.classList.add('active');

    if (USE_REAL_API) {
        loadCatalogFromApi();
    } else {
        filterHomeGrid();
    }
}

function filterHomeGrid() {
    if (USE_REAL_API) {
        // En modo real, cada tecla dispara una búsqueda en el servidor (con un pequeño debounce)
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(loadCatalogFromApi, 350);
        return;
    }

    const searchInput = document.getElementById('search-input');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const cards = document.querySelectorAll('#manga-grid-container .manga-card');
    let visibleCount = 0;

    cards.forEach(card => {
        const genre = card.getAttribute('data-genre');
        const id = card.getAttribute('data-id');
        const title = (card.getAttribute('data-title') || '').toLowerCase();

        let matchesGenre = currentGenreFilter === 'all' || genre === currentGenreFilter;
        if (currentGenreFilter === 'favorites') matchesGenre = favoriteMangas.has(id);

        const matchesQuery = !query || title.includes(query);
        const visible = matchesGenre && matchesQuery;
        card.style.display = visible ? '' : 'none';
        if (visible) visibleCount++;
    });

    const emptyMsg = document.getElementById('grid-empty-msg');
    if (emptyMsg) emptyMsg.style.display = visibleCount === 0 ? 'block' : 'none';
}

// ===== Catálogo dinámico desde la API real =====

// IDs de generos (ver genres.php) que se consideran contenido explicito/adulto para el
// filtro de censura NSFW. Es un criterio editorial, no algo que diga la base de datos -
// ajustar esta lista si el equipo del scan clasifica las cosas distinto.
// Adulto(22), Ahegao(23), Exhibición(24), Ecchi(26), BDSM(30), RAPE(29), Shota(31), MILFS(21), Harem(10)
const NSFW_GENRE_IDS = new Set([10, 21, 22, 23, 24, 26, 29, 30, 31]);

function isAdultManga(manga) {
    return (manga.genres || []).some(g => NSFW_GENRE_IDS.has(g.id));
}

function renderMangaCard(manga, index = 0) {
    const genreNames = (manga.genres || []).map(g => g.name).join(' / ');
    const isFav = favoriteMangas.has(String(manga.id));
    const isAdult = isAdultManga(manga);
    // Revelado en cascada: cada tarjeta entra con un pequeño retraso segun su posicion (ver
    // @keyframes fadeInUp + .manga-card en style.css). Tope de 12 items para que una grilla
    // larga no tarde una eternidad en terminar de aparecer -de ahi en mas todas entran juntas.
    const delay = Math.min(index, 12) * 0.04;
    return `
        <div class="manga-card ${isAdult ? 'adult-content' : ''}" data-genre="${manga.genres?.[0]?.id ?? ''}" data-id="${manga.id}" data-title="${manga.title}" onclick="openMangaDetails(${manga.id})" style="animation-delay: ${delay}s">
            <div class="manga-cover">
                <img src="${siteUrl(manga.cover_image)}" alt="${manga.title}" loading="lazy" decoding="async">
                <button class="fav-heart-btn ${isFav ? 'active' : ''}" data-fav-id="${manga.id}" onclick="toggleFavorite(event, '${manga.id}')">
                    <i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                </button>
                ${isAdult ? '<div class="nsfw-overlay"><i class="fa-solid fa-eye-slash"></i> +18 Censurado</div>' : ''}
                ${isAdult ? '<span class="manga-badge adult-badge">Adulto</span>' : ''}
                <span class="views-badge"><i class="fa-solid fa-eye"></i> ${manga.views ?? 0}</span>
            </div>
            <h4>${manga.title}</h4>
            <span class="manga-chapters">${manga.chapter_count ?? 0} Capítulos${genreNames ? ' · ' + genreNames : ''}</span>
        </div>
    `;
}

let catalogPage = 1;
let catalogHasMore = false;
let catalogLoadingMore = false;

async function loadCatalogFromApi(page = 1) {
    const container = document.getElementById('manga-grid-container');
    const emptyMsg = document.getElementById('grid-empty-msg');
    const searchInput = document.getElementById('search-input');
    const query = searchInput ? searchInput.value.trim() : '';

    const params = new URLSearchParams();
    if (query) params.set('search', query);
    if (currentGenreFilter === 'favorites') {
        params.set('favorites', '1');
    } else if (currentGenreFilter !== 'all') {
        params.set('genre', currentGenreFilter);
    }
    params.set('page', page);

    if (page === 1) {
        emptyMsg.style.display = 'none';
        container.innerHTML = '<p class="empty-grid-msg"><i class="fa-solid fa-spinner fa-spin"></i> Cargando obras...</p>';
    }

    try {
        const data = await apiRequest(`mangas.php?${params.toString()}`);
        if (page === 1) {
            container.innerHTML = data.mangas.map(renderMangaCard).join('');
        } else {
            container.insertAdjacentHTML('beforeend', data.mangas.map(renderMangaCard).join(''));
        }
        catalogPage = page;
        catalogHasMore = !!data.has_more;
        emptyMsg.style.display = (page === 1 && data.mangas.length === 0) ? 'block' : 'none';
        applyNsfwFilter();
        updateLoadMoreButton();
        if (page === 1) updateSearchDropdown(query, data.mangas);
    } catch (err) {
        if (page === 1) {
            container.innerHTML = `<p class="empty-grid-msg">No se pudo cargar el catálogo.<br>${err.message}</p>`;
        } else {
            showNotification('No se pudieron cargar más obras: ' + err.message);
        }
    }
}

function updateLoadMoreButton() {
    const btn = document.getElementById('btn-load-more');
    if (!btn) return;
    btn.style.display = catalogHasMore ? 'block' : 'none';
    btn.textContent = 'Cargar más';
    btn.disabled = false;
}

async function loadMoreCatalog() {
    if (catalogLoadingMore || !catalogHasMore) return;
    catalogLoadingMore = true;
    const btn = document.getElementById('btn-load-more');
    if (btn) { btn.textContent = 'Cargando...'; btn.disabled = true; }
    await loadCatalogFromApi(catalogPage + 1);
    catalogLoadingMore = false;
}

// Menu desplegable de resultados rapidos justo debajo de la barra de busqueda,
// para que se note de una que la busqueda si esta funcionando (antes solo filtraba
// la grilla de mas abajo, dificil de notar sin scrollear hasta ahi).
function updateSearchDropdown(query, mangas) {
    const dropdown = document.getElementById('search-dropdown');
    if (!dropdown) return;

    if (!query) {
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
        return;
    }

    const top = mangas.slice(0, 6);
    if (top.length === 0) {
        dropdown.innerHTML = '<div class="search-dropdown-empty">Sin resultados</div>';
    } else {
        dropdown.innerHTML = top.map(m => `
            <div class="search-dropdown-item" onclick="selectSearchResult(${m.id})">
                <img src="${siteUrl(m.cover_image)}" alt="">
                <span class="search-dropdown-item-title">${m.title}</span>
            </div>
        `).join('');
    }
    dropdown.classList.add('active');
}

function selectSearchResult(id) {
    document.getElementById('search-dropdown').classList.remove('active');
    openMangaDetails(id);
}

function hideSearchDropdownDelayed() {
    // El timeout deja que el click en un item del menu se registre antes de ocultarlo
    setTimeout(() => {
        const dropdown = document.getElementById('search-dropdown');
        if (dropdown) dropdown.classList.remove('active');
    }, 150);
}

async function loadGenreChipsFromApi() {
    const row = document.getElementById('genre-chips-row');
    try {
        const genres = await apiRequest('genres.php');
        row.innerHTML = `
            <button class="genre-chip active" onclick="setGenreFilter('all', this)">Todos</button>
            ${genres.map(g => `<button class="genre-chip" onclick="setGenreFilter('${g.id}', this)">${g.name}</button>`).join('')}
            <button class="genre-chip" onclick="setGenreFilter('favorites', this)"><i class="fa-solid fa-heart"></i> Favoritos</button>
        `;
    } catch (err) {
        showNotification('No se pudieron cargar los géneros: ' + err.message);
    }
}
// ===== Seguir leyendo / Últimos leídos =====
let continueReadingCache = [];

async function loadContinueReading() {
    const homeSection = document.getElementById('continue-reading-section');
    const profileSection = document.getElementById('profile-recent-section');
    if (!USE_REAL_API || !authToken) {
        homeSection.style.display = 'none';
        profileSection.style.display = 'none';
        return;
    }
    try {
        continueReadingCache = await apiRequest('continue_reading.php?limit=20');
    } catch (err) {
        continueReadingCache = [];
    }
    renderContinueReadingHome();
    renderRecentReadProfile();
}

function renderContinueReadingHome() {
    const section = document.getElementById('continue-reading-section');
    const row = document.getElementById('continue-reading-row');
    const items = continueReadingCache.filter(m => m.status === 'reading' || m.status === 'on_hold');

    if (items.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    row.innerHTML = items.map(m => `
        <div class="continue-card ${isAdultManga(m) ? 'adult-content' : ''}" onclick="openMangaDetails(${m.manga_id})">
            <div class="cover-wrap">
                <img src="${siteUrl(m.cover_image)}" alt="${m.title}" loading="lazy" decoding="async">
                <div class="nsfw-overlay-mini"><i class="fa-solid fa-eye-slash"></i></div>
            </div>
            <span class="continue-card-title">${m.title}</span>
            <span class="continue-card-chapter">Cap. ${m.next_chapter_number}</span>
        </div>
    `).join('');
    applyNsfwFilter();
}

// Carrusel real de "Últimas Actualizaciones": antes esta etiqueta estaba puesta sobre la
// grilla general del catálogo (ordenada por m.updated_at, que se mueve con cualquier edición
// del registro del manga, no solo cuando sale capítulo nuevo) y mezclaba obras al azar.
// Ahora usa mangas.php?sort=updates, que ordena por la fecha real del último capítulo.
async function loadLatestUpdates() {
    const section = document.getElementById('latest-updates-section');
    const row = document.getElementById('latest-updates-row');
    if (!USE_REAL_API) {
        section.style.display = 'none';
        return;
    }
    try {
        const data = await apiRequest('mangas.php?sort=updates&limit=12');
        const items = (data.mangas || []).filter(m => m.latest_chapter_number != null);
        if (items.length === 0) {
            section.style.display = 'none';
            return;
        }
        section.style.display = 'block';
        row.innerHTML = items.map(m => `
            <div class="continue-card ${isAdultManga(m) ? 'adult-content' : ''}" onclick="openMangaDetails(${m.id})">
                <div class="cover-wrap">
                    <img src="${siteUrl(m.cover_image)}" alt="${m.title}" loading="lazy" decoding="async">
                    <div class="nsfw-overlay-mini"><i class="fa-solid fa-eye-slash"></i></div>
                </div>
                <span class="continue-card-title">${m.title}</span>
                <span class="continue-card-chapter">Cap. ${m.latest_chapter_number}</span>
            </div>
        `).join('');
        applyNsfwFilter();
    } catch (err) {
        section.style.display = 'none';
    }
}

function renderRecentReadProfile() {
    const section = document.getElementById('profile-recent-section');
    const list = document.getElementById('profile-recent-list');

    if (continueReadingCache.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    // Limitado a 6 -antes mostraba TODO el historial de "seguir leyendo" sin tope, y con varias
    // obras la lista se volvia interminable en una pantalla que deberia ser un resumen rapido.
    list.innerHTML = continueReadingCache.slice(0, 6).map(m => `
        <div class="recent-row ${isAdultManga(m) ? 'adult-content' : ''}" onclick="openMangaDetails(${m.manga_id})">
            <div class="cover-wrap">
                <img src="${siteUrl(m.cover_image)}" alt="${m.title}" loading="lazy" decoding="async">
                <div class="nsfw-overlay-mini"><i class="fa-solid fa-eye-slash"></i></div>
            </div>
            <div class="recent-row-info">
                <span class="recent-row-title">${m.title}</span>
                <span class="recent-row-chapter">${STATUS_LABELS[m.status] || m.status} · Cap. ${m.last_read_chapter}</span>
            </div>
        </div>
    `).join('');
    applyNsfwFilter();
}
// ===== Fin catálogo dinámico =====

// Estado de lista de lectura (Pendiente/Leyendo/En pausa/Completado/Abandonado)
const STATUS_LABELS = {
    plan_to_read: 'Pendiente',
    reading: 'Leyendo',
    on_hold: 'En pausa',
    completed: 'Completado',
    dropped: 'Abandonado',
};
let mangaListStatusDemo = {}; // { [mangaId]: status } usado solo en modo demo

function renderListStatusChips(activeStatus) {
    document.querySelectorAll('#list-status-row .list-status-chip').forEach(chip => {
        chip.classList.toggle('active', chip.getAttribute('data-status') === activeStatus);
    });
}

// Calificación con estrellas (tap to rate)
let mangaRatingDemo = {}; // { [mangaId]: rating } usado solo en modo demo

// Dibuja 5 estrellas en `container`. Si `interactive` es true, se pueden tocar para calificar.
function renderStars(container, rating, interactive) {
    container.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
        const star = document.createElement("i");
        star.className = i <= rating ? "fas fa-star" : "fa-regular fa-star";
        if (interactive) {
            star.style.cursor = "pointer";
            star.onclick = () => rateActiveManga(i);
        }
        container.appendChild(star);
    }
}

async function rateActiveManga(rating) {
    if (!activeManga.id) return;

    if (!USE_REAL_API) {
        mangaRatingDemo[activeManga.id] = rating;
        renderStars(document.getElementById("detail-stars"), rating, true);
        showNotification(`¡Calificaste esta obra con ${rating} estrellas!`);
        return;
    }

    if (!authToken) {
        showNotification('Inicia sesión para calificar esta obra.');
        switchScreen('login');
        return;
    }

    try {
        const data = await apiRequest('rate_manga.php', {
            method: 'POST',
            body: JSON.stringify({ manga_id: activeManga.id, rating }),
        });
        renderStars(document.getElementById("detail-stars"), rating, true);
        showNotification(`¡Gracias por tu calificación! Promedio actual: ${Number(data.summary.avg_rating).toFixed(1)}`);
    } catch (err) {
        showNotification('No se pudo enviar la calificación: ' + err.message);
    }
}

async function setListStatus(status, btnEl) {
    if (!activeManga.id) return;

    if (!USE_REAL_API) {
        mangaListStatusDemo[activeManga.id] = status;
        renderListStatusChips(status);
        showNotification(`Estado actualizado: ${STATUS_LABELS[status]}`);
        return;
    }

    if (!authToken) {
        showNotification('Inicia sesión para guardar tu progreso de lectura.');
        switchScreen('login');
        return;
    }

    try {
        await apiRequest('list_status.php', {
            method: 'POST',
            body: JSON.stringify({ manga_id: activeManga.id, status }),
        });
        renderListStatusChips(status);
        showNotification(`Estado actualizado: ${STATUS_LABELS[status]}`);
    } catch (err) {
        showNotification('No se pudo guardar el estado: ' + err.message);
    }
}

// Comentarios
let commentsDemo = {}; // { [scopeName-entityId]: [ {id, username, avatar, content, likes, dislikes, my_vote, created_at, replies:[]} ] }
let nextDemoCommentId = 90000;

// Los comentarios viven tanto en la ficha de obra (manga_id) como en el lector de capitulo
// (chapter_id) — el backend ya soportaba ambos scopes, esto centraliza las diferencias de
// markup/ids para no duplicar toda la logica de render/envio/voto en 2 copias.
const commentScopes = {
    manga: {
        containerId: 'comments-container',
        formId: 'comment-form',
        loginCtaId: 'comment-login-cta',
        inputId: 'comment-input',
        mainKey: 'main',
        mainPreviewId: 'comment-attach-preview-main',
        apiParam: 'manga_id',
        getId: () => activeManga.id,
    },
    chapter: {
        containerId: 'reader-comments-container',
        formId: 'reader-comment-form',
        loginCtaId: 'reader-comment-login-cta',
        inputId: 'reader-comment-input',
        mainKey: 'chapter-main',
        mainPreviewId: 'reader-comment-attach-preview-main',
        apiParam: 'chapter_id',
        getId: () => readerState.chapterId,
    },
};

function demoCommentsKey(scopeName, entityId) {
    return `${scopeName}-${entityId}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function timeAgo(dateStr) {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'ahora';
    if (mins < 60) return `hace ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `hace ${hours} h`;
    return `hace ${Math.floor(hours / 24)} d`;
}

function renderAttachment(a) {
    const src = USE_REAL_API ? siteUrl(a.file_path) : a.file_path;
    if (a.file_type === 'video') {
        return `<video class="comment-attachment" src="${src}" controls></video>`;
    }
    return `<img class="comment-attachment" src="${src}" alt="adjunto" loading="lazy">`;
}

function renderCommentCard(c, scopeName) {
    const replyHtml = (c.replies || []).map(r => renderCommentCard(r, scopeName)).join('');
    const attachmentsHtml = (c.attachments || []).map(renderAttachment).join('');
    return `
        <div class="comment-card" data-comment-id="${c.id}">
            <div class="comment-card-header">
                ${c.avatar
                    ? `<img class="comment-avatar" src="${USE_REAL_API ? siteUrl('uploads/avatars/' + c.avatar) : c.avatar}" alt="">`
                    : `<div class="comment-avatar comment-avatar-fallback"><i class="fa-solid fa-user"></i></div>`}
                <div>
                    <div class="comment-username${c.active_name_aura && NAME_AURAS[c.active_name_aura] ? ' name-aura-' + c.active_name_aura : ''}">${escapeHtml(c.username)}</div>
                    <div class="comment-date">${timeAgo(c.created_at)}</div>
                </div>
            </div>
            ${c.content ? `<div class="comment-content">${escapeHtml(c.content)}</div>` : ''}
            ${attachmentsHtml}
            <div class="comment-actions">
                <button class="comment-vote-btn ${c.my_vote === 1 ? 'active' : ''}" onclick="voteComment(${c.id}, 1, '${scopeName}')">
                    <i class="fa-solid fa-thumbs-up"></i> ${c.likes || 0}
                </button>
                <button class="comment-vote-btn ${c.my_vote === -1 ? 'active' : ''}" onclick="voteComment(${c.id}, -1, '${scopeName}')">
                    <i class="fa-solid fa-thumbs-down"></i> ${c.dislikes || 0}
                </button>
                ${c.parent_id ? '' : `<button class="comment-reply-btn" onclick="toggleReplyForm(${c.id})">Responder</button>`}
                ${currentUser && currentUser.id !== c.user_id ? `<button class="comment-report-btn" onclick="reportContent('comment', ${c.id})" title="Reportar comentario"><i class="fa-solid fa-flag"></i></button>` : ''}
                ${currentUser && (currentUser.role || 0) >= 1 ? `<button class="comment-delete-btn" onclick="adminDeleteComment(${c.id}, '${scopeName}')" title="Borrar comentario (staff)"><i class="fa-solid fa-trash"></i></button>` : ''}
            </div>
            ${c.parent_id ? '' : `
            <div class="comment-reply-form" id="reply-form-${c.id}">
                <textarea id="reply-input-${c.id}" placeholder="Escribe una respuesta..." rows="1" onpaste="handleCommentPaste(event, 'reply-${c.id}', 'comment-attach-preview-reply-${c.id}')"></textarea>
                <div class="comment-attach-preview" id="comment-attach-preview-reply-${c.id}"></div>
                <div class="comment-form-actions">
                    <label class="comment-attach-btn" for="comment-attach-input-reply-${c.id}" title="Adjuntar imagen o video">
                        <i class="fa-solid fa-paperclip"></i>
                    </label>
                    <input type="file" id="comment-attach-input-reply-${c.id}" accept="image/*,video/*" style="display:none;" onchange="onAttachmentSelected(event, 'reply-${c.id}', 'comment-attach-preview-reply-${c.id}')">
                    <button class="btn-comment-submit" onclick="submitComment(${c.id}, '${scopeName}')">Enviar</button>
                </div>
            </div>`}
            ${replyHtml ? `<div class="comment-replies">${replyHtml}</div>` : ''}
        </div>
    `;
}

function renderComments(comments, scopeName) {
    const container = document.getElementById(commentScopes[scopeName].containerId);
    if (!comments || comments.length === 0) {
        container.innerHTML = '<p class="empty-grid-msg">Aún no hay comentarios. ¡Sé el primero!</p>';
        return;
    }
    container.innerHTML = comments.map(c => renderCommentCard(c, scopeName)).join('');
}

function updateCommentFormVisibility(scopeName) {
    const scope = commentScopes[scopeName];
    document.getElementById(scope.formId).style.display = (USE_REAL_API && !authToken) ? 'none' : 'flex';
    document.getElementById(scope.loginCtaId).style.display = (USE_REAL_API && !authToken) ? 'block' : 'none';
}

async function loadComments(scopeName, entityId) {
    const scope = commentScopes[scopeName];
    updateCommentFormVisibility(scopeName);

    if (!USE_REAL_API) {
        renderComments(commentsDemo[demoCommentsKey(scopeName, entityId)] || [], scopeName);
        return;
    }

    try {
        const comments = await apiRequest(`comments.php?${scope.apiParam}=${entityId}`);
        renderComments(comments, scopeName);
    } catch (err) {
        document.getElementById(scope.containerId).innerHTML = '<p class="empty-grid-msg">No se pudieron cargar los comentarios.</p>';
    }
}

function toggleReplyForm(commentId) {
    document.getElementById(`reply-form-${commentId}`)?.classList.toggle('active');
}

// Adjuntos pendientes de envío: key 'main' o 'reply-<id>' -> File seleccionado
let pendingAttachments = {};
let pendingAttachmentUrls = {}; // key -> blob URL del preview, para liberarla con URL.revokeObjectURL

function onAttachmentSelected(event, key, previewElId) {
    const file = event.target.files[0];
    if (!file) {
        clearAttachment(key, previewElId);
        return;
    }
    applyAttachmentFile(file, key, previewElId, () => { event.target.value = ''; });
}

// Cuando se pega un GIF/imagen desde el teclado de Google (Gboard) en el campo de comentario,
// el navegador lo recibe como un "paste" con datos de imagen en vez de texto.
function handleCommentPaste(event, key, previewElId) {
    const items = event.clipboardData?.items || [];
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
                event.preventDefault();
                applyAttachmentFile(file, key, previewElId);
                showNotification('Imagen/GIF listo para enviar junto al comentario.');
            }
            return;
        }
    }
    // Si no hay imagen en el portapapeles, se deja que el pegado de texto normal siga su curso
}

const imageExtensions = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
const videoExtensions = /\.(mp4|webm|mov|3gp)$/i;

function applyAttachmentFile(file, key, previewElId, onRejected) {
    const previewEl = document.getElementById(previewElId);
    // El selector de archivos de Android (sobre todo al elegir desde la galería/Google Fotos
    // dentro del WebView) a veces entrega el File con `type` vacío aunque sí sea una imagen/video
    // real. Si el navegador no nos dio un mime, lo inferimos por la extensión del nombre antes
    // de rechazarlo, para no bloquear adjuntos válidos solo porque el picker no mandó el tipo.
    let isImage = file.type.startsWith('image/');
    let isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo && !file.type) {
        isImage = imageExtensions.test(file.name || '');
        isVideo = videoExtensions.test(file.name || '');
    }
    if (!isImage && !isVideo) {
        showNotification('Solo se permiten imágenes o videos.');
        if (onRejected) onRejected();
        return;
    }
    const maxBytes = isImage ? 8 * 1024 * 1024 : 25 * 1024 * 1024;
    if (file.size > maxBytes) {
        showNotification(`El archivo es muy pesado (máx. ${isImage ? '8MB' : '25MB'}).`);
        if (onRejected) onRejected();
        return;
    }

    if (pendingAttachmentUrls[key]) {
        URL.revokeObjectURL(pendingAttachmentUrls[key]);
    }
    pendingAttachments[key] = file;
    const url = URL.createObjectURL(file);
    pendingAttachmentUrls[key] = url;
    previewEl.innerHTML = `
        <div class="attach-preview-item">
            ${isImage ? `<img src="${url}">` : `<video src="${url}" muted></video>`}
            <button type="button" class="attach-remove-btn" onclick="clearAttachment('${key}', '${previewElId}')">&times;</button>
        </div>
    `;
}

function clearAttachment(key, previewElId) {
    delete pendingAttachments[key];
    if (pendingAttachmentUrls[key]) {
        URL.revokeObjectURL(pendingAttachmentUrls[key]);
        delete pendingAttachmentUrls[key];
    }
    const previewEl = document.getElementById(previewElId);
    if (previewEl) previewEl.innerHTML = '';
}

// Guarda contra doble envío: mientras un comentario se está mandando, ignora taps repetidos
// del botón (era la causa de comentarios duplicados: el botón no daba feedback y la gente
// lo tocaba varias veces, y cada tap mandaba otra vez porque el campo no se limpiaba hasta
// que el servidor respondía).
let commentSubmitting = {};

async function submitComment(parentId, scopeName) {
    scopeName = scopeName || 'manga';
    const scope = commentScopes[scopeName];
    const entityId = scope.getId();
    if (!entityId) return;
    const key = parentId ? `reply-${parentId}` : scope.mainKey;

    if (commentSubmitting[key]) return; // ya hay un envío en curso para este formulario

    const previewElId = parentId ? `comment-attach-preview-reply-${parentId}` : scope.mainPreviewId;
    const inputEl = parentId ? document.getElementById(`reply-input-${parentId}`) : document.getElementById(scope.inputId);
    const content = (inputEl.value || '').trim();
    const file = pendingAttachments[key];
    if (!content && !file) return;

    if (!USE_REAL_API) {
        if (!currentUser) {
            showNotification('Inicia sesión para comentar.');
            switchScreen('login');
            return;
        }
        const newComment = {
            id: nextDemoCommentId++,
            parent_id: parentId || null,
            username: currentUser.username,
            avatar: currentUser.avatar || null,
            content,
            likes: 0,
            dislikes: 0,
            my_vote: 0,
            created_at: new Date().toISOString(),
            replies: [],
            attachments: file ? [{ file_path: URL.createObjectURL(file), file_type: file.type.startsWith('image/') ? 'image' : 'video' }] : [],
        };
        const dKey = demoCommentsKey(scopeName, entityId);
        if (!commentsDemo[dKey]) commentsDemo[dKey] = [];
        if (parentId) {
            const parent = commentsDemo[dKey].find(c => c.id === parentId);
            if (parent) parent.replies.push(newComment);
        } else {
            commentsDemo[dKey].unshift(newComment);
        }
        inputEl.value = '';
        clearAttachment(key, previewElId);
        renderComments(commentsDemo[dKey], scopeName);
        return;
    }

    if (!authToken) {
        showNotification('Inicia sesión para comentar.');
        switchScreen('login');
        return;
    }

    // Bloquea reenvíos y vacía el campo de una vez (optimista) para que un segundo tap
    // no encuentre el mismo texto y lo mande de nuevo.
    commentSubmitting[key] = true;
    inputEl.value = '';
    inputEl.disabled = true;

    try {
        // Todo va en una sola peticion multipart (texto + archivo opcional) para que el
        // servidor pueda validar el adjunto ANTES de crear el comentario. Antes el texto se
        // mandaba por JSON y el archivo en una segunda peticion separada: si esa segunda
        // fallaba, el comentario (vacío o solo con texto) ya había quedado creado igual.
        const formData = new FormData();
        formData.append(scope.apiParam, entityId);
        if (parentId) formData.append('parent_id', parentId);
        formData.append('content', content);
        if (file) formData.append('file', file);

        if (file) {
            await apiUploadFormData('comment_post.php', formData);
        } else {
            await apiRequest('comment_post.php', { method: 'POST', body: formData });
        }

        clearAttachment(key, previewElId);
        loadComments(scopeName, entityId);
    } catch (err) {
        inputEl.value = content; // si falló, devuelve el texto para que no se pierda
        showNotification('No se pudo publicar el comentario: ' + err.message);
    } finally {
        commentSubmitting[key] = false;
        inputEl.disabled = false;
    }
}

function findCommentDemo(demoKey, commentId) {
    for (const c of (commentsDemo[demoKey] || [])) {
        if (c.id === commentId) return c;
        const reply = (c.replies || []).find(r => r.id === commentId);
        if (reply) return reply;
    }
    return null;
}

async function voteComment(commentId, vote, scopeName) {
    scopeName = scopeName || 'manga';
    const scope = commentScopes[scopeName];
    const entityId = scope.getId();

    if (!USE_REAL_API) {
        if (!currentUser) {
            showNotification('Inicia sesión para votar comentarios.');
            switchScreen('login');
            return;
        }
        const dKey = demoCommentsKey(scopeName, entityId);
        const c = findCommentDemo(dKey, commentId);
        if (!c) return;
        if (c.my_vote === vote) {
            if (vote === 1) c.likes--; else c.dislikes--;
            c.my_vote = 0;
        } else {
            if (c.my_vote === 1) c.likes--;
            if (c.my_vote === -1) c.dislikes--;
            if (vote === 1) c.likes++; else c.dislikes++;
            c.my_vote = vote;
        }
        renderComments(commentsDemo[dKey], scopeName);
        return;
    }

    if (!authToken) {
        showNotification('Inicia sesión para votar comentarios.');
        switchScreen('login');
        return;
    }

    try {
        await apiRequest('comment_vote.php', {
            method: 'POST',
            body: JSON.stringify({ comment_id: commentId, vote }),
        });
        loadComments(scopeName, entityId);
    } catch (err) {
        showNotification('No se pudo registrar el voto: ' + err.message);
    }
}

// Favorites (heart toggle on covers)
let favoriteMangas = new Set();

function toggleFavorite(event, id) {
    event.stopPropagation();

    const willBeFavorited = !favoriteMangas.has(id);
    if (willBeFavorited) {
        favoriteMangas.add(id);
        showNotification("Añadido a tus favoritos");
    } else {
        favoriteMangas.delete(id);
    }

    document.querySelectorAll(`.fav-heart-btn[data-fav-id="${id}"]`).forEach(btn => {
        const icon = btn.querySelector('i');
        if (favoriteMangas.has(id)) {
            btn.classList.add('active');
            icon.className = 'fa-solid fa-heart';
        } else {
            btn.classList.remove('active');
            icon.className = 'fa-regular fa-heart';
        }
    });

    if (currentGenreFilter === 'favorites') filterHomeGrid();

    // Si hay sesión real y el backend ya esta activo, sincroniza el favorito en la base de datos
    if (USE_REAL_API && authToken) {
        apiRequest('favorite_toggle.php', {
            method: 'POST',
            body: JSON.stringify({ manga_id: id }),
        }).catch(err => showNotification('No se pudo guardar el favorito: ' + err.message));
    }
}

// Chapter list ordering toggle (Recientes/Antiguos)
let chapterOrderDesc = true;

function toggleChapterOrder() {
    const container = document.getElementById('chapters-container');
    const rows = Array.from(container.children);
    rows.reverse().forEach(row => container.appendChild(row));

    chapterOrderDesc = !chapterOrderDesc;
    const btn = document.getElementById('btn-order-toggle');
    btn.innerHTML = chapterOrderDesc
        ? '<i class="fa-solid fa-arrow-down-short-wide"></i> Recientes primero'
        : '<i class="fa-solid fa-arrow-up-short-wide"></i> Antiguos primero';
}

// Manga catalog (centralized so adding a new series only means adding one entry here)
const mangaDatabase = {
    chibi: {
        title: 'Mi Chibi Ayudante', img: 'images/media_chibi.jpg', genre: 'comedy',
        autor: 'Hana K.', artista: 'Studio Mochi', anio: '2023', tipo: 'Webcomic', estado: 'En Emisión',
        views: '8.4K', rating: 4,
        desc: 'Mi Chibi Ayudante: Un adorable y cómico recuento de vida sobre una chibi que ayuda en las tareas diarias de oficina.'
    },
    'sweet-secrets': {
        title: 'Sweet Secrets', img: 'images/media_mature.jpg', genre: 'adult',
        autor: 'R. Ainsworth', artista: 'Violet Ink', anio: '2022', tipo: 'Manhwa', estado: 'En Emisión',
        views: '12.1K', rating: 5,
        desc: 'Sweet Secrets: Una historia madura y cautivadora. Sigue los encuentros secretos en el aula con la profesora de literatura.'
    },
    'secretaria-medianoche': {
        title: 'Secretaria de Medianoche', img: 'images/07240e93de3cb9febe3848ba710665fd.jpg', genre: 'drama',
        autor: 'M. Lebrún', artista: 'Studio Iris', anio: '2024', tipo: 'Manhwa', estado: 'En Emisión',
        views: '6.7K', rating: 4,
        desc: 'Secretaria de Medianoche: Las tensiones de oficina escalan cuando los secretos empiezan a salir a la luz.'
    },
    'ojos-carmesi': {
        title: 'Ojos Carmesí', img: 'images/19cfefbd4fda8226423069eb97211947.jpg', genre: 'drama',
        autor: 'D. Hwang', artista: 'Studio Iris', anio: '2023', tipo: 'Manhwa', estado: 'En Emisión',
        views: '9.9K', rating: 5,
        desc: 'Ojos Carmesí: Una mirada de reojo puede cambiarlo todo. Un drama silencioso entre dos extraños que se cruzan demasiado seguido.'
    },
    'mala-costumbre': {
        title: 'Mala Costumbre', img: 'images/55ca6476c59c0a526b14b5b51b0c6526.jpg', genre: 'drama',
        autor: 'S. Okonkwo', artista: 'Studio Mochi', anio: '2022', tipo: 'Manhwa', estado: 'Finalizado',
        views: '15.3K', rating: 4,
        desc: 'Mala Costumbre: Ella tiene fama de problemática. Él decide averiguar por qué.'
    },
    'primavera-conmigo': {
        title: 'Primavera Conmigo', img: 'images/84f91ff1286f8d31115374c076628f8e.jpg', genre: 'comedy',
        autor: 'Y. Tanaka', artista: 'Studio Sakura', anio: '2024', tipo: 'Webcomic', estado: 'En Emisión',
        views: '5.2K', rating: 5,
        desc: 'Primavera Conmigo: Una comedia romántica ligera sobre dos amigos de la infancia que se reencuentran bajo los cerezos.'
    },
    'buenos-dias-jefa': {
        title: 'Buenos Días, Jefa', img: 'images/0093c6ae80961d790d3d6178ffe9f11f.jpg', genre: 'romance',
        autor: 'C. Reyes', artista: 'Studio Iris', anio: '2023', tipo: 'Manhwa', estado: 'En Emisión',
        views: '7.8K', rating: 4,
        desc: 'Buenos Días, Jefa: Un romance de oficina entre el empleado más nuevo y la jefa más temida del piso 12.'
    }
};

// Open Manga Details Screen
let activeManga = {};

async function openMangaDetails(id) {
    maybeShowInterstitialAd();

    if (USE_REAL_API) {
        document.getElementById('detail-title').textContent = 'Cargando...';
        document.getElementById('detail-desc').textContent = '';
        document.getElementById('chapters-container').innerHTML = '<p class="empty-grid-msg"><i class="fa-solid fa-spinner fa-spin"></i> Cargando capítulos...</p>';
        document.getElementById('comments-container').innerHTML = '';
        switchScreen("manga-details");

        try {
            const manga = await apiRequest(`manga_detail.php?id=${id}`);
            renderMangaDetailFromApi(manga);
        } catch (err) {
            document.getElementById('detail-title').textContent = 'Error al cargar';
            document.getElementById('chapters-container').innerHTML = `<p class="empty-grid-msg">No se pudo cargar la obra.<br>${err.message}</p>`;
        }
        return;
    }

    const data = mangaDatabase[id];
    if (!data) return;
    activeManga = { id, title: data.title, img: data.img, genre: data.genre };

    document.getElementById("detail-title").textContent = data.title;
    document.getElementById("detail-cover-img").src = data.img;
    document.getElementById("detail-autor").textContent = data.autor;
    document.getElementById("detail-artista").textContent = data.artista;
    document.getElementById("detail-anio").textContent = data.anio;
    document.getElementById("detail-tipo").textContent = data.tipo;
    document.getElementById("detail-status").textContent = data.estado;
    document.getElementById("detail-views-count").textContent = data.views;
    document.getElementById("detail-desc").textContent = data.desc;

    const myRating = mangaRatingDemo[id] ?? data.rating;
    renderStars(document.getElementById("detail-stars"), myRating, true);

    renderListStatusChips(mangaListStatusDemo[id] || null);
    loadComments('manga', id);

    switchScreen("manga-details");
}

// Algunos capítulos traen el crédito del scan pegado al título (ej. "Nombre - Orckuro
// Translations"). La app entera es de ese scan, así que sobra ahí y solo ocupa espacio.
function cleanChapterTitle(title) {
    if (!title) return '';
    return title
        .replace(/orckuro\s*translations?/gi, '')
        .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '')
        .trim();
}

// Pinta la pantalla de detalles usando la respuesta real de manga_detail.php
function renderMangaDetailFromApi(manga) {
    activeManga = { id: manga.id, title: manga.title, img: siteUrl(manga.cover_image), genre: null, type: manga.type };

    document.getElementById("detail-title").textContent = manga.title;
    document.getElementById("detail-cover-img").src = siteUrl(manga.cover_image);
    document.getElementById("manga-detail-cover-wrap").classList.toggle("adult-content", isAdultManga(manga));
    applyNsfwFilter();
    document.getElementById("detail-autor").textContent = manga.author || '—';
    document.getElementById("detail-artista").textContent = manga.artist || '—';
    document.getElementById("detail-anio").textContent = manga.year || '—';
    document.getElementById("detail-tipo").textContent = manga.type || '—';
    document.getElementById("detail-status").textContent = manga.status || '—';
    document.getElementById("detail-views-count").textContent = manga.views || 0;
    document.getElementById("detail-desc").textContent = manga.description || '';

    const avgRating = Math.round(manga.rating?.avg_rating || 0);
    renderStars(document.getElementById("detail-stars"), avgRating, true);

    // Construye la lista de capítulos reales (todos llegan del backend, ya no hay fila VIP fija)
    const chaptersContainer = document.getElementById("chapters-container");
    chaptersContainer.innerHTML = "";
    (manga.chapters || []).forEach((chapter, index) => {
        const row = document.createElement("div");
        row.className = "chapter-row";
        // Tope de 10 items de retraso -una obra con 80 capitulos no debe tardar en aparecer del
        // todo, de ahi en mas todas entran juntas (ver mismo criterio en renderMangaCard).
        row.style.animationDelay = `${Math.min(index, 10) * 0.03}s`;
        row.onclick = () => readChapterFromApi(chapter.id);
        const cleanTitle = cleanChapterTitle(chapter.title);
        row.innerHTML = `
            <div class="chapter-left-info">
                <span class="chapter-number">Capítulo ${chapter.chapter_number}${cleanTitle ? ' - ' + cleanTitle : ''}</span>
                <span class="chapter-date">${new Date(chapter.created_at).toLocaleDateString('es-ES')}</span>
            </div>
            <i class="fa-solid fa-chevron-right chapter-row-arrow"></i>
        `;
        chaptersContainer.appendChild(row);
    });

    renderListStatusChips(manga.user_status?.status || null);
    renderContinueButton(manga);
    loadComments('manga', manga.id);
}

// Si el usuario ya tiene avance guardado en esta obra, muestra el boton para retomar
// desde el siguiente capitulo sin leer (o el mismo, si ya esta al dia).
function renderContinueButton(manga) {
    const btn = document.getElementById('btn-continue-reading');
    const lastRead = parseFloat(manga.user_status?.last_read_chapter || 0);

    if (!lastRead || lastRead <= 0) {
        btn.style.display = 'none';
        return;
    }

    const chapters = manga.chapters || [];
    const next = chapters.find(c => parseFloat(c.chapter_number) > lastRead)
        || chapters.find(c => parseFloat(c.chapter_number) === lastRead);

    if (!next) {
        btn.style.display = 'none';
        return;
    }

    btn.style.display = 'flex';
    btn.querySelector('span').textContent = `Continuar desde Capítulo ${next.chapter_number}`;
    btn.onclick = () => readChapterFromApi(next.id);
}

function goBackToHome() {
    switchScreen("home");
}

// Estado del lector real. Hay 2 modos:
// - "strip": tira continua con scroll vertical (manhwa/manhua, la mayoría de nuestro catálogo)
// - "paginated": una pagina a la vez, con navegacion (manga clasico)
let readerState = { images: [], index: 0, mode: 'strip', prevChapterId: null, nextChapterId: null, chapterId: null };

function isPaginatedType(type) {
    return (type || '').toLowerCase() === 'manga';
}

// ===== Compartir (2026-07-18) =====
// Comparte un link real del sitio web (no algo exclusivo de la app) - asi lo puede abrir
// cualquiera, tenga o no la app instalada. Usa el plugin nativo de Capacitor si esta
// disponible; si no (ej. probando en el preview de escritorio), cae a la Web Share API del
// navegador o, en su defecto, copia el link al portapapeles.
async function shareContent(title, text, url) {
    try {
        if (window.Capacitor?.Plugins?.Share) {
            await window.Capacitor.Plugins.Share.share({ title, text, url });
        } else if (navigator.share) {
            await navigator.share({ title, text, url });
        } else {
            await navigator.clipboard.writeText(`${text} ${url}`);
            showNotification('Enlace copiado al portapapeles.');
        }
    } catch (err) {
        // El usuario cancelo el dialogo nativo de compartir - comportamiento normal, no un error.
    }
}

function shareManga() {
    if (!activeManga.id) return;
    shareContent(
        activeManga.title,
        `Mira "${activeManga.title}" en OrckuMangas`,
        `${SITE_BASE}/ficha.php?id=${activeManga.id}`
    );
}

function shareChapter() {
    if (!readerState.chapterId) return;
    shareContent(
        readerState.mangaTitle,
        `Estoy leyendo "${readerState.mangaTitle}" - Capítulo ${readerState.chapterNumber} en OrckuMangas`,
        `${SITE_BASE}/capitulo.php?id=${readerState.chapterId}`
    );
}

// Lee un capítulo real desde la API (se usa cuando USE_REAL_API esté activo)
async function readChapterFromApi(chapterId) {
    const reader = document.getElementById("screen-reader");
    const readerTitle = document.getElementById("reader-title");
    const imagesWrap = document.getElementById("reader-images-wrap");
    const pagesContainer = document.getElementById("reader-pages-container");

    // Si se viene del final del capitulo anterior, el scroll quedaba muy abajo. Sin resetearlo
    // antes de cambiar el contenido, el navegador arrastra esa posicion sobre el capitulo nuevo
    // (que tiene otra altura) y aterriza en una pagina random con un parpadeo feo en el cambio.
    if (pagesContainer) pagesContainer.scrollTop = 0;

    readerTitle.textContent = "Cargando capítulo...";
    imagesWrap.innerHTML = '<p class="empty-grid-msg"><i class="fa-solid fa-spinner fa-spin"></i> Cargando páginas...</p>';
    document.getElementById('reader-comments-container').innerHTML = '';
    reader.style.display = "flex";
    reader.classList.add("active");
    setupReaderScrollAutoHide();
    resetReaderBarsVisibility();

    try {
        let chapter;
        const offlineEntry = getOfflineManifest()[chapterId];
        if (offlineEntry) {
            // Capitulo descargado (Pergaminos de Minas Tirith): se sirve desde el almacenamiento
            // local sin tocar la red. Funciona haya o no internet, y de paso ahorra datos.
            chapter = await buildOfflineChapterPayload(offlineEntry);
        } else if (preloadedChapters[chapterId]) {
            // Ya se precargo en segundo plano mientras se leia el capitulo anterior. Se usa
            // de una (transicion instantanea) y se manda un pedido normal en paralelo solo
            // para que el contador de vistas del capitulo se actualice de verdad.
            chapter = preloadedChapters[chapterId];
            delete preloadedChapters[chapterId];
            apiRequest(`chapter.php?id=${chapterId}`).catch(() => {});
        } else {
            chapter = await apiRequest(`chapter.php?id=${chapterId}`);
        }
        readerTitle.textContent = `${chapter.manga_title} - Capítulo ${chapter.chapter_number}`;

        readerState = {
            images: chapter.images,
            index: 0,
            mode: isPaginatedType(activeManga.type) ? 'paginated' : 'strip',
            prevChapterId: chapter.prev_id,
            nextChapterId: chapter.next_id,
            chapterId: chapterId,
            mangaId: chapter.manga_id,
            mangaTitle: chapter.manga_title,
            mangaSlug: chapter.manga_slug,
            chapterNumber: chapter.chapter_number,
        };
        refreshOfflineDownloadIcon(chapterId);

        const modeIcon = document.getElementById('reader-mode-icon');
        if (readerState.mode === 'paginated') {
            renderPaginatedPage();
            modeIcon.className = 'fa-solid fa-table-cells-large';
        } else {
            renderStripPages(imagesWrap, chapter.images);
            modeIcon.className = 'fa-solid fa-images';
        }
        if (pagesContainer) pagesContainer.scrollTop = 0;
        updateReaderBottomNav();
        applyReaderSettingsOnOpen();
        loadComments('chapter', chapterId);
        preloadNextChapter(readerState.nextChapterId);

        if (authToken) {
            apiRequest('mark_read.php', {
                method: 'POST',
                body: JSON.stringify({ chapter_id: chapterId }),
            }).catch(() => {});
        }
    } catch (err) {
        readerTitle.textContent = "Error al cargar";
        imagesWrap.innerHTML = `
            <p class="empty-grid-msg">No se pudo cargar el capítulo.<br>${err.message}</p>
            <button class="btn-admin-submit" style="margin: 12px auto; display: block;" onclick="readChapterFromApi(${chapterId})">Reintentar</button>
        `;
    }
}

// ===== Pergaminos de Minas Tirith: descarga de capitulos para lectura offline =====
// Las paginas se guardan en el almacenamiento privado de la app (Directory.Data via
// @capacitor/filesystem) y el manifiesto (que capitulos hay, sus rutas locales) se guarda en
// localStorage. No depende de la web ni de sesion: funciona igual logueado o no, online u offline.
const OFFLINE_DIR = 'offline_chapters';
// LIMITE PROVISIONAL: falta que Ockuro confirme el cupo gratis final. Los VIP no tienen tope y
// "extra_offline_slots" (comprable como Pergaminos, ver store_buy_pergaminos.php) suma al cupo free.
const FREE_OFFLINE_SLOTS = 5;

function getCapacitorFilesystem() {
    return window.Capacitor?.Plugins?.Filesystem || null;
}

function getOfflineManifest() {
    try {
        return JSON.parse(localStorage.getItem('offlineChapters') || '{}');
    } catch {
        return {};
    }
}

function saveOfflineManifest(manifest) {
    localStorage.setItem('offlineChapters', JSON.stringify(manifest));
}

function getOfflineSlotLimit() {
    if (currentUser?.is_vip) return Infinity;
    const extra = currentUser?.extra_offline_slots || 0;
    return FREE_OFFLINE_SLOTS + extra;
}

function getOfflineSlotsUsed() {
    return Object.keys(getOfflineManifest()).length;
}

// Usa Filesystem.downloadFile (descarga nativa) en vez de fetch()+writeFile(): el origen del
// WebView de Capacitor es https://localhost, asi que un fetch() normal a orckumangas.com pega
// contra CORS -las imagenes son archivos estaticos servidos directo por el hosting, sin el
// header Access-Control-Allow-Origin que si tienen los endpoints de api-php-. downloadFile
// corre del lado nativo (no es una peticion del WebView), asi que no le aplica CORS.
async function downloadImageToFilesystem(url, path) {
    const Filesystem = getCapacitorFilesystem();
    const result = await Filesystem.downloadFile({ url, path, directory: 'DATA', recursive: true });
    if (!result || !result.path) throw new Error('No se pudo descargar la página');
}

// Reconstruye un objeto "chapter" como el que devuelve chapter.php, pero con las imagenes
// apuntando a los archivos locales ya descargados (convertFileSrc las vuelve URLs validas
// para un <img> dentro del WebView de Capacitor).
async function buildOfflineChapterPayload(entry) {
    const Filesystem = getCapacitorFilesystem();
    const images = [];
    for (const relPath of entry.localPaths) {
        try {
            const { uri } = await Filesystem.getUri({ path: relPath, directory: 'DATA' });
            images.push(window.Capacitor.convertFileSrc(uri));
        } catch (e) {
            images.push(null);
        }
    }
    return {
        manga_title: entry.mangaTitle,
        manga_slug: entry.mangaSlug,
        manga_id: entry.mangaId,
        chapter_number: entry.chapterNumber,
        images,
        prev_id: null,
        next_id: null,
    };
}

function refreshOfflineDownloadIcon(chapterId) {
    const icon = document.getElementById('reader-download-icon');
    if (!icon) return;
    icon.className = getOfflineManifest()[chapterId] ? 'fa-solid fa-circle-check' : 'fa-solid fa-download';
}

async function removeOfflineChapter(chapterId, fallbackDirPath) {
    const Filesystem = getCapacitorFilesystem();
    const manifest = getOfflineManifest();
    const entry = manifest[chapterId];
    const dirPath = entry ? `${OFFLINE_DIR}/${chapterId}` : fallbackDirPath;

    if (Filesystem && dirPath) {
        try {
            await Filesystem.rmdir({ path: dirPath, directory: 'DATA', recursive: true });
        } catch (e) {
            // Puede no existir todavia (ej. se cancelo a mitad de la descarga) - no es un error real.
        }
    }

    delete manifest[chapterId];
    saveOfflineManifest(manifest);
    refreshOfflineDownloadIcon(chapterId);
    if (typeof renderDownloadsScreen === 'function') renderDownloadsScreen();
}

async function downloadCurrentChapter(chapterId) {
    const images = readerState.images;
    if (!images || !images.length) return;

    const icon = document.getElementById('reader-download-icon');
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
    showNotification('Descargando capítulo para leer offline...');

    const dirPath = `${OFFLINE_DIR}/${chapterId}`;
    const localPaths = [];
    try {
        // Filesystem.downloadFile() ignora la opcion "recursive" en Android (a diferencia de
        // writeFile/mkdir), asi que si no se crea la carpeta del capitulo a mano antes de
        // descargar, la primera pagina falla con ENOENT porque la ruta destino no existe todavia.
        const Filesystem = getCapacitorFilesystem();
        try {
            await Filesystem.mkdir({ path: dirPath, directory: 'DATA', recursive: true });
        } catch (e) {
            // Ya existe (ej. se reintenta una descarga que fallo a mitad de camino) - no es un error real.
        }

        for (let i = 0; i < images.length; i++) {
            const ext = (images[i].split('.').pop() || 'jpg').split('?')[0].toLowerCase();
            const relPath = `${dirPath}/page_${i}.${ext}`;
            await downloadImageToFilesystem(siteUrl(images[i]), relPath);
            localPaths.push(relPath);
        }

        const manifest = getOfflineManifest();
        manifest[chapterId] = {
            chapterId,
            mangaId: readerState.mangaId,
            mangaTitle: readerState.mangaTitle,
            mangaSlug: readerState.mangaSlug,
            chapterNumber: readerState.chapterNumber,
            localPaths,
            downloadedAt: Date.now(),
        };
        saveOfflineManifest(manifest);
        refreshOfflineDownloadIcon(chapterId);
        showNotification('¡Capítulo descargado! Disponible en Mis Descargas.');
    } catch (err) {
        await removeOfflineChapter(chapterId, dirPath);
        showNotification('No se pudo descargar el capítulo: ' + err.message);
    }
}

async function toggleChapterDownload() {
    const chapterId = readerState?.chapterId;
    if (!chapterId) return;

    if (getOfflineManifest()[chapterId]) {
        if (!confirm('¿Borrar esta descarga offline?')) return;
        await removeOfflineChapter(chapterId);
        showNotification('Descarga eliminada.');
        return;
    }

    if (!getCapacitorFilesystem()) {
        showNotification('La descarga offline solo está disponible en la app instalada en el celular.');
        return;
    }

    const limit = getOfflineSlotLimit();
    if (getOfflineSlotsUsed() >= limit) {
        showNotification(`Llegaste al límite de ${limit} capítulos descargados. Consigue Pergaminos de Minas Tirith en la Tienda o hazte VIP para descargas ilimitadas.`);
        return;
    }

    await downloadCurrentChapter(chapterId);
}

// ===== Pantalla "Mis Descargas" =====
function renderDownloadsScreen() {
    const container = document.getElementById('downloads-list-container');
    const slotsText = document.getElementById('downloads-slots-text');
    const buyBtn = document.getElementById('downloads-buy-pergaminos-btn');
    if (!container) return;

    const manifest = getOfflineManifest();
    const entries = Object.values(manifest).sort((a, b) => b.downloadedAt - a.downloadedAt);
    const limit = getOfflineSlotLimit();

    if (slotsText) {
        slotsText.textContent = limit === Infinity
            ? `${entries.length} capítulos descargados · VIP (ilimitado)`
            : `${entries.length} / ${limit} capítulos descargados`;
    }
    if (buyBtn) buyBtn.style.display = (limit === Infinity) ? 'none' : 'flex';

    if (!entries.length) {
        container.innerHTML = '<p class="empty-grid-msg">Todavía no descargaste ningún capítulo. Abrí un capítulo y tocá el ícono de descarga para leerlo sin internet.</p>';
        return;
    }

    container.innerHTML = entries.map(entry => `
        <div class="download-item">
            <div class="download-item-info">
                <h4>${entry.mangaTitle || 'Manga'}</h4>
                <p>Capítulo ${entry.chapterNumber ?? '?'} · ${entry.localPaths.length} páginas</p>
            </div>
            <button class="btn-remove-download" onclick="removeOfflineChapter(${entry.chapterId})" title="Borrar descarga">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `).join('');
}

// Modo tira continua: todas las imagenes apiladas, scroll vertical normal
// Si una pagina no carga (link roto, imagen corrupta, etc.) mostrar un aviso claro en vez
// de dejar el icono de imagen rota del navegador, que parece que la app esta fallando.
function buildBrokenPageNotice(pageNumber) {
    const div = document.createElement("div");
    div.className = "reader-broken-page";
    div.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>No se pudo cargar la página ${pageNumber}.</p>
        <p class="reader-broken-page-hint">Avísale al staff en el Discord del servidor para que la revisen.</p>
    `;
    return div;
}

// Banner de anuncio nativo del lector - solo al INICIO y al FINAL del capitulo (decidido con
// Orckuro: nada en el medio de la tira, porque si el corte cae justo encima de una pagina se
// siente invasivo/feo; al cambio real de capitulo ya esta el intersticial aparte).
function insertReaderAdBanner(container) {
    if (userIsAdFree()) return;
    const adBox = document.createElement("div");
    adBox.className = "reader-in-page-ad";
    if (exoClickZoneReady(EXOCLICK_ZONE_NATIVE_BANNER)) {
        container.appendChild(adBox);
        loadExoClickNativeBanner(EXOCLICK_ZONE_NATIVE_BANNER, adBox);
    } else {
        adBox.innerHTML = `
            <p>Publicidad no invasiva integrada</p>
            <div class="ad-banner-mock">Anuncio Nativo Estético (Violeta)</div>
        `;
        container.appendChild(adBox);
    }
}

function renderStripPages(container, images) {
    container.innerHTML = "";
    images.forEach((imgPath, index) => {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = siteUrl(imgPath);
        img.onload = () => img.classList.add('loaded');
        img.onerror = () => img.replaceWith(buildBrokenPageNotice(index + 1));
        container.appendChild(img);

        if (index === 0) insertReaderAdBanner(container);
    });
    insertReaderAdBanner(container);
}

// Modo paginas: una imagen a la vez, con zonas de tap para avanzar/retroceder
function renderPaginatedPage() {
    const container = document.getElementById("reader-images-wrap");
    const { images, index } = readerState;
    container.innerHTML = `
        <div class="reader-page-view" onclick="handleReaderPageTap(event)">
            <img class="reader-page-single" src="${siteUrl(images[index])}" alt="Página ${index + 1}" onload="this.classList.add('loaded')" onerror="this.replaceWith(buildBrokenPageNotice(${index + 1}))">
        </div>
    `;
    updateReaderBottomNav();
}

function handleReaderPageTap(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const tapX = event.clientX - rect.left;
    if (tapX < rect.width * 0.4) {
        readerGoPrev();
    } else {
        readerGoNext();
    }
}

function updateReaderBottomNav() {
    const indicator = document.getElementById('reader-page-indicator');
    const prevBtn = document.getElementById('reader-nav-prev');
    const nextBtn = document.getElementById('reader-nav-next');
    const { mode, index, images, prevChapterId, nextChapterId } = readerState;

    if (mode === 'paginated') {
        indicator.textContent = `Página ${index + 1} / ${images.length}`;
        prevBtn.textContent = index === 0 ? 'Cap. anterior' : 'Anterior';
        nextBtn.textContent = (index === images.length - 1) ? 'Cap. siguiente' : 'Siguiente';
        prevBtn.classList.toggle('disabled', index === 0 && !prevChapterId);
        nextBtn.classList.toggle('disabled', index === images.length - 1 && !nextChapterId);
    } else {
        indicator.textContent = 'Capítulo Completo';
        prevBtn.textContent = 'Cap. anterior';
        nextBtn.textContent = 'Cap. siguiente';
        prevBtn.classList.toggle('disabled', !prevChapterId);
        nextBtn.classList.toggle('disabled', !nextChapterId);
    }
}

// Permite cambiar manualmente el modo de lectura sin importar el tipo de la obra
// (algunos lectores prefieren tira continua incluso en manga, o paginas en manhwa)
function toggleReaderMode() {
    if (!readerState.images || readerState.images.length === 0) return;

    readerState.mode = readerState.mode === 'paginated' ? 'strip' : 'paginated';
    readerState.index = 0;

    const container = document.getElementById('reader-images-wrap');
    const icon = document.getElementById('reader-mode-icon');

    if (readerState.mode === 'paginated') {
        renderPaginatedPage();
        icon.className = 'fa-solid fa-table-cells-large';
        showNotification('Modo de lectura: páginas');
    } else {
        renderStripPages(container, readerState.images);
        icon.className = 'fa-solid fa-images';
        showNotification('Modo de lectura: tira continua');
    }
    updateReaderBottomNav();
    applyReaderSettingsOnOpen();
}

function readerGoPrev() {
    if (readerState.mode === 'paginated' && readerState.index > 0) {
        readerState.index--;
        renderPaginatedPage();
        return;
    }
    if (readerState.prevChapterId) {
        // Intersticial solo al cambiar de CAPITULO (no al pasar de pagina dentro del mismo,
        // ver rama de arriba) - y nunca si el capitulo esta descargado offline (no hay red
        // para servir un anuncio real, y descargar es un perk pago que ya evita anuncios).
        if (!getOfflineManifest()[readerState.prevChapterId]) maybeShowInterstitialAd();
        readChapterFromApi(readerState.prevChapterId);
    }
}

function readerGoNext() {
    if (readerState.mode === 'paginated' && readerState.index < readerState.images.length - 1) {
        readerState.index++;
        renderPaginatedPage();
        return;
    }
    if (readerState.nextChapterId) {
        if (!getOfflineManifest()[readerState.nextChapterId]) maybeShowInterstitialAd();
        readChapterFromApi(readerState.nextChapterId);
    }
}

// Oculta la barra superior y la navegacion inferior del lector al desplazar hacia abajo,
// y las muestra de nuevo al desplazar hacia arriba (para no tapar la pagina mientras se lee).
let readerLastScrollTop = 0;

function setupReaderScrollAutoHide() {
    const scrollEl = document.getElementById('reader-pages-container');
    if (!scrollEl || scrollEl.dataset.autoHideBound) return;
    scrollEl.dataset.autoHideBound = '1';
    scrollEl.addEventListener('scroll', () => {
        const top = scrollEl.scrollTop;
        const delta = top - readerLastScrollTop;
        if (Math.abs(delta) > 5) {
            if (delta > 0 && top > 40) {
                hideReaderBars();
            } else {
                showReaderBars();
            }
            readerLastScrollTop = top;
        }
        updateReaderProgressBar();
    }, { passive: true });
}

function hideReaderBars() {
    document.querySelector('.reader-top-bar')?.classList.add('reader-bar-hidden');
    document.querySelector('.reader-bottom-nav')?.classList.add('reader-bar-hidden');
    document.getElementById('reader-progress-bar')?.classList.add('reader-bar-hidden');
}

function showReaderBars() {
    document.querySelector('.reader-top-bar')?.classList.remove('reader-bar-hidden');
    document.querySelector('.reader-bottom-nav')?.classList.remove('reader-bar-hidden');
    document.getElementById('reader-progress-bar')?.classList.remove('reader-bar-hidden');
}

function resetReaderBarsVisibility() {
    readerLastScrollTop = 0;
    showReaderBars();
}

// ===== Ajustes de lectura: brillo, filtro nocturno, auto-scroll, pantalla encendida,
// tap-to-scroll, zoom y barra de progreso. Preferencias guardadas por dispositivo. =====
let readerPrefs = Object.assign({
    brightness: 100,
    nightFilter: false,
    autoScrollEnabled: false,
    autoScrollSpeed: 4,
    wakeLockEnabled: true,
}, JSON.parse(localStorage.getItem('orcku_reader_prefs') || '{}'));

function saveReaderPrefs() {
    localStorage.setItem('orcku_reader_prefs', JSON.stringify(readerPrefs));
}

function toggleReaderOptionsPanel() {
    document.getElementById('reader-options-panel').classList.add('active');
    document.getElementById('reader-options-overlay').classList.add('active');
}

function closeReaderOptionsPanel() {
    document.getElementById('reader-options-panel').classList.remove('active');
    document.getElementById('reader-options-overlay').classList.remove('active');
}

function applyReaderBrightness(value) {
    const overlay = document.getElementById('reader-brightness-overlay');
    if (!overlay) return;
    const v = Math.max(20, Math.min(100, value));
    // Maximo 85% de oscurecimiento (a brillo 20, el minimo permitido) para no dejar la
    // pantalla completamente negra e ilegible.
    overlay.style.opacity = (((100 - v) / 80) * 0.85).toFixed(2);
}

function toggleNightFilter() {
    readerPrefs.nightFilter = document.getElementById('reader-opt-night').checked;
    saveReaderPrefs();
    document.getElementById('screen-reader').classList.toggle('reader-night-filter', readerPrefs.nightFilter);
}

// Auto-scroll: desplaza el contenedor del capitulo solo, a velocidad ajustable (1-10).
// Usa requestAnimationFrame (un paso por cuadro, basado en el tiempo real transcurrido) en
// vez de setInterval cada 50ms: con setInterval el avance era a saltos de varios px de
// golpe 20 veces por segundo, se sentia con tirones. Con rAF el avance es continuo y suave.
let autoScrollRAF = null;
let autoScrollLastTimestamp = null;

function autoScrollStep(timestamp) {
    if (autoScrollLastTimestamp === null) autoScrollLastTimestamp = timestamp;
    const elapsedMs = timestamp - autoScrollLastTimestamp;
    autoScrollLastTimestamp = timestamp;

    const scrollEl = document.getElementById('reader-pages-container');
    const pxPerMs = readerPrefs.autoScrollSpeed * 0.05;
    scrollEl.scrollTop += pxPerMs * elapsedMs;

    autoScrollRAF = requestAnimationFrame(autoScrollStep);
}

function startAutoScroll() {
    const wasPlaying = !!autoScrollRAF;
    if (autoScrollRAF) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
    }
    autoScrollLastTimestamp = null;
    autoScrollRAF = requestAnimationFrame(autoScrollStep);
    const icon = document.getElementById('reader-autoscroll-icon');
    if (icon) icon.className = 'fa-solid fa-pause';
    if (!wasPlaying) {
        document.getElementById('reader-autoscroll-btn')?.classList.add('playing');
    }
}

function stopAutoScroll() {
    if (autoScrollRAF) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
    }
    autoScrollLastTimestamp = null;
    const icon = document.getElementById('reader-autoscroll-icon');
    if (icon) icon.className = 'fa-solid fa-play';
    document.getElementById('reader-autoscroll-btn')?.classList.remove('playing');
}

function toggleAutoScrollPlayback() {
    if (autoScrollRAF) stopAutoScroll(); else startAutoScroll();
}

function toggleAutoScrollSetting() {
    readerPrefs.autoScrollEnabled = document.getElementById('reader-opt-autoscroll').checked;
    saveReaderPrefs();
    updateAutoScrollUiVisibility();
    if (readerPrefs.autoScrollEnabled && readerState.mode === 'strip') startAutoScroll();
    else stopAutoScroll();
}

function updateAutoScrollUiVisibility() {
    const show = readerPrefs.autoScrollEnabled && readerState.mode === 'strip';
    document.getElementById('reader-autoscroll-speed-row').style.display = readerPrefs.autoScrollEnabled ? 'flex' : 'none';
    document.getElementById('reader-autoscroll-btn').style.display = show ? 'flex' : 'none';
}

// Mantener pantalla encendida mientras se lee (Screen Wake Lock API, sin plugin nativo).
let wakeLockSentinel = null;

async function acquireWakeLock() {
    if (!readerPrefs.wakeLockEnabled || !navigator.wakeLock || wakeLockSentinel) return;
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
    } catch (e) {
        // Algunos dispositivos lo niegan si la app no esta en foco; no es critico, se reintenta
        // al volver a ponerse visible (ver listener de visibilitychange mas abajo).
    }
}

function releaseWakeLock() {
    if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
    }
}

function toggleWakeLockSetting() {
    readerPrefs.wakeLockEnabled = document.getElementById('reader-opt-wakelock').checked;
    saveReaderPrefs();
    if (readerPrefs.wakeLockEnabled) acquireWakeLock(); else releaseWakeLock();
}

document.addEventListener('visibilitychange', () => {
    const readerActive = document.getElementById('screen-reader')?.classList.contains('active');
    if (readerActive && document.visibilityState === 'visible') acquireWakeLock();
});

// Barra de progreso arrastrable: solo tiene sentido en modo tira continua.
function updateReaderProgressBar() {
    const scrollEl = document.getElementById('reader-pages-container');
    const bar = document.getElementById('reader-progress-bar');
    if (!scrollEl || !bar || readerState.mode !== 'strip') return;
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    const pct = max > 0 ? (scrollEl.scrollTop / max) * 100 : 0;
    bar.value = Math.round(pct * 10);
    bar.style.setProperty('--reader-progress', pct + '%');
}

function seekReaderProgressBar(value) {
    const scrollEl = document.getElementById('reader-pages-container');
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    scrollEl.scrollTop = (value / 1000) * max;
}

// Tap-to-scroll + doble tap para zoom puntual en una pagina (solo modo tira continua; en modo
// paginas ya existe handleReaderPageTap() con su propia logica de avanzar/retroceder).
// El scroll arranca DE UNA en el primer toque (con una animacion propia por rAF, no la
// smooth-scroll nativa) en vez de esperar ~300ms a ver si llega un segundo toque - esa espera
// se sentia como demora al usar tap-to-scroll. Si llega un segundo toque rapido encima de la
// misma imagen, se cancela la animacion en curso (apenas se nota, recien empezo) y se hace
// zoom en su lugar.
let readerLastTapTime = 0;
let readerLastTapTarget = null;
let readerTapScrollAnim = null;

function setupReaderTapGestures() {
    const wrap = document.getElementById('reader-images-wrap');
    if (!wrap || wrap.dataset.tapBound) return;
    wrap.dataset.tapBound = '1';
    wrap.addEventListener('click', handleReaderStripTap);
    wrap.addEventListener('pointerdown', handleAutoScrollHoldStart);
    wrap.addEventListener('pointerup', handleAutoScrollHoldEnd);
    wrap.addEventListener('pointercancel', handleAutoScrollHoldEnd);
}

// Mantener el dedo presionado pausa el auto-scroll (sin tocar el estado del switch del panel
// de ajustes); al soltar, continua solo. Si la presion duro lo suficiente para sentirse como
// una pausa real (no un toque rapido), se ignora el "click" que dispara despues al soltar -
// si no, ese click haria un tap-to-scroll extra justo al reanudar.
let autoScrollHeldPause = false;
let autoScrollHoldStartTime = 0;
let suppressNextReaderTap = false;

function handleAutoScrollHoldStart() {
    if (readerState.mode !== 'strip' || !autoScrollRAF) return;
    autoScrollHeldPause = true;
    autoScrollHoldStartTime = Date.now();
    stopAutoScroll();
}

function handleAutoScrollHoldEnd() {
    if (!autoScrollHeldPause) return;
    autoScrollHeldPause = false;
    if (Date.now() - autoScrollHoldStartTime > 180) {
        suppressNextReaderTap = true;
    }
    if (readerPrefs.autoScrollEnabled) startAutoScroll();
}

function cancelReaderTapScrollAnim() {
    if (readerTapScrollAnim) {
        cancelAnimationFrame(readerTapScrollAnim);
        readerTapScrollAnim = null;
    }
}

// Scroll animado y cancelable (a diferencia de scrollBy({behavior:'smooth'}) nativo, que no
// se puede interrumpir a medio camino de forma confiable en todos los WebView).
function animateReaderScrollBy(scrollEl, deltaY, duration = 320) {
    cancelReaderTapScrollAnim();
    const startTop = scrollEl.scrollTop;
    const startTime = performance.now();
    function step(now) {
        const t = Math.min((now - startTime) / duration, 1);
        // ease-IN (arranca lento, acelera al final) a proposito: si el toque resulta ser el
        // primero de un doble tap, la ventana de deteccion (320ms) cae justo en la parte
        // lenta de la curva, asi que apenas se alcanza a mover antes de cancelarse para el
        // zoom. Con ease-out (como estaba antes) ya se habia recorrido la mayoria de la
        // distancia en esos mismos 320ms, y el doble tap se sentia con un salto notorio.
        const eased = Math.pow(t, 3);
        scrollEl.scrollTop = startTop + deltaY * eased;
        readerTapScrollAnim = t < 1 ? requestAnimationFrame(step) : null;
    }
    readerTapScrollAnim = requestAnimationFrame(step);
}

function handleReaderStripTap(event) {
    if (readerState.mode !== 'strip') return;
    if (suppressNextReaderTap) {
        suppressNextReaderTap = false;
        return;
    }
    const now = Date.now();
    const isDoubleTap = (now - readerLastTapTime < 320) && readerLastTapTarget === event.target;
    readerLastTapTime = isDoubleTap ? 0 : now;
    readerLastTapTarget = event.target;

    if (isDoubleTap) {
        cancelReaderTapScrollAnim();
        if (event.target.tagName === 'IMG') toggleImageZoom(event.target, event);
        return;
    }

    const scrollEl = document.getElementById('reader-pages-container');
    const viewportH = scrollEl.clientHeight;
    const goingUp = event.clientY < window.innerHeight / 2;
    animateReaderScrollBy(scrollEl, goingUp ? -viewportH * 0.8 : viewportH * 0.8);
}

function toggleImageZoom(img, event) {
    if (img.classList.contains('reader-page-zoomed')) {
        img.classList.remove('reader-page-zoomed');
        img.style.transformOrigin = '';
    } else {
        const rect = img.getBoundingClientRect();
        const originX = ((event.clientX - rect.left) / rect.width) * 100;
        const originY = ((event.clientY - rect.top) / rect.height) * 100;
        img.style.transformOrigin = `${originX}% ${originY}%`;
        img.classList.add('reader-page-zoomed');
    }
}

// Precarga del siguiente capitulo en segundo plano mientras se lee el actual, para que la
// transicion al pasar de capitulo se sienta instantanea. preload=1 evita inflar el contador
// de vistas de un capitulo que todavia no se leyo de verdad.
let preloadedChapters = {};

async function preloadNextChapter(nextChapterId) {
    if (!nextChapterId || preloadedChapters[nextChapterId]) return;
    try {
        const chapter = await apiRequest(`chapter.php?id=${nextChapterId}&preload=1`);
        preloadedChapters[nextChapterId] = chapter;
        if (chapter.images && chapter.images[0]) {
            new Image().src = siteUrl(chapter.images[0]);
        }
    } catch (e) {
        // Si falla la precarga no pasa nada: se pedira normal cuando el usuario navegue ahi.
    }
}

// Aplica brillo/filtro nocturno/auto-scroll/wake-lock guardados cada vez que se abre un
// capitulo (los controles del panel son elementos fijos que no se recrean, pero el estado
// que dependen de readerState.mode -como la barra de progreso o el boton de auto-scroll- si
// hay que re-evaluarlo en cada apertura/cambio de capitulo).
function applyReaderSettingsOnOpen() {
    applyReaderBrightness(readerPrefs.brightness);
    document.getElementById('screen-reader').classList.toggle('reader-night-filter', readerPrefs.nightFilter);
    acquireWakeLock();
    updateAutoScrollUiVisibility();
    if (readerPrefs.autoScrollEnabled && readerState.mode === 'strip') startAutoScroll();
    else stopAutoScroll();
    setupReaderTapGestures();
    document.getElementById('reader-progress-bar').style.display = readerState.mode === 'strip' ? 'block' : 'none';
    updateReaderProgressBar();
}

// Conecta los controles del panel de ajustes una sola vez al iniciar la app (los elementos
// son fijos en el HTML, no se recrean al abrir/cerrar el lector) y refleja las preferencias
// guardadas del dispositivo en cada control.
function setupReaderOptionControls() {
    const brightnessInput = document.getElementById('reader-opt-brightness');
    const nightInput = document.getElementById('reader-opt-night');
    const autoScrollInput = document.getElementById('reader-opt-autoscroll');
    const autoScrollSpeedInput = document.getElementById('reader-opt-autoscroll-speed');
    const wakeLockInput = document.getElementById('reader-opt-wakelock');
    const progressBar = document.getElementById('reader-progress-bar');

    brightnessInput.value = readerPrefs.brightness;
    nightInput.checked = readerPrefs.nightFilter;
    autoScrollInput.checked = readerPrefs.autoScrollEnabled;
    autoScrollSpeedInput.value = readerPrefs.autoScrollSpeed;
    wakeLockInput.checked = readerPrefs.wakeLockEnabled;
    document.getElementById('reader-autoscroll-speed-row').style.display = readerPrefs.autoScrollEnabled ? 'flex' : 'none';

    brightnessInput.addEventListener('input', (e) => {
        readerPrefs.brightness = parseInt(e.target.value, 10);
        saveReaderPrefs();
        applyReaderBrightness(readerPrefs.brightness);
    });

    autoScrollSpeedInput.addEventListener('input', (e) => {
        readerPrefs.autoScrollSpeed = parseInt(e.target.value, 10);
        saveReaderPrefs();
        if (autoScrollRAF) startAutoScroll();
    });

    progressBar.addEventListener('input', (e) => {
        seekReaderProgressBar(parseInt(e.target.value, 10));
    });
}

// Marca un capítulo como leído en el backend real, si hay sesión activa
function markChapterReadIfLoggedIn(mangaSlug, chapterNum) {
    if (!USE_REAL_API || !authToken) return;
    // En modo real, readChapterFromApi ya se encarga de esto con el chapter_id real.
}

function closeReader() {
    const reader = document.getElementById("screen-reader");
    reader.style.display = "none";
    reader.classList.remove("active");
    stopAutoScroll();
    releaseWakeLock();
    closeReaderOptionsPanel();
}

// Maneja el botón/gesto "atrás" físico de Android. Sin esto, Capacitor usa el comportamiento
// nativo por defecto: como la app es un SPA que nunca cambia el historial real del WebView,
// CUALQUIER toque de "atrás" cerraba la app entera de inmediato, sin importar en qué pantalla
// estuviera el usuario. Orden de prioridad: lector abierto > modales abiertos > pantalla
// anterior en el historial > si ya está en "home" sin historial, recién ahí se sale de la app.
function handleAndroidBackButton() {
    const reader = document.getElementById('screen-reader');
    if (reader && reader.classList.contains('active')) {
        closeReader();
        return;
    }

    // Overlays a pantalla completa: tienen que cerrarse con "atras" antes de navegar de
    // pantalla, si no el boton fisico se salta el modal entero (reportado: abrías una foto de
    // la galeria, dabas "atras" para cerrarla, y en vez de eso te mandaba a otra pestaña).
    const galleryViewer = document.getElementById('gallery-viewer-overlay');
    if (galleryViewer && galleryViewer.classList.contains('active')) {
        closeGalleryViewer();
        return;
    }
    const cardZoom = document.getElementById('gacha-card-zoom-overlay');
    if (cardZoom && cardZoom.classList.contains('active')) {
        closeGachaCardZoom();
        return;
    }
    const gachaReveal = document.getElementById('gacha-reveal-overlay');
    if (gachaReveal && gachaReveal.classList.contains('active')) {
        closeGachaReveal();
        return;
    }
    const gachaArchive = document.getElementById('gacha-archive-overlay');
    if (gachaArchive && gachaArchive.classList.contains('active')) {
        closeGachaArchive();
        return;
    }

    const uploadModal = document.getElementById('upload-waifu-modal');
    if (uploadModal && uploadModal.classList.contains('active')) {
        closeUploadModal();
        return;
    }

    const searchDropdown = document.getElementById('search-dropdown');
    if (searchDropdown && searchDropdown.classList.contains('active')) {
        searchDropdown.classList.remove('active');
        return;
    }

    const headerPopover = document.getElementById('header-profile-popover');
    if (headerPopover && headerPopover.classList.contains('active')) {
        closeHeaderProfilePopover();
        return;
    }

    const notificationsPanel = document.getElementById('header-notifications-panel');
    if (notificationsPanel && notificationsPanel.classList.contains('active')) {
        closeNotificationsPanel();
        return;
    }

    if (screenHistory.length > 1) {
        screenHistory.pop();
        const previousScreen = screenHistory[screenHistory.length - 1];
        switchScreen(previousScreen, null, true);
        return;
    }

    if (window.Capacitor?.Plugins?.App) {
        window.Capacitor.Plugins.App.exitApp();
    }
}

function setupAndroidBackButton() {
    if (window.Capacitor?.Plugins?.App) {
        window.Capacitor.Plugins.App.addListener('backButton', handleAndroidBackButton);
        // Al volver de otra app (ej. navegador tras el OAuth de Patreon), re-sincronizar
        // el estado del servidor para que la Tienda refleje el tier/VIP actualizado sin
        // que el usuario tenga que reiniciar la app manualmente.
        window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
            if (state.isActive && authToken) syncWalletBalance();
        });
    }
}

// ── Patreon OAuth ──────────────────────────────────────────────────────────
const PATREON_CLIENT_ID = 'cBADsvOi_zR8t_rlyjXDkYcjodJcxlKFrhzgqJZgoub08T5TMNbDvFCGa_nEKI5N';
const PATREON_REDIRECT  = 'https://orckumangas.com/api-php/patreon_oauth.php';

const PATREON_TIER_NAMES = {
    0: null,
    1: 'El Poney Pisador',
    2: 'Juramento del Montaraz',
    3: 'Forja de Celebrimbor',
    4: 'El Concilio Blanco',
};

function connectPatreon() {
    if (!authToken) {
        showNotification('Inicia sesión antes de vincular Patreon.');
        switchScreen('login');
        return;
    }
    const url = 'https://www.patreon.com/oauth2/authorize'
        + '?response_type=code'
        + '&client_id=' + encodeURIComponent(PATREON_CLIENT_ID)
        + '&redirect_uri=' + encodeURIComponent(PATREON_REDIRECT)
        + '&scope=identity%20identity.memberships'
        + '&state=' + encodeURIComponent(authToken);
    window.open(url, '_system');
    // Al volver a la app el usuario puede tocar "Reconectar" o volver a la Tienda
    // para que syncWalletBalance() recargue su tier actualizado.
}

function renderPatreonConnectArea() {
    const tier = currentUser?.patreon_tier ?? 0;
    const connected = currentUser?.patreon_connected ?? false;

    const connectedInfo = document.getElementById('patreon-connected-info');
    const tierLabel     = document.getElementById('patreon-tier-label');
    const connectBtn    = document.getElementById('btn-connect-patreon');
    const grid          = document.getElementById('patreon-tiers-grid');
    if (!connectedInfo || !connectBtn) return;

    // Marcar card activa
    if (grid) {
        grid.querySelectorAll('.patreon-tier-card').forEach(card => {
            const t = parseInt(card.dataset.tier);
            card.classList.toggle('ptier-active', connected && t === tier && tier > 0);
            const badge = card.querySelector('.ptier-badge');
            if (badge && connected && t === tier && tier > 0) {
                badge.textContent = '✓ ACTIVO';
                badge.classList.add('ptier-badge-active');
            }
        });
    }

    if (connected && tier > 0) {
        connectedInfo.style.display = 'flex';
        tierLabel.textContent = 'Tier activo: ' + (PATREON_TIER_NAMES[tier] || 'Desconocido');
        connectBtn.style.display = 'none';
    } else if (connected && tier === 0) {
        connectedInfo.style.display = 'flex';
        tierLabel.textContent = 'Patreon vinculado — sin suscripción activa';
        connectBtn.style.display = 'none';
    } else {
        connectedInfo.style.display = 'none';
        connectBtn.style.display = 'flex';
    }
}

// ── Packs de Runas vía Binance ─────────────────────────────────────────────
async function buyRunasPack(packId) {
    if (!authToken) {
        showNotification('Inicia sesión para comprar Runas.');
        switchScreen('login');
        return;
    }
    try {
        const data = await apiRequest('binance_payment_request.php', {
            method: 'POST',
            body: JSON.stringify({ pack_id: packId }),
        });
        showBinanceModal(data.ref, data.runas, data.usdt, data.binance_uid);
    } catch (err) {
        showNotification(err.message);
    }
}

function showBinanceModal(ref, runas, usdt, binanceUid) {
    const uid = binanceUid || 'Consultar al staff en Discord';
    const overlay = document.createElement('div');
    overlay.className = 'binance-modal-overlay';
    overlay.innerHTML = `
        <div class="binance-modal">
            <h3>💎 Comprar ${runas} Runas</h3>
            <p style="font-size:13px;color:var(--text-muted);margin:4px 0 0">Envía exactamente <strong style="color:var(--text-primary)">$${usdt} USDT</strong> a la cuenta Binance del scan:</p>

            <div class="bm-step" style="margin-top:14px"><span>1.</span><span>UID Binance: <strong>${uid}</strong></span></div>
            <div class="bm-step"><span>2.</span><span>Monto: <strong>$${usdt} USDT</strong></span></div>
            <div class="bm-step"><span>3.</span><span>En el campo <em>Nota / Referencia</em> del pago, pon exactamente este código:</span></div>

            <div class="bm-ref" onclick="navigator.clipboard?.writeText('${ref}').then(()=>showNotification('¡Código copiado!'))">
                ${ref}
                <span style="font-size:.75em;color:var(--text-muted);display:block;margin-top:3px">Toca para copiar</span>
            </div>

            <div class="bm-step"><span>4.</span><span>Toca <strong>"Ya pagué"</strong> y el staff verificará tu pago (máx. 24h).</span></div>

            <div class="bm-actions">
                <button class="bm-btn-cancel" onclick="this.closest('.binance-modal-overlay').remove()">Cancelar</button>
                <button class="bm-btn-paid" onclick="confirmBinancePayment(this)">Ya pagué ✓</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function confirmBinancePayment(btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
        // El registro ya se hizo en buyRunasPack(). Solo cerramos el modal y avisamos.
        btn.closest('.binance-modal-overlay').remove();
        showNotification('¡Recibido! El staff verificará tu pago y acreditará las Runas en un máximo de 24h.');
    } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Ya pagué ✓';
        showNotification(err.message);
    }
}

// ── Tip Jar ─────────────────────────────────────────────────────────────────

const TIP_BADGE_ICONS = { trasgo: '🗡️', capataz: '⚔️', lugarteniente: '👁️' };

function renderDonationBadge() {
    const badge    = currentUser?.donation_badge;
    const el       = document.getElementById('profile-donation-badge');
    const iconEl   = document.getElementById('profile-donation-badge-icon');
    const textEl   = document.getElementById('profile-donation-badge-text');
    if (!el) return;
    if (badge) {
        iconEl.textContent = TIP_BADGE_ICONS[badge.id] || '🔥';
        textEl.textContent = badge.label;
        el.style.display = 'inline-flex';
    } else {
        el.style.display = 'none';
    }
}

// Racha de check-in diario (2026-07-18) - reutiliza users.checkin_streak, que ya calcula
// daily_checkin.php server-side (no hay nada nuevo que instrumentar del lado del cliente).
function renderStreakBadge() {
    const el = document.getElementById('profile-streak-badge');
    const textEl = document.getElementById('profile-streak-badge-text');
    if (!el) return;
    const streak = currentUser?.checkin_streak || 0;
    if (streak >= 1) {
        textEl.textContent = `Racha de ${streak} día${streak === 1 ? '' : 's'}`;
        el.style.display = 'inline-flex';
    } else {
        el.style.display = 'none';
    }
}

async function buyTip(amountId) {
    if (!authToken) {
        showNotification('Inicia sesión para donar.');
        switchScreen('login');
        return;
    }
    try {
        const data = await apiRequest('tip_donate.php', {
            method: 'POST',
            body: JSON.stringify({ amount_id: amountId }),
        });
        showTipModal(data.ref, data.usdt, data.label, data.binance_uid);
    } catch (err) {
        showNotification(err.message);
    }
}

function showTipModal(ref, usdt, label, binanceUid) {
    const uid = binanceUid || 'Consultar al staff en Discord';
    const overlay = document.createElement('div');
    overlay.className = 'binance-modal-overlay';
    overlay.innerHTML = `
      <div class="binance-modal">
        <h3>🔥 Apoyar al Scan</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">${label} · sin ventaja en juego</p>
        <div class="bm-ref">${ref}</div>
        <div class="bm-step"><strong>1.</strong> Abre Binance y envía exactamente <strong>${usdt} USDT</strong> al UID <strong>${uid}</strong>.</div>
        <div class="bm-step"><strong>2.</strong> Usa el código de arriba como referencia/nota del pago.</div>
        <div class="bm-step"><strong>3.</strong> El staff verificará y acreditará tu insignia (máx. 24h).</div>
        <div class="bm-actions">
          <button class="bm-btn-paid" onclick="confirmBinancePayment(this)">Ya pagué ✓</button>
          <button class="bm-btn-cancel" onclick="this.closest('.binance-modal-overlay').remove()">Cancelar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

// "Ración de Lembas": pase de 24h sin anuncios, comprado con Runas reales. A diferencia del VIP
// mensual de arriba, este SÍ es 100% real porque las Runas ya son moneda real del usuario
// (mismo patrón de débito atómico que gacha_pull.php), no requiere ninguna pasarela de pago.
async function buyLembasPass() {
    if (!authToken) {
        showNotification('Inicia sesión para comprar la Ración de Lembas.');
        switchScreen('login');
        return;
    }
    if (!confirm('¿Comprar la Ración de Lembas por 25 Runas? (24h sin anuncios)')) return;

    try {
        const data = await apiRequest('store_buy_lembas.php', { method: 'POST', body: JSON.stringify({}) });
        userCoins = data.coins;
        updateCoinsDisplay();
        if (currentUser) {
            currentUser.ad_free_until = data.ad_free_until;
            currentUser.is_ad_free = true;
            saveSession(authToken, currentUser);
            renderProfileAuthState();
        }
        showNotification('¡Ración de Lembas activada! 24 horas sin anuncios.');
    } catch (err) {
        showNotification(err.message);
    }
}

// Precio y cantidad confirmados por Ockuro (2026-07-01). Debe coincidir con
// PERGAMINOS_COST / PERGAMINOS_SLOTS en store_buy_pergaminos.php.
const PERGAMINOS_COST = 20;
const PERGAMINOS_SLOTS = 5;

async function buyPergaminos() {
    if (!authToken) {
        showNotification('Inicia sesión para comprar Pergaminos de Minas Tirith.');
        switchScreen('login');
        return;
    }
    if (!confirm(`¿Comprar Pergaminos de Minas Tirith por ${PERGAMINOS_COST} Runas? (+${PERGAMINOS_SLOTS} cupos de descarga offline)`)) return;

    try {
        const data = await apiRequest('store_buy_pergaminos.php', { method: 'POST', body: JSON.stringify({}) });
        userCoins = data.coins;
        updateCoinsDisplay();
        if (currentUser) {
            currentUser.extra_offline_slots = data.extra_offline_slots;
            saveSession(authToken, currentUser);
        }
        showNotification(`¡+${PERGAMINOS_SLOTS} cupos de descarga offline conseguidos!`);
        renderDownloadsScreen();
    } catch (err) {
        showNotification(err.message);
    }
}

// Toast Notifications helper
function showNotification(text) {
    const toast = document.createElement("div");
    toast.style.position = "absolute";
    toast.style.bottom = "80px";
    toast.style.left = "50%";
    toast.style.transform = "translateX(-50%)";
    toast.style.background = "rgba(157, 78, 221, 0.95)";
    toast.style.color = "#fff";
    toast.style.padding = "12px 24px";
    toast.style.borderRadius = "30px";
    toast.style.fontSize = "12.5px";
    toast.style.fontWeight = "700";
    toast.style.zIndex = "9999";
    toast.style.boxShadow = "0 8px 25px rgba(0,0,0,0.6)";
    toast.style.maxWidth = "85%";
    toast.style.whiteSpace = "normal";
    toast.style.textAlign = "center";
    toast.style.border = "1px solid rgba(255,255,255,0.1)";
    
    toast.textContent = text;
    
    // Append to phone screen
    const phoneScreen = document.querySelector(".phone-screen");
    phoneScreen.appendChild(toast);
    
    // Animate and destroy
    setTimeout(() => {
        toast.style.transition = "opacity 0.5s ease";
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 500);
    }, 2500);
}
