/* Groundcheck: notes-grounding auditor for Circleback meetings.
 *
 * Runs in the browser (window.Groundcheck) and in Node (module.exports) so
 * the same code that renders the demo is what the test harness verifies.
 *
 * What it does: given a meeting transcript plus the notes Circleback
 * generated, it audits every claim deterministically.
 *   - Grounding check (precision): each claim is matched against the
 *     transcript by content-token containment, then its numbers, dates,
 *     owner and (for quotes) speaker are checked against the matched line.
 *     Verdicts: GROUNDED / PARTIAL / UNGROUNDED, with the quoted line cited.
 *   - Recall check: transcript lines matching the commitment lexicon
 *     ("I'll…", "we'll…", "let's…", "I'm going to…", "I can…") that no
 *     claim covers are reported as MISSED commitments.
 *   - Attribution check: quotes whose attributed speaker differs from the
 *     speaker of the matched line (A-1), and quotes attributed to a speaker
 *     with under 10% talk share (A-2).
 *
 * No LLM anywhere. Lexical + rules-based matching only. Thresholds and the
 * commitment lexicon are stated in the UI next to the results.
 *
 * Sample data: three fictional meetings with planted defects. The meetings
 * are invented; the audit logic is real and runs against them live.
 *
 * Real-data path: fetchFromCircleback(apiKey) below shows the seam:
 * GET https://circleback.ai/api/meetings with a cb_ bearer key, as documented
 * at https://circleback.ai/docs/api. This static demo makes no network calls;
 * the bundled meetings are the no-key fallback.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ thresholds
  var THRESHOLDS = {
    groundMin: 0.55,      // min content-token containment for a GROUNDED candidate
    partialMin: 0.30,     // min containment for any supporting evidence
    recallMin: 0.35,      // min containment for a claim to cover a commitment
    lowTalkShare: 0.10    // attributed speaker under 10% of words = A-2 flag
  };

  var COMMITMENT_LEXICON = [
    "I'll", 'I will', "we'll", 'we will', "let's",
    "I'm going to", "we're going to", 'I can'
  ];

  // ------------------------------------------------------------------ text
  var STOPWORDS = {};
  ('a an and are as at be been by can could did do does for from had has have ' +
   'he her his i if in is it its just me more my no not of on or our out over ' +
   'she so that the their then there they this to too up us very was we were ' +
   'what when will with would you your am an are be been being did do does ' +
   'doing had has have having is isn t don didn doesn wasn weren hasn haven ' +
   'i\'m i\'ll i\'ve we\'re we\'ll we\'ve you\'re you\'ll let\'s let it\'s ' +
   'that\'s there\'s here\'s how who whom which why when where should shall ' +
   'may might must ought need needs per').split(' ').forEach(function (w) { STOPWORDS[w] = true; });
  // "per" is kept as a stopword except in price phrases; the number check
  // carries price matching, so dropping "per" does not change verdicts.

  function stem(w) {
    if (w.length > 3 && w.slice(-2) === "'s") w = w.slice(0, -2);
    if (w.length > 3 && w.slice(-1) === 's' &&
        w.slice(-2) !== 'ss' && w.slice(-2) !== 'us' && w.slice(-2) !== 'is') {
      w = w.slice(0, -1);
    }
    return w;
  }

  function tokenize(text) {
    return (text || '').toLowerCase()
      .replace(/['’]/g, "'")
      .split(/[^a-z0-9$%]+/)
      .map(function (t) { return t.replace(/^\$/, '').replace(/%$/, ''); })
      .filter(function (t) { return t.length > 1 && !STOPWORDS[t]; })
      .map(stem);
  }

  function tokenSet(text) {
    var s = {};
    tokenize(text).forEach(function (t) { s[t] = true; });
    return s;
  }

  // Containment of the claim's content tokens in the line's tokens.
  function containment(claimTokens, lineSet) {
    if (!claimTokens.length) return 0;
    var hit = 0;
    claimTokens.forEach(function (t) { if (lineSet[t]) hit++; });
    return hit / claimTokens.length;
  }

  // ------------------------------------------------------- structured fields
  var MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  var WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  // Numbers: money normalized to dollars ($12K -> 12000, $4.2M -> 4200000),
  // plain numbers as floats. Money spans are removed before plain extraction
  // so "$4.2M" is counted once.
  function extractNumbers(text) {
    var out = [];
    var s = text || '';
    var moneyRe = /\$\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/g;
    var m;
    while ((m = moneyRe.exec(s)) !== null) {
      var v = parseFloat(m[1].replace(/,/g, ''));
      var unit = (m[2] || '').toLowerCase();
      if (unit === 'k') v *= 1000;
      if (unit === 'm') v *= 1000000;
      out.push({ raw: m[0].trim(), value: v, kind: 'money' });
    }
    var stripped = s.replace(moneyRe, ' ');
    var plainRe = /\b\d+(?:\.\d+)?\b/g;
    while ((m = plainRe.exec(stripped)) !== null) {
      out.push({ raw: m[0], value: parseFloat(m[0]), kind: 'number' });
    }
    return out;
  }

  // Dates as normalized tags: wd:friday, md:december-10, mo:january,
  // rel:tomorrow, rel:next-week, rel:next-year, rel:this-week.
  function extractDates(text) {
    var s = (' ' + (text || '').toLowerCase() + ' ');
    var out = [];
    WEEKDAYS.forEach(function (d) {
      if (new RegExp('\\b' + d + '\\b').test(s)) out.push('wd:' + d);
    });
    Object.keys(MONTHS).forEach(function (mo) {
      var md = s.match(new RegExp('\\b' + mo + '\\s+(\\d{1,2})\\b'));
      if (md) out.push('md:' + mo + '-' + parseInt(md[1], 10));
      else if (new RegExp('\\b' + mo + '\\b').test(s)) out.push('mo:' + mo);
    });
    if (/\btomorrow\b/.test(s)) out.push('rel:tomorrow');
    if (/\btoday\b/.test(s)) out.push('rel:today');
    if (/\bnext week\b/.test(s)) out.push('rel:next-week');
    if (/\bnext year\b/.test(s)) out.push('rel:next-year');
    if (/\bthis week\b/.test(s)) out.push('rel:this-week');
    return out;
  }

  function firstName(full) { return (full || '').split(' ')[0]; }

  // ------------------------------------------------------------ commitments
  var COMMITMENT_RE = /\b(i'?ll|i will|we'?ll|we will|let'?s|i'?m going to|we'?re going to|i can)\b/i;
  function isCommitment(line) { return COMMITMENT_RE.test(line.text); }

  // -------------------------------------------------------------- talk share
  function talkShare(meeting) {
    var words = {}, total = 0;
    meeting.transcript.forEach(function (ln) {
      var n = ln.text.split(/\s+/).filter(Boolean).length;
      words[ln.speaker] = (words[ln.speaker] || 0) + n;
      total += n;
    });
    var out = {};
    Object.keys(words).forEach(function (sp) { out[sp] = total ? words[sp] / total : 0; });
    out._totalWords = total;
    return out;
  }

  // ------------------------------------------------------------- the audit
  function auditClaim(claim, meeting, shares) {
    var claimTokens = tokenize(claim.text);
    var claimNums = extractNumbers(claim.text);
    var claimDates = extractDates(claim.text);

    // Best matching transcript line by containment; ties break by more
    // matched tokens, then earliest line.
    var best = null, bestScore = -1, bestHits = -1;
    meeting.transcript.forEach(function (ln) {
      var set = tokenSet(ln.text);
      var score = containment(claimTokens, set);
      var hits = 0;
      claimTokens.forEach(function (t) { if (set[t]) hits++; });
      if (score > bestScore || (score === bestScore && hits > bestHits)) {
        best = ln; bestScore = score; bestHits = hits;
      }
    });

    var result = {
      id: claim.id, type: claim.type, text: claim.text,
      owner: claim.owner || null, due: claim.due || null,
      speaker: claim.speaker || null,
      score: Math.round(bestScore * 100) / 100,
      evidence: null, closest: null,
      verdict: 'UNGROUNDED', rule: 'U-1', reasons: [], flags: []
    };
    if (best) {
      result.closest = { lineId: best.id, t: best.t, speaker: best.speaker, text: best.text, score: result.score };
    }

    if (bestScore < THRESHOLDS.partialMin) {
      result.reasons.push('No transcript line shares enough content with this claim (best match ' +
        Math.round(bestScore * 100) + '% of its key terms, below the ' +
        Math.round(THRESHOLDS.partialMin * 100) + '% floor).');
      return result;
    }

    result.evidence = { lineId: best.id, t: best.t, speaker: best.speaker, text: best.text };

    // Field checks against the matched line.
    var lineNums = extractNumbers(best.text);
    var lineDates = extractDates(best.text);
    var mismatches = [];

    claimNums.forEach(function (cn) {
      var found = lineNums.some(function (ln2) { return ln2.value === cn.value; });
      if (!found) {
        var lineNum = lineNums.length ? lineNums.map(function (n) { return n.raw; }).join(', ') : 'none';
        mismatches.push({
          kind: 'number',
          text: 'Number mismatch: the notes say ' + cn.raw + ', but the cited line says ' + lineNum + '.'
        });
      }
    });

    if (claimDates.length && lineDates.length) {
      var shared = claimDates.some(function (d) { return lineDates.indexOf(d) !== -1; });
      if (!shared) {
        mismatches.push({
          kind: 'date',
          text: 'Date mismatch: the notes say ' + claimDates.join(', ') +
            ', but the cited line says ' + lineDates.join(', ') + '.'
        });
      }
    }

    if (claim.owner) {
      var ownerFirst = firstName(claim.owner).toLowerCase();
      var lineText = ' ' + best.text.toLowerCase() + ' ';
      var ownerInLine = new RegExp('\\b' + ownerFirst + '\\b').test(lineText);
      var ownerIsSpeaker = firstName(best.speaker).toLowerCase() === ownerFirst;
      if (!ownerInLine && !ownerIsSpeaker) {
        mismatches.push({
          kind: 'owner',
          text: 'Owner mismatch: the notes assign this to ' + claim.owner +
            ', but the cited line is ' + best.speaker + ' saying they will do it.'
        });
      }
    }

    var speakerMismatch = false;
    if (claim.type === 'quote' && claim.speaker) {
      if (firstName(best.speaker) !== firstName(claim.speaker)) {
        speakerMismatch = true;
        mismatches.push({
          kind: 'speaker',
          text: 'Speaker mismatch: the notes attribute this quote to ' + claim.speaker +
            ', but the cited line was spoken by ' + best.speaker + '.'
        });
        result.flags.push({
          code: 'A-1', label: 'Attribution risk',
          text: 'Quote attributed to ' + claim.speaker + '; transcript line is ' +
            best.speaker + '. Check the speaker name before forwarding.'
        });
      }
    }

    // A-2: quote attributed to someone who barely spoke in this meeting.
    if (claim.type === 'quote' && claim.speaker && !speakerMismatch) {
      var share = shares[claim.speaker];
      if (share !== undefined && share < THRESHOLDS.lowTalkShare) {
        result.flags.push({
          code: 'A-2', label: 'Attribution risk',
          text: 'Attributed to ' + claim.speaker + ', who spoke only ' +
            Math.round(share * 100) + '% of this meeting. Verify the speaker ' +
            'before forwarding the quote.'
        });
      }
    }

    // Verdict.
    if (bestScore >= THRESHOLDS.groundMin && mismatches.length === 0) {
      result.verdict = 'GROUNDED';
      result.rule = 'G-1';
      result.reasons.push('Content match ' + Math.round(bestScore * 100) + '% of key terms' +
        (claimNums.length ? '; numbers agree' : '') +
        (claimDates.length ? '; dates agree' : '') +
        (claim.owner ? '; owner agrees' : '') +
        (claim.type === 'quote' ? '; speaker agrees' : '') + '.');
    } else if (bestScore >= THRESHOLDS.groundMin) {
      result.verdict = 'PARTIAL';
      result.rule = 'P-1';
      result.reasons.push('Content matches (' + Math.round(bestScore * 100) +
        '% of key terms), but a field disagrees:');
      mismatches.forEach(function (mm) { result.reasons.push(mm.text); });
    } else {
      result.verdict = 'PARTIAL';
      result.rule = 'P-2';
      result.reasons.push('Weak match: only ' + Math.round(bestScore * 100) +
        '% of the claim\u2019s key terms appear in the closest line. ' +
        'The claim may be a paraphrase the lexical match missed, or it may ' +
        'not be in the meeting at all.');
      mismatches.forEach(function (mm) { result.reasons.push(mm.text); });
    }
    return result;
  }

  function auditMeeting(meeting) {
    var shares = talkShare(meeting);
    var claims = meeting.claims.map(function (c) { return auditClaim(c, meeting, shares); });

    // Recall: commitment lines no claim covers.
    var commitments = meeting.transcript.filter(isCommitment).map(function (ln) {
      var lineSet = tokenSet(ln.text);
      var covering = null;
      claims.forEach(function (r) {
        if (r.evidence && r.evidence.lineId === ln.id) covering = r.id;
        if (!covering) {
          var ct = tokenize(r.text);
          if (containment(ct, lineSet) >= THRESHOLDS.recallMin) covering = r.id;
        }
      });
      return { lineId: ln.id, t: ln.t, speaker: ln.speaker, text: ln.text, coveredBy: covering };
    });
    var missed = commitments.filter(function (c) { return !c.coveredBy; });

    var counts = { grounded: 0, partial: 0, ungrounded: 0 };
    claims.forEach(function (r) { counts[r.verdict.toLowerCase()]++; });
    var flagged = claims.filter(function (r) { return r.flags.length; }).length;

    return {
      meetingId: meeting.id,
      claims: claims,
      commitments: commitments,
      missed: missed,
      counts: counts,
      totalClaims: claims.length,
      groundedShare: claims.length ? counts.grounded / claims.length : 0,
      commitmentsCaptured: commitments.length - missed.length,
      commitmentsTotal: commitments.length,
      attributionFlags: flagged,
      talkShare: shares
    };
  }

  function buildReport(meeting) {
    var a = auditMeeting(meeting);
    return {
      tool: 'Groundcheck',
      method: 'lexical + rules-based, no LLM',
      thresholds: THRESHOLDS,
      meeting: {
        id: meeting.id, title: meeting.title, date: meeting.date,
        duration: meeting.duration, source: meeting.source,
        attendees: meeting.attendees
      },
      score: {
        grounded: a.counts.grounded, partial: a.counts.partial,
        ungrounded: a.counts.ungrounded, total: a.totalClaims,
        groundedShare: Math.round(a.groundedShare * 1000) / 1000,
        commitmentsCaptured: a.commitmentsCaptured,
        commitmentsTotal: a.commitmentsTotal,
        attributionFlags: a.attributionFlags
      },
      claims: a.claims,
      missedCommitments: a.missed,
      limits: [
        'Lexical matching misses paraphrases; some GROUNDED claims may read PARTIAL and some flags are false positives.',
        'A flag means "check this", not "wrong".',
        'Cannot judge meaning, tone, or whether a decision was wise.',
        'Needs the transcript; meetings whose transcripts were deleted under retention settings cannot be audited.'
      ]
    };
  }

  // ------------------------------------------------------------- API seam
  // The real-data path, unused by this static demo (no key, no network).
  // Circleback's public REST API: GET https://circleback.ai/api/meetings
  // with Authorization: Bearer cb_...  Keys are created in Settings → API
  // keys. Free plan: 20 requests/minute. Docs: /docs/api.
  // A hosted run would call this, map each meeting to {transcript, claims},
  // and run auditMeeting on it with the same engine.
  function fetchFromCircleback(apiKey, opts) {
    opts = opts || {};
    var base = opts.baseUrl || 'https://circleback.ai/api';
    return fetch(base + '/meetings?limit=50', {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('Circleback API ' + res.status);
      return res.json();
    });
  }

  function formatTs(totalSeconds) {
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ------------------------------------------------------------------ data
  // Three fictional meetings. Names, companies and numbers are invented.
  // Defects planted (ground truth lives in verify/test.js, not here):
  //   M1: an invented action item; a wrong price ($12K vs $21K); one dropped
  //       commitment (Marcus on the DPA).
  //   M2: an action item assigned to the wrong owner; one dropped commitment
  //       (Ravi on the migration).
  //   M3: a quote attributed to the wrong speaker; a wrong date (Dec 8 vs
  //       Dec 10); a quote from a speaker with under 10% talk share; one
  //       dropped commitment (Tom on the whitepaper).
  var MEETINGS = [
    {
      id: 'm1',
      title: 'Meridian Logistics: pricing and rollout',
      kind: 'Sales call',
      date: 'Nov 18, 2026',
      duration: '24 min',
      source: 'Circleback bot',
      sourceNote: 'Bot-joined call, so speaker names come from the meeting invite.',
      attendees: ['Maya Chen (Sales)', 'Daniel Okafor (Solutions)', 'Priya Raman (Customer success)', 'Marcus Webb (Meridian)', 'Dana Whitfield (Meridian)'],
      transcript: [
        { id: 'L1', t: 8, speaker: 'Maya Chen', text: 'Thanks for joining, everyone. Today we walk through the pilot plan for Meridian.' },
        { id: 'L2', t: 45, speaker: 'Marcus Webb', text: "We're starting with 240 seats on the pilot, across 3 departments." },
        { id: 'L3', t: 85, speaker: 'Dana Whitfield', text: 'Our current tool is Fireflies, and the notes are unreliable.' },
        { id: 'L4', t: 125, speaker: 'Marcus Webb', text: 'The pilot price is $21K per year, right? That was the number in the proposal.' },
        { id: 'L5', t: 170, speaker: 'Maya Chen', text: "Yes, $21K a year for the pilot, and the renewal date is something I'll confirm with procurement tomorrow." },
        { id: 'L6', t: 215, speaker: 'Dana Whitfield', text: 'We need SSO before rollout. Our security team requires it.' },
        { id: 'L7', t: 260, speaker: 'Marcus Webb', text: 'If the notes are wrong, my team stops trusting them. That is the whole ballgame for us.' },
        { id: 'L8', t: 305, speaker: 'Maya Chen', text: "I'll send over the SOC 2 report by Friday." },
        { id: 'L9', t: 350, speaker: 'Daniel Okafor', text: "I'll run the security review with Meridian IT next week." },
        { id: 'L10', t: 395, speaker: 'Priya Raman', text: "I'll share the onboarding checklist by Wednesday." },
        { id: 'L11', t: 440, speaker: 'Marcus Webb', text: 'Rollout starts with the ops team in January.' },
        { id: 'L12', t: 485, speaker: 'Dana Whitfield', text: 'Quarterly business reviews should be monthly during the pilot.' },
        { id: 'L13', t: 530, speaker: 'Marcus Webb', text: 'Contract signature target is December 15.' },
        { id: 'L14', t: 575, speaker: 'Marcus Webb', text: "I'll loop in our legal team on the DPA this week." },
        { id: 'L15', t: 620, speaker: 'Maya Chen', text: 'The pilot includes unlimited meetings and the automations pack.' },
        { id: 'L16', t: 665, speaker: 'Dana Whitfield', text: 'How does the speaker timeline handle overlapping speech?' },
        { id: 'L17', t: 710, speaker: 'Daniel Okafor', text: 'It separates speakers by voice signature, and you can correct names after the call.' },
        { id: 'L18', t: 755, speaker: 'Marcus Webb', text: 'Our legal team already reviewed the data processing terms.' },
        { id: 'L19', t: 800, speaker: 'Priya Raman', text: 'Onboarding usually takes two weeks for a group this size.' },
        { id: 'L20', t: 845, speaker: 'Marcus Webb', text: 'The ops team wants the notes in Slack the same day.' },
        { id: 'L21', t: 890, speaker: 'Dana Whitfield', text: 'Can the notes separate action items by owner automatically?' },
        { id: 'L22', t: 935, speaker: 'Maya Chen', text: 'Yes, action items carry an owner and a due date in the notes.' },
        { id: 'L23', t: 980, speaker: 'Marcus Webb', text: 'We compared three vendors before this call.' },
        { id: 'L24', t: 1025, speaker: 'Daniel Okafor', text: 'The desktop app records locally, then uploads after the call.' },
        { id: 'L25', t: 1070, speaker: 'Dana Whitfield', text: 'What happens when a meeting runs over two hours?' },
        { id: 'L26', t: 1115, speaker: 'Maya Chen', text: 'Long meetings split into chapters automatically.' },
        { id: 'L27', t: 1160, speaker: 'Marcus Webb', text: 'The pricing in the proposal matches what we discussed.' },
        { id: 'L28', t: 1205, speaker: 'Priya Raman', text: 'Support responds within one business day on the pilot plan.' },
        { id: 'L29', t: 1250, speaker: 'Marcus Webb', text: 'Dana signs off on vendors for our group.' },
        { id: 'L30', t: 1295, speaker: 'Maya Chen', text: 'We have time for two more questions before we wrap up.' },
        { id: 'L31', t: 1340, speaker: 'Dana Whitfield', text: 'Does the free plan keep meetings past 30 days?' },
        { id: 'L32', t: 1375, speaker: 'Maya Chen', text: 'Meetings older than 30 days are locked on the free plan, not deleted.' },
        { id: 'L33', t: 1410, speaker: 'Marcus Webb', text: 'Good. The January start works for the ops group.' },
        { id: 'L34', t: 1435, speaker: 'Maya Chen', text: 'Thanks everyone. The pilot kicks off in January.' }
      ],
      claims: [
        { id: 'c1', type: 'action', owner: 'Maya Chen', due: 'Friday', text: 'Maya to send Meridian the SOC 2 report by Friday' },
        { id: 'c2', type: 'number', text: 'Meridian has 240 seats on the pilot' },
        { id: 'c3', type: 'number', text: 'Agreed pilot price is $12K per year' },
        { id: 'c4', type: 'decision', text: 'Rollout starts with the ops team in January' },
        { id: 'c5', type: 'action', owner: 'Daniel Okafor', text: 'Daniel to run the security review with Meridian IT next week' },
        { id: 'c6', type: 'action', owner: 'Maya Chen', text: "Schedule a follow-up demo with Meridian's warehouse team in Reno" },
        { id: 'c7', type: 'fact', text: "Meridian's current tool is Fireflies" },
        { id: 'c8', type: 'decision', text: 'Quarterly business reviews will be monthly during the pilot' },
        { id: 'c9', type: 'action', owner: 'Priya Raman', due: 'Wednesday', text: 'Priya to share the onboarding checklist by Wednesday' },
        { id: 'c10', type: 'quote', speaker: 'Marcus Webb', text: 'If the notes are wrong, my team stops trusting them' },
        { id: 'c11', type: 'fact', text: 'Meridian needs SSO before rollout' },
        { id: 'c12', type: 'number', text: 'Pilot covers 3 departments' },
        { id: 'c13', type: 'decision', text: 'Contract signature target is December 15' },
        { id: 'c14', type: 'action', owner: 'Maya Chen', text: 'Maya to confirm the renewal date with procurement' }
      ]
    },
    {
      id: 'm2',
      title: 'Platform standup: migration and on-call',
      kind: 'Eng standup',
      date: 'Nov 19, 2026',
      duration: '16 min',
      source: 'Circleback bot',
      sourceNote: 'Bot-joined call, so speaker names come from the meeting invite.',
      attendees: ['Ravi Patel (Backend)', 'Jess Kim (Frontend)', 'Omar Haddad (Infra)', 'Lena Fischer (PM)'],
      transcript: [
        { id: 'L1', t: 6, speaker: 'Lena Fischer', text: 'Morning, everyone. Standup, quick round, starting with Ravi.' },
        { id: 'L2', t: 35, speaker: 'Ravi Patel', text: 'The migration covers 14 tables, and the backfill is halfway done.' },
        { id: 'L3', t: 65, speaker: 'Ravi Patel', text: "I'll have the migration done by Thursday." },
        { id: 'L4', t: 100, speaker: 'Jess Kim', text: "I'll ship the new onboarding flow by Friday." },
        { id: 'L5', t: 130, speaker: 'Jess Kim', text: "I'll write the runbook for the cache outage." },
        { id: 'L6', t: 165, speaker: 'Omar Haddad', text: "The cache didn't fail, the retry storm killed it." },
        { id: 'L7', t: 195, speaker: 'Omar Haddad', text: 'The cache outage on Tuesday lasted 42 minutes.' },
        { id: 'L8', t: 230, speaker: 'Ravi Patel', text: 'API p99 latency is 310 ms after the fix.' },
        { id: 'L9', t: 265, speaker: 'Lena Fischer', text: "I'll circulate the Q1 roadmap draft on Monday." },
        { id: 'L10', t: 300, speaker: 'Lena Fischer', text: 'On-call rotation moves to a weekly schedule.' },
        { id: 'L11', t: 335, speaker: 'Ravi Patel', text: "I'll review your PR on the auth refactor, Jess." },
        { id: 'L12', t: 370, speaker: 'Jess Kim', text: "I'll update the status page copy today." },
        { id: 'L13', t: 405, speaker: 'Omar Haddad', text: 'Freeze deploys during the migration window.' },
        { id: 'L14', t: 440, speaker: 'Lena Fischer', text: 'Standup moves to 9:30 starting next week.' },
        { id: 'L15', t: 475, speaker: 'Omar Haddad', text: 'On-call pages dropped from 11 last week to 3 this week.' },
        { id: 'L16', t: 510, speaker: 'Ravi Patel', text: 'The backfill runs at night to avoid load on the primary.' },
        { id: 'L17', t: 545, speaker: 'Jess Kim', text: 'The onboarding flow passed design review yesterday.' },
        { id: 'L18', t: 580, speaker: 'Omar Haddad', text: 'Retry budgets are now capped at three attempts per request.' },
        { id: 'L19', t: 615, speaker: 'Lena Fischer', text: 'The roadmap draft includes the mobile work for Q1.' },
        { id: 'L20', t: 650, speaker: 'Ravi Patel', text: 'Auth refactor touches the session service and the token store.' },
        { id: 'L21', t: 685, speaker: 'Jess Kim', text: 'Status page copy goes through support before it ships.' },
        { id: 'L22', t: 720, speaker: 'Omar Haddad', text: 'Cache hit rate is back above 94 percent after the fix.' },
        { id: 'L23', t: 755, speaker: 'Lena Fischer', text: 'Two open roles on the platform team, both backend.' },
        { id: 'L24', t: 790, speaker: 'Ravi Patel', text: 'The migration window is Sunday night, low traffic.' },
        { id: 'L25', t: 825, speaker: 'Jess Kim', text: 'Design wants the empty states for onboarding by Thursday.' },
        { id: 'L26', t: 860, speaker: 'Omar Haddad', text: 'PagerDuty quieted down after the retry cap.' },
        { id: 'L27', t: 895, speaker: 'Lena Fischer', text: 'Anything else before we close?' },
        { id: 'L28', t: 930, speaker: 'Ravi Patel', text: 'Nothing from me. The migration is on track.' }
      ],
      claims: [
        { id: 'c1', type: 'action', owner: 'Jess Kim', due: 'Friday', text: 'Jess to ship the new onboarding flow by Friday' },
        { id: 'c2', type: 'decision', text: 'On-call rotation moves to a weekly schedule' },
        { id: 'c3', type: 'action', owner: 'Omar Haddad', text: 'Omar to write the runbook for the cache outage' },
        { id: 'c4', type: 'fact', text: 'Cache outage on Tuesday lasted 42 minutes' },
        { id: 'c5', type: 'number', text: 'API p99 latency is 310 ms after the fix' },
        { id: 'c6', type: 'action', owner: 'Lena Fischer', due: 'Monday', text: 'Lena to circulate the Q1 roadmap draft on Monday' },
        { id: 'c7', type: 'decision', text: 'Freeze deploys during the migration window' },
        { id: 'c8', type: 'fact', text: 'Migration covers 14 tables' },
        { id: 'c9', type: 'action', owner: 'Ravi Patel', text: "Ravi to review Jess's PR on the auth refactor" },
        { id: 'c10', type: 'quote', speaker: 'Omar Haddad', text: "The cache didn't fail, the retry storm killed it" },
        { id: 'c11', type: 'decision', text: 'Standup moves to 9:30 starting next week' },
        { id: 'c12', type: 'number', text: 'On-call pages dropped from 11 to 3 this week' },
        { id: 'c13', type: 'action', owner: 'Jess Kim', text: 'Jess to update the status page copy' }
      ]
    },
    {
      id: 'm3',
      title: 'Q3 investor update: Northwind',
      kind: 'Investor update',
      date: 'Nov 20, 2026',
      duration: '34 min',
      source: 'Desktop recording',
      sourceNote: 'Recorded on desktop, so speaker names come from voice signatures, not a bot join. Check names before forwarding an attributed quote.',
      attendees: ['Sarah Lindqvist (CEO)', 'Tom Berger (CTO)', 'Elena Ruiz (Meridian Capital)', 'David Osei (Meridian Capital)'],
      transcript: [
        { id: 'L1', t: 10, speaker: 'Sarah Lindqvist', text: 'Welcome to the Q3 update. ARR grew to $4.2M in Q3.' },
        { id: 'L2', t: 75, speaker: 'Tom Berger', text: 'Net revenue retention is 118 percent.' },
        { id: 'L3', t: 140, speaker: 'Elena Ruiz', text: 'Churn fell from 3.1 percent to 2.4 percent in Q3.' },
        { id: 'L4', t: 205, speaker: 'David Osei', text: 'The churn number is the one I want to see move.' },
        { id: 'L5', t: 270, speaker: 'Sarah Lindqvist', text: "I'll send the updated cohort analysis by Tuesday." },
        { id: 'L6', t: 335, speaker: 'Tom Berger', text: "I'll share the technical due diligence pack this week." },
        { id: 'L7', t: 400, speaker: 'Elena Ruiz', text: "I'll introduce you to two design partners next week." },
        { id: 'L8', t: 465, speaker: 'Tom Berger', text: "I'll send the security whitepaper to the diligence group this week." },
        { id: 'L9', t: 530, speaker: 'Sarah Lindqvist', text: 'The next fundraise is targeted for Q2 next year.' },
        { id: 'L10', t: 595, speaker: 'Sarah Lindqvist', text: 'Board meeting is December 10.' },
        { id: 'L11', t: 660, speaker: 'Tom Berger', text: 'Hiring freeze on non-engineering roles through January.' },
        { id: 'L12', t: 725, speaker: 'David Osei', text: 'Your burn multiple is the best in the portfolio.' },
        { id: 'L13', t: 790, speaker: 'Sarah Lindqvist', text: "We're 34 people now, up from 27 in June." },
        { id: 'L14', t: 855, speaker: 'Sarah Lindqvist', text: 'We plan to open a London office in the second half of next year.' },
        { id: 'L15', t: 920, speaker: 'Elena Ruiz', text: 'The cohort analysis last quarter was strong.' },
        { id: 'L16', t: 985, speaker: 'Tom Berger', text: 'Infrastructure costs are flat while usage doubled.' },
        { id: 'L17', t: 1050, speaker: 'Sarah Lindqvist', text: 'Gross margin is 81 percent this quarter.' },
        { id: 'L18', t: 1115, speaker: 'Elena Ruiz', text: 'Two design partners asked about the enterprise tier.' },
        { id: 'L19', t: 1180, speaker: 'Tom Berger', text: 'The diligence pack includes architecture diagrams and runbooks.' },
        { id: 'L20', t: 1245, speaker: 'David Osei', text: 'Makes sense.' },
        { id: 'L21', t: 1310, speaker: 'Sarah Lindqvist', text: 'Q4 hiring focuses on two senior engineers.' },
        { id: 'L22', t: 1375, speaker: 'Elena Ruiz', text: 'The London office needs a local lead before launch.' },
        { id: 'L23', t: 1440, speaker: 'Tom Berger', text: 'Security review with the new vendor starts in December.' },
        { id: 'L24', t: 1505, speaker: 'Sarah Lindqvist', text: 'The board deck goes out the week before the meeting.' },
        { id: 'L25', t: 1570, speaker: 'Elena Ruiz', text: 'Send the cohort analysis to the full partnership, not just me.' },
        { id: 'L26', t: 1635, speaker: 'Tom Berger', text: 'The whitepaper covers encryption and access controls.' },
        { id: 'L27', t: 1700, speaker: 'Sarah Lindqvist', text: 'Fundraising conversations start after the board meeting.' },
        { id: 'L28', t: 1765, speaker: 'Elena Ruiz', text: 'The enterprise tier closes the gap with larger buyers.' },
        { id: 'L29', t: 1830, speaker: 'Tom Berger', text: 'Latency p99 is under 200 ms across regions.' },
        { id: 'L30', t: 1845, speaker: 'Sarah Lindqvist', text: 'Thanks, everyone. The winter board session will be the big one.' },
        { id: 'L31', t: 1880, speaker: 'Elena Ruiz', text: 'The partnership meets again in January to review the numbers.' },
        { id: 'L32', t: 1920, speaker: 'Tom Berger', text: 'The architecture diagrams are ready for the data room.' },
        { id: 'L33', t: 1960, speaker: 'Sarah Lindqvist', text: 'The board deck circulates on Friday.' },
        { id: 'L34', t: 1990, speaker: 'Elena Ruiz', text: 'Good update. The retention story is the strongest part.' }
      ],
      claims: [
        { id: 'c1', type: 'number', text: 'ARR grew to $4.2M in Q3' },
        { id: 'c2', type: 'decision', text: 'Next fundraise targeted for Q2 next year' },
        { id: 'c3', type: 'quote', speaker: 'Elena Ruiz', text: 'The churn number is the one I want to see move' },
        { id: 'c4', type: 'action', owner: 'Sarah Lindqvist', due: 'Tuesday', text: 'Sarah to send the updated cohort analysis by Tuesday' },
        { id: 'c5', type: 'number', text: 'Net revenue retention is 118%' },
        { id: 'c6', type: 'decision', text: 'Board meeting scheduled for December 8' },
        { id: 'c7', type: 'decision', text: 'Hiring freeze on non-engineering roles through January' },
        { id: 'c8', type: 'action', owner: 'Tom Berger', text: 'Tom to share the technical due diligence pack' },
        { id: 'c9', type: 'quote', speaker: 'David Osei', text: 'Your burn multiple is the best in the portfolio' },
        { id: 'c10', type: 'number', text: 'Churn fell from 3.1% to 2.4% in Q3' },
        { id: 'c11', type: 'number', text: 'Team is 34 people, up from 27' },
        { id: 'c12', type: 'decision', text: 'Open a London office in H2 next year' },
        { id: 'c13', type: 'action', owner: 'Elena Ruiz', text: 'Elena to introduce the team to two design partners' }
      ]
    }
  ];

  var api = {
    MEETINGS: MEETINGS,
    THRESHOLDS: THRESHOLDS,
    COMMITMENT_LEXICON: COMMITMENT_LEXICON,
    auditMeeting: auditMeeting,
    auditClaim: auditClaim,
    buildReport: buildReport,
    talkShare: talkShare,
    isCommitment: isCommitment,
    tokenize: tokenize,
    extractNumbers: extractNumbers,
    extractDates: extractDates,
    fetchFromCircleback: fetchFromCircleback,
    formatTs: formatTs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Groundcheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
