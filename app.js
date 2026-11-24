/**
 * CACHUELO — Panel Administrativo Web Oficial (Todo Ecuador)
 * Conectado 100% en tiempo real a Supabase Cloud (PostgreSQL 17 + RLS + RPCs Atómicas)
 * Ningún dato bancario privado está hardcodeado en el cliente: la tesorería se obtiene
 * exclusivamente desde el servidor tras autenticar un usuario con rol 'admin' u 'owner'.
 */

const SUPABASE_URL = 'https://dsutranzydjwsgdqeypz.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzdXRyYW56eWRqd3NnZHFleXB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NTY1MzcsImV4cCI6MjExMTAzMjUzN30.cv6JNk8AxP6zDLErVVkINP-3SzS4blLIe8zrDdb5PiI';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  adminProfile: null,
  summary: {},
  treasury: null,
  users: [],
  walletsByUser: {},
  workerLocations: [],
  cachuelos: [],
  settlements: [],
  transactions: [],
  withdrawals: [],
  reports: [],
  ratings: [],
  settings: {},
  auditLogs: [],
  map: null,
  mapMarkersLayer: null,
  realtimeChannel: null,
};

function esc(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtUsd(num) {
  const n = Number(num || 0);
  return '$' + n.toFixed(2);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-EC', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function showToast(msg, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' toast-error' : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function openModal(title, htmlContent) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = htmlContent;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
}

/* ============================================================================
   1. AUTENTICACIÓN Y VERIFICACIÓN DE ROL ADMINISTRATIVO EN SERVIDOR
============================================================================ */
async function checkInitialSession() {
  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    await verifyAndEnterAdmin(data.session.user.id);
  }
}

async function verifyAndEnterAdmin(uid) {
  const errBox = document.getElementById('auth-error');
  errBox.classList.add('hidden');

  try {
    const { data: profile, error: profErr } = await sb
      .from('profiles')
      .select('*')
      .eq('id', uid)
      .maybeSingle();

    if (profErr || !profile) {
      throw new Error('No se encontró un perfil válido para esta cuenta.');
    }

    if (!['admin', 'owner'].includes(profile.role) || profile.is_active === false) {
      await sb.auth.signOut();
      throw new Error(
        'Acceso denegado: Tu cuenta (' +
          (profile.email || '') +
          ') tiene rol "' +
          profile.role +
          '". Se requiere rol administrativo (admin u owner) verificado en servidor.'
      );
    }

    // Confirm server-side RPC authorization
    const { data: summaryData, error: rpcErr } = await sb.rpc('admin_get_dashboard_summary');
    if (rpcErr) {
      await sb.auth.signOut();
      throw new Error('Autorización RPC rechazada por el servidor: ' + rpcErr.message);
    }

    state.adminProfile = profile;
    state.summary = summaryData || {};

    document.getElementById('admin-name').textContent =
      profile.full_name || profile.email || 'Admin';
    document.getElementById('admin-role').textContent = (profile.role || 'ADMIN').toUpperCase();
    document.getElementById('admin-avatar').textContent = (
      profile.full_name ||
      profile.email ||
      'A'
    )[0].toUpperCase();

    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('admin-app').classList.remove('hidden');

    initNationalMap();
    await loadAllAdminData();
    subscribeRealtime();
  } catch (err) {
    errBox.textContent = err.message || String(err);
    errBox.classList.remove('hidden');
  }
}

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('btn-login');
  const errBox = document.getElementById('auth-error');

  errBox.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Verificando credenciales y rol...';

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await verifyAndEnterAdmin(data.user.id);
  } catch (err) {
    errBox.textContent = err.message || 'Credenciales inválidas.';
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ingresar al Panel Administrativo';
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (state.realtimeChannel) {
    sb.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  await sb.auth.signOut();
  state.adminProfile = null;
  document.getElementById('admin-app').classList.add('hidden');
  document.getElementById('auth-gate').classList.remove('hidden');
});

document.getElementById('btn-forgot-password').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const errBox = document.getElementById('auth-error');
  const infoBox = document.getElementById('auth-info');
  errBox.classList.add('hidden');
  infoBox.classList.add('hidden');

  if (!email || !email.includes('@')) {
    errBox.textContent = 'Escribe tu correo electrónico administrativo arriba antes de solicitar el enlace.';
    errBox.classList.remove('hidden');
    return;
  }

  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) throw error;
    infoBox.textContent =
      'Se envió un enlace de recuperación de contraseña a ' + email + '.';
    infoBox.classList.remove('hidden');
  } catch (err) {
    errBox.textContent = 'No se pudo enviar el enlace: ' + (err.message || err);
    errBox.classList.remove('hidden');
  }
});

document.getElementById('btn-change-password').addEventListener('click', () => {
  openModal(
    'Cambiar Contraseña Administrativa',
    `
      <form id="form-change-admin-pass">
        <p class="text-muted mb-20">
          Actualiza la contraseña de tu cuenta administrativa (<strong>${esc(
            state.adminProfile?.email || ''
          )}</strong>) directamente en Supabase Auth.
        </p>
        <div class="form-group">
          <label>Nueva contraseña (mínimo 8 caracteres) *</label>
          <input type="password" id="new-admin-pass" minlength="8" required placeholder="Nueva contraseña segura" />
        </div>
        <div class="form-group">
          <label>Confirmar nueva contraseña *</label>
          <input type="password" id="confirm-admin-pass" minlength="8" required placeholder="Repite la nueva contraseña" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Actualizar Contraseña en Supabase Auth</button>
      </form>
    `
  );

  document.getElementById('form-change-admin-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = document.getElementById('new-admin-pass').value;
    const p2 = document.getElementById('confirm-admin-pass').value;
    if (p1.length < 8) {
      showToast('La contraseña debe tener al menos 8 caracteres.', true);
      return;
    }
    if (p1 !== p2) {
      showToast('Las contraseñas no coinciden.', true);
      return;
    }
    try {
      const { error } = await sb.auth.updateUser({ password: p1 });
      if (error) throw error;
      try {
        await sb.rpc('log_admin_action', {
          p_action_type: 'CHANGE_ADMIN_PASSWORD',
          p_target_entity: 'auth.users',
          p_target_id: state.adminProfile?.id || '',
          p_details: { updated_via: 'admin_web_panel' },
        });
      } catch (_) {}
      closeModal();
      showToast('Contraseña administrativa actualizada con éxito.');
      await loadAllAdminData();
    } catch (err) {
      showToast('Error al cambiar contraseña: ' + (err.message || err), true);
    }
  });
});

/* ============================================================================
   2. CARGA DE DATOS REALES DESDE SUPABASE
============================================================================ */
async function loadAllAdminData() {
  try {
    const [
      summaryRes,
      treasuryRes,
      usersRes,
      walletsRes,
      wlRes,
      jobsRes,
      settlementsRes,
      txRes,
      withdrawalsRes,
      reportsRes,
      ratingsRes,
      settingsRes,
      auditRes,
    ] = await Promise.all([
      sb.rpc('admin_get_dashboard_summary'),
      sb.rpc('admin_get_treasury_config'),
      sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(250),
      sb.from('wallets').select('*'),
      sb.from('worker_locations').select('*'),
      sb
        .from('cachuelos')
        .select(
          '*, client:profiles!cachuelos_client_id_fkey(full_name, email, phone, client_rating), worker:profiles!cachuelos_worker_id_fkey(full_name, email, phone, worker_rating)'
        )
        .order('created_at', { ascending: false })
        .limit(250),
      sb
        .from('commission_settlements')
        .select('*, worker:profiles!commission_settlements_worker_id_fkey(full_name, email, phone)')
        .order('created_at', { ascending: false })
        .limit(150),
      sb
        .from('wallet_transactions')
        .select('*, user:profiles!wallet_transactions_user_id_fkey(full_name, email)')
        .order('created_at', { ascending: false })
        .limit(150),
      sb
        .from('withdrawal_requests')
        .select('*, user:profiles!withdrawal_requests_user_id_fkey(full_name, email, phone)')
        .order('created_at', { ascending: false })
        .limit(150),
      sb
        .from('reports_and_support')
        .select('*, user:profiles!reports_and_support_user_id_fkey(full_name, email, phone)')
        .order('created_at', { ascending: false })
        .limit(150),
      sb
        .from('ratings')
        .select(
          '*, from_user:profiles!ratings_from_user_id_fkey(full_name, email), to_user:profiles!ratings_to_user_id_fkey(full_name, email), cachuelo:cachuelos!ratings_cachuelo_id_fkey(job_code, title)'
        )
        .order('created_at', { ascending: false })
        .limit(150),
      sb.from('system_settings').select('*'),
      sb.from('admin_audit_logs').select('*').order('created_at', { ascending: false }).limit(150),
    ]);

    if (summaryRes.data) state.summary = summaryRes.data;
    if (treasuryRes.data) state.treasury = treasuryRes.data;
    state.users = usersRes.data || [];

    state.walletsByUser = {};
    for (const w of walletsRes.data || []) {
      state.walletsByUser[w.user_id] = w;
    }

    state.workerLocations = wlRes.data || [];
    state.cachuelos = jobsRes.data || [];
    state.settlements = settlementsRes.data || [];
    state.transactions = txRes.data || [];
    state.withdrawals = withdrawalsRes.data || [];
    state.reports = reportsRes.data || [];
    state.ratings = ratingsRes.data || [];

    state.settings = {};
    for (const s of settingsRes.data || []) {
      state.settings[s.key] = s.value;
    }

    state.auditLogs = auditRes.data || [];

    renderBadges();
    renderDashboard();
    renderNationalMapMarkers();
    renderUsersTable();
    renderCachuelosTable();
    renderFinancesAndTreasury();
    renderWithdrawalsTable();
    renderSupportAndRatings();
    renderSettingsForm();
    renderAuditLogs();
  } catch (err) {
    showToast('Error al actualizar datos: ' + (err.message || err), true);
  }
}

function subscribeRealtime() {
  if (state.realtimeChannel) {
    sb.removeChannel(state.realtimeChannel);
  }
  state.realtimeChannel = sb
    .channel('admin-web-global-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cachuelos' }, () =>
      loadAllAdminData()
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawal_requests' }, () =>
      loadAllAdminData()
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'commission_settlements' }, () =>
      loadAllAdminData()
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reports_and_support' }, () =>
      loadAllAdminData()
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () =>
      loadAllAdminData()
    )
    .subscribe();
}

function renderBadges() {
  document.getElementById('badge-users').textContent = state.users.length;
  document.getElementById('badge-cachuelos').textContent = state.cachuelos.length;
  const pendingSettle = state.settlements.filter((s) => s.status === 'PENDING').length;
  document.getElementById('badge-settlements').textContent = pendingSettle;
  const pendingWith = state.withdrawals.filter((w) =>
    ['PENDING', 'APPROVED'].includes(w.status)
  ).length;
  document.getElementById('badge-withdrawals').textContent = pendingWith;
  const openRep = state.reports.filter((r) => ['OPEN', 'IN_REVIEW'].includes(r.status)).length;
  document.getElementById('badge-reports').textContent = openRep;
}

/* ============================================================================
   3. DASHBOARD Y MAPA OPERATIVO NACIONAL (TODO ECUADOR)
============================================================================ */
function renderDashboard() {
  const s = state.summary || {};
  const commRate = state.settings['COMMISSION_PERCENT'] || '10.0';
  const minWith = state.settings['MIN_WITHDRAWAL_USD'] || '6.00';

  const kpis = [
    {
      label: 'Volumen Efectivo Completado',
      value: fmtUsd(s.total_cash_volume),
      sub: `${s.completed_cachuelos || 0} cachuelos pagados en efectivo`,
      cls: 'kpi-teal',
    },
    {
      label: `Comisión Generada (${commRate}%)`,
      value: fmtUsd(s.total_commissions_generated),
      sub: `Ganancia neta trabajadores: ${fmtUsd(s.total_worker_net_earnings)}`,
      cls: 'kpi-teal',
    },
    {
      label: 'Comisiones Liquidadas en Banco',
      value: fmtUsd(s.total_commissions_settled),
      sub: `Pendiente por cobrar: ${fmtUsd(s.total_pending_commission_debt)}`,
      cls: 'kpi-orange',
    },
    {
      label: 'Saldos Billetera / Retiros',
      value: fmtUsd(s.total_available_wallet_balances),
      sub: `Retiros pagados: ${fmtUsd(s.total_withdrawn_paid)} (Mín. $${minWith})`,
      cls: '',
    },
    {
      label: 'Cachuelos en Tiempo Real',
      value: `${(s.searching_cachuelos || 0) + (s.active_cachuelos || 0)}`,
      sub: `${s.searching_cachuelos || 0} buscando • ${s.active_cachuelos || 0} en ejecución`,
      cls: '',
    },
    {
      label: 'Trabajadores Online / Usuarios',
      value: `${s.online_workers || 0} / ${s.total_users || 0}`,
      sub: `${s.available_workers || 0} disponibles • ${s.suspended_users || 0} suspendidos`,
      cls: '',
    },
    {
      label: 'Solicitudes por Atender',
      value: `${(s.pending_withdrawals_count || 0) + (s.pending_settlements_count || 0)}`,
      sub: `${s.pending_withdrawals_count || 0} retiros • ${s.pending_settlements_count || 0} liquidaciones`,
      cls: 'kpi-orange',
    },
    {
      label: 'Calificación y Soporte',
      value: `★ ${Number(s.avg_platform_rating || 5).toFixed(2)}`,
      sub: `${s.total_ratings_count || 0} reseñas • ${s.open_reports_count || 0} tickets abiertos`,
      cls: '',
    },
  ];

  document.getElementById('kpi-grid').innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi-card ${k.cls}">
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value">${esc(k.value)}</div>
        <div class="kpi-sub">${esc(k.sub)}</div>
      </div>
    `
    )
    .join('');
}

function initNationalMap() {
  if (state.map) return;
  const mapEl = document.getElementById('ecuador-live-map');
  if (!mapEl || !window.L) return;

  // Vista nacional de todo Ecuador
  state.map = L.map('ecuador-live-map').setView([-1.8312, -78.8], 7);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors &bull; CACHUELO Ecuador',
    maxZoom: 19,
  }).addTo(state.map);

  state.mapMarkersLayer = L.layerGroup().addTo(state.map);

  document.querySelectorAll('[data-map-focus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [lat, lng, zoom] = btn.getAttribute('data-map-focus').split(',').map(Number);
      state.map.setView([lat, lng], zoom);
    });
  });
}

function renderNationalMapMarkers() {
  if (!state.map || !state.mapMarkersLayer) return;
  state.mapMarkersLayer.clearLayers();

  // 1. Marcadores de cachuelos en todo Ecuador
  for (const j of state.cachuelos) {
    if (typeof j.location_lat !== 'number' || typeof j.location_lng !== 'number') continue;
    const isCompleted = j.status === 'COMPLETED';
    const isCancelled = j.status === 'CANCELLED';
    const color = isCompleted ? '#22C55E' : isCancelled ? '#EF4444' : '#FF8A00';

    const circle = L.circleMarker([j.location_lat, j.location_lng], {
      radius: 8,
      fillColor: color,
      color: '#0B1F2A',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.92,
    });

    circle.bindPopup(`
      <div style="color:#0B1F2A;font-family:Inter,sans-serif;min-width:200px;">
        <strong>${esc(j.job_code)} &bull; ${esc(j.status)}</strong><br/>
        <span>${esc(j.title)}</span><br/>
        <strong>${fmtUsd(j.agreed_price)} Efectivo</strong> (Com: ${fmtUsd(j.commission_amount)})<br/>
        <small>${esc(j.location_address)} (${j.location_lat.toFixed(4)}, ${j.location_lng.toFixed(4)})</small><br/>
        <small>Radio: ${Number(j.search_radius_km || 5).toFixed(0)} km</small>
      </div>
    `);
    state.mapMarkersLayer.addLayer(circle);
  }

  // 2. Marcadores de trabajadores con telemetría GPS activa
  const usersById = {};
  for (const u of state.users) usersById[u.id] = u;

  for (const wl of state.workerLocations) {
    if (!wl.is_online) continue;
    const u = usersById[wl.worker_id];
    const marker = L.circleMarker([wl.latitude, wl.longitude], {
      radius: 7,
      fillColor: '#00B4A6',
      color: '#F4F6FA',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.95,
    });
    marker.bindPopup(`
      <div style="color:#0B1F2A;font-family:Inter,sans-serif;">
        <strong>Trabajador en Línea</strong><br/>
        <span>${esc(u ? u.full_name || u.email : wl.worker_id)}</span><br/>
        <small>GPS: ${wl.latitude.toFixed(5)}, ${wl.longitude.toFixed(5)}</small>
      </div>
    `);
    state.mapMarkersLayer.addLayer(marker);
  }
}

/* ============================================================================
   4. GESTIÓN DE USUARIOS Y TRABAJADORES
============================================================================ */
function renderUsersTable() {
  const search = (document.getElementById('filter-users-search').value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('filter-users-status').value;

  const filtered = state.users.filter((u) => {
    const w = state.walletsByUser[u.id] || {};
    if (statusFilter === 'ACTIVE' && !u.is_active) return false;
    if (statusFilter === 'SUSPENDED' && u.is_active) return false;
    if (statusFilter === 'ONLINE' && !u.is_online) return false;
    if (statusFilter === 'DEBT' && !(Number(w.pending_commission_debt || 0) > 0)) return false;

    if (search) {
      const hay = `${u.full_name || ''} ${u.email || ''} ${u.phone || ''} ${u.role || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById('tbody-users');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted">No se encontraron usuarios con los filtros actuales.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((u) => {
      const w = state.walletsByUser[u.id] || {};
      const debt = Number(w.pending_commission_debt || 0);
      const bal = Number(w.available_balance || 0);
      const gross = Number(w.total_gross_earned || 0);
      const net = Number(w.total_net_earned || 0);

      return `
        <tr>
          <td>
            <strong>${esc(u.full_name || 'Sin nombre')}</strong><br/>
            <small class="text-muted">ID: ${esc(u.id.slice(0, 8))} &bull; ${fmtDate(u.created_at)}</small>
          </td>
          <td>
            ${esc(u.email || '—')}<br/>
            <small class="text-muted">Tel: ${esc(u.phone || '—')}</small>
          </td>
          <td>
            <span class="badge ${u.role === 'owner' || u.role === 'admin' ? 'badge-orange' : 'badge-teal'}">${esc(u.role.toUpperCase())}</span><br/>
            <small class="text-muted">Modo: ${esc(u.current_mode)}</small>
          </td>
          <td>
            <span class="badge ${u.is_active ? 'badge-green' : 'badge-red'}">${u.is_active ? 'ACTIVO' : 'SUSPENDIDO'}</span><br/>
            <small class="text-muted">${u.is_online ? '● Online' : '○ Offline'}${u.is_available ? ' (Disponible)' : ''}</small>
          </td>
          <td>
            Trabajador: ★ ${Number(u.worker_rating || 5).toFixed(2)} (${u.completed_as_worker || 0})<br/>
            <small class="text-muted">Cliente: ★ ${Number(u.client_rating || 5).toFixed(2)} (${u.completed_as_client || 0}) &bull; Canc: ${u.cancelled_count || 0}</small>
          </td>
          <td>
            <div>Efectivo bruto: <strong>${fmtUsd(gross)}</strong> (Neto: ${fmtUsd(net)})</div>
            <div>Comisión pendiente: <strong style="color:${debt > 0 ? '#FF8A00' : '#98B2C2'}">${fmtUsd(debt)}</strong></div>
            <div>Saldo billetera: <strong style="color:#00B4A6">${fmtUsd(bal)}</strong></div>
          </td>
          <td>
            <div class="btn-group">
              <button class="btn ${u.is_active ? 'btn-outline-danger' : 'btn-success'} btn-xs" onclick="window.toggleUserActive('${u.id}', ${!u.is_active})">
                ${u.is_active ? 'Suspender' : 'Activar'}
              </button>
              <button class="btn btn-secondary btn-xs" onclick="window.openRoleModal('${u.id}')">Rol</button>
              <button class="btn btn-accent btn-xs" onclick="window.openDirectSettlementModal('${u.id}')">Liquidar Com.</button>
              <button class="btn btn-secondary btn-xs" onclick="window.openWalletAdjustModal('${u.id}')">Saldo</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

window.toggleUserActive = async function (userId, targetActive) {
  try {
    const { error } = await sb.rpc('admin_manage_user', {
      p_user_id: userId,
      p_is_active: targetActive,
      p_role: null,
    });
    if (error) throw error;
    showToast(targetActive ? 'Cuenta activada correctamente.' : 'Cuenta suspendida correctamente.');
    await loadAllAdminData();
  } catch (err) {
    showToast('Error al actualizar cuenta: ' + err.message, true);
  }
};

window.openRoleModal = function (userId) {
  const u = state.users.find((x) => x.id === userId);
  if (!u) return;
  openModal(
    'Cambiar Rol de Usuario — ' + (u.full_name || u.email),
    `
      <form id="form-role-change">
        <div class="form-group">
          <label>Rol del usuario en CACHUELO</label>
          <select id="modal-role-select">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>user (Cliente / Trabajador estándar)</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin (Administrador)</option>
            <option value="owner" ${u.role === 'owner' ? 'selected' : ''}>owner (Propietario)</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Guardar Rol en Servidor</button>
      </form>
    `
  );
  document.getElementById('form-role-change').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = document.getElementById('modal-role-select').value;
    try {
      const { error } = await sb.rpc('admin_manage_user', {
        p_user_id: u.id,
        p_is_active: u.is_active,
        p_role: role,
      });
      if (error) throw error;
      closeModal();
      showToast('Rol actualizado a ' + role.toUpperCase());
      await loadAllAdminData();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });
};

window.openDirectSettlementModal = function (userId) {
  const u = state.users.find((x) => x.id === userId);
  const w = state.walletsByUser[userId] || {};
  const debt = Number(w.pending_commission_debt || 0);
  if (!u) return;

  openModal(
    'Registrar Liquidación de Comisión — ' + (u.full_name || u.email),
    `
      <form id="form-direct-settlement">
        <p class="text-muted mb-20">
          Comisión pendiente actual del trabajador: <strong style="color:#FF8A00">${fmtUsd(debt)}</strong>.<br/>
          El pago se conciliará directamente con la Cuenta Bancaria Administrativa configurada en Tesorería.
        </p>
        <div class="form-group">
          <label>Monto recibido (USD) *</label>
          <input type="number" step="0.01" min="0.01" id="modal-settle-amount" value="${debt > 0 ? debt.toFixed(2) : '5.00'}" required />
        </div>
        <div class="form-group">
          <label>N° de comprobante / transferencia bancaria *</label>
          <input type="text" id="modal-settle-ref" placeholder="Ej. COMP-998123" required />
        </div>
        <div class="form-group">
          <label>Observación administrativa</label>
          <input type="text" id="modal-settle-notes" placeholder="Conciliado en cuenta administrativa" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Registrar y Conciliar Liquidación</button>
      </form>
    `
  );

  document.getElementById('form-direct-settlement').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amt = Number(document.getElementById('modal-settle-amount').value);
    const ref = document.getElementById('modal-settle-ref').value.trim();
    const notes = document.getElementById('modal-settle-notes').value.trim();
    try {
      const { error } = await sb.rpc('admin_record_direct_commission_settlement', {
        p_worker_id: userId,
        p_amount: amt,
        p_receipt_reference: ref,
        p_admin_notes: notes,
      });
      if (error) throw error;
      closeModal();
      showToast('Comisión liquidada y registrada en tesorería.');
      await loadAllAdminData();
    } catch (err) {
      showToast('Error al liquidar comisión: ' + err.message, true);
    }
  });
};

window.openWalletAdjustModal = function (userId) {
  const u = state.users.find((x) => x.id === userId);
  const w = state.walletsByUser[userId] || {};
  if (!u) return;

  openModal(
    'Ajuste Auditado de Billetera — ' + (u.full_name || u.email),
    `
      <form id="form-wallet-adjust">
        <p class="text-muted mb-20">
          Saldo disponible actual: <strong style="color:#00B4A6">${fmtUsd(w.available_balance)}</strong>.<br/>
          Usa valores positivos para acreditar saldo verificado/bono o negativos para reversos.
        </p>
        <div class="form-group">
          <label>Monto del ajuste (USD) *</label>
          <input type="number" step="0.01" id="modal-adj-amount" placeholder="Ej. 10.00 o -5.00" required />
        </div>
        <div class="form-group">
          <label>Motivo contable obligatorio (registrado en auditoría) *</label>
          <input type="text" id="modal-adj-reason" placeholder="Ej. Depósito verificado / Bono de incentivo" required />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Aplicar Ajuste Contable</button>
      </form>
    `
  );

  document.getElementById('form-wallet-adjust').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amt = Number(document.getElementById('modal-adj-amount').value);
    const reason = document.getElementById('modal-adj-reason').value.trim();
    try {
      const { error } = await sb.rpc('admin_adjust_wallet', {
        p_user_id: userId,
        p_amount: amt,
        p_reason: reason,
      });
      if (error) throw error;
      closeModal();
      showToast('Ajuste de billetera aplicado y auditado.');
      await loadAllAdminData();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });
};

/* ============================================================================
   5. CACHUELOS Y SEGUIMIENTO EN VIVO
============================================================================ */
function renderCachuelosTable() {
  const search = (document.getElementById('filter-jobs-search').value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('filter-jobs-status').value;

  const filtered = state.cachuelos.filter((j) => {
    if (statusFilter === 'SEARCHING' && !['PUBLISHED', 'SEARCHING'].includes(j.status)) return false;
    if (statusFilter === 'NEGOTIATING' && j.status !== 'NEGOTIATING') return false;
    if (
      statusFilter === 'ACTIVE' &&
      !['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(j.status)
    )
      return false;
    if (statusFilter === 'COMPLETED' && j.status !== 'COMPLETED') return false;
    if (statusFilter === 'CANCELLED' && j.status !== 'CANCELLED') return false;
    if (statusFilter === 'DISPUTED' && j.status !== 'DISPUTED') return false;

    if (search) {
      const hay = `${j.job_code} ${j.title} ${j.description} ${j.location_address} ${j.location_reference} ${j.client?.full_name || ''} ${j.worker?.full_name || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById('tbody-cachuelos');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted">No hay cachuelos que coincidan con el filtro seleccionado.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((j) => {
      const statusBadge =
        j.status === 'COMPLETED'
          ? 'badge-green'
          : j.status === 'CANCELLED' || j.status === 'DISPUTED'
          ? 'badge-red'
          : ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(j.status)
          ? 'badge-teal'
          : 'badge-orange';

      return `
        <tr>
          <td>
            <strong>${esc(j.job_code)}</strong><br/>
            <small class="text-muted">${fmtDate(j.created_at)}</small>
          </td>
          <td>
            <strong>${esc(j.title)}</strong><br/>
            <small class="text-muted">${esc(j.location_reference || j.description || 'Sin referencia adicional')}</small>
          </td>
          <td>
            ${esc(j.location_address)}<br/>
            <small class="text-muted">${Number(j.location_lat).toFixed(4)}, ${Number(j.location_lng).toFixed(4)} &bull; Radio: ${Number(j.search_radius_km || 5).toFixed(0)} km</small>
          </td>
          <td>
            Cliente: <strong>${esc(j.client?.full_name || '—')}</strong><br/>
            <small class="text-muted">Trabajador: ${esc(j.worker?.full_name || 'Sin asignar')}</small>
          </td>
          <td>
            Efectivo: <strong>${fmtUsd(j.agreed_price)}</strong><br/>
            <small class="text-muted">Com (${j.commission_rate}%): ${fmtUsd(j.commission_amount)} | Neto: ${fmtUsd(j.worker_net_amount)}</small>
          </td>
          <td>
            <span class="badge ${statusBadge}">${esc(j.status)}</span>
          </td>
          <td>
            <div class="btn-group">
              <button class="btn btn-secondary btn-xs" onclick="window.inspectCachuelo('${j.id}')">Seguimiento</button>
              ${
                ['PUBLISHED', 'SEARCHING', 'NEGOTIATING'].includes(j.status)
                  ? `<button class="btn btn-accent btn-xs" onclick="window.expandJobRadius('${j.id}')">+Radio Nacional</button>`
                  : ''
              }
              ${
                !['COMPLETED', 'CANCELLED'].includes(j.status)
                  ? `<button class="btn btn-outline-danger btn-xs" onclick="window.adminCancelJob('${j.id}')">Cancelar</button>`
                  : ''
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

window.expandJobRadius = async function (jobId) {
  try {
    const { data, error } = await sb.rpc('expand_cachuelo_search_radius', {
      p_cachuelo_id: jobId,
    });
    if (error) throw error;
    showToast(
      `Radio expandido a ${data.search_radius_km} km (${data.dispatched_workers} trabajadores adicionales notificados).`
    );
    await loadAllAdminData();
  } catch (err) {
    showToast('Error al expandir radio: ' + err.message, true);
  }
};

window.adminCancelJob = async function (jobId) {
  const reason = prompt('Motivo administrativo de cancelación:', 'Cancelado por administración');
  if (!reason) return;
  try {
    const { error } = await sb.rpc('cancel_cachuelo', {
      p_cachuelo_id: jobId,
      p_reason: reason,
    });
    if (error) throw error;
    showToast('Cachuelo cancelado correctamente.');
    await loadAllAdminData();
  } catch (err) {
    showToast('Error al cancelar: ' + err.message, true);
  }
};

window.inspectCachuelo = async function (jobId) {
  const j = state.cachuelos.find((x) => x.id === jobId);
  if (!j) return;

  const [eventsRes, offersRes, chatRes] = await Promise.all([
    sb.from('cachuelo_events').select('*').eq('cachuelo_id', jobId).order('created_at', { ascending: true }),
    sb
      .from('cachuelo_offers')
      .select('*, worker:profiles!cachuelo_offers_worker_id_fkey(full_name)')
      .eq('cachuelo_id', jobId)
      .order('updated_at', { ascending: false }),
    sb.from('chat_messages').select('*').eq('cachuelo_id', jobId).order('created_at', { ascending: true }),
  ]);

  const events = eventsRes.data || [];
  const offers = offersRes.data || [];
  const chats = chatRes.data || [];

  const wazeUrl = `https://waze.com/ul?ll=${j.location_lat},${j.location_lng}&navigate=yes`;
  const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${j.location_lat},${j.location_lng}&travelmode=driving`;

  openModal(
    `Seguimiento de Cachuelo ${j.job_code} — ${j.status}`,
    `
      <div style="display:grid;gap:12px;">
        <div style="background:var(--bg-main);padding:14px;border-radius:14px;border:1px solid var(--border);">
          <strong>${esc(j.title)}</strong> (${fmtUsd(j.agreed_price)} Efectivo)<br/>
          <small class="text-muted">Descripción: ${esc(j.description || '—')}</small><br/>
          <small class="text-muted">Referencia: ${esc(j.location_reference || '—')}</small><br/>
          <small class="text-muted">Coordenadas GPS: ${j.location_lat}, ${j.location_lng} &bull; ${esc(j.location_address)}</small><br/>
          <div class="btn-group" style="margin-top:8px;">
            <a class="btn btn-primary btn-xs" href="${wazeUrl}" target="_blank" rel="noopener">Abrir en Waze</a>
            <a class="btn btn-secondary btn-xs" href="${gmapsUrl}" target="_blank" rel="noopener">Abrir en Google Maps</a>
          </div>
        </div>

        <div>
          <strong>Línea de Tiempo de Eventos (${events.length})</strong>
          <div style="max-height:140px;overflow-y:auto;background:var(--bg-main);padding:10px;border-radius:12px;margin-top:6px;font-size:12px;">
            ${
              events.length
                ? events
                    .map(
                      (ev) =>
                        `<div><code>${fmtDate(ev.created_at)}</code> &bull; <strong>${esc(ev.event_type)}</strong> (${esc(ev.old_status || '—')} &rarr; ${esc(ev.new_status || '—')})</div>`
                    )
                    .join('')
                : '<span class="text-muted">Sin eventos registrados.</span>'
            }
          </div>
        </div>

        <div>
          <strong>Ofertas y Contraofertas (${offers.length})</strong>
          <div style="max-height:130px;overflow-y:auto;background:var(--bg-main);padding:10px;border-radius:12px;margin-top:6px;font-size:12px;">
            ${
              offers.length
                ? offers
                    .map(
                      (of) =>
                        `<div><strong>${esc(of.worker?.full_name || of.worker_id.slice(0, 6))}</strong>: Propuesta ${fmtUsd(of.proposed_price)} &bull; A ${of.worker_distance_km} km &bull; <span class="badge badge-teal">${esc(of.status)}</span></div>`
                    )
                    .join('')
                : '<span class="text-muted">Sin ofertas registradas.</span>'
            }
          </div>
        </div>

        <div>
          <strong>Mensajes de Chat (${chats.length})</strong>
          <div style="max-height:130px;overflow-y:auto;background:var(--bg-main);padding:10px;border-radius:12px;margin-top:6px;font-size:12px;">
            ${
              chats.length
                ? chats
                    .map(
                      (m) =>
                        `<div><code>${fmtDate(m.created_at)}</code>: ${esc(m.content)}</div>`
                    )
                    .join('')
                : '<span class="text-muted">Sin mensajes en este cachuelo.</span>'
            }
          </div>
        </div>
      </div>
    `
  );
};

/* ============================================================================
   6. FINANZAS, TESORERÍA BANCARIA PRIVADA Y LIQUIDACIONES DE COMISIONES
============================================================================ */
function renderFinancesAndTreasury() {
  const t = state.treasury;
  const box = document.getElementById('treasury-summary-box');
  if (t) {
    box.innerHTML = `
      <div class="treasury-item">
        <div class="label">Banco Destino Oficial</div>
        <div class="val teal">${esc(t.bank_name)}</div>
      </div>
      <div class="treasury-item">
        <div class="label">Tipo de Cuenta</div>
        <div class="val">${esc(t.account_type)}</div>
      </div>
      <div class="treasury-item">
        <div class="label">Número de Cuenta (Privado)</div>
        <div class="val teal">${esc(t.account_number)}</div>
      </div>
      <div class="treasury-item">
        <div class="label">Cédula del Titular</div>
        <div class="val">${esc(t.holder_identification)}</div>
      </div>
      <div class="treasury-item">
        <div class="label">Contacto Telefónico</div>
        <div class="val">${esc(t.contact_phone)}</div>
      </div>
      <div class="treasury-item">
        <div class="label">Comisiones Conciliadas</div>
        <div class="val green">${fmtUsd(t.total_commissions_settled)}</div>
      </div>
      <div class="treasury-item">
        <div class="label">Comisiones Pendientes de Cobro</div>
        <div class="val orange">${fmtUsd(t.total_commissions_pending)}</div>
      </div>
    `;
  } else {
    box.innerHTML = `<div class="text-muted">Cargando configuración protegida de tesorería...</div>`;
  }

  // Tabla de liquidaciones
  const tbodyS = document.getElementById('tbody-settlements');
  if (!state.settlements.length) {
    tbodyS.innerHTML = `<tr><td colspan="7" class="text-muted">No hay liquidaciones de comisiones registradas aún.</td></tr>`;
  } else {
    tbodyS.innerHTML = state.settlements
      .map((s) => {
        const bCls =
          s.status === 'VERIFIED'
            ? 'badge-green'
            : s.status === 'REJECTED'
            ? 'badge-red'
            : 'badge-orange';
        return `
          <tr>
            <td>
              <strong>${esc(s.settlement_code)}</strong><br/>
              <small class="text-muted">${fmtDate(s.created_at)}</small>
            </td>
            <td>
              <strong>${esc(s.worker?.full_name || 'Trabajador')}</strong><br/>
              <small class="text-muted">${esc(s.worker?.email || '')}</small>
            </td>
            <td><strong style="color:#00B4A6">${fmtUsd(s.amount)}</strong></td>
            <td>
              ${esc(s.payment_channel)}<br/>
              <small class="text-muted">Ref: ${esc(s.receipt_reference)}</small>
              ${
                s.proof_image_url
                  ? `<br/><a href="${esc(s.proof_image_url)}" target="_blank" rel="noopener noreferrer" style="color:#00B4A6;font-size:12px;font-weight:700;">Ver foto comprobante</a>`
                  : ''
              }
            </td>
            <td>
              Deuda reducida: ${fmtUsd(s.debt_reduced)}
            </td>
            <td>
              <span class="badge ${bCls}">${esc(s.status)}</span><br/>
              <small class="text-muted">${esc(s.treasury_reconciliation_note || s.admin_notes || '')}</small>
            </td>
            <td>
              ${
                s.status === 'PENDING'
                  ? `
                    <div class="btn-group">
                      <button class="btn btn-success btn-xs" onclick="window.processSettlement('${s.id}', 'VERIFIED')">Verificar</button>
                      <button class="btn btn-outline-danger btn-xs" onclick="window.processSettlement('${s.id}', 'REJECTED')">Rechazar</button>
                    </div>
                  `
                  : '<span class="text-muted">Procesada</span>'
              }
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // Tabla de movimientos contables
  const tbodyT = document.getElementById('tbody-transactions');
  if (!state.transactions.length) {
    tbodyT.innerHTML = `<tr><td colspan="8" class="text-muted">No hay movimientos en el libro mayor.</td></tr>`;
  } else {
    tbodyT.innerHTML = state.transactions
      .map(
        (tx) => `
          <tr>
            <td><small>${fmtDate(tx.created_at)}</small></td>
            <td>${esc(tx.user?.full_name || tx.user?.email || tx.user_id.slice(0, 8))}</td>
            <td><span class="badge badge-teal">${esc(tx.tx_type)}</span></td>
            <td>${fmtUsd(tx.gross_amount)}</td>
            <td>${fmtUsd(tx.commission_amount)}</td>
            <td style="color:${Number(tx.net_amount) >= 0 ? '#22C55E' : '#FF8A00'};font-weight:800;">
              ${Number(tx.net_amount) >= 0 ? '+' : ''}${fmtUsd(tx.net_amount)}
            </td>
            <td>${fmtUsd(tx.balance_after)}</td>
            <td><small>${esc(tx.description)}</small></td>
          </tr>
        `
      )
      .join('');
  }

  // Tabla de trabajadores morosos / próximos al límite
  renderDebtorsTable();
}

async function renderDebtorsTable() {
  const tbodyD = document.getElementById('tbody-debtors');
  if (!tbodyD) return;
  try {
    const { data, error } = await sb.rpc('admin_list_workers_commission_status');
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      tbodyD.innerHTML = `<tr><td colspan="5" class="text-muted">No hay trabajadores con comisiones pendientes ni morosos.</td></tr>`;
      return;
    }
    tbodyD.innerHTML = rows
      .map((w) => {
        const badgeCls =
          w.debt_status_label === 'BLOQUEADO' || w.debt_status_label === 'EN_LIMITE'
            ? 'badge-red'
            : w.debt_status_label === 'PROXIMO_LIMITE'
            ? 'badge-orange'
            : 'badge-green';
        return `
          <tr>
            <td>
              <strong>${esc(w.full_name || 'Trabajador')}</strong><br/>
              <small class="text-muted">${esc(w.phone || '')}</small>
            </td>
            <td><strong style="color:#FF8A00">${fmtUsd(w.pending_commission_debt)}</strong> <small class="text-muted">/ ${fmtUsd(w.debt_limit)}</small></td>
            <td>${fmtUsd(w.total_commission_settled)}</td>
            <td>
              <span class="badge ${badgeCls}">${esc(w.debt_status_label)}</span>
              ${w.commission_debt_due_at ? `<br/><small class="text-muted">Vence: ${fmtDate(w.commission_debt_due_at)}</small>` : ''}
              ${w.worker_blocked_reason ? `<br/><small class="text-muted">${esc(w.worker_blocked_reason)}</small>` : ''}
            </td>
            <td>
              <div class="btn-group">
                ${
                  w.worker_blocked_for_debt
                    ? `<button class="btn btn-success btn-xs" onclick="window.toggleWorkerDebtBlock('${w.id}', false)">Desbloquear</button>`
                    : `<button class="btn btn-outline-danger btn-xs" onclick="window.toggleWorkerDebtBlock('${w.id}', true)">Bloquear</button>`
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    tbodyD.innerHTML = `<tr><td colspan="5" class="text-muted">Error cargando morosidad: ${esc(err.message)}</td></tr>`;
  }
}

window.toggleWorkerDebtBlock = async function (workerId, blocked) {
  const reason = blocked
    ? prompt('Motivo del bloqueo de modo cachuelador (deuda vencida):', 'Deuda de comisiones vencida')
    : 'Desbloqueado por administración';
  if (blocked && reason === null) return;
  try {
    const { error } = await sb.rpc('admin_set_worker_debt_block', {
      p_worker_id: workerId,
      p_blocked: blocked,
      p_reason: reason || '',
    });
    if (error) throw error;
    showToast(blocked ? 'Trabajador bloqueado para aceptar cachuelos.' : 'Trabajador desbloqueado.');
    await loadAllAdminData();
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
};

document.getElementById('btn-edit-treasury').addEventListener('click', () => {
  const t = state.treasury || {};
  openModal(
    'Configurar Cuenta Bancaria Administrativa Privada (Tesorería)',
    `
      <form id="form-treasury-config">
        <div class="form-group">
          <label>Institución Financiera / Banco *</label>
          <input type="text" id="tr-bank" value="${esc(t.bank_name || '')}" required />
        </div>
        <div class="form-group">
          <label>Tipo de Cuenta *</label>
          <input type="text" id="tr-type" value="${esc(t.account_type || '')}" required />
        </div>
        <div class="form-group">
          <label>Número de Cuenta *</label>
          <input type="text" id="tr-number" value="${esc(t.account_number || '')}" required />
        </div>
        <div class="form-group">
          <label>Cédula del Titular *</label>
          <input type="text" id="tr-id" value="${esc(t.holder_identification || '')}" required />
        </div>
        <div class="form-group">
          <label>Contacto Telefónico *</label>
          <input type="text" id="tr-phone" value="${esc(t.contact_phone || '')}" required />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Guardar en Bóveda Administrativa</button>
      </form>
    `
  );

  document.getElementById('form-treasury-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { error } = await sb.rpc('admin_update_treasury_config', {
        p_bank_name: document.getElementById('tr-bank').value.trim(),
        p_account_type: document.getElementById('tr-type').value.trim(),
        p_account_number: document.getElementById('tr-number').value.trim(),
        p_holder_identification: document.getElementById('tr-id').value.trim(),
        p_contact_phone: document.getElementById('tr-phone').value.trim(),
      });
      if (error) throw error;
      closeModal();
      showToast('Cuenta bancaria administrativa actualizada de forma segura.');
      await loadAllAdminData();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });
});

window.processSettlement = async function (settlementId, targetStatus) {
  const notes = prompt(
    targetStatus === 'VERIFIED'
      ? 'Observación de conciliación bancaria (opcional):'
      : 'Motivo del rechazo del comprobante:',
    targetStatus === 'VERIFIED' ? 'Verificado en cuenta Banco Bolivariano' : 'Comprobante no válido'
  );
  if (notes === null) return;
  try {
    const { error } = await sb.rpc('admin_process_commission_settlement', {
      p_settlement_id: settlementId,
      p_status: targetStatus,
      p_admin_notes: notes,
    });
    if (error) throw error;
    showToast(
      targetStatus === 'VERIFIED'
        ? 'Liquidación verificada y comisión descontada.'
        : 'Liquidación rechazada.'
    );
    await loadAllAdminData();
  } catch (err) {
    showToast('Error al procesar liquidación: ' + err.message, true);
  }
};

/* ============================================================================
   7. SOLICITUDES DE RETIRO BANCARIO
============================================================================ */
function renderWithdrawalsTable() {
  const statusFilter = document.getElementById('filter-withdrawals-status').value;
  const filtered = state.withdrawals.filter((w) => {
    if (statusFilter !== 'ALL' && w.status !== statusFilter) return false;
    return true;
  });

  const tbody = document.getElementById('tbody-withdrawals');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted">No hay solicitudes de retiro en este estado.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((w) => {
      const bCls =
        w.status === 'PAID'
          ? 'badge-green'
          : w.status === 'REJECTED'
          ? 'badge-red'
          : w.status === 'APPROVED'
          ? 'badge-teal'
          : 'badge-orange';
      return `
        <tr>
          <td><small>${fmtDate(w.created_at)}</small></td>
          <td>
            <strong>${esc(w.user?.full_name || 'Trabajador')}</strong><br/>
            <small class="text-muted">${esc(w.user?.email || '')}</small>
          </td>
          <td><strong style="color:#FF8A00;font-size:15px;">${fmtUsd(w.amount)}</strong></td>
          <td>
            <strong>${esc(w.bank_name)}</strong> (${esc(w.account_type)})<br/>
            <small class="text-muted">Cuenta: ${esc(w.account_number)}</small>
          </td>
          <td>
            ${esc(w.account_holder_name)}<br/>
            <small class="text-muted">ID: ${esc(w.holder_identification)}</small>
          </td>
          <td>
            <span class="badge ${bCls}">${esc(w.status)}</span><br/>
            <small class="text-muted">${esc(w.transfer_reference ? 'Ref: ' + w.transfer_reference : w.admin_notes || '')}</small>
          </td>
          <td>
            ${
              w.status === 'PENDING' || w.status === 'APPROVED'
                ? `
                  <div class="btn-group">
                    ${
                      w.status === 'PENDING'
                        ? `<button class="btn btn-secondary btn-xs" onclick="window.processWithdrawal('${w.id}', 'APPROVED')">Aprobar</button>`
                        : ''
                    }
                    <button class="btn btn-success btn-xs" onclick="window.processWithdrawal('${w.id}', 'PAID')">Marcar Pagado</button>
                    <button class="btn btn-outline-danger btn-xs" onclick="window.processWithdrawal('${w.id}', 'REJECTED')">Rechazar</button>
                  </div>
                `
                : '<span class="text-muted">Finalizado</span>'
            }
          </td>
        </tr>
      `;
    })
    .join('');
}

window.processWithdrawal = function (withdrawalId, targetStatus) {
  const w = state.withdrawals.find((x) => x.id === withdrawalId);
  if (!w) return;

  openModal(
    `${targetStatus === 'APPROVED' ? 'Aprobar' : targetStatus === 'PAID' ? 'Registrar Pago de' : 'Rechazar'} Retiro (${fmtUsd(w.amount)})`,
    `
      <form id="form-proc-withdrawal">
        <p class="text-muted mb-20">
          Destino: <strong>${esc(w.bank_name)} (${esc(w.account_type)}) &bull; Cuenta: ${esc(w.account_number)}</strong><br/>
          Titular: ${esc(w.account_holder_name)} (${esc(w.holder_identification)})
        </p>
        ${
          targetStatus === 'PAID'
            ? `
              <div class="form-group">
                <label>N° de comprobante / referencia de transferencia bancaria *</label>
                <input type="text" id="pw-ref" required placeholder="Ej. TRF-0029182" />
              </div>
            `
            : ''
        }
        <div class="form-group">
          <label>Observación administrativa</label>
          <input type="text" id="pw-notes" placeholder="${targetStatus === 'REJECTED' ? 'Motivo del rechazo (el saldo se reembolsará)' : 'Nota opcional'}" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Confirmar ${esc(targetStatus)}</button>
      </form>
    `
  );

  document.getElementById('form-proc-withdrawal').addEventListener('submit', async (e) => {
    e.preventDefault();
    const refEl = document.getElementById('pw-ref');
    const ref = refEl ? refEl.value.trim() : '';
    const notes = document.getElementById('pw-notes').value.trim();

    try {
      const { error } = await sb.rpc('admin_process_withdrawal', {
        p_withdrawal_id: withdrawalId,
        p_new_status: targetStatus,
        p_transfer_reference: ref,
        p_admin_notes: notes,
      });
      if (error) throw error;
      closeModal();
      showToast('Solicitud de retiro actualizada a ' + targetStatus);
      await loadAllAdminData();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });
};

/* ============================================================================
   8. SOPORTE, INCIDENCIAS Y CALIFICACIONES
============================================================================ */
function renderSupportAndRatings() {
  const tbodyR = document.getElementById('tbody-reports');
  if (!state.reports.length) {
    tbodyR.innerHTML = `<tr><td colspan="6" class="text-muted">No hay tickets de soporte ni reclamos registrados.</td></tr>`;
  } else {
    tbodyR.innerHTML = state.reports
      .map((r) => {
        const bCls =
          r.status === 'RESOLVED'
            ? 'badge-green'
            : r.status === 'DISMISSED'
            ? 'badge-teal'
            : 'badge-red';
        return `
          <tr>
            <td>
              <strong>${esc(r.ticket_code)}</strong><br/>
              <small class="text-muted">${fmtDate(r.created_at)}</small>
            </td>
            <td>
              ${esc(r.user?.full_name || 'Usuario')}<br/>
              <small class="text-muted">${esc(r.user?.email || '')}</small>
            </td>
            <td><span class="badge badge-orange">${esc(r.category)}</span></td>
            <td>
              <strong>${esc(r.subject)}</strong><br/>
              <small class="text-muted">${esc(r.description)}</small>
            </td>
            <td>
              <span class="badge ${bCls}">${esc(r.status)}</span><br/>
              <small class="text-muted">${esc(r.admin_resolution || '')}</small>
            </td>
            <td>
              <button class="btn btn-secondary btn-xs" onclick="window.openResolveReportModal('${r.id}')">Gestionar</button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  const tbodyRat = document.getElementById('tbody-ratings');
  if (!state.ratings.length) {
    tbodyRat.innerHTML = `<tr><td colspan="7" class="text-muted">Aún no hay calificaciones registradas.</td></tr>`;
  } else {
    tbodyRat.innerHTML = state.ratings
      .map(
        (rt) => `
          <tr>
            <td><small>${fmtDate(rt.created_at)}</small></td>
            <td>${esc(rt.cachuelo?.job_code || rt.cachuelo_id.slice(0, 8))}</td>
            <td>${esc(rt.from_user?.full_name || rt.from_user?.email || '—')}</td>
            <td>${esc(rt.to_user?.full_name || rt.to_user?.email || '—')}</td>
            <td><span class="badge badge-teal">${esc(rt.target_role)}</span></td>
            <td style="color:#FBBF24;font-weight:900;">${'★'.repeat(rt.stars)}${'☆'.repeat(5 - rt.stars)} (${rt.stars})</td>
            <td><small>${esc(rt.comment || 'Sin comentario')}</small></td>
          </tr>
        `
      )
      .join('');
  }
}

window.openResolveReportModal = function (reportId) {
  const r = state.reports.find((x) => x.id === reportId);
  if (!r) return;

  openModal(
    `Resolver Ticket ${r.ticket_code} — ${r.subject}`,
    `
      <form id="form-resolve-report">
        <p class="text-muted mb-20">${esc(r.description)}</p>
        <div class="form-group">
          <label>Nuevo Estado</label>
          <select id="rep-status">
            <option value="IN_REVIEW" ${r.status === 'IN_REVIEW' ? 'selected' : ''}>IN_REVIEW (En revisión)</option>
            <option value="RESOLVED" ${r.status === 'RESOLVED' ? 'selected' : ''}>RESOLVED (Resuelto)</option>
            <option value="DISMISSED" ${r.status === 'DISMISSED' ? 'selected' : ''}>DISMISSED (Desestimado)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Resolución y respuesta al usuario *</label>
          <textarea id="rep-resolution" rows="3" required>${esc(r.admin_resolution || 'Revisado y atendido por soporte administrativo CACHUELO.')}</textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Guardar Resolución y Notificar</button>
      </form>
    `
  );

  document.getElementById('form-resolve-report').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { error } = await sb.rpc('admin_resolve_report', {
        p_report_id: reportId,
        p_status: document.getElementById('rep-status').value,
        p_resolution: document.getElementById('rep-resolution').value.trim(),
      });
      if (error) throw error;
      closeModal();
      showToast('Ticket actualizado y usuario notificado.');
      await loadAllAdminData();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });
};

/* ============================================================================
   9. CONFIGURACIÓN GLOBAL Y HISTORIAL DE AUDITORÍA
============================================================================ */
function renderSettingsForm() {
  const s = state.settings;
  document.getElementById('set-commission').value = s['COMMISSION_PERCENT'] || '10.0';
  document.getElementById('set-debt-limit').value = s['COMMISSION_DEBT_LIMIT_USD'] || '6.00';
  document.getElementById('set-grace-hours').value = s['COMMISSION_PAYMENT_GRACE_HOURS'] || '48';
  document.getElementById('set-init-radius').value = s['INITIAL_SEARCH_RADIUS_KM'] || '2.0';
  document.getElementById('set-exp-radius').value = s['EXPANDED_SEARCH_RADIUS_KM'] || '5.0';
  document.getElementById('set-reg-radius').value = s['REGIONAL_SEARCH_RADIUS_KM'] || '10.0';
  document.getElementById('set-max-radius').value = s['MAX_SEARCH_RADIUS_KM'] || '20.0';
  document.getElementById('set-min-workers').value = s['MIN_WORKERS_FOR_RADIUS_STOP'] || '3';
  document.getElementById('set-offer-expiry').value = s['OFFER_EXPIRY_SECONDS'] || '120';
  document.getElementById('set-otp-expiry').value = s['OTP_EXPIRY_MINUTES'] || '120';
  document.getElementById('set-max-photos').value = s['MAX_PHOTOS_PER_JOB'] || '3';
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pairs = [
    ['COMMISSION_PERCENT', document.getElementById('set-commission').value],
    ['COMMISSION_DEBT_LIMIT_USD', document.getElementById('set-debt-limit').value],
    ['COMMISSION_PAYMENT_GRACE_HOURS', document.getElementById('set-grace-hours').value],
    ['INITIAL_SEARCH_RADIUS_KM', document.getElementById('set-init-radius').value],
    ['EXPANDED_SEARCH_RADIUS_KM', document.getElementById('set-exp-radius').value],
    ['REGIONAL_SEARCH_RADIUS_KM', document.getElementById('set-reg-radius').value],
    ['MAX_SEARCH_RADIUS_KM', document.getElementById('set-max-radius').value],
    ['MIN_WORKERS_FOR_RADIUS_STOP', document.getElementById('set-min-workers').value],
    ['OFFER_EXPIRY_SECONDS', document.getElementById('set-offer-expiry').value],
    ['OTP_EXPIRY_MINUTES', document.getElementById('set-otp-expiry').value],
    ['MAX_PHOTOS_PER_JOB', document.getElementById('set-max-photos').value],
  ];

  try {
    for (const [k, v] of pairs) {
      const { error } = await sb.rpc('admin_update_setting', {
        p_key: k,
        p_value: String(v).trim(),
      });
      if (error) throw error;
    }
    showToast('Parámetros globales y cobertura nacional actualizados en servidor.');
    await loadAllAdminData();
  } catch (err) {
    showToast('Error al guardar configuración: ' + err.message, true);
  }
});

function renderAuditLogs() {
  const tbody = document.getElementById('tbody-audit');
  if (!state.auditLogs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">No hay acciones administrativas registradas todavía.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.auditLogs
    .map(
      (log) => `
        <tr>
          <td><small>${fmtDate(log.created_at)}</small></td>
          <td><strong>${esc(log.admin_email || log.admin_id || 'Sistema')}</strong></td>
          <td><span class="badge badge-teal">${esc(log.action_type)}</span></td>
          <td>${esc(log.target_entity)}</td>
          <td><small>${esc(log.target_id)}</small></td>
          <td><code style="font-size:11.5px;color:var(--text-secondary);">${esc(JSON.stringify(log.details))}</code></td>
        </tr>
      `
    )
    .join('');
}

/* ============================================================================
   10. NAVEGACIÓN DE PESTAÑAS Y EVENTOS UI
============================================================================ */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    const tab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    const target = document.getElementById('tab-' + tab);
    if (target) target.classList.remove('hidden');

    if (tab === 'dashboard' && state.map) {
      setTimeout(() => state.map.invalidateSize(), 120);
    }
  });
});

document.getElementById('btn-refresh-all').addEventListener('click', () => {
  loadAllAdminData();
  showToast('Datos sincronizados con Supabase Cloud.');
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});

document.getElementById('filter-users-search').addEventListener('input', renderUsersTable);
document.getElementById('filter-users-status').addEventListener('change', renderUsersTable);
document.getElementById('filter-jobs-search').addEventListener('input', renderCachuelosTable);
document.getElementById('filter-jobs-status').addEventListener('change', renderCachuelosTable);
document.getElementById('filter-withdrawals-status').addEventListener('change', renderWithdrawalsTable);

checkInitialSession();
