/* Groundcheck UI: renders the audit from data.js. No backend, no network. */
(function () {
  'use strict';
  var GC = window.Groundcheck;
  var MEETINGS = GC.MEETINGS;

  var state = { meetingId: 'm1', filter: 'all', openClaims: {}, pane: 'claims' };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function scrollBehavior() { return reduceMotion ? 'auto' : 'smooth'; }
  var currentAudit = null;
  var revealTimers = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTs(t) { return GC.formatTs(t); }

  var VERDICT_ORDER = { UNGROUNDED: 0, PARTIAL: 1, GROUNDED: 2 };
  var VERDICT_LABEL = { UNGROUNDED: 'Ungrounded', PARTIAL: 'Partial', GROUNDED: 'Grounded' };

  function getMeeting(id) { return MEETINGS.find(function (m) { return m.id === id; }) || MEETINGS[0]; }

  // ------------------------------------------------------------------- rail
  function renderRail() {
    var html = MEETINGS.map(function (m) {
      var a = GC.auditMeeting(m);
      var flags = [];
      if (a.counts.ungrounded) flags.push('<span><i class="flag-dot red"></i>' + a.counts.ungrounded + ' ungrounded</span>');
      if (a.counts.partial) flags.push('<span><i class="flag-dot amber"></i>' + a.counts.partial + ' partial</span>');
      if (a.missed.length) flags.push('<span><i class="flag-dot red"></i>' + a.missed.length + ' missed</span>');
      if (!flags.length) flags.push('<span><i class="flag-dot green"></i>clean</span>');
      return '<button class="meeting-card' + (m.id === state.meetingId ? ' active' : '') +
        '" data-meeting="' + m.id + '" role="option" aria-selected="' + (m.id === state.meetingId) + '" type="button">' +
        '<div class="meeting-card-kind">' + esc(m.kind) + ' &middot; ' + esc(m.date) + '</div>' +
        '<div class="meeting-card-title">' + esc(m.title) + '</div>' +
        '<div class="meeting-card-meta"><span>' + esc(m.duration) + ' &middot; ' + m.transcript.length + ' lines</span>' +
        '<span class="meeting-card-score">' + a.counts.grounded + '/' + a.totalClaims + ' grounded</span></div>' +
        '<div class="meeting-card-flags">' + flags.join('') + '</div>' +
        '</button>';
    }).join('');
    $('meetingList').innerHTML = html;
    $('meetingList').querySelectorAll('[data-meeting]').forEach(function (el) {
      el.addEventListener('click', function () { selectMeeting(el.getAttribute('data-meeting'), true); });
    });
  }

  // ------------------------------------------------------------ meeting head
  function renderHead(meeting) {
    $('meetingHead').innerHTML =
      '<div class="meeting-kindline">' + esc(meeting.kind) + ' &middot; ' + esc(meeting.date) + ' &middot; ' + esc(meeting.duration) + '<span class="kind-source"> &middot; ' + esc(meeting.source) + '</span></div>' +
      '<h1 class="meeting-title">' + esc(meeting.title) + '</h1>' +
      '<p class="meeting-sub"><strong>Attendees:</strong> <span class="attendees-full">' + meeting.attendees.map(function (a) { return '<span class="attendee">' + esc(a) + '</span>'; }).join(' &middot; ') + '</span><span class="attendees-short">' + meeting.attendees.map(function (a) { return esc(a.split(' ')[0]); }).join(', ') + '</span></p>' +
      (meeting.source === 'Desktop recording'
        ? '<span class="source-note">Desktop recording: speaker names come from voice signatures, not a bot join. Check names before forwarding an attributed quote.</span>'
        : '');
  }

  // ------------------------------------------------------------ score strip
  function renderScore(audit, animate) {
    var pct = Math.round(audit.groundedShare * 100);
    $('scoreStrip').innerHTML =
      '<div class="score-main">' +
        '<div class="score-num"><span id="scoreNum">0</span><span class="score-total">/' + audit.totalClaims + '</span></div>' +
        '<div class="score-label"><strong>' + pct + '% grounded</strong><span class="score-label-long"> &middot; claims checked against the transcript</span></div>' +
      '</div>' +
      '<div class="score-counts">' +
        '<div class="score-count"><div class="score-count-n g">' + audit.counts.grounded + '</div><div class="score-count-l">Grounded</div></div>' +
        '<div class="score-count"><div class="score-count-n p">' + audit.counts.partial + '</div><div class="score-count-l">Partial</div><div class="score-count-s">field disagrees</div></div>' +
        '<div class="score-count"><div class="score-count-n u">' + audit.counts.ungrounded + '</div><div class="score-count-l">Ungrounded</div></div>' +
        '<div class="score-count"><div class="score-count-n m">' + audit.missed.length + '</div><div class="score-count-l">Missed</div><div class="score-count-s">' + audit.commitmentsCaptured + '/' + audit.commitmentsTotal + ' captured</div></div>' +
      '</div>';
    var target = audit.counts.grounded;
    var el = $('scoreNum');
    el.textContent = target;
  }

  // ---------------------------------------------------------------- filters
  function renderFilters(audit) {
    var defs = [
      ['all', 'All', audit.totalClaims],
      ['UNGROUNDED', 'Ungrounded', audit.counts.ungrounded],
      ['PARTIAL', 'Partial', audit.counts.partial],
      ['GROUNDED', 'Grounded', audit.counts.grounded]
    ];
    $('filterRow').innerHTML = defs.map(function (d) {
      return '<button class="filter-btn' + (state.filter === d[0] ? ' active' : '') +
        '" data-filter="' + d[0] + '" type="button">' + d[1] + ' <span class="n">' + d[2] + '</span></button>';
    }).join('');
    $('filterRow').querySelectorAll('[data-filter]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.filter = el.getAttribute('data-filter');
        renderClaims(currentAudit, false);
        renderMissed(currentAudit);
        renderFilters(currentAudit);
      });
    });
  }

  // ------------------------------------------------------------------ claims
  function claimMeta(r) {
    var parts = ['<span class="mono">' + r.type.toUpperCase() + '</span>'];
    if (r.owner) parts.push('Owner: ' + esc(r.owner));
    if (r.due) parts.push('Due: ' + esc(r.due));
    if (r.type === 'quote' && r.speaker) parts.push('Attributed to ' + esc(r.speaker));
    return parts.join('<span aria-hidden="true">&middot;</span>');
  }

  function evidenceHtml(r) {
    if (!r.evidence) {
      var floorPct = Math.round(GC.THRESHOLDS.partialMin * 100);
      var closest = r.closest
        ? '<p class="closest-line">Closest line found (' + Math.round(r.closest.score * 100) + '% of key terms): &ldquo;' + esc(r.closest.text) + '&rdquo; &middot; ' + esc(r.closest.speaker) + ', <span class="mono">' + fmtTs(r.closest.t) + '</span> &middot; line ' + esc(r.closest.lineId) + '</p>'
        : '';
      return '<div class="claim-evidence"><div class="evidence-box">' +
        '<p class="no-evidence">No transcript line supports this claim.</p>' +
        '<p class="evidence-rule"><span class="mono">Rule ' + esc(r.rule) + '</span> &middot; best match below the ' + floorPct + '% floor.</p>' +
        '<ul class="evidence-reasons"><li>' + r.reasons.map(esc).join('</li><li>') + '</li></ul>' +
        closest +
        '</div></div>';
    }
    var reasons = r.reasons.map(function (reason, i) {
      var cls = (i > 0 || r.rule === 'P-2') ? ' class="mismatch"' : '';
      return '<li' + cls + '>' + esc(reason) + '</li>';
    }).join('');
    return '<div class="claim-evidence"><div class="evidence-box">' +
      '<p class="evidence-quote">' + esc(r.evidence.text) + '</p>' +
      '<p class="evidence-cite">' + esc(r.evidence.speaker) + ' &middot; <span class="mono">' + fmtTs(r.evidence.t) + '</span> &middot; line ' + esc(r.evidence.lineId) + '</p>' +
      '<p class="evidence-rule"><span class="mono">Rule ' + r.rule + '</span> &middot; content match ' + Math.round(r.score * 100) + '% of key terms</p>' +
      '<ul class="evidence-reasons">' + reasons + '</ul>' +
      '<button class="jump-btn" data-jump="' + r.evidence.lineId + '" type="button">Jump to transcript line &rarr;</button>' +
      '</div></div>';
  }

  function renderClaims(audit, animate) {
    var sec = $('missedSection');
    if (sec && $('claimsList').contains(sec)) $('claimsPane').appendChild(sec);
    var list = audit.claims.slice().sort(function (a, b) {
      return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    });
    if (state.filter !== 'all') list = list.filter(function (r) { return r.verdict === state.filter; });
    $('claimsTabCount').textContent = audit.totalClaims;
    if (!list.length) {
      $('claimsList').innerHTML = '<div class="empty-note">No ' + VERDICT_LABEL[state.filter].toLowerCase() + ' claims in this meeting.</div>';
      return;
    }
    var rowHtml = function (r) {
      var flagHtml = r.flags.map(function (f) {
        return '<span class="attrib-flag"><strong>' + f.code + ' &middot; ' + esc(f.label) + '.</strong> ' + esc(f.text) + '</span>';
      }).join('');
      var textHtml = r.type === 'quote'
        ? '<span class="q">&ldquo;' + esc(r.text) + '&rdquo;</span>'
        : esc(r.text);
      return '<div class="claim-row" data-claim="' + r.id + '" data-verdict="' + r.verdict + '">' +
        '<div class="claim-head" role="button" tabindex="0" aria-expanded="false">' +
          '<span class="chip ' + r.verdict.toLowerCase() + '">' + r.verdict + '</span>' +
          '<div class="claim-body">' +
            '<div class="claim-text">' + textHtml + '</div>' +
            '<div class="claim-meta">' + claimMeta(r) + '</div>' +
            flagHtml +
          '</div>' +
          '<div class="claim-right"><span class="claim-score">' + (r.evidence ? Math.round(r.score * 100) + '% match' : 'no match') + '</span>' +
          '<span class="claim-chev" aria-hidden="true">&#9662;</span></div>' +
        '</div>' +
        evidenceHtml(r) +
      '</div>';
    };
    if (state.filter === 'all') {
      var flaggedRows = list.filter(function (r) { return r.verdict !== 'GROUNDED'; }).map(rowHtml).join('');
      var groundedRows = list.filter(function (r) { return r.verdict === 'GROUNDED'; }).map(rowHtml).join('');
      $('claimsList').innerHTML = flaggedRows + '<div id="missedSlot"></div>' + groundedRows;
    } else {
      $('claimsList').innerHTML = list.map(rowHtml).join('');
    }

    var rows = $('claimsList').querySelectorAll('.claim-row');
    rows.forEach(function (row, i) {
      var head = row.querySelector('.claim-head');
      var claimId = row.getAttribute('data-claim');
      if (state.openClaims[claimId]) {
        row.classList.add('open');
        head.setAttribute('aria-expanded', 'true');
      }
      var toggle = function () {
        var open = row.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) state.openClaims[claimId] = true; else delete state.openClaims[claimId];
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      row.querySelectorAll('[data-jump]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          jumpToLine(btn.getAttribute('data-jump'));
        });
      });
      if (animate) {
        revealTimers.push(setTimeout(function () { row.classList.add('in'); }, Math.min(i * 28, 300)));
      } else {
        row.classList.add('in');
      }
    });

    // Worst-first: the first flagged claim opens itself so the evidence is
    // visible without a click on first load. The timer re-queries the live
    // row by claim id, so a filter re-render inside the 200ms window cannot
    // strand the auto-open on a detached node.
    if (animate) {
      var firstFlagged = $('claimsList').querySelector('.claim-row[data-verdict="UNGROUNDED"], .claim-row[data-verdict="PARTIAL"]');
      if (firstFlagged) {
        var firstId = firstFlagged.getAttribute('data-claim');
        revealTimers.push(setTimeout(function () {
          state.openClaims[firstId] = true;
          var live = $('claimsList').querySelector('[data-claim="' + firstId + '"]');
          if (live) {
            live.classList.add('open');
            var head = live.querySelector('.claim-head');
            if (head) head.setAttribute('aria-expanded', 'true');
          }
        }, 200));
      }
    }
  }

  // ------------------------------------------------------------------ missed
  function placeMissed() {
    var sec = $('missedSection');
    var slot = $('missedSlot');
    if (state.filter === 'all' && slot) {
      slot.appendChild(sec);
    } else {
      var pane = $('claimsPane');
      if (sec.parentNode !== pane) pane.appendChild(sec);
    }
  }

  function renderMissed(audit) {
    if (!audit.missed.length) {
      $('missedSection').innerHTML =
        '<h2 class="missed-h">Missed commitments</h2>' +
        '<p class="missed-none">None. Every commitment in the transcript has a matching action item in the notes.</p>';
      placeMissed();
      return;
    }
    $('missedSection').innerHTML =
      '<h2 class="missed-h">Missed commitments</h2>' +
      '<p class="missed-sub">Commitments spoken in the meeting that never made it into the notes. Recall check, rule R-1: lines matching &ldquo;I&rsquo;ll&hellip;&rdquo;, &ldquo;we&rsquo;ll&hellip;&rdquo;, &ldquo;let&rsquo;s&hellip;&rdquo; with no covering claim.</p>' +
      '<div class="missed-list">' + audit.missed.map(function (m) {
        return '<div class="missed-row" data-missed="' + m.lineId + '">' +
          '<span class="chip missed">MISSED</span>' +
          '<div class="missed-body">' +
            '<p class="missed-quote">' + esc(m.text) + '</p>' +
            '<p class="missed-meta">' + esc(m.speaker) + ' &middot; <span class="mono">' + fmtTs(m.t) + '</span> &middot; line ' + esc(m.lineId) + ' &middot; no matching action item in the notes</p>' +
            '<button class="jump-btn" data-jump="' + m.lineId + '" type="button">Jump to transcript line &rarr;</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    $('missedSection').querySelectorAll('[data-jump]').forEach(function (btn) {
      btn.addEventListener('click', function () { jumpToLine(btn.getAttribute('data-jump')); });
    });
    placeMissed();
  }

  // -------------------------------------------------------------- transcript
  function renderTranscript(meeting, audit) {
    // Worst verdict citing each line: missed > partial > grounded.
    // Every citing claim id is named in the mark, so a line cited by two
    // claims does not hide the second one.
    var lineClass = {}, lineClaims = {}, lineVerdict = {};
    audit.claims.forEach(function (r) {
      if (!r.evidence) return;
      var id = r.evidence.lineId;
      var cls = r.verdict === 'PARTIAL' ? 'cited-partial' : r.verdict === 'GROUNDED' ? 'cited-grounded' : 'cited-missed';
      var rank = { 'cited-grounded': 1, 'cited-partial': 2, 'cited-missed': 3 };
      if (!lineClass[id] || rank[cls] > rank[lineClass[id]]) {
        lineClass[id] = cls;
        lineVerdict[id] = r.verdict;
      }
      if (!lineClaims[id]) lineClaims[id] = [];
      lineClaims[id].push(r.id.toUpperCase());
    });
    var lineMark = {};
    Object.keys(lineClaims).forEach(function (id) {
      lineMark[id] = lineClaims[id].join(', ') + ' &middot; ' + lineVerdict[id];
    });
    audit.missed.forEach(function (m) {
      lineClass[m.lineId] = 'cited-missed';
      lineMark[m.lineId] = 'MISSED COMMITMENT';
    });
    $('transcriptMeta').textContent = meeting.transcript.length + ' lines · ' + meeting.duration;
    $('transcriptNote').textContent = meeting.sourceNote || '';
    $('transcriptLines').innerHTML = meeting.transcript.map(function (ln) {
      var cited = !!lineClass[ln.id];
      var cls = cited ? ' ' + lineClass[ln.id] : '';
      var mark = lineMark[ln.id] ? '<span class="tline-mark">' + lineMark[ln.id] + '</span>' : '';
      // Only cited lines act as buttons. Uncited lines carry no role, no
      // title, and no pointer affordance, so nothing promises a no-op.
      var attrs = cited ? ' role="button" tabindex="0" title="Show the claims citing this line"' : '';
      return '<div class="tline' + cls + '" data-line="' + ln.id + '"' + attrs + '>' +
        '<span class="tline-ts">' + fmtTs(ln.t) + '</span>' +
        '<div class="tline-body"><span class="tline-speaker">' + esc(ln.speaker) + '</span>' + mark +
        '<div class="tline-text">' + esc(ln.text) + '</div></div>' +
      '</div>';
    }).join('');
    $('transcriptLines').querySelectorAll('.tline[role="button"]').forEach(function (el) {
      var show = function () { showClaimsForLine(el.getAttribute('data-line')); };
      el.addEventListener('click', show);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
      });
    });
  }

  // ------------------------------------------------------------- navigation
  function setPane(pane) {
    state.pane = pane;
    document.body.classList.toggle('show-transcript', pane === 'transcript');
    document.querySelectorAll('.pane-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-pane') === pane);
    });
  }

  function jumpToLine(lineId) {
    setPane('transcript');
    var el = document.querySelector('[data-line="' + lineId + '"]');
    if (!el) return;
    // Defer so the mobile tab switch has laid out first.
    setTimeout(function () {
      el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }, 60);
  }

  function showClaimsForLine(lineId) {
    var citing = currentAudit.claims.filter(function (r) {
      return r.evidence && r.evidence.lineId === lineId;
    });
    var missedHere = currentAudit.missed.some(function (m) { return m.lineId === lineId; });
    if (!citing.length && !missedHere) return;
    setPane('claims');
    // A filter could hide the citing claims; reset to All first.
    if (state.filter !== 'all' && citing.some(function (r) { return r.verdict !== state.filter; })) {
      state.filter = 'all';
      renderClaims(currentAudit, false);
      renderMissed(currentAudit);
      renderFilters(currentAudit);
    }
    setTimeout(function () {
      var first = null;
      citing.forEach(function (r) {
        var row = document.querySelector('[data-claim="' + r.id + '"]');
        if (!row) return;
        row.classList.remove('flash');
        void row.offsetWidth;
        row.classList.add('flash');
        if (!first) first = row;
      });
      if (missedHere) {
        var mrow = document.querySelector('[data-missed="' + lineId + '"]');
        if (mrow) {
          mrow.classList.remove('flash');
          void mrow.offsetWidth;
          mrow.classList.add('flash');
          if (!first) first = mrow;
        }
      }
      if (first) first.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    }, 60);
  }

  // ------------------------------------------------------------------ select
  function selectMeeting(id, reveal) {
    // Resolve unknown ids to the fallback meeting before storing anything,
    // so state, the rail, and the URL always agree on a real meeting.
    var meeting = getMeeting(id);
    id = meeting.id;
    state.meetingId = id;
    state.filter = 'all';
    state.openClaims = {};
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
    currentAudit = GC.auditMeeting(meeting);
    renderRail();
    renderHead(meeting);
    renderScore(currentAudit, reveal);
    renderFilters(currentAudit);
    renderClaims(currentAudit, reveal);
    renderMissed(currentAudit);
    renderTranscript(meeting, currentAudit);
    setPane('claims');
    var url = new URL(window.location.href);
    url.searchParams.set('m', id);
    window.history.replaceState(null, '', url.toString());
    var rail = document.querySelector('.transcript-lines');
    if (rail) rail.scrollTop = 0;
    window.scrollTo({ top: 0 });
  }

  // -------------------------------------------------------------------- boot
  document.querySelectorAll('.pane-tab').forEach(function (t) {
    t.addEventListener('click', function () { setPane(t.getAttribute('data-pane')); });
  });
  $('runBtn').addEventListener('click', function () { selectMeeting(state.meetingId, true); });
  $('exportBtn').addEventListener('click', function () {
    var meeting = getMeeting(state.meetingId);
    var report = GC.buildReport(meeting);
    var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'groundcheck-' + meeting.id + '-audit.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName || '')) return;
    var i = MEETINGS.findIndex(function (m) { return m.id === state.meetingId; });
    var next = e.key === 'ArrowRight'
      ? MEETINGS[(i + 1) % MEETINGS.length]
      : MEETINGS[(i - 1 + MEETINGS.length) % MEETINGS.length];
    selectMeeting(next.id, true);
    // The re-render destroys the previously focused element. Land focus on
    // the newly active meeting card so keyboard users keep their place.
    var card = document.querySelector('.meeting-card.active');
    if (card) card.focus();
  });

  var params = new URLSearchParams(window.location.search);
  var initial = params.get('m');
  var initialValid = initial && MEETINGS.some(function (m) { return m.id === initial; });
  selectMeeting(initialValid ? initial : 'm1', true);
})();
