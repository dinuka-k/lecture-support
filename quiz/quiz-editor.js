/* Question editor for the admin: add, edit, reorder, import and export questions. */
(function (global) {
  'use strict';

  const TYPES = { mcq: 'Multiple choice', tf: 'True or false', sql: 'Write a query' };

  let modal, list, form, qs = [], sel = 0, onSave = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function blank(type) {
    if (type === 'sql') return { type, topic: '', limit: 60, text: '', model: '', answers: [] };
    if (type === 'tf') return { type, topic: '', limit: 20, text: '', correct: 0 };
    return { type: 'mcq', topic: '', limit: 25, text: '', options: ['', '', '', ''], correct: 0 };
  }

  function save() { onSave(cleaned()); }

  function renderList() {
    list.innerHTML = qs.map((q, i) =>
      '<li class="ed-item' + (i === sel ? ' on' : '') + '" data-i="' + i + '">' +
        '<span class="ed-n">' + (i + 1) + '</span>' +
        '<span class="ed-t">' + (esc(q.text) || '<i>(empty question)</i>') + '<small>' + TYPES[q.type] + (q.topic ? ' · ' + esc(q.topic) : '') + '</small></span>' +
      '</li>').join('');
    modal.querySelector('#edCount').textContent = qs.length + (qs.length === 1 ? ' question' : ' questions');
    const on = list.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function renderForm() {
    const q = qs[sel];
    if (!q) { form.innerHTML = '<p class="muted">No questions. Press <b>Add</b> to write one.</p>'; return; }
    let specific = '';
    if (q.type === 'mcq') {
      const opts = q.options || [];
      specific = '<div class="ed-field"><span>Options <small>pick the correct one; leave a box empty for fewer than 4</small></span>' +
        [0, 1, 2, 3].map((i) =>
          '<label class="ed-opt opt-' + i + '"><input type="radio" name="edCorrect" value="' + i + '"' + (q.correct === i ? ' checked' : '') + '>' +
          '<input class="input" data-opt="' + i + '" value="' + esc(opts[i] || '') + '" placeholder="Option ' + (i + 1) + '"></label>').join('') + '</div>';
    } else if (q.type === 'tf') {
      specific = '<div class="ed-field"><span>Correct answer</span><div class="seg" id="edTf">' +
        '<button data-v="0" class="' + (q.correct === 0 ? 'on' : '') + '">True</button><button data-v="1" class="' + (q.correct === 1 ? 'on' : '') + '">False</button></div></div>';
    } else {
      specific =
        '<label class="ed-field"><span>Model answer <small>shown to everyone on the reveal</small></span>' +
          '<textarea class="input mono" data-k="model" rows="3" spellcheck="false">' + esc(q.model) + '</textarea></label>' +
        '<label class="ed-field"><span>Accepted answers <small>one per line; case, spacing, a plural s, AS, ASC, INNER and the final ; are ignored; {x} matches any alias. Empty = the model answer only. You can also accept answers by hand during the reveal.</small></span>' +
          '<textarea class="input mono" data-k="answers" rows="5" spellcheck="false">' + esc((q.answers || []).join('\n')) + '</textarea></label>';
    }
    form.innerHTML =
      '<div class="ed-row">' +
        '<label class="ed-field"><span>Type</span><select class="input" data-k="type">' +
          Object.keys(TYPES).map((t) => '<option value="' + t + '"' + (q.type === t ? ' selected' : '') + '>' + TYPES[t] + '</option>').join('') + '</select></label>' +
        '<label class="ed-field"><span>Topic</span><input class="input" data-k="topic" value="' + esc(q.topic) + '" placeholder="e.g. Joins"></label>' +
        '<label class="ed-field ed-small"><span>Seconds</span><input class="input" type="number" min="5" max="600" data-k="limit" value="' + q.limit + '"></label>' +
      '</div>' +
      '<label class="ed-field"><span>Question</span><textarea class="input" data-k="text" rows="2">' + esc(q.text) + '</textarea></label>' +
      '<label class="ed-field"><span>Code or table <small>optional, shown in a monospace box</small></span><textarea class="input mono" data-k="code" rows="3" spellcheck="false">' + esc(q.code) + '</textarea></label>' +
      specific;
  }

  function onInput(e) {
    const q = qs[sel];
    const t = e.target;
    if (!q) return;
    if (t.dataset.k === 'type') {
      const nq = blank(t.value);
      nq.text = q.text; nq.topic = q.topic; nq.code = q.code;
      qs[sel] = nq;
      renderForm();
    } else if (t.dataset.k === 'limit') {
      q.limit = Math.max(5, Math.min(600, parseInt(t.value, 10) || 20));
    } else if (t.dataset.k === 'answers') {
      q.answers = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
    } else if (t.dataset.k) {
      q[t.dataset.k] = t.value;
    } else if (t.dataset.opt != null) {
      q.options = q.options || ['', '', '', ''];
      q.options[+t.dataset.opt] = t.value;
    } else if (t.name === 'edCorrect') {
      q.correct = +t.value;
    }
    renderList();
    save();
  }

  // Empty option boxes are dropped from the saved question; the correct index follows.
  function cleaned() {
    return qs.map((q) => {
      if (q.type !== 'mcq') return q;
      const keep = [];
      let correct = 0;
      (q.options || []).forEach((o, i) => {
        if (String(o).trim()) { if (i === q.correct) correct = keep.length; keep.push(o); }
      });
      return Object.assign({}, q, { options: keep, correct });
    });
  }

  function act(name) {
    if (name === 'add') { qs.splice(sel + 1, 0, blank('mcq')); sel = Math.min(sel + 1, qs.length - 1); }
    else if (name === 'dup' && qs[sel]) { qs.splice(sel + 1, 0, JSON.parse(JSON.stringify(qs[sel]))); sel++; }
    else if (name === 'del' && qs[sel]) {
      if (!confirm('Delete question ' + (sel + 1) + '?')) return;
      qs.splice(sel, 1); sel = Math.max(0, Math.min(sel, qs.length - 1));
    }
    else if (name === 'up' && sel > 0) { qs.splice(sel - 1, 0, qs.splice(sel, 1)[0]); sel--; }
    else if (name === 'down' && sel < qs.length - 1) { qs.splice(sel + 1, 0, qs.splice(sel, 1)[0]); sel++; }
    else if (name === 'reset') {
      if (!confirm('Replace all questions with the 20 built-in DBMS questions?')) return;
      qs = global.QuizHost.resetQuestions(); sel = 0;
    }
    else if (name === 'export') { exportJson(); return; }
    else if (name === 'import') { modal.querySelector('#edFile').click(); return; }
    else if (name === 'close') { close(); return; }
    else return;
    save();
    renderList();
    renderForm();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(cleaned(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dbms-quiz-questions.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importJson(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!Array.isArray(data) || !data.every((q) => q && TYPES[q.type] && typeof q.text === 'string')) throw new Error('bad');
        data.forEach((q) => { q.limit = Math.max(5, Math.min(600, parseInt(q.limit, 10) || 20)); if (q.correct == null) q.correct = 0; });
        qs = data; sel = 0;
        save(); renderList(); renderForm();
      } catch (e) {
        alert('That file is not a quiz question list.');
      }
    };
    r.readAsText(file);
  }

  function open() {
    modal.hidden = false;
    renderList();
    renderForm();
    modal.querySelector('#edNote').hidden = !global.QuizHost.inGame();
  }

  function close() {
    save();
    modal.hidden = true;
  }

  global.QuizEditor = {
    init(modalEl, getQuestions, saveFn) {
      modal = modalEl;
      list = modal.querySelector('#edList');
      form = modal.querySelector('#edForm');
      onSave = saveFn;
      modal.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ed]');
        if (b) return act(b.dataset.ed);
        const item = e.target.closest('.ed-item');
        if (item) { sel = +item.dataset.i; renderList(); renderForm(); return; }
        const tf = e.target.closest('#edTf button');
        if (tf) { qs[sel].correct = +tf.dataset.v; save(); renderForm(); return; }
        if (e.target === modal) close();
      });
      form.addEventListener('input', onInput);
      modal.querySelector('#edFile').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
      this.open = () => { qs = JSON.parse(JSON.stringify(getQuestions())); sel = Math.min(sel, Math.max(0, qs.length - 1)); open(); };
    },
  };
})(window);
