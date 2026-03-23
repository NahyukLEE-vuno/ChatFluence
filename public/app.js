function apiFetch(input, init = {}) {
  return fetch(input, { credentials: 'include', ...init });
}

const app = {
  conversations: [],
  currentConvId: null,
  conversationMessages: [],
  isLoading: false,
  abortController: null,
  currentConfig: { provider: 'openai', model: 'gpt-5.4-mini', has_key: false },
  allSpacesCatalog: [],
  spaces: [],
  selectedParentPage: null,
  parentSearchTimer: null,
  _parentFlashTimer: null,
  selectedCommentTargetPage: null,
  commentSearchTimer: null,
  _commentFlashTimer: null,
  selectedUpdateTargetPage: null,
  updateSearchTimer: null,
  _updatePageFlashTimer: null,
  selectedDeleteTargetPage: null,
  deleteSearchTimer: null,
  _deletePageFlashTimer: null,
  /** 서버가 needs_confirmation으로 돌려준 쓰기 도구 목록; 실행 전 사용자 확인용 */
  pendingToolCalls: null,
  _pendingBlockFlashTimer: null,
  /** 웰컴 화면 인사 문구 (로그인 후 /api/status greetingName 기준) */
  _welcomeGreetingText: '',
  /** 채팅 사용자 말풍선 동그라미 아바타에 넣을 2글자 (greetingName 기반) */
  userAvatarShortLabel: '유',

  /** 이번 전송에 붙일 첨부 { name, mime, data } (base64, data URL 제외) */
  pendingAttachments: [],
  /** FileReader 비동기 완료 전 send 방지 */
  pendingAttachmentReads: 0,
  _maxAttachmentBytes: 20 * 1024 * 1024,

  async init() {
    marked.setOptions({
      highlight: (code, lang) => {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
      },
      breaks: true,
    });
    const ok = await this.probeSession();
    if (!ok) {
      this.showLoginGate();
      return;
    }
    this.hideLoginGate();
    await this.bootstrapMain();
  },

  async probeSession() {
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      return !!(data.configured && data.aiReady);
    } catch {
      return false;
    }
  },

  showLoginGate() {
    document.getElementById('login-gate')?.classList.remove('login-gate--hidden');
    document.getElementById('app')?.setAttribute('inert', '');
  },

  hideLoginGate() {
    document.getElementById('login-gate')?.classList.add('login-gate--hidden');
    document.getElementById('app')?.removeAttribute('inert');
  },

  async submitLogin() {
    const errEl = document.getElementById('login-error');
    const uid = (document.getElementById('login-user-id')?.value || '').trim();
    const cf = (document.getElementById('login-cf-token')?.value || '').trim();
    const oai = (document.getElementById('login-oai-key')?.value || '').trim();
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    if (!uid || !cf || !oai) {
      if (errEl) {
        errEl.textContent = '세 항목을 모두 입력하세요.';
        errEl.hidden = false;
      }
      return;
    }
    const btn = document.getElementById('login-submit');
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: uid,
          confluence_token: cf,
          openai_api_key: oai,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || `로그인 실패 (${res.status})`;
          errEl.hidden = false;
        }
        return;
      }
      window.location.reload();
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message || '네트워크 오류';
        errEl.hidden = false;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  async logout() {
    try {
      await apiFetch('/api/logout', { method: 'POST' });
    } catch {}
    window.location.reload();
  },

  async bootstrapMain() {
    this.setupAttachments();
    this.setupInput();
    this.setupParentPagePicker();
    this.setupCommentPagePicker();
    this.setupUpdatePagePicker();
    this.setupDeletePagePicker();
    this.setupPickerSpaceAndDocCloseouts();
    this.setupWriteTaskRadios();
    this.loadConversations();
    await this.loadConfig();
    await this.loadChatModels();
    this.loadSpaces();
    await this.checkStatus();
  },

  renderWelcomeGreeting() {
    const el = document.getElementById('welcome-title');
    if (!el) return;
    const t = (this._welcomeGreetingText || '').trim();
    el.textContent = t || 'ChatFluence';
  },

  setupWriteTaskRadios() {
    document.querySelectorAll('input[name="chat-write-task"]').forEach((radio) => {
      radio.addEventListener('change', () => this.onWriteTaskChanged());
    });
    this.onWriteTaskChanged();
  },

  /** 선택된 단일 쓰기 작업; 없으면 빈 문자열 (읽기만) */
  getSelectedWriteTask() {
    const el = document.querySelector('input[name="chat-write-task"]:checked');
    if (!el || !el.value || el.value === 'none') return '';
    return el.value;
  },

  onWriteTaskChanged() {
    this.syncParentPageRowVisibility();
    this.syncCommentPageRowVisibility();
    this.syncUpdatePageRowVisibility();
    this.syncDeletePageRowVisibility();
  },

  setupAttachments() {
    const input = document.getElementById('chat-file-input');
    const btn = document.getElementById('chat-attach-btn');
    if (!input || !btn) return;
    btn.addEventListener('click', () => {
      if (this.isLoading) return;
      input.click();
    });
    input.addEventListener('change', () => this.onChatFilesSelected(input));
    const strip = document.getElementById('attachment-strip');
    strip?.addEventListener('click', (e) => {
      const rm = e.target.closest?.('.attach-chip-remove');
      if (!rm || !strip.contains(rm)) return;
      const i = Number(rm.dataset.idx);
      if (!Number.isNaN(i)) this.removePendingAttachment(i);
    });
  },

  waitForPendingAttachmentReads(maxMs) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.pendingAttachmentReads <= 0) {
          resolve();
          return;
        }
        if (Date.now() - t0 >= maxMs) {
          resolve();
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
  },

  /** readAsDataURL 대신 사용 — 대용량/일부 브라우저에서 빈 결과 방지 */
  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  },

  onChatFilesSelected(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length || this.isLoading) return;
    const maxFiles = 8;
    for (const file of files) {
      if (this.pendingAttachments.length >= maxFiles) {
        alert(`첨부는 최대 ${maxFiles}개까지입니다.`);
        break;
      }
      if (file.size > this._maxAttachmentBytes) {
        alert(`"${file.name}"은(는) 20MB를 초과합니다.`);
        continue;
      }
      if (file.size === 0) {
        alert(`"${file.name}"은(는) 빈 파일입니다.`);
        continue;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const entry = {
        id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        data: '',
        loading: true,
        error: false,
        _reader: null,
      };
      this.pendingAttachments.push(entry);
      this.pendingAttachmentReads += 1;
      this.renderPendingAttachments();

      const reader = new FileReader();
      entry._reader = reader;
      const fname = file.name;
      reader.onload = () => {
        try {
          const buf = reader.result;
          if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) {
            entry.data = '';
            entry.loading = false;
            entry.error = true;
            return;
          }
          let base64;
          try {
            base64 = this._arrayBufferToBase64(buf);
          } catch (e) {
            entry.data = '';
            entry.loading = false;
            entry.error = true;
            console.error('attachment base64 encode failed', fname, e);
            return;
          }
          if (!base64) {
            entry.data = '';
            entry.loading = false;
            entry.error = true;
            return;
          }
          entry.data = base64;
          entry.loading = false;
          entry.error = false;
        } finally {
          entry._reader = null;
          this.pendingAttachmentReads -= 1;
          this.renderPendingAttachments();
          if (entry.error && !entry.data) {
            alert(`"${fname}"을(를) 읽거나 인코딩하지 못했습니다. 다시 추가해 주세요.`);
          }
        }
      };
      reader.onerror = () => {
        entry.loading = false;
        entry.error = true;
        entry.data = '';
        entry._reader = null;
        this.pendingAttachmentReads -= 1;
        this.renderPendingAttachments();
        alert(`"${fname}"을(를) 읽지 못했습니다.`);
      };
      reader.readAsArrayBuffer(file);
    }
  },

  removePendingAttachment(index) {
    if (index < 0 || index >= this.pendingAttachments.length) return;
    if (this.pendingAttachments[index].loading) return;
    this.pendingAttachments.splice(index, 1);
    this.renderPendingAttachments();
  },

  renderPendingAttachments() {
    const strip = document.getElementById('attachment-strip');
    if (!strip) return;
    if (!this.pendingAttachments.length) {
      strip.hidden = true;
      strip.innerHTML = '';
      strip.removeAttribute('aria-busy');
      return;
    }
    strip.hidden = false;
    const anyLoading = this.pendingAttachments.some((a) => a.loading);
    strip.setAttribute('aria-busy', anyLoading ? 'true' : 'false');
    strip.innerHTML = this.pendingAttachments
      .map((a, i) => {
        const spin = a.loading
          ? '<span class="attach-spinner" aria-hidden="true"></span>'
          : '';
        const err = a.error ? '<span class="attach-chip-error" title="읽기 실패">!</span>' : '';
        const rm = a.loading
          ? ''
          : `<button type="button" class="attach-chip-remove" data-idx="${i}" aria-label="첨부 제거">&times;</button>`;
        const cls = a.loading ? 'attach-chip attach-chip--loading' : 'attach-chip';
        const st = a.loading ? '읽는 중…' : '';
        return `
      <span class="${cls}" title="${this.escapeHtml(a.name)}${st ? ' — ' + st : ''}">
        ${spin}
        <span class="attach-chip-name">${this.escapeHtml(a.name)}</span>
        ${err}
        ${rm}
      </span>
    `;
      })
      .join('');
  },

  /** 히스토리·멀티모달 user 메시지 표시용 */
  userMessageDisplay(m) {
    if (!m || m.role !== 'user') return typeof m?.content === 'string' ? m.content : '';
    if (m.display_text) return m.display_text;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const textParts = m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '');
      const nImg = m.content.filter((p) => p && p.type === 'image_url').length;
      let s = textParts.join('\n\n').trim();
      if (nImg) s += (s ? '\n' : '') + `🖼 이미지 ${nImg}장`;
      return s || '(첨부 메시지)';
    }
    return '';
  },

  setupInput() {
    const ta = document.getElementById('chat-input');
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
      if (e.key === 'Escape' && this.isLoading) {
        this.stopGeneration();
      }
    });
  },

  setupParentPagePicker() {
    const search = document.getElementById('parent-page-search');
    const results = document.getElementById('parent-page-results');
    const resetBtn = document.getElementById('parent-page-reset');
    if (!search || !results) return;

    search.addEventListener('input', () => this.scheduleParentSearch());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.resolveParentFromSearchInput();
      }
      if (e.key === 'Escape') {
        results.hidden = true;
      }
    });
    resetBtn?.addEventListener('click', () => this.resetParentPagePicker());
    this.syncParentPageRowVisibility();
  },

  setupCommentPagePicker() {
    const search = document.getElementById('comment-page-search');
    const results = document.getElementById('comment-page-results');
    const resetBtn = document.getElementById('comment-page-reset');
    if (!search || !results) return;

    search.addEventListener('input', () => this.scheduleCommentSearch());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.resolveCommentFromSearchInput();
      }
      if (e.key === 'Escape') {
        results.hidden = true;
      }
    });
    resetBtn?.addEventListener('click', () => this.resetCommentPagePicker());
    this.syncCommentPageRowVisibility();
  },

  setupPickerSpaceAndDocCloseouts() {
    const spaceSel = document.getElementById('chat-space-select');
    spaceSel?.addEventListener('change', () => {
      const hadP = !!this.selectedParentPage;
      const hadC = !!this.selectedCommentTargetPage;
      const hadU = !!this.selectedUpdateTargetPage;
      const hadD = !!this.selectedDeleteTargetPage;
      this.resetParentPagePicker();
      this.resetCommentPagePicker();
      this.resetUpdatePagePicker();
      this.resetDeletePagePicker();
      if (hadP) this.flashParentHint('스페이스가 바뀌어 부모 선택을 해제했습니다.');
      if (hadC) this.flashCommentHint('스페이스가 바뀌어 댓글 대상 페이지 선택을 해제했습니다.');
      if (hadU) this.flashUpdateHint('스페이스가 바뀌어 수정 대상 페이지 선택을 해제했습니다.');
      if (hadD) this.flashDeleteHint('스페이스가 바뀌어 삭제 대상 페이지 선택을 해제했습니다.');
    });
    document.addEventListener('click', (e) => {
      const pr = document.getElementById('parent-page-row');
      const cr = document.getElementById('comment-page-row');
      const ur = document.getElementById('update-page-row');
      const dr = document.getElementById('delete-page-row');
      const pres = document.getElementById('parent-page-results');
      const cres = document.getElementById('comment-page-results');
      const ures = document.getElementById('update-page-results');
      const dres = document.getElementById('delete-page-results');
      if (pres && pr && !pr.contains(e.target)) pres.hidden = true;
      if (cres && cr && !cr.contains(e.target)) cres.hidden = true;
      if (ures && ur && !ur.contains(e.target)) ures.hidden = true;
      if (dres && dr && !dr.contains(e.target)) dres.hidden = true;
    });
  },

  syncParentPageRowVisibility() {
    const row = document.getElementById('parent-page-row');
    if (!row) return;
    const on = this.getSelectedWriteTask() === 'confluence_create_page';
    row.classList.toggle('is-visible', on);
    if (!on) this.resetParentPagePicker();
  },

  flashParentHint(text, ms = 4000, level = 'info') {
    const el = document.getElementById('parent-page-flash');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-alert', !!(text && level === 'alert'));
    if (this._parentFlashTimer) clearTimeout(this._parentFlashTimer);
    if (text && ms) {
      this._parentFlashTimer = setTimeout(() => {
        el.textContent = '';
        el.classList.remove('is-alert');
      }, ms);
    }
    if (!text) el.classList.remove('is-alert');
  },

  /** 서버 `extract_confluence_page_id`와 동일 규칙 */
  extractPageIdFromPaste(s) {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim();
    if (/^\d+$/.test(t)) return t;
    let m = t.match(/\/pages\/(\d+)/);
    if (m) return m[1];
    m = t.match(/pageId=(\d+)/i);
    if (m) return m[1];
    m = t.match(/\/content\/(\d+)/);
    if (m) return m[1];
    return null;
  },

  looksLikePageRef(s) {
    const t = String(s || '').trim();
    if (/^\d+$/.test(t)) return true;
    return /\/pages\/\d+|pageId=\d+|atlassian\.net\/wiki|\/wiki\/|\/display\//i.test(t);
  },

  scheduleParentSearch() {
    clearTimeout(this.parentSearchTimer);
    this.parentSearchTimer = setTimeout(() => this.runParentSearch(), 280);
  },

  async resolveParentFromSearchInput() {
    const search = document.getElementById('parent-page-search');
    const q = (search?.value || '').trim();
    if (!q) return;
    if (this.looksLikePageRef(q)) {
      const id = this.extractPageIdFromPaste(q);
      if (!id) {
        this.flashParentHint(
          '유효하지 않은 URL입니다. …/pages/숫자/… 형태, 숫자 페이지 ID, 또는 pageId=숫자 가 포함된 Confluence 주소를 넣어 주세요.',
          6000,
          'alert',
        );
        return;
      }
      await this.fetchParentLookup(q);
      return;
    }
    await this.runParentSearch();
  },

  async fetchParentLookup(q) {
    const search = document.getElementById('parent-page-search');
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    try {
      const res = await apiFetch(`/api/pages/lookup?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        this.flashParentHint(data.error || '페이지를 찾을 수 없습니다.', 6000, 'alert');
        return false;
      }
      const p = data.page;
      if (!p || p.id == null) {
        this.flashParentHint('응답 형식 오류', 5000, 'alert');
        return false;
      }
      this.applySelectedParent({
        id: String(p.id),
        title: p.title || '',
        space_key: (p.space && p.space.key) || '',
      });
      if (search) search.value = '';
      this.flashParentHint('');
      return true;
    } catch (e) {
      this.flashParentHint(e.message || '조회 실패', 5000, 'alert');
      return false;
    }
  },

  async runParentSearch() {
    const search = document.getElementById('parent-page-search');
    const results = document.getElementById('parent-page-results');
    if (!search || !results) return;
    const q = search.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    if (this.looksLikePageRef(q)) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    results.innerHTML = '<div class="parent-page-results-empty">검색 중…</div>';
    results.hidden = false;
    try {
      const res = await apiFetch(`/api/pages/search?${qs}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        results.innerHTML = `<div class="parent-page-results-error">${this.escapeHtml(data.error || '검색 실패')}</div>`;
        return;
      }
      const pages = data.pages || [];
      if (pages.length === 0) {
        results.innerHTML = '<div class="parent-page-results-empty">결과 없음</div>';
        return;
      }
      results.innerHTML = '';
      for (const p of pages) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'parent-page-hit';
        const t = document.createElement('span');
        t.textContent = p.title || '(제목 없음)';
        const m = document.createElement('span');
        m.className = 'parent-page-hit-meta';
        m.textContent = [p.space_key, p.space_name].filter(Boolean).join(' · ');
        btn.appendChild(t);
        btn.appendChild(m);
        btn.addEventListener('click', () => {
          this.applySelectedParent({
            id: String(p.id),
            title: p.title || '',
            space_key: p.space_key || '',
          });
          this.flashParentHint('');
        });
        results.appendChild(btn);
      }
      results.hidden = false;
    } catch (e) {
      results.innerHTML = `<div class="parent-page-results-error">${this.escapeHtml(e.message)}</div>`;
    }
  },

  applySelectedParent(obj) {
    this.selectedParentPage = obj;
    const field = document.getElementById('parent-page-field-wrap');
    const selBox = document.getElementById('parent-page-selected');
    const results = document.getElementById('parent-page-results');
    const tEl = document.getElementById('parent-page-chip-title');
    const mEl = document.getElementById('parent-page-chip-meta');
    if (tEl) tEl.textContent = obj.title || '(제목 없음)';
    if (mEl) mEl.textContent = obj.space_key ? ` · ${obj.space_key}` : '';
    if (field) {
      field.setAttribute('hidden', '');
      field.hidden = true;
    }
    if (selBox) {
      selBox.removeAttribute('hidden');
      selBox.hidden = false;
    }
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
  },

  clearSelectedParent() {
    this.selectedParentPage = null;
    const field = document.getElementById('parent-page-field-wrap');
    const selBox = document.getElementById('parent-page-selected');
    const search = document.getElementById('parent-page-search');
    const results = document.getElementById('parent-page-results');
    const tEl = document.getElementById('parent-page-chip-title');
    const mEl = document.getElementById('parent-page-chip-meta');
    if (tEl) tEl.textContent = '';
    if (mEl) mEl.textContent = '';
    if (field) {
      field.removeAttribute('hidden');
      field.hidden = false;
    }
    if (selBox) {
      selBox.setAttribute('hidden', '');
      selBox.hidden = true;
    }
    if (search) search.value = '';
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
    this.flashParentHint('');
  },

  /** 선택·검색창·드롭다운·힌트를 모두 비움 (등록된 부모가 다시 보이지 않도록) */
  resetParentPagePicker() {
    if (this.parentSearchTimer) clearTimeout(this.parentSearchTimer);
    this.clearSelectedParent();
  },

  syncCommentPageRowVisibility() {
    const row = document.getElementById('comment-page-row');
    if (!row) return;
    const on = this.getSelectedWriteTask() === 'confluence_add_comment';
    row.classList.toggle('is-visible', on);
    if (!on) this.resetCommentPagePicker();
  },

  flashCommentHint(text, ms = 4000, level = 'info') {
    const el = document.getElementById('comment-page-flash');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-alert', !!(text && level === 'alert'));
    if (this._commentFlashTimer) clearTimeout(this._commentFlashTimer);
    if (text && ms) {
      this._commentFlashTimer = setTimeout(() => {
        el.textContent = '';
        el.classList.remove('is-alert');
      }, ms);
    }
    if (!text) el.classList.remove('is-alert');
  },

  scheduleCommentSearch() {
    clearTimeout(this.commentSearchTimer);
    this.commentSearchTimer = setTimeout(() => this.runCommentSearch(), 280);
  },

  async resolveCommentFromSearchInput() {
    const search = document.getElementById('comment-page-search');
    const q = (search?.value || '').trim();
    if (!q) return;
    if (this.looksLikePageRef(q)) {
      const id = this.extractPageIdFromPaste(q);
      if (!id) {
        this.flashCommentHint(
          '유효하지 않은 URL입니다. …/pages/숫자/… 형태, 숫자 페이지 ID, 또는 pageId=숫자 가 포함된 Confluence 주소를 넣어 주세요.',
          6000,
          'alert',
        );
        return;
      }
      await this.fetchCommentLookup(q);
      return;
    }
    await this.runCommentSearch();
  },

  async fetchCommentLookup(q) {
    const search = document.getElementById('comment-page-search');
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    try {
      const res = await apiFetch(`/api/pages/lookup?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        this.flashCommentHint(data.error || '페이지를 찾을 수 없습니다.', 6000, 'alert');
        return false;
      }
      const p = data.page;
      if (!p || p.id == null) {
        this.flashCommentHint('응답 형식 오류', 5000, 'alert');
        return false;
      }
      this.applySelectedCommentTarget({
        id: String(p.id),
        title: p.title || '',
        space_key: (p.space && p.space.key) || '',
      });
      if (search) search.value = '';
      this.flashCommentHint('');
      return true;
    } catch (e) {
      this.flashCommentHint(e.message || '조회 실패', 5000, 'alert');
      return false;
    }
  },

  async runCommentSearch() {
    const search = document.getElementById('comment-page-search');
    const results = document.getElementById('comment-page-results');
    if (!search || !results) return;
    const q = search.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    if (this.looksLikePageRef(q)) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    results.innerHTML = '<div class="comment-page-results-empty">검색 중…</div>';
    results.hidden = false;
    try {
      const res = await apiFetch(`/api/pages/search?${qs}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        results.innerHTML = `<div class="comment-page-results-error">${this.escapeHtml(data.error || '검색 실패')}</div>`;
        return;
      }
      const pages = data.pages || [];
      if (pages.length === 0) {
        results.innerHTML = '<div class="comment-page-results-empty">결과 없음</div>';
        return;
      }
      results.innerHTML = '';
      for (const p of pages) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'comment-page-hit';
        const t = document.createElement('span');
        t.textContent = p.title || '(제목 없음)';
        const m = document.createElement('span');
        m.className = 'comment-page-hit-meta';
        m.textContent = [p.space_key, p.space_name].filter(Boolean).join(' · ');
        btn.appendChild(t);
        btn.appendChild(m);
        btn.addEventListener('click', () => {
          this.applySelectedCommentTarget({
            id: String(p.id),
            title: p.title || '',
            space_key: p.space_key || '',
          });
          this.flashCommentHint('');
        });
        results.appendChild(btn);
      }
      results.hidden = false;
    } catch (e) {
      results.innerHTML = `<div class="comment-page-results-error">${this.escapeHtml(e.message)}</div>`;
    }
  },

  applySelectedCommentTarget(obj) {
    this.selectedCommentTargetPage = obj;
    const field = document.getElementById('comment-page-field-wrap');
    const selBox = document.getElementById('comment-page-selected');
    const results = document.getElementById('comment-page-results');
    const tEl = document.getElementById('comment-page-chip-title');
    const mEl = document.getElementById('comment-page-chip-meta');
    if (tEl) tEl.textContent = obj.title || '(제목 없음)';
    if (mEl) mEl.textContent = obj.space_key ? ` · ${obj.space_key}` : '';
    if (field) {
      field.setAttribute('hidden', '');
      field.hidden = true;
    }
    if (selBox) {
      selBox.removeAttribute('hidden');
      selBox.hidden = false;
    }
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
  },

  clearSelectedCommentTarget() {
    this.selectedCommentTargetPage = null;
    const field = document.getElementById('comment-page-field-wrap');
    const selBox = document.getElementById('comment-page-selected');
    const search = document.getElementById('comment-page-search');
    const results = document.getElementById('comment-page-results');
    const tEl = document.getElementById('comment-page-chip-title');
    const mEl = document.getElementById('comment-page-chip-meta');
    if (tEl) tEl.textContent = '';
    if (mEl) mEl.textContent = '';
    if (field) {
      field.removeAttribute('hidden');
      field.hidden = false;
    }
    if (selBox) {
      selBox.setAttribute('hidden', '');
      selBox.hidden = true;
    }
    if (search) search.value = '';
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
    this.flashCommentHint('');
  },

  resetCommentPagePicker() {
    if (this.commentSearchTimer) clearTimeout(this.commentSearchTimer);
    this.clearSelectedCommentTarget();
  },

  setupUpdatePagePicker() {
    const search = document.getElementById('update-page-search');
    const results = document.getElementById('update-page-results');
    const resetBtn = document.getElementById('update-page-reset');
    if (!search || !results) return;
    search.addEventListener('input', () => this.scheduleUpdateSearch());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.resolveUpdateFromSearchInput();
      }
      if (e.key === 'Escape') results.hidden = true;
    });
    resetBtn?.addEventListener('click', () => this.resetUpdatePagePicker());
    this.syncUpdatePageRowVisibility();
  },

  setupDeletePagePicker() {
    const search = document.getElementById('delete-page-search');
    const results = document.getElementById('delete-page-results');
    const resetBtn = document.getElementById('delete-page-reset');
    if (!search || !results) return;
    search.addEventListener('input', () => this.scheduleDeleteSearch());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.resolveDeleteFromSearchInput();
      }
      if (e.key === 'Escape') results.hidden = true;
    });
    resetBtn?.addEventListener('click', () => this.resetDeletePagePicker());
    this.syncDeletePageRowVisibility();
  },

  syncUpdatePageRowVisibility() {
    const row = document.getElementById('update-page-row');
    if (!row) return;
    const on = this.getSelectedWriteTask() === 'confluence_update_page';
    row.classList.toggle('is-visible', on);
    if (!on) this.resetUpdatePagePicker();
  },

  syncDeletePageRowVisibility() {
    const row = document.getElementById('delete-page-row');
    if (!row) return;
    const on = this.getSelectedWriteTask() === 'confluence_delete_page';
    row.classList.toggle('is-visible', on);
    if (!on) this.resetDeletePagePicker();
  },

  flashUpdateHint(text, ms = 4000, level = 'info') {
    const el = document.getElementById('update-page-flash');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-alert', !!(text && level === 'alert'));
    if (this._updatePageFlashTimer) clearTimeout(this._updatePageFlashTimer);
    if (text && ms) {
      this._updatePageFlashTimer = setTimeout(() => {
        el.textContent = '';
        el.classList.remove('is-alert');
      }, ms);
    }
    if (!text) el.classList.remove('is-alert');
  },

  flashDeleteHint(text, ms = 4000, level = 'info') {
    const el = document.getElementById('delete-page-flash');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-alert', !!(text && level === 'alert'));
    if (this._deletePageFlashTimer) clearTimeout(this._deletePageFlashTimer);
    if (text && ms) {
      this._deletePageFlashTimer = setTimeout(() => {
        el.textContent = '';
        el.classList.remove('is-alert');
      }, ms);
    }
    if (!text) el.classList.remove('is-alert');
  },

  scheduleUpdateSearch() {
    clearTimeout(this.updateSearchTimer);
    this.updateSearchTimer = setTimeout(() => this.runUpdateSearch(), 280);
  },

  scheduleDeleteSearch() {
    clearTimeout(this.deleteSearchTimer);
    this.deleteSearchTimer = setTimeout(() => this.runDeleteSearch(), 280);
  },

  async resolveUpdateFromSearchInput() {
    const search = document.getElementById('update-page-search');
    const q = (search?.value || '').trim();
    if (!q) return;
    if (this.looksLikePageRef(q)) {
      const id = this.extractPageIdFromPaste(q);
      if (!id) {
        this.flashUpdateHint(
          '유효하지 않은 URL입니다. …/pages/숫자/… 형태, 숫자 페이지 ID, 또는 pageId=숫자 가 포함된 Confluence 주소를 넣어 주세요.',
          6000,
          'alert',
        );
        return;
      }
      await this.fetchUpdateLookup(q);
      return;
    }
    await this.runUpdateSearch();
  },

  async resolveDeleteFromSearchInput() {
    const search = document.getElementById('delete-page-search');
    const q = (search?.value || '').trim();
    if (!q) return;
    if (this.looksLikePageRef(q)) {
      const id = this.extractPageIdFromPaste(q);
      if (!id) {
        this.flashDeleteHint(
          '유효하지 않은 URL입니다. …/pages/숫자/… 형태, 숫자 페이지 ID, 또는 pageId=숫자 가 포함된 Confluence 주소를 넣어 주세요.',
          6000,
          'alert',
        );
        return;
      }
      await this.fetchDeleteLookup(q);
      return;
    }
    await this.runDeleteSearch();
  },

  async fetchUpdateLookup(q) {
    const search = document.getElementById('update-page-search');
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    try {
      const res = await apiFetch(`/api/pages/lookup?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        this.flashUpdateHint(data.error || '페이지를 찾을 수 없습니다.', 6000, 'alert');
        return false;
      }
      const p = data.page;
      if (!p || p.id == null) {
        this.flashUpdateHint('응답 형식 오류', 5000, 'alert');
        return false;
      }
      this.applySelectedUpdateTarget({
        id: String(p.id),
        title: p.title || '',
        space_key: (p.space && p.space.key) || '',
      });
      if (search) search.value = '';
      this.flashUpdateHint('');
      return true;
    } catch (e) {
      this.flashUpdateHint(e.message || '조회 실패', 5000, 'alert');
      return false;
    }
  },

  async fetchDeleteLookup(q) {
    const search = document.getElementById('delete-page-search');
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    try {
      const res = await apiFetch(`/api/pages/lookup?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        this.flashDeleteHint(data.error || '페이지를 찾을 수 없습니다.', 6000, 'alert');
        return false;
      }
      const p = data.page;
      if (!p || p.id == null) {
        this.flashDeleteHint('응답 형식 오류', 5000, 'alert');
        return false;
      }
      this.applySelectedDeleteTarget({
        id: String(p.id),
        title: p.title || '',
        space_key: (p.space && p.space.key) || '',
      });
      if (search) search.value = '';
      this.flashDeleteHint('');
      return true;
    } catch (e) {
      this.flashDeleteHint(e.message || '조회 실패', 5000, 'alert');
      return false;
    }
  },

  async runUpdateSearch() {
    const search = document.getElementById('update-page-search');
    const results = document.getElementById('update-page-results');
    if (!search || !results) return;
    const q = search.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    if (this.looksLikePageRef(q)) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    results.innerHTML = '<div class="update-page-results-empty">검색 중…</div>';
    results.hidden = false;
    try {
      const res = await apiFetch(`/api/pages/search?${qs}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        results.innerHTML = `<div class="update-page-results-error">${this.escapeHtml(data.error || '검색 실패')}</div>`;
        return;
      }
      const pages = data.pages || [];
      if (pages.length === 0) {
        results.innerHTML = '<div class="update-page-results-empty">결과 없음</div>';
        return;
      }
      results.innerHTML = '';
      for (const p of pages) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'update-page-hit';
        const t = document.createElement('span');
        t.textContent = p.title || '(제목 없음)';
        const m = document.createElement('span');
        m.className = 'update-page-hit-meta';
        m.textContent = [p.space_key, p.space_name].filter(Boolean).join(' · ');
        btn.appendChild(t);
        btn.appendChild(m);
        btn.addEventListener('click', () => {
          this.applySelectedUpdateTarget({
            id: String(p.id),
            title: p.title || '',
            space_key: p.space_key || '',
          });
          this.flashUpdateHint('');
        });
        results.appendChild(btn);
      }
      results.hidden = false;
    } catch (e) {
      results.innerHTML = `<div class="update-page-results-error">${this.escapeHtml(e.message)}</div>`;
    }
  },

  async runDeleteSearch() {
    const search = document.getElementById('delete-page-search');
    const results = document.getElementById('delete-page-results');
    if (!search || !results) return;
    const q = search.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    if (this.looksLikePageRef(q)) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    const spaceSel = document.getElementById('chat-space-select');
    const sk = spaceSel ? spaceSel.value : '';
    const qs = new URLSearchParams({ q });
    if (sk) qs.set('space_key', sk);
    results.innerHTML = '<div class="delete-page-results-empty">검색 중…</div>';
    results.hidden = false;
    try {
      const res = await apiFetch(`/api/pages/search?${qs}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        results.innerHTML = `<div class="delete-page-results-error">${this.escapeHtml(data.error || '검색 실패')}</div>`;
        return;
      }
      const pages = data.pages || [];
      if (pages.length === 0) {
        results.innerHTML = '<div class="delete-page-results-empty">결과 없음</div>';
        return;
      }
      results.innerHTML = '';
      for (const p of pages) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'delete-page-hit';
        const t = document.createElement('span');
        t.textContent = p.title || '(제목 없음)';
        const m = document.createElement('span');
        m.className = 'delete-page-hit-meta';
        m.textContent = [p.space_key, p.space_name].filter(Boolean).join(' · ');
        btn.appendChild(t);
        btn.appendChild(m);
        btn.addEventListener('click', () => {
          this.applySelectedDeleteTarget({
            id: String(p.id),
            title: p.title || '',
            space_key: p.space_key || '',
          });
          this.flashDeleteHint('');
        });
        results.appendChild(btn);
      }
      results.hidden = false;
    } catch (e) {
      results.innerHTML = `<div class="delete-page-results-error">${this.escapeHtml(e.message)}</div>`;
    }
  },

  applySelectedUpdateTarget(obj) {
    this.selectedUpdateTargetPage = obj;
    const field = document.getElementById('update-page-field-wrap');
    const selBox = document.getElementById('update-page-selected');
    const results = document.getElementById('update-page-results');
    const tEl = document.getElementById('update-page-chip-title');
    const mEl = document.getElementById('update-page-chip-meta');
    if (tEl) tEl.textContent = obj.title || '(제목 없음)';
    if (mEl) mEl.textContent = obj.space_key ? ` · ${obj.space_key}` : '';
    if (field) {
      field.setAttribute('hidden', '');
      field.hidden = true;
    }
    if (selBox) {
      selBox.removeAttribute('hidden');
      selBox.hidden = false;
    }
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
  },

  applySelectedDeleteTarget(obj) {
    this.selectedDeleteTargetPage = obj;
    const field = document.getElementById('delete-page-field-wrap');
    const selBox = document.getElementById('delete-page-selected');
    const results = document.getElementById('delete-page-results');
    const tEl = document.getElementById('delete-page-chip-title');
    const mEl = document.getElementById('delete-page-chip-meta');
    if (tEl) tEl.textContent = obj.title || '(제목 없음)';
    if (mEl) mEl.textContent = obj.space_key ? ` · ${obj.space_key}` : '';
    if (field) {
      field.setAttribute('hidden', '');
      field.hidden = true;
    }
    if (selBox) {
      selBox.removeAttribute('hidden');
      selBox.hidden = false;
    }
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
  },

  clearSelectedUpdateTarget() {
    this.selectedUpdateTargetPage = null;
    const field = document.getElementById('update-page-field-wrap');
    const selBox = document.getElementById('update-page-selected');
    const search = document.getElementById('update-page-search');
    const results = document.getElementById('update-page-results');
    const tEl = document.getElementById('update-page-chip-title');
    const mEl = document.getElementById('update-page-chip-meta');
    if (tEl) tEl.textContent = '';
    if (mEl) mEl.textContent = '';
    if (field) {
      field.removeAttribute('hidden');
      field.hidden = false;
    }
    if (selBox) {
      selBox.setAttribute('hidden', '');
      selBox.hidden = true;
    }
    if (search) search.value = '';
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
    this.flashUpdateHint('');
  },

  clearSelectedDeleteTarget() {
    this.selectedDeleteTargetPage = null;
    const field = document.getElementById('delete-page-field-wrap');
    const selBox = document.getElementById('delete-page-selected');
    const search = document.getElementById('delete-page-search');
    const results = document.getElementById('delete-page-results');
    const tEl = document.getElementById('delete-page-chip-title');
    const mEl = document.getElementById('delete-page-chip-meta');
    if (tEl) tEl.textContent = '';
    if (mEl) mEl.textContent = '';
    if (field) {
      field.removeAttribute('hidden');
      field.hidden = false;
    }
    if (selBox) {
      selBox.setAttribute('hidden', '');
      selBox.hidden = true;
    }
    if (search) search.value = '';
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
    this.flashDeleteHint('');
  },

  resetUpdatePagePicker() {
    if (this.updateSearchTimer) clearTimeout(this.updateSearchTimer);
    this.clearSelectedUpdateTarget();
  },

  resetDeletePagePicker() {
    if (this.deleteSearchTimer) clearTimeout(this.deleteSearchTimer);
    this.clearSelectedDeleteTarget();
  },

  async loadConfig() {
    try {
      const res = await apiFetch('/api/config');
      const data = await res.json();
      this.currentConfig = data;
      this.updateModelBadge();
    } catch {}
  },

  getChatModelId() {
    const sel = document.getElementById('chat-model-select');
    if (sel && sel.value) return sel.value;
    return this.currentConfig.model || '';
  },

  updateModelBadge() {
    const badge = document.getElementById('model-badge');
    const m = this.getChatModelId() || '—';
    if (badge) badge.textContent = `OpenAI / ${m}`;
  },

  async fetchOpenAIModels() {
    const res = await apiFetch('/api/models?provider=openai');
    return res.json();
  },

  buildModelOptionsList(data) {
    const fb = (this.currentConfig && this.currentConfig.model) || 'gpt-5.4-mini';
    const models = data.models || [];
    if (models.length === 0) {
      return [{ id: fb, name: `${fb} (API 목록 없음)` }];
    }
    return models;
  },

  async loadChatModels() {
    const sel = document.getElementById('chat-model-select');
    if (!sel) return;
    const prev = sel.value;
    const data = await this.fetchOpenAIModels();
    const models = this.buildModelOptionsList(data);
    sel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }
    const serverModel = this.currentConfig.model || models[0].id;
    let pick = '';
    if (prev && models.some((x) => x.id === prev)) pick = prev;
    else if (serverModel && models.some((x) => x.id === serverModel)) pick = serverModel;
    else pick = models[0].id;
    sel.value = pick;
    sel.onchange = () => {
      this.updateModelBadge();
    };
    this.updateModelBadge();
  },

  async refreshSettingsModels(fromBtn) {
    const sel = document.getElementById('settings-default-model-select');
    const status = document.getElementById('settings-model-status');
    const btn = document.getElementById('settings-refresh-models-btn');
    if (!sel) return;
    if (fromBtn && btn) btn.classList.add('spinning');
    if (status) {
      status.textContent = '모델 목록을 불러오는 중...';
      status.className = 'settings-model-status';
    }
    try {
      const data = await this.fetchOpenAIModels();
      if (fromBtn && btn) btn.classList.remove('spinning');
      if (data.error) {
        if (status) {
          status.textContent = `오류: ${data.error}`;
          status.className = 'settings-model-status error';
        }
        const fb = this.currentConfig.model || 'gpt-5.4-mini';
        sel.innerHTML = '';
        const o = document.createElement('option');
        o.value = fb;
        o.textContent = fb;
        sel.appendChild(o);
        sel.value = fb;
        return;
      }
      if (data.message && (!data.models || data.models.length === 0)) {
        if (status) {
          status.textContent = data.message;
          status.className = 'settings-model-status';
        }
      }
      const models = this.buildModelOptionsList(data);
      sel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        sel.appendChild(opt);
      }
      const want = this.currentConfig.model || models[0].id;
      if (want && models.some((x) => x.id === want)) sel.value = want;
      else sel.value = models[0].id;
      if (status && models.length) {
        status.textContent = `${models.length}개 모델`;
        status.className = 'settings-model-status success';
      }
    } catch (e) {
      if (fromBtn && btn) btn.classList.remove('spinning');
      if (status) {
        status.textContent = e.message;
        status.className = 'settings-model-status error';
      }
    }
  },

  getVisibleSpaceKeysSet() {
    try {
      const raw = localStorage.getItem('cc-visible-space-keys');
      if (raw === null) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return new Set(arr);
    } catch {
      return null;
    }
  },

  isPersonalSpace(s) {
    const rawType = String(s.type || '').toLowerCase();
    return rawType === 'personal' || /^~/.test(s.key || '');
  },

  getIncludePersonalSpaces() {
    return localStorage.getItem('cc-include-personal-spaces') === '1';
  },

  getDefaultSpaceKey() {
    return localStorage.getItem('cc-default-space-key') || '';
  },

  buildChatVisibleSpaceList(all) {
    const globalOnly = all.filter((s) => !this.isPersonalSpace(s));
    const personalOnly = all.filter((s) => this.isPersonalSpace(s));
    const filter = this.getVisibleSpaceKeysSet();
    const globalsForDropdown = filter
      ? globalOnly.filter((s) => filter.has(s.key))
      : globalOnly;
    const list = [...globalsForDropdown];
    if (this.getIncludePersonalSpaces()) {
      list.push(...personalOnly);
    }
    list.sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key, 'ko'));
    return list;
  },

  populateDefaultSpaceSelect(allSpaces) {
    const sel = document.getElementById('default-space-select');
    if (!sel) return;
    const list = this.buildChatVisibleSpaceList(allSpaces);
    const saved = this.getDefaultSpaceKey();
    sel.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = '기본값 없음 (전체 스페이스)';
    sel.appendChild(o0);
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = `${s.name} (${s.key})`;
      sel.appendChild(opt);
    }
    if (saved && list.some((x) => x.key === saved)) sel.value = saved;
    else sel.value = '';
  },

  async loadSpaces() {
    const sel = document.getElementById('chat-space-select');
    if (!sel) return;
    const prev = sel.value;
    try {
      const res = await apiFetch('/api/spaces');
      const data = await res.json();
      const all = data.spaces || [];
      this.spaces = all;

      const filter = this.getVisibleSpaceKeysSet();
      const globalOnly = all.filter((s) => !this.isPersonalSpace(s));
      const globalsForDropdown = filter
        ? globalOnly.filter((s) => filter.has(s.key))
        : globalOnly;

      const personalOnly = all.filter((s) => this.isPersonalSpace(s));
      const personalKeysSorted = personalOnly.map((s) => s.key).sort();
      const personalAggValue = personalKeysSorted.join(',');

      const globalsSorted = [...globalsForDropdown].sort((a, b) =>
        (a.name || a.key).localeCompare(b.name || b.key, 'ko'),
      );
      const dropdownRows = [...globalsSorted];
      if (this.getIncludePersonalSpaces() && personalKeysSorted.length > 0) {
        dropdownRows.push({
          key: personalAggValue,
          name: `개인 스페이스 전체 (${personalKeysSorted.length})`,
        });
      }

      if (dropdownRows.length === 0) {
        if (filter && filter.size > 0 && globalsForDropdown.length === 0) {
          sel.innerHTML =
            '<option value="">선택한 글로벌 스페이스 없음 · 설정에서 조정</option>';
        } else {
          sel.innerHTML = '<option value="">전체 스페이스</option>';
        }
        return;
      }

      const opts = dropdownRows.map((s) => {
        const v = this.escapeHtml(s.key);
        const isPersonalAgg = s.key === personalAggValue && personalKeysSorted.length > 0;
        const text = isPersonalAgg
          ? this.escapeHtml(s.name)
          : `${this.escapeHtml(s.name)} (${this.escapeHtml(s.key)})`;
        return `<option value="${v}">${text}</option>`;
      });
      sel.innerHTML = '<option value="">전체 스페이스</option>' + opts.join('');

      const def = this.getDefaultSpaceKey();
      let pick = '';
      const rowKeySet = new Set(dropdownRows.map((r) => r.key));
      const incP = this.getIncludePersonalSpaces();
      const prevParts = prev
        ? prev.split(',').map((x) => x.trim()).filter(Boolean)
        : [];
      const samePersonalBundle =
        incP &&
        personalKeysSorted.length > 0 &&
        prevParts.length === personalKeysSorted.length &&
        personalKeysSorted.every((k) => prevParts.includes(k));

      if (prev) {
        if (samePersonalBundle || prev === personalAggValue || (incP && personalKeysSorted.includes(prev))) {
          pick = personalAggValue;
        } else if (rowKeySet.has(prev)) pick = prev;
      }
      if (!pick && def) {
        const defIsPersonal = incP && personalKeysSorted.includes(def);
        if (defIsPersonal || (def === personalAggValue && incP && personalKeysSorted.length)) {
          pick = personalAggValue;
        } else if (rowKeySet.has(def)) pick = def;
      }
      if (pick && rowKeySet.has(pick)) sel.value = pick;
    } catch {}
  },

  async checkStatus() {
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      const dot = document.querySelector('.status-dot');
      const text = document.querySelector('.status-text');

      if (data.configured) {
        if (data.aiReady) {
          dot.className = 'status-dot connected';
          text.textContent = 'Ready';
        } else {
          dot.className = 'status-dot warning';
          text.textContent = 'OpenAI 키 없음';
        }
      } else {
        dot.className = 'status-dot disconnected';
        text.textContent = '로그인 필요';
      }
      const name = (data.greetingName || '').trim();
      this.userAvatarShortLabel = this.computeUserAvatarShortLabel(name);
      this._welcomeGreetingText = name
        ? `${name}님, 안녕하세요. 무엇을 도와드릴까요?`
        : '';
    } catch {
      document.querySelector('.status-dot').className = 'status-dot disconnected';
      document.querySelector('.status-text').textContent = 'Error';
      this._welcomeGreetingText = '';
      this.userAvatarShortLabel = '유';
    }
    this.renderWelcomeGreeting();
  },

  readOnlyTools: ['confluence_search', 'confluence_get_page', 'confluence_get_spaces', 'confluence_get_page_children', 'confluence_get_comments'],

  getEnabledTools() {
    const task = this.getSelectedWriteTask();
    const write = task ? [task] : [];
    return [...this.readOnlyTools, ...write];
  },

  handleSendBtn() {
    if (this.isLoading) {
      this.stopGeneration();
    } else {
      this.send();
    }
  },

  setSendBtnState(loading) {
    const btn = document.getElementById('send-btn');
    const iconSend = btn.querySelector('.icon-send');
    const iconStop = btn.querySelector('.icon-stop');
    if (loading) {
      iconSend.style.display = 'none';
      iconStop.style.display = 'block';
      btn.classList.add('stopping');
      btn.disabled = false;
    } else {
      iconSend.style.display = 'block';
      iconStop.style.display = 'none';
      btn.classList.remove('stopping');
    }
  },

  stopGeneration() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  },

  flashPendingBlock(msg) {
    const el = document.getElementById('pending-block-flash');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    if (this._pendingBlockFlashTimer) clearTimeout(this._pendingBlockFlashTimer);
    if (msg) {
      this._pendingBlockFlashTimer = setTimeout(() => {
        el.hidden = true;
        el.textContent = '';
      }, 4200);
    }
  },

  _finalizePendingConfirmUi(label) {
    document.querySelectorAll('.pending-confirm-bar').forEach((bar) => {
      const s = document.createElement('span');
      s.className = 'pending-confirm-done';
      s.textContent = label;
      bar.replaceWith(s);
    });
  },

  cancelPendingWrites() {
    if (!this.pendingToolCalls?.length) return;
    this.pendingToolCalls = null;
    this._finalizePendingConfirmUi('취소됨');
    this.addMessage('assistant', '*작업이 취소되었습니다.*', false, '');
    this.conversationMessages.push({ role: 'assistant', content: '*작업이 취소되었습니다.*' });
    this.saveCurrentConversation();
  },

  async confirmPendingWrites() {
    await this._executePendingConfirmation();
  },

  async _executePendingConfirmation() {
    const pending = this.pendingToolCalls;
    if (!pending?.length || this.isLoading) return;

    const spaceSel = document.getElementById('chat-space-select');
    const spaceKey = spaceSel ? spaceSel.value : '';
    const payload = {
      pending_tool_calls: pending,
      model: this.getChatModelId(),
      enabled_tools: this.getEnabledTools(),
    };
    if (spaceKey) payload.space_key = spaceKey;

    this.isLoading = true;
    this.showTyping();
    this.setSendBtnState(true);
    try {
      const res = await apiFetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      this.hideTyping();
      if (data.error) {
        this.addMessage('assistant', `**Error:** ${data.error}`, true);
        this.conversationMessages.push({ role: 'assistant', content: `**Error:** ${data.error}` });
      } else {
        this.pendingToolCalls = null;
        this._finalizePendingConfirmUi('실행함');
        this.addMessage('assistant', data.response, false, data.used_model || '');
        this.conversationMessages.push({ role: 'assistant', content: data.response });
      }
    } catch (err) {
      this.hideTyping();
      this.addMessage('assistant', `**Network Error:** ${err.message}`, true);
      this.conversationMessages.push({ role: 'assistant', content: `**Network Error:** ${err.message}` });
    }
    this.saveCurrentConversation();
    this.isLoading = false;
    this.setSendBtnState(false);
  },

  async send() {
    const ta = document.getElementById('chat-input');
    const text = ta.value.trim();
    const hasAttachments = this.pendingAttachments.length > 0;
    if ((!text && !hasAttachments) || this.isLoading) return;

    const confirmPat = /^\s*(확인|예|yes|y|ok|ㅇㅇ)\s*$/i;
    const cancelPat = /^\s*(취소|아니|no|n)\s*$/i;

    if (this.pendingToolCalls?.length) {
      if (hasAttachments) {
        this.flashPendingBlock('실행 대기 중에는 새 첨부를 보낼 수 없습니다. 실행 또는 취소한 뒤 다시 시도하세요.');
        return;
      }
      if (cancelPat.test(text)) {
        ta.value = '';
        ta.style.height = 'auto';
        this.hideWelcome();
        this.addMessage('user', text);
        this.conversationMessages.push({ role: 'user', content: text });
        this.flashPendingBlock('');
        this.cancelPendingWrites();
        return;
      }
      if (confirmPat.test(text)) {
        ta.value = '';
        ta.style.height = 'auto';
        this.hideWelcome();
        this.addMessage('user', text);
        this.conversationMessages.push({ role: 'user', content: text });
        this.saveCurrentConversation();
        this.flashPendingBlock('');
        await this._executePendingConfirmation();
        return;
      }
      this.flashPendingBlock('실행 대기 중입니다. 먼저 실행/취소 버튼을 누르거나, 채팅에 「확인」 또는 「취소」를 입력하세요.');
      return;
    }

    const spaceSel = document.getElementById('chat-space-select');
    const spaceKey = spaceSel ? spaceSel.value : '';

    if (hasAttachments) {
      if (this.pendingAttachments.some((a) => a.loading)) {
        await this.waitForPendingAttachmentReads(60000);
      }
      if (this.pendingAttachments.some((a) => a.loading)) {
        alert(
          '아직 파일을 읽는 중입니다. 각 칩 왼쪽의 원형 표시(스피너)가 사라진 뒤 다시 보내 주세요.',
        );
        return;
      }
      if (this.pendingAttachments.some((a) => a.error || !a.data)) {
        alert(
          '일부 첨부를 읽지 못했습니다. 칩에 느낌표가 있으면 제거(×)한 뒤 파일을 다시 추가해 주세요.',
        );
        return;
      }
    }

    const names = this.pendingAttachments.map((a) => a.name);
    const userDisplay =
      (text || '(첨부만 전송 — 파일 내용을 참고해 답해 주세요.)') +
      (names.length ? `\n📎 ${names.join(', ')}` : '');

    ta.value = '';
    ta.style.height = 'auto';
    this.hideWelcome();
    this.addMessage('user', userDisplay);
    this.conversationMessages.push({ role: 'user', content: text });
    if (!this.currentConvId) this.createConversation(userDisplay);
    this.saveCurrentConversation();

    const attachmentsPayload = this.pendingAttachments
      .filter((a) => a.data)
      .map((a) => ({
        filename: a.name,
        mime_type: a.mime,
        data: a.data,
      }));

    this.isLoading = true;
    this.abortController = new AbortController();
    this.showTyping();
    this.setSendBtnState(true);

    try {
      const enabledTools = this.getEnabledTools();
      const payload = {
        messages: this.conversationMessages,
        enabled_tools: enabledTools,
        model: this.getChatModelId(),
      };
      if (attachmentsPayload.length) payload.attachments = attachmentsPayload;
      if (spaceKey) payload.space_key = spaceKey;
      if (this.selectedParentPage && this.selectedParentPage.id) {
        payload.parent_page_context = {
          id: this.selectedParentPage.id,
          title: this.selectedParentPage.title,
          space_key: this.selectedParentPage.space_key,
        };
      }
      if (this.selectedCommentTargetPage && this.selectedCommentTargetPage.id) {
        payload.comment_target_page_context = {
          id: this.selectedCommentTargetPage.id,
          title: this.selectedCommentTargetPage.title,
          space_key: this.selectedCommentTargetPage.space_key,
        };
      }
      if (this.selectedUpdateTargetPage && this.selectedUpdateTargetPage.id) {
        payload.update_target_page_context = {
          id: this.selectedUpdateTargetPage.id,
          title: this.selectedUpdateTargetPage.title,
          space_key: this.selectedUpdateTargetPage.space_key,
        };
      }
      if (this.selectedDeleteTargetPage && this.selectedDeleteTargetPage.id) {
        payload.delete_target_page_context = {
          id: this.selectedDeleteTargetPage.id,
          title: this.selectedDeleteTargetPage.title,
          space_key: this.selectedDeleteTargetPage.space_key,
        };
      }

      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
      });
      const data = await res.json();
      this.hideTyping();

      if (data.error) {
        this.addMessage('assistant', `**Error:** ${data.error}`, true);
        if (data.error.toLowerCase().includes('api key') || data.error.toLowerCase().includes('auth')) {
          alert('인증 오류입니다. 로그아웃 후 다시 로그인해 주세요.');
        }
      } else {
        if (attachmentsPayload.length) {
          this.pendingAttachments = [];
          this.renderPendingAttachments();
        }
        if (data.needs_confirmation && data.pending_tool_calls?.length) {
          this.pendingToolCalls = data.pending_tool_calls;
          this.addMessage('assistant', data.response, false, data.used_model, { showConfirmBar: true });
        } else {
          this.pendingToolCalls = null;
          this.addMessage('assistant', data.response, false, data.used_model);
        }
        if (data.messages) {
          this.conversationMessages = data.messages;
        }
      }
    } catch (err) {
      this.hideTyping();
      if (err.name === 'AbortError') {
        this.addMessage('assistant', '*생성이 중단되었습니다.*', true);
      } else {
        this.addMessage('assistant', `**Network Error:** ${err.message}`, true);
      }
    }

    this.saveCurrentConversation();
    this.abortController = null;
    this.isLoading = false;
    this.setSendBtnState(false);
  },

  hideWelcome() {
    const ws = document.getElementById('welcome-screen');
    if (ws) ws.style.display = 'none';
  },

  addMessage(role, content, isError = false, modelUsed = '', options = {}) {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = `message ${role}`;

    if (role === 'user') {
      const bodyHtml = content.includes('\n')
        ? `<div class="message-user-text">${this.escapeHtml(content).replace(/\n/g, '<br/>')}</div>`
        : `<p>${this.escapeHtml(content)}</p>`;
      const av = this.escapeHtml(this.userAvatarShortLabel || '유');
      div.innerHTML = `
        <div class="message-avatar user-avatar">${av}</div>
        <div class="message-body">${bodyHtml}</div>
      `;
    } else {
      const rendered = marked.parse(content);
      const modelTag = modelUsed ? `<span class="msg-model-tag">${this.escapeHtml(modelUsed)}</span>` : '';
      div.innerHTML = `
        <div class="message-inner">
          <div class="message-avatar assistant-avatar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
          </div>
          <div class="message-body ${isError ? 'error-text' : ''}">${rendered}${modelTag}</div>
        </div>
      `;
      div.querySelectorAll('.message-body a[href]').forEach((a) => {
        const h = a.getAttribute('href') || '';
        if (/^javascript:/i.test(h) || /^data:/i.test(h)) return;
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      div.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
      if (options.showConfirmBar) {
        const body = div.querySelector('.message-body');
        const bar = document.createElement('div');
        bar.className = 'pending-confirm-bar';
        bar.innerHTML = `
          <button type="button" class="btn-primary btn-compact pending-confirm-run">실행</button>
          <button type="button" class="btn-secondary btn-compact pending-confirm-cancel">취소</button>
        `;
        bar.querySelector('.pending-confirm-run').addEventListener('click', () => this.confirmPendingWrites());
        bar.querySelector('.pending-confirm-cancel').addEventListener('click', () => this.cancelPendingWrites());
        body.appendChild(bar);
      }
    }

    messages.appendChild(div);
    this.scrollToBottom();
  },

  showTyping() {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.id = 'typing-indicator';
    div.innerHTML = `
      <div class="message-inner">
        <div class="message-avatar assistant-avatar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </div>
        <div class="message-body">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
    messages.appendChild(div);
    this.scrollToBottom();
  },

  hideTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  },

  scrollToBottom() {
    const c = document.getElementById('chat-container');
    setTimeout(() => c.scrollTop = c.scrollHeight, 50);
  },

  escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  },

  /** 한국어 이름 2자(또는 비한글 시 이니셜) — 서버 greetingName 기준 */
  computeUserAvatarShortLabel(greetingName) {
    const raw = (greetingName || '').trim();
    const isHangul = (ch) => {
      const cp = ch.codePointAt(0);
      return cp >= 0xac00 && cp <= 0xd7a3;
    };
    const hangul = [];
    for (const ch of raw) {
      if (isHangul(ch)) hangul.push(ch);
    }
    if (hangul.length >= 2) return hangul.slice(-2).join('');
    if (hangul.length === 1) return `${hangul[0]}·`;
    const ascii = raw.replace(/[^a-zA-Z0-9]/g, '');
    if (ascii.length >= 2) return ascii.slice(0, 2).toUpperCase();
    if (ascii.length === 1) return `${ascii[0].toUpperCase()}·`;
    return '유';
  },

  newSession() {
    const readRadio = document.querySelector('input[name="chat-write-task"][value="none"]');
    if (readRadio) readRadio.checked = true;
    this.onWriteTaskChanged();
    this.pendingToolCalls = null;
    this.flashPendingBlock('');
    this.pendingAttachments = [];
    this.renderPendingAttachments();
    this.currentConvId = null;
    this.conversationMessages = [];
    document.getElementById('messages').innerHTML = '';
    document.getElementById('welcome-screen').style.display = '';
    this.renderWelcomeGreeting();
    this.renderConversations();
  },

  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
  },

  createConversation(firstMessage) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const title = firstMessage.length > 40 ? firstMessage.slice(0, 40) + '…' : firstMessage;
    const conv = { id, title, time: Date.now(), messages: [] };
    this.conversations.unshift(conv);
    this.currentConvId = id;
    if (this.conversations.length > 50) this.conversations.pop();
    this.renderConversations();
  },

  saveCurrentConversation() {
    if (!this.currentConvId) return;
    const conv = this.conversations.find(c => c.id === this.currentConvId);
    if (conv) {
      conv.messages = [...this.conversationMessages];
      conv.time = Date.now();
    }
    localStorage.setItem('cc-conversations', JSON.stringify(this.conversations));
  },

  loadConversation(id) {
    const conv = this.conversations.find(c => c.id === id);
    if (!conv) return;
    this.pendingToolCalls = null;
    this.flashPendingBlock('');
    this.currentConvId = id;
    this.conversationMessages = [...conv.messages];
    document.getElementById('messages').innerHTML = '';
    this.hideWelcome();
    for (const m of conv.messages) {
      if (m.role === 'user') {
        this.addMessage('user', this.userMessageDisplay(m));
      } else if (m.role === 'assistant') {
        this.addMessage(m.role, typeof m.content === 'string' ? m.content : '');
      }
    }
    this.renderConversations();
  },

  deleteConversation(id, e) {
    e.stopPropagation();
    this.conversations = this.conversations.filter(c => c.id !== id);
    localStorage.setItem('cc-conversations', JSON.stringify(this.conversations));
    if (this.currentConvId === id) this.newSession();
    else this.renderConversations();
  },

  loadConversations() {
    try {
      this.conversations = JSON.parse(localStorage.getItem('cc-conversations') || '[]');
    } catch { this.conversations = []; }
    this.renderConversations();
  },

  renderConversations() {
    const list = document.getElementById('history-list');
    if (!list) return;

    const now = Date.now();
    const dayMs = 86400000;
    const today = [], yesterday = [], week = [], older = [];

    for (const c of this.conversations) {
      const age = now - c.time;
      if (age < dayMs) today.push(c);
      else if (age < dayMs * 2) yesterday.push(c);
      else if (age < dayMs * 7) week.push(c);
      else older.push(c);
    }

    let html = '';
    const renderGroup = (label, items) => {
      if (!items.length) return '';
      let out = `<div class="history-group-label">${label}</div>`;
      for (const c of items) {
        const active = c.id === this.currentConvId ? ' active' : '';
        out += `<button class="history-item${active}" onclick="app.loadConversation('${c.id}')" title="${this.escapeHtml(c.title)}">
          <span class="history-item-title">${this.escapeHtml(c.title)}</span>
          <span class="history-item-delete" onclick="app.deleteConversation('${c.id}', event)" title="삭제">&times;</span>
        </button>`;
      }
      return out;
    };

    html += renderGroup('오늘', today);
    html += renderGroup('어제', yesterday);
    html += renderGroup('이번 주', week);
    html += renderGroup('이전', older);

    list.innerHTML = html || '<div class="history-empty">대화 기록이 없습니다</div>';
  },

  // ===== Settings =====

  async openSettings() {
    document.getElementById('settings-modal').classList.add('open');
    document.getElementById('settings-status').textContent = '';
    const search = document.getElementById('space-picker-search');
    if (search) search.value = '';
    await this.renderSpacePicker();
    await this.refreshSettingsModels(false);
  },

  closeSettings() {
    document.getElementById('settings-modal').classList.remove('open');
  },

  filterSpacePicker() {
    const q = (document.getElementById('space-picker-search')?.value || '').trim().toLowerCase();
    document.querySelectorAll('.space-picker-item').forEach((row) => {
      const t = row.dataset.filterText || '';
      row.classList.toggle('hidden', Boolean(q && !t.includes(q)));
    });
  },

  spacePickerSelectAll() {
    document.querySelectorAll('#space-picker-list .space-picker-cb').forEach((cb) => {
      cb.checked = true;
    });
  },

  spacePickerSelectNone() {
    document.querySelectorAll('#space-picker-list .space-picker-cb').forEach((cb) => {
      cb.checked = false;
    });
  },

  saveSpacePickerSelection() {
    const inc = document.getElementById('include-personal-spaces');
    if (inc) {
      localStorage.setItem('cc-include-personal-spaces', inc.checked ? '1' : '0');
    }
    const defSel = document.getElementById('default-space-select');
    if (defSel) {
      let v = defSel.value.trim();
      if (this.allSpacesCatalog.length) {
        const allowed = this.buildChatVisibleSpaceList(this.allSpacesCatalog);
        if (v && !allowed.some((x) => x.key === v)) v = '';
      }
      if (!v) localStorage.removeItem('cc-default-space-key');
      else localStorage.setItem('cc-default-space-key', v);
    }
    const boxes = document.querySelectorAll('#space-picker-list .space-picker-cb');
    const total = boxes.length;
    const keys = [];
    boxes.forEach((cb) => {
      if (cb.checked) keys.push(cb.value);
    });
    if (total === 0) return;
    if (keys.length === total || keys.length === 0) {
      localStorage.removeItem('cc-visible-space-keys');
    } else {
      localStorage.setItem('cc-visible-space-keys', JSON.stringify(keys));
    }
  },

  async renderSpacePicker() {
    const listEl = document.getElementById('space-picker-list');
    const statusEl = document.getElementById('space-picker-status');
    if (!listEl || !statusEl) return;
    statusEl.textContent = '스페이스 목록을 불러오는 중...';
    statusEl.className = 'space-picker-status';
    listEl.innerHTML = '';
    try {
      const res = await apiFetch('/api/spaces');
      const data = await res.json();
      if (data.error) {
        statusEl.textContent = `오류: ${data.error}`;
        statusEl.className = 'space-picker-status error';
        return;
      }
      const spaces = data.spaces || [];
      this.allSpacesCatalog = spaces;
      const globalSpaces = spaces.filter((s) => !this.isPersonalSpace(s));
      const nPersonal = spaces.length - globalSpaces.length;

      const incEl = document.getElementById('include-personal-spaces');
      const incCountEl = document.getElementById('include-personal-spaces-count');
      if (incEl) {
        incEl.checked = this.getIncludePersonalSpaces();
        if (!incEl.dataset.boundDefaultSync) {
          incEl.dataset.boundDefaultSync = '1';
          incEl.addEventListener('change', () => {
            if (this.allSpacesCatalog.length) this.populateDefaultSpaceSelect(this.allSpacesCatalog);
          });
        }
      }
      if (incCountEl) {
        incCountEl.textContent = nPersonal > 0 ? `· ${nPersonal}개` : '';
      }

      this.populateDefaultSpaceSelect(spaces);

      const visibleSet = this.getVisibleSpaceKeysSet();
      statusEl.textContent =
        nPersonal > 0
          ? `글로벌 ${globalSpaces.length}개는 아래 목록에서 선택 · 위 체크로 개인 ${nPersonal}개 일괄 포함`
          : `글로벌 ${globalSpaces.length}개는 아래 목록에서 선택`;
      const frag = document.createDocumentFragment();
      for (const s of globalSpaces) {
        const row = document.createElement('label');
        row.className = 'space-picker-item';
        row.dataset.filterText = `${s.name} ${s.key}`.toLowerCase();
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'space-picker-cb';
        cb.value = s.key;
        cb.checked = visibleSet === null || visibleSet.has(s.key);
        const meta = document.createElement('span');
        meta.className = 'space-picker-meta';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'space-picker-name';
        nameSpan.textContent = s.name || s.key;
        const keySpan = document.createElement('span');
        keySpan.className = 'space-picker-key';
        keySpan.textContent = s.key;
        meta.appendChild(nameSpan);
        meta.appendChild(keySpan);
        row.appendChild(cb);
        row.appendChild(meta);
        frag.appendChild(row);
      }
      listEl.appendChild(frag);
      const search = document.getElementById('space-picker-search');
      if (search && !search.dataset.bound) {
        search.dataset.bound = '1';
        search.addEventListener('input', () => this.filterSpacePicker());
      }
      this.filterSpacePicker();
    } catch (e) {
      statusEl.textContent = `네트워크 오류: ${e.message}`;
      statusEl.className = 'space-picker-status error';
    }
  },

  async saveConfig() {
    const status = document.getElementById('settings-status');
    const msel = document.getElementById('settings-default-model-select');
    const defaultModel = msel && msel.value ? msel.value.trim() : '';

    try {
      this.saveSpacePickerSelection();
      await this.loadSpaces();

      const body = {};
      if (defaultModel) body.model = defaultModel;

      if (Object.keys(body).length > 0) {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.success) {
          status.textContent = data.error || '설정 저장에 실패했습니다.';
          status.className = 'settings-status error';
          return;
        }
        const { success: _s, ...cfg } = data;
        this.currentConfig = { ...this.currentConfig, ...cfg };
      }

      await this.loadChatModels();

      this.updateModelBadge();
      this.checkStatus();

      status.textContent = '저장했습니다.';
      status.className = 'settings-status success';
      setTimeout(() => this.closeSettings(), 900);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status error';
    }
  },
};

document.addEventListener('DOMContentLoaded', () => app.init());
