/**
 * Google Drive Sync Module
 * Sincroniza o layout de pads com o Google Drive AppData
 * para funcionar em qualquer dispositivo.
 */

class GoogleDriveSync {
  constructor() {
    this.token = null;
    this.tokenClient = null;
    this.ready = false;
    this.folderId = null;
    this.folderName = null;
    this.lastSync = null;
    this.syncing = false;
    this.clientId = null;
    this._tokenResolve = null;
    this._tokenReject = null;

    this.loadSettings();
  }

  // ─── Persistência ───────────────────────────────────────────
  loadSettings() {
    try {
      const saved = localStorage.getItem('gdrive-sync-settings');
      if (saved) {
        const s = JSON.parse(saved);
        this.folderId   = s.folderId   || null;
        this.folderName = s.folderName || null;
        this.clientId   = s.clientId   || null;
        this.lastSync   = s.lastSync   || null;
      }
    } catch (_) {}
  }

  saveSettings() {
    localStorage.setItem('gdrive-sync-settings', JSON.stringify({
      folderId:   this.folderId,
      folderName: this.folderName,
      clientId:   this.clientId,
      lastSync:   this.lastSync,
    }));
  }

  // ─── Carrega scripts do Google ───────────────────────────────
  loadScript(src) {
    return new Promise((resolve, reject) => {
      if (src.includes('gsi/client') && window.google?.accounts) { resolve(); return; }
      if (src.includes('api.js')     && window.gapi)              { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }

  // ─── Inicialização (carrega APIs + cria tokenClient) ─────────
  async init(clientId) {
    if (this.ready) return;
    if (!clientId) throw new Error('Client ID é obrigatório');

    this.clientId = clientId;
    this.saveSettings();

    await this.loadScript('https://accounts.google.com/gsi/client');
    await this.loadScript('https://apis.google.com/js/api.js');
    await new Promise(res => window.gapi.load('picker', res));

    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      // drive.readonly  → lê os áudios do Drive do usuário
      // drive.appdata   → salva/lê o layout no AppData (oculto, só o app acessa)
      scope: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.appdata',
      ].join(' '),
      callback: (resp) => {
        if (resp?.access_token) {
          this.token = resp.access_token;
          this._tokenResolve?.(resp.access_token);
        } else {
          this._tokenReject?.(new Error('Token negado pelo Google'));
        }
        this._tokenResolve = null;
        this._tokenReject  = null;
      },
      error_callback: (err) => {
        this._tokenReject?.(new Error('Login cancelado ou bloqueado'));
        this._tokenResolve = null;
        this._tokenReject  = null;
      },
    });

    this.ready = true;
  }

  // ─── Login (abre popup do Google) ────────────────────────────
  requestLogin() {
    if (!this.tokenClient) throw new Error('Drive não inicializado — chame init() primeiro');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._tokenResolve = null;
        this._tokenReject  = null;
        reject(new Error('Tempo esgotado. Feche o popup e tente novamente.'));
      }, 120_000);

      this._tokenResolve = (t)   => { clearTimeout(timeout); resolve(t); };
      this._tokenReject  = (err) => { clearTimeout(timeout); reject(err); };

      // prompt vazio = não força re-consentimento se já autenticou antes
      this.tokenClient.requestAccessToken({ prompt: this.token ? '' : 'select_account' });
    });
  }

  // ─── AppData: encontra o arquivo de layout ───────────────────
  async findLayoutFileId() {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files` +
      `?spaces=appDataFolder&q=name%3D'launchpad-layout.json'&fields=files(id%2CmodifiedTime)`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!resp.ok) throw new Error('Erro ao buscar layout: ' + resp.status);
    const data = await resp.json();
    return data.files?.[0]?.id || null;
  }

  // ─── AppData: salva layout na nuvem ─────────────────────────
  async saveLayout(pads, folderId, folderName) {
    if (!this.token) throw new Error('Não autenticado');

    const layoutData = {
      version:      1,
      lastModified: new Date().toISOString(),
      folderId,
      folderName,
      pads, // { "p0_i0": { name, fileName }, ... }
    };

    const existingId = await this.findLayoutFileId();
    const jsonBlob   = new Blob([JSON.stringify(layoutData, null, 2)], { type: 'application/json' });
    const form       = new FormData();

    if (existingId) {
      form.append('metadata', new Blob([JSON.stringify({ name: 'launchpad-layout.json' })], { type: 'application/json' }));
      form.append('file', jsonBlob);
      const resp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${this.token}` }, body: form }
      );
      if (!resp.ok) throw new Error('Erro ao atualizar layout: ' + resp.status);
    } else {
      form.append('metadata', new Blob([JSON.stringify({ name: 'launchpad-layout.json', parents: ['appDataFolder'] })], { type: 'application/json' }));
      form.append('file', jsonBlob);
      const resp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
        { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: form }
      );
      if (!resp.ok) throw new Error('Erro ao criar layout: ' + resp.status);
    }

    this.folderId   = folderId;
    this.folderName = folderName;
    this.lastSync   = new Date().toISOString();
    this.saveSettings();
  }

  // ─── AppData: carrega layout da nuvem ───────────────────────
  async loadLayout() {
    if (!this.token) throw new Error('Não autenticado');
    const fileId = await this.findLayoutFileId();
    if (!fileId) return null;
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!resp.ok) throw new Error('Erro ao baixar layout: ' + resp.status);
    return await resp.json();
  }

  // ─── Drive: busca pastas por nome (não lê o Drive inteiro) ────
  async listFolders(searchName = '') {
    if (!this.token) throw new Error('Não autenticado');
    const nameFilter = searchName
      ? ` and name contains '${searchName.replace(/'/g, "\\'")}'`
      : '';
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and trashed=false${nameFilter}`
    );
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&pageSize=20&fields=files(id,name)&orderBy=name`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!resp.ok) throw new Error('Erro ao buscar pastas: ' + resp.statusText);
    const data = await resp.json();
    return data.files || [];
  }

  // ─── Drive: lista áudios em uma pasta ───────────────────────
  async listAudioFilesInFolder(folderId) {
    if (!this.token) throw new Error('Não autenticado');
    const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'audio/' and trashed=false`);
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=name`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!resp.ok) throw new Error('Erro ao listar áudios: ' + resp.statusText);
    const data = await resp.json();
    return data.files || [];
  }

  // ─── Drive: encontra arquivo pelo nome em uma pasta ─────────
  async findFileByName(folderId, fileName) {
    if (!this.token) throw new Error('Não autenticado');
    const escaped = fileName.replace(/'/g, "\\'");
    const q = encodeURIComponent(`'${folderId}' in parents and name = '${escaped}' and trashed=false`);
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.files?.[0] || null;
  }

  // ─── Drive: baixa arquivo (retorna Blob) ─────────────────────
  async downloadFile(fileId, fileName) {
    if (!this.token) throw new Error('Não autenticado');
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!resp.ok) throw new Error(`Erro ao baixar ${fileName}: ${resp.statusText}`);
    return await resp.blob();
  }

  // ─── Sincronizar pasta (lista arquivos) ─────────────────────
  async syncFolder(folderId, folderName, onProgress) {
    if (this.syncing) throw new Error('Sincronização já em andamento');
    this.syncing = true;
    try {
      if (onProgress) onProgress({ status: 'Buscando arquivos...', percent: 5 });
      const files = await this.listAudioFilesInFolder(folderId);
      if (!files.length) throw new Error('Nenhum arquivo de áudio nesta pasta');
      if (onProgress) onProgress({ status: `${files.length} arquivos encontrados`, percent: 15 });
      this.syncing = false;
      return files;
    } catch (e) {
      this.syncing = false;
      throw e;
    }
  }

  // ─── Importar arquivos em lote (baixa cada um) ──────────────
  async importFiles(files, onProgress) {
    if (!this.token) throw new Error('Não autenticado');
    const results = [];
    const total   = files.length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        if (onProgress) onProgress({
          status:  `Baixando: ${file.name}`,
          percent: Math.round(15 + (i / total) * 80),
          current: i + 1,
          total,
        });
        const blob = await this.downloadFile(file.id, file.name);
        results.push({
          success:  true,
          name:     file.name.replace(/\.[^/.]+$/, '').slice(0, 26),
          fileName: file.name,   // nome original com extensão (necessário para o layout)
          blob,
          driveFileId: file.id,
        });
      } catch (e) {
        results.push({ success: false, name: file.name, error: e.message });
      }
    }

    if (onProgress) onProgress({ status: 'Concluído', percent: 100 });
    return results;
  }

  // ─── Status ─────────────────────────────────────────────────
  isAuthenticated() { return this.token !== null; }
  isConfigured()    { return this.folderId !== null; }

  getSettings() {
    return {
      isAuthenticated: this.isAuthenticated(),
      isConfigured:    this.isConfigured(),
      folderId:        this.folderId,
      folderName:      this.folderName,
      lastSync:        this.lastSync,
      clientId:        this.clientId,
    };
  }

  // ─── Reset / desconectar ─────────────────────────────────────
  reset() {
    this.token      = null;
    this.folderId   = null;
    this.folderName = null;
    this.lastSync   = null;
    this.clientId   = null;
    this.ready      = false;
    this.tokenClient = null;
    localStorage.removeItem('gdrive-sync-settings');
  }
}

// Singleton global
window.googleDriveSync = new GoogleDriveSync();
