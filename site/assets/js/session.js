// The session panel on the home page: pick a region, start a desktop, open it,
// end it. All state lives in the Worker (/api/*); this only renders it.
// Other pages just get the signed-in user in the header.
(() => {
  const root = document.getElementById('session');
  const who = document.getElementById('who');

  let pollTimer = null;
  let view = null;        // what is on screen, so a poll doesn't wipe the form
  let chosen = null;      // the region a new session would open, as /api/folders gave it
  let listingRound = 0;   // only the newest folder listing may draw
  let starting = false;   // a Start request is on its way

  const pretty = (path) => path.split('/').join(' / ');
  const planes = (n) => `${n} z-plane${n === 1 ? '' : 's'}`;

  class NoApi extends Error {}

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const ago = (ms) => {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    return `${Math.floor(min / 60)} h ${min % 60} min ago`;
  };

  const size = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

  const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const recallList = (key) => { try { const v = JSON.parse(recall(key)); return Array.isArray(v) ? v : []; } catch { return []; } };

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
      });
    } catch {
      // Access answers an expired sign-in with a cross-origin redirect.
      throw new Error('Could not reach the server. Your sign-in may have expired; reload the page.');
    }
    if (!(res.headers.get('content-type') || '').includes('application/json')) throw new NoApi();
    if (res.status === 401) {
      location.href = '/auth/login';   // signed out, or the sign-in ran out
      throw new Error('Signing you in again…');
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function poll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, ms);
  }

  async function refresh() {
    let state;
    try {
      state = await api('/api/state');
    } catch (err) {
      if (!root) return;
      if (err instanceof NoApi) return renderNoApi();
      renderError(err);
      return poll(15000);
    }

    who.innerHTML = esc(state.user.email) +
      (state.signout ? ` · <a href="${esc(state.signout)}">Sign out</a>` : '');
    if (!root) return;

    const s = state.session;
    if (!s) {
      if (view !== 'form') await renderForm(state.last);
      return;
    }
    renderSession(s);
    poll(s.state === 'ready' ? 30000 : 5000);
  }

  function renderNoApi() {
    view = 'no-api';
    root.innerHTML = `
      <h2>Sessions aren't available here</h2>
      <p class="muted">This copy of the site is served by <code>jekyll serve</code>, which only serves pages.
      To try starting and ending sessions locally, run <code>make dev</code> and open
      <a href="http://localhost:8787/">localhost:8787</a>. That serves the site and the session API together, using a pretend cloud.</p>`;
  }

  function renderError(err) {
    view = 'error';
    root.innerHTML = `<p class="notice bad">${esc(err.message)}</p>
      <div class="actions"><button class="secondary" id="retry">Try again</button></div>`;
    root.querySelector('#retry').onclick = () => { clearTimeout(pollTimer); refresh(); };
  }

  function lastNotice(last) {
    if (!last) return '';
    const region = esc(pretty(last.region));
    if (last.state === 'failed') {
      return `<p class="notice bad">Your last session on ${region} failed: ${esc(last.error || 'unknown error')}</p>`;
    }
    if (!last.ready_at) return `<p class="notice">Your session on ${region} was cancelled before it started.</p>`;
    return `<p class="notice ok">Your session on ${region} ended ${ago(last.ended_at)}. Its masks are saved.</p>`;
  }

  async function renderForm(last) {
    view = 'form';
    chosen = null;
    starting = false;
    root.innerHTML = `
      ${lastNotice(last)}
      <h2>Start a session</h2>
      <div id="folders"></div>
      <fieldset id="stacks-box" hidden>
        <legend>Images to open</legend>
        <div id="stacks"></div>
        <p class="hint">Each opens as a layer of its own. Every z-plane is read whole when you reach it, so more and bigger images load more slowly.</p>
      </fieldset>
      <div id="resume-box" hidden>
        <label for="resume">Masks to start from</label>
        <select id="resume"><option value="">Loading…</option></select>
        <p class="hint">Resuming copies that file's labels into a new masks file with your name on it; the file you pick is never changed.</p>
      </div>
      <p class="notice bad" id="form-error" hidden></p>
      <div class="actions"><button id="start" disabled>Start session</button></div>`;
    root.querySelector('#start').onclick = () =>
      startSession(chosen.region, chosen.pick ? picked() : [], root.querySelector('#resume').value);
    openLevel(0, '', recallList('picks'));
  }

  /**
   * Show the choices at `path` as level `depth`: first the data folder, then
   * on down. The Worker says what each level is and where its choices lead,
   * until a level is a region that opens.
   */
  async function openLevel(depth, path, wanted) {
    const box = root.querySelector('#folders');
    [...box.children].slice(depth).forEach((el) => el.remove());
    chosen = null;
    root.querySelector('#stacks').innerHTML = '';
    root.querySelector('#stacks-box').hidden = true;
    root.querySelector('#resume-box').hidden = true;
    updateStart();

    const round = ++listingRound;
    let step;
    try {
      step = await api(`/api/folders?path=${encodeURIComponent(path)}`);
    } catch (err) {
      if (round === listingRound) showFormError(err.message);
      return;
    }
    if (round !== listingRound) return;   // a newer choice replaced this one
    showFormError('');
    if (step.region) {
      chosen = step;
      remember('picks', JSON.stringify([...box.querySelectorAll('select')].map((s) => s.selectedOptions[0].text)));
      if (step.pick) showStacks(step.stacks);
      updateStart();
      return loadMasks(step.region);
    }

    const level = document.createElement('div');
    const id = `level-${depth}`;
    level.innerHTML = `
      <label for="${id}">${esc(step.label)}</label>
      <select id="${id}"><option value="">Choose…</option>
        ${step.folders.map((f, i) => `<option value="${i}"${f.name === wanted[depth] ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select>`;
    box.append(level);
    const select = level.querySelector('select');
    const next = (keep) => { const f = step.folders[select.value]; if (f) openLevel(depth + 1, f.path, keep); };
    select.onchange = () => next([]);
    next(wanted);   // carry on down to the folder used last time
  }

  /** A region's image stacks to tick, the ones picked last time already ticked (else the first raw one). */
  function showStacks(stacks) {
    const last = recallList('stacks');
    const raw = stacks.find((s) => !s.name.includes('.')) || stacks[0];   // mosaic_DAPI, not mosaic_DAPI.decon
    const on = stacks.some((s) => last.includes(s.name)) ? last : [raw.name];
    root.querySelector('#stacks').innerHTML = stacks.map((s) => `
      <label class="check"><input type="checkbox" value="${esc(s.name)}"${on.includes(s.name) ? ' checked' : ''}>
        <span>${esc(s.name)} <span class="muted">· ${planes(s.planes)} · ${size(s.bytes)}</span></span></label>`).join('');
    const box = root.querySelector('#stacks-box');
    box.hidden = false;
    box.onchange = () => { remember('stacks', JSON.stringify(picked())); updateStart(); };
  }

  const picked = () => [...root.querySelectorAll('#stacks input:checked')].map((i) => i.value);

  function updateStart() {
    root.querySelector('#start').disabled = starting || !chosen || (chosen.pick && !picked().length);
  }

  function showFormError(message) {
    const el = root.querySelector('#form-error');
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  async function loadMasks(regionId) {
    root.querySelector('#resume-box').hidden = false;
    const select = root.querySelector('#resume');
    select.innerHTML = '<option value="">Loading…</option>';
    select.disabled = true;
    try {
      const { masks, username } = await api(`/api/masks?region=${encodeURIComponent(regionId)}`);
      const option = (m) => `<option value="${esc(m.key)}">${esc(m.name)} · saved ${ago(Date.parse(m.saved_at))} · ${size(m.size)}</option>`;
      const mine = masks.filter((m) => m.user === username);
      const others = masks.filter((m) => m.user !== username);
      select.innerHTML = '<option value="">Empty masks (start fresh)</option>' +
        (mine.length ? `<optgroup label="Yours">${mine.map(option).join('')}</optgroup>` : '') +
        (others.length ? `<optgroup label="Everyone else's">${others.map(option).join('')}</optgroup>` : '');
      if (mine.length) select.value = mine[0].key;   // newest of yours
      select.disabled = false;
      showFormError('');
    } catch (err) {
      select.innerHTML = '<option value="">Empty masks (start fresh)</option>';
      select.disabled = false;
      showFormError(`Couldn't list saved masks: ${err.message}`);
    }
  }

  async function startSession(regionId, stacks, resumeKey) {
    const button = root.querySelector('#start');
    starting = true;
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      await api('/api/session', {
        method: 'POST',
        body: JSON.stringify({ region: regionId, stacks, resume_key: resumeKey || null }),
      });
      view = null;
      refresh();   // the session view replaces the button
    } catch (err) {
      button.textContent = 'Start session';
      showFormError(err.message);
      starting = false;
      updateStart();
    }
  }

  async function endSession(button) {
    const ready = button.dataset.state === 'ready';
    if (ready && !confirm('End this session? napari saves your masks, then the desktop shuts down.')) return;
    button.disabled = true;
    try {
      await api('/api/session', { method: 'DELETE' });
      refresh();
    } catch (err) {
      button.disabled = false;
      alert(err.message);
    }
  }

  function renderSession(s) {
    view = `session-${s.state}`;
    const regionLabel = pretty(s.region);
    const from = s.resume_key ? s.resume_key.split('/').pop() : 'empty masks';
    const facts = `
      <dl class="facts">
        <dt>Folder</dt><dd>${esc(regionLabel)}</dd>
        <dt>Masks from</dt><dd>${esc(from)}</dd>
        <dt>Started</dt><dd>${ago(s.created_at)}</dd>
      </dl>`;

    const body = {
      starting: `
        <p class="status"><span class="dot starting"></span>Starting your desktop…</p>
        <p class="muted">This usually takes 2–4 minutes. The page updates by itself.</p>
        ${facts}
        <div class="actions"><button class="secondary" id="end" data-state="starting">Cancel</button></div>`,
      ready: `
        <p class="status"><span class="dot ready"></span>Your desktop is ready</p>
        <p>napari is open on <strong>${esc(regionLabel)}</strong>. Masks save every 5 minutes, and again when you close napari or end the session.</p>
        ${facts}
        <div class="actions">
          <a class="button" href="${esc(s.url)}" target="_blank" rel="noopener">Open desktop</a>
          <button class="secondary" id="end" data-state="ready">End session</button>
        </div>`,
      stopping: `
        <p class="status"><span class="dot stopping"></span>Saving your masks and shutting down…</p>
        <p class="muted">Large regions can take a few minutes to save. You can close this page.</p>
        ${facts}`,
    }[s.state];

    root.innerHTML = body || `<p class="muted">Session is ${esc(s.state)}.</p>`;
    const end = root.querySelector('#end');
    if (end) end.onclick = () => endSession(end);
  }

  refresh();
})();
