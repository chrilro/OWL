/* =============================================================
   OWL suite — shared core (suite-core.js)

   The rules every OWL tool must apply IDENTICALLY. If two tools
   disagreed about where sentences begin or which ID belongs to
   which sentence, the shared files would stop being trustworthy —
   so none of this logic may be reimplemented inside a tool.

   Keep this file in the SAME FOLDER as the tool HTML files
   (writer_standalone.html, glosser_standalone.html, …); they load
   it with <script src="suite-core.js"> and refuse to run without it.
   ============================================================= */
(function(global){
  'use strict';
  const SuiteCore = {};

  /* ---------- names & normalization ---------- */

  // Unicode NFC everywhere, so composed vs. decomposed diacritics
  // (ɨ́ typed as one codepoint vs. base + combining mark) can never
  // make identical-looking sentences compare as different.
  SuiteCore.nfc = function(s){ return (s || '').normalize('NFC'); };

  // Sidecar files sit next to the .txt they annotate; one sidecar
  // per annotation type, each owned by one tool.
  SuiteCore.sidecarName = function(txtName){ return txtName.replace(/\.txt$/i, '.translations.json'); };
  SuiteCore.glossSidecarName = function(txtName){ return txtName.replace(/\.txt$/i, '.gloss.json'); };
  SuiteCore.SETTINGS_FILE = 'writer.settings.json';

  /* ---------- identity ---------- */

  // Permanent random IDs for texts (t-…) and sentence occurrences
  // (s-…). Minted once, never reused, never derived from content —
  // identical sentences get different IDs, because context can make
  // identical wording mean different things.
  SuiteCore.newId = function(prefix){
    const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    return prefix + '-' + uuid;
  };

  /* ---------- segmentation ---------- */

  // Paragraphs are separated by one or more blank lines. Single line
  // breaks WITHIN a paragraph are preserved — they matter to sentence
  // segmentation below.
  SuiteCore.parseIntoParagraphs = function(raw){
    return raw.split(/\n\s*\n+/)
      .map(b => b.replace(/^[ \t]+|[ \t]+$/g, '').replace(/^\n+|\n+$/g, ''))
      .filter(Boolean);
  };

  // Sentence boundaries are punctuation-first: a run of text ending in
  // . ! ? or … closes a sentence (runs like "..." or "?!" swallow
  // together). A line break only closes whatever text punctuation
  // hasn't already closed — so prose segments purely on punctuation,
  // while an unpunctuated wordlist/elicitation block still gets one
  // sentence per line.
  SuiteCore.splitIntoSentencesWithOffsets = function(text){
    const spans = [];
    let start = 0, i = 0;
    const n = text.length;
    const isTerminal = ch => ch === '.' || ch === '!' || ch === '?' || ch === '…';
    while(i < n){
      const ch = text[i];
      if(isTerminal(ch)){
        let j = i + 1;
        while(j < n && isTerminal(text[j])) j++;
        spans.push({ start, end: j });
        i = j;
        start = j;
        continue;
      }
      if(ch === '\n'){
        if(text.slice(start, i).trim().length) spans.push({ start, end: i });
        i++;
        start = i;
        continue;
      }
      i++;
    }
    if(start < n && text.slice(start, n).trim().length) spans.push({ start, end: n });

    return spans
      .map(({start, end}) => {
        const raw = text.slice(start, end);
        const lead = raw.length - raw.replace(/^\s+/, '').length;
        const trimmedText = raw.trim();
        return { text: trimmedText, start: start + lead, end: start + lead + trimmedText.length };
      })
      .filter(p => p.text.length > 0);
  };

  SuiteCore.splitIntoSentences = function(text){
    return SuiteCore.splitIntoSentencesWithOffsets(text).map(s => s.text);
  };

  /* ---------- ID reconciliation ---------- */

  // Claims the first unconsumed pool entry whose text matches exactly,
  // marking it consumed (null) in the pool array. "In order" matching
  // is what makes duplicate identical sentences pair first-to-first,
  // second-to-second. Used at load time to match a document against
  // its sidecar; external edits mean some sentences find no entry —
  // by design, those look brand new (the plain-text price).
  SuiteCore.claimByExactText = function(text, pool){
    if(!pool) return null;
    const idx = pool.findIndex(e => e && e.text === text);
    if(idx === -1) return null;
    const e = pool[idx];
    pool[idx] = null;
    return e;
  };

  // Live-edit reconciliation, passes 1–2 (pass 3 — minting fresh IDs
  // or claiming from a load pool — belongs to the caller):
  //   pass 1: exact text, in order — an unchanged sentence keeps its
  //           identity wherever it moved (splits/merges are free);
  //   pass 2: positional pairing of leftovers — a sentence whose
  //           WORDING was edited in place keeps its ID (marked
  //           changed:true so the caller can apply its annotation
  //           policy: translations drop, glosses flag stale, links flag).
  // The pool is consumed in place (entries nulled), so one shared pool
  // can safely serve several paragraphs being reconciled together.
  // The two passes are also exposed separately (2026-08-07) so a caller
  // reconciling SEVERAL text groups against one shared pool at once (e.g.
  // Writer rebuilding a handful of paragraphs together after a native
  // Enter-split/Backspace-merge) can run pass 1 for EVERY group before pass
  // 2 runs for ANY of them. Calling plain `reconcile` once per group in a
  // loop — the original shape here — does both passes for group 1 before
  // group 2 is even considered, so group 1's positional fallback can steal
  // a pool entry that group 2 would have matched exactly a moment later.
  // Real, reported case: inserting several brand-new sentences immediately
  // before an unrelated existing one (a native multi-paragraph structural
  // edit) let the FIRST new paragraph processed claim the existing
  // sentence's id+translations via positional fallback, purely because it
  // was reconciled before the paragraph that actually still held that exact
  // text got its turn — see the design doc entry for the full trace.
  SuiteCore.reconcileExactPass = function(newTexts, pool){
    const assigned = new Array(newTexts.length).fill(null);
    newTexts.forEach((t, i)=>{
      const idx = pool.findIndex(e => e && e.text === t);
      if(idx !== -1){ assigned[i] = { id: pool[idx].id, changed: false, entry: pool[idx] }; pool[idx] = null; }
    });
    return assigned;
  };
  SuiteCore.reconcilePositionalPass = function(newTexts, pool, assigned){
    newTexts.forEach((t, i)=>{
      if(assigned[i]) return;
      const idx = pool.findIndex(Boolean);
      if(idx !== -1){ assigned[i] = { id: pool[idx].id, changed: true, entry: pool[idx] }; pool[idx] = null; }
    });
    return assigned;
  };
  SuiteCore.reconcile = function(newTexts, pool){
    const assigned = SuiteCore.reconcileExactPass(newTexts, pool);
    SuiteCore.reconcilePositionalPass(newTexts, pool, assigned);
    return assigned;
  };

  /* ---------- translations sidecar (v2, with v1 migration) ---------- */

  // Parses a translations sidecar's JSON text. Returns a uniform shape
  // whether the file is v2, legacy v1, malformed, or absent (pass null).
  // v1 files (single unlabeled translation keyed by sentence text)
  // migrate silently: translations land under the first fallback
  // language, or "Translation" if none exist; IDs are minted later,
  // during reconciliation.
  SuiteCore.parseSidecar = function(jsonText, fallbackLanguages){
    const out = {
      textId: null,
      languages: (fallbackLanguages || []).slice(),
      textTranslations: {},
      entries: []
    };
    if(!jsonText) return out;
    let parsed = null;
    try{ parsed = JSON.parse(jsonText); }catch(e){ return out; }
    if(!parsed || typeof parsed !== 'object') return out;

    if(parsed.version === 2){
      out.textId = parsed.textId || null;
      if(Array.isArray(parsed.languages) && parsed.languages.length) out.languages = parsed.languages.slice();
      out.textTranslations = parsed.textTranslations || {};
      out.entries = (parsed.sentences || []).map(s => ({
        id: s.id || null,
        // NFC-normalized on read, not just on write: this text gets matched
        // by exact string equality against freshly-parsed (NFC) document
        // text (see rebuildParagraphDom/claimByExactText). Any sidecar ever
        // written with an un-normalized string — by an older code path, a
        // hand edit, or a future bug — would otherwise silently fail that
        // match and orphan its translations, instead of just working.
        text: SuiteCore.nfc(s.text || ''),
        translations: s.translations || {},
        // The wording these translations were last confirmed against —
        // absent on older files (nothing to compare, so no stale flag
        // rather than a false one). See writer_standalone.html's
        // collectSentenceRecords/rebuildParagraphDom for how it's set.
        fingerprint: s.translationFingerprint ? SuiteCore.nfc(s.translationFingerprint) : null
      }));
    } else {
      const lbl = out.languages[0] || 'Translation';
      if(!out.languages.includes(lbl)) out.languages.unshift(lbl);
      if(parsed.textTranslation) out.textTranslations = { [lbl]: parsed.textTranslation };
      out.entries = Object.entries(parsed.sentences || {}).map(([t, v]) => ({
        id: null,
        text: SuiteCore.nfc(t),
        translations: v ? { [lbl]: v } : {}
      }));
    }
    return out;
  };

  // Serializes a translations sidecar. `sentences` must be the full
  // ordered array of occurrences — including untranslated ones, since
  // their IDs are what gloss sidecars and lexicon links reference.
  SuiteCore.buildSidecarJson = function(data){
    return JSON.stringify({
      version: 2,
      textId: data.textId,
      languages: data.languages,
      textTranslations: data.textTranslations,
      sentences: data.sentences
    }, null, 2);
  };

  // Cross-tool save-clobber guard (2026-08-08): both Writer and Glosser
  // hold a full in-memory copy of a text's translations sidecar and, on
  // save, unconditionally rewrite the WHOLE sentence array from that copy.
  // If one tool is left open in a background tab/window while the OTHER
  // tool saves newer translations for the same text, the backgrounded
  // tool's next autosave — triggered by literally any edit, even an
  // unrelated one — silently overwrites the file with its own stale
  // snapshot, discarding the newer work with no warning (the same failure
  // mode already seen once with a stale Lexicon tab, see the 2026-08-06
  // design-doc entry, but that was a one-off manual recovery — this is
  // the same class of bug recurring for Writer/Glosser translations).
  // Returns the sidecar file's current `lastModified` timestamp, or null
  // if it can't be read (no sidecar yet, or some other read error) — each
  // tool compares this against its own last-known value to detect an
  // external change before it next autosaves over the file.
  SuiteCore.sidecarMtime = async function(dirHandle, fileName){
    try{
      const fh = await dirHandle.getFileHandle(fileName);
      const file = await fh.getFile();
      return file.lastModified;
    }catch(e){ return null; }
  };

  /* ---------- tokenization ---------- */

  // Whitespace tokenization — deliberately simple for now. Real
  // morpheme-aware segmentation is a later Glosser milestone; when it
  // arrives it lives HERE, not in a tool, for the same no-drift reason
  // as everything else in this file.
  SuiteCore.tokenize = function(sentenceText){
    return sentenceText.split(/\s+/).filter(Boolean);
  };

  /* ---------- morpheme conventions ---------- */

  // Canonical morpheme-line notation (standard practice): morphemes are
  // space-separated, each affix carrying its boundary marker on the side
  // that attaches — prefix "bo-", suffix "-ta", clitics with "=". Users
  // may TYPE compactly ("bo-tö"); canonicalizeMorphLine below converts.
  // splitMorphs extracts just the morpheme material (no markers), the
  // shared unit for alignment counting and memory keys, from either
  // compact or canonical notation.
  SuiteCore.splitMorphs = function(s){
    return (s || '').split(/[\s\-=]+/).map(x => x.trim()).filter(Boolean);
  };

  // Strips a leading/trailing copy of `marker` from `text`, or returns
  // `text` unchanged if it isn't there — makes reattaching a boundary
  // marker idempotent. Needed specifically for "~": splitMorphs (unlike
  // its own marker-stripping for "-"/"=") deliberately leaves "~" attached
  // to a gloss piece, since other code needs to recognize a reduplicant
  // token by its marker — but that means a gloss piece handed to
  // canonicalizeMorphLine/reglossLine for re-rendering can already carry
  // its "~", and blindly prepending/appending another one stacks up
  // ("eat ~ATT" -> "eat ~~ATT" -> "eat ~~~ATT" on every re-save). Stripping
  // first, then reattaching exactly once, is what "-"/"=" already get for
  // free from splitMorphs; this gives "~" the same guarantee at the one
  // place that actually needs it (2026-08-06).
  SuiteCore.stripOwnMarker = function(text, marker){
    let t = text || '';
    if(marker && t.startsWith(marker)) t = t.slice(marker.length);
    if(marker && t.endsWith(marker)) t = t.slice(0, t.length - marker.length);
    return t;
  };

  // Whitespace-only split — each piece KEEPS its attached boundary marker
  // ("-ta", "=lo", "~a", "koo~"), unlike splitMorphs above. Needed wherever
  // a caller has to tell markers apart rather than discard them: a
  // reduplicant token can't be recognized as reduplicant
  // (classifyReduplicantToken) once its "~" is gone, and a "~"-marked piece
  // formKey-collides with an unrelated plain morph of the same bare letters
  // (e.g. reduplicant "~a" vs. a genuine root "a") if compared after
  // stripping — see the 2026-08-06 Lexicon findCorpusExamples fix.
  SuiteCore.splitMbRaw = function(mb){
    const t = (mb || '').trim();
    return t ? t.split(/\s+/) : [];
  };

  // Leipzig-style gloss case signal: grammatical morphemes are glossed in
  // caps/digits ("2SG", "ACC", "CIS"), lexical roots in lowercase
  // ("foot", "bring"). A gloss with no lowercase letters marks its morph
  // as an affix candidate; one with lowercase marks a root candidate.
  SuiteCore.isGrammaticalGloss = function(g){
    if(!g || !g.trim()) return false;
    return !/\p{Ll}/u.test(g);
  };

  // Strips leading/trailing punctuation from a token, Unicode-aware —
  // letters, combining marks, and digits all count as word material.
  // This is what the morpheme line starts from: "wao." segments as "wao",
  // the sentence punctuation isn't morphology.
  SuiteCore.stripEdgePunct = function(form){
    return (form || '').replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
  };

  // Normalized key for "is this the same word?" lookups: NFC-normalized
  // (so composed vs. decomposed diacritics compare equal), edge punctuation
  // stripped (token "wao." matches remembered "wao"), then lowercased so
  // sentence-initial capitals still match.
  SuiteCore.formKey = function(form){
    return SuiteCore.stripEdgePunct(SuiteCore.nfc(form)).toLowerCase();
  };

  // Segments a form into phonological units for Analyze's Phonology tab
  // (segment inventory, minimal pairs). Deliberately NOT a fixed rule for
  // any one language: what counts as "one segment" from spelling alone
  // can't be guessed reliably (a language's own digraphs — Wao's "ng" is
  // the motivating case — may be one phoneme or two, and only the person
  // documenting the language knows which). So this takes a user-defined,
  // per-project list of multi-character graphemes (`writer.settings.json`
  // → `graphemes`, edited in Writer) and does greedy longest-match
  // tokenization against it; anything not covered falls back to one
  // Unicode codepoint per segment (NFC-normalized first, so a precomposed
  // accented letter like "ë" is already correctly one codepoint/one
  // segment with zero configuration — the empty-list default degrades to
  // exactly that, which is already correct for plenty of languages).
  // `graphemes` need not be sorted — this sorts its own working copy
  // longest-first so a trigraph is never shadowed by a shorter prefix.
  SuiteCore.segmentIntoGraphemes = function(form, graphemes){
    const text = SuiteCore.nfc(form || '');
    // NFC-normalize every configured grapheme before matching — a digraph
    // typed into a plain prompt() dialog (e.g. a doubled diacritic vowel
    // like "ää") can easily land in memory as a DECOMPOSED sequence (base
    // letter + combining mark, twice) even though it looks identical to the
    // precomposed form the corpus text is already normalized to. Without
    // this, `text.startsWith(g, i)` silently never matches — the digraph
    // quietly falls back to one-codepoint-per-segment with no error.
    const multi = (graphemes || []).map(g => SuiteCore.nfc(g)).filter(g => g && g.length > 1).slice().sort((a, b) => b.length - a.length);
    const segments = [];
    let i = 0;
    outer:
    while(i < text.length){
      for(const g of multi){
        if(text.startsWith(g, i)){
          segments.push(g);
          i += g.length;
          continue outer;
        }
      }
      // One codepoint, not one UTF-16 code unit — keeps surrogate pairs
      // (rare, but cheap to get right) and combining marks attached to
      // their base letter when NFC didn't already precompose them.
      const cp = Array.from(text.slice(i, i + 2))[0];
      segments.push(cp);
      i += cp.length;
    }
    return segments;
  };

  // Whether a morpheme-break string, once its hyphens/spaces/clitic
  // markers are stripped away, actually reconstructs the surface form it's
  // claimed to analyze. A token whose stored mb does NOT reconstruct its
  // own form is internally inconsistent — a data-entry mistake, e.g. a
  // copy/paste or mis-click that swapped one token's analysis onto a
  // neighboring token (the real bug this exists to catch: a "tömënga"
  // token whose mb/gl had been overwritten with an adjacent "botö"
  // token's analysis, then silently offered as tömënga's memorized
  // analysis corpus-wide, forever, until now). Same "corrupted data
  // teaches nothing" principle as skipping a misaligned mb/gl pair —
  // generalized to check the record against itself, not just internally.
  // `ipaInventory` (optional, 2026-08-05) is the fallback check for a
  // LEGITIMATE case this function used to misclassify as corrupted: an
  // accepted IPA-recognized analysis has its mb line in the project's
  // orthography (from the lexicon/segmentation, e.g. "tömëngä") while the
  // token's own `form` is the literal IPA text the user actually typed
  // (e.g. "tõmẽngã") — see the 2026-08-05 IPA-vs-orthography design
  // entries. That is NOT the same failure mode as the corrupted-record
  // case this function exists to catch (an unrelated analysis copy/pasted
  // onto the wrong token) — it's the intended, designed behavior of IPA
  // recognition. Only tried as a fallback, never in place of the literal
  // check, and only when a caller actually has an inventory to offer.
  //
  // A reduplicant piece's "~" (2026-08-06) is a MARKER, not literal surface
  // material — same status as the "-"/"=" boundary markers splitMorphs
  // already strips before this function ever sees the pieces. splitMorphs
  // deliberately leaves "~" attached (Glosser's per-morph resolver needs it
  // intact to recognize a reduplicant token at all — see
  // classifyReduplicantToken), so it has to be stripped HERE, at
  // reconstruction time, or "a -ta ~a" reconstructs as "ata~a" and never
  // matches its real surface form "ataa" — exactly the bug reported after
  // shipping reduplication support: the record LOOKED right in Glosser but
  // silently failed this check, so it was never learned into corpus memory.
  //
  // An infix token's "<"/">" (2026-08-07) are likewise pure notation, not
  // surface material — "b<um>ili" reconstructs as "bumili", not literally
  // "b<um>ili" — so they're stripped here the same way "~" is, while the
  // bracketed letters themselves (unlike "~", which marks a COPY of
  // material already counted elsewhere) are always real surface material
  // and stay.
  SuiteCore.mbMatchesForm = function(mb, form, ipaInventory){
    const joined = SuiteCore.splitMorphs(mb).map(m => m.replace(/~/g, '').replace(/[<>]/g, '')).join('');
    if(!joined) return false;
    const joinedKey = SuiteCore.formKey(joined);
    if(joinedKey === SuiteCore.formKey(form)) return true;
    if(ipaInventory){
      const orth = SuiteCore.ipaWordToOrthography(form, ipaInventory);
      if(orth && joinedKey === SuiteCore.formKey(orth)) return true;
    }
    return false;
  };

  /* ---------- gloss sidecar (v2, with v1 migration) ---------- */

  // Gloss data is keyed by sentence ID — the whole point of the ID
  // system. Each record carries the sentence text it was glossed
  // against as a FINGERPRINT: if the live text no longer matches, the
  // gloss is stale (kept and flagged, never silently dropped — glosses
  // are expensive; that's the per-annotation-type policy).
  //
  // v2 token record: { form, mb, gl } — the surface form, its morpheme
  // breakdown ("kuya-ta"), and the aligned gloss ("book-ACC"). A v1
  // record (word-level gloss only) migrates with mb = the whole form.
  SuiteCore.parseGlossSidecar = function(jsonText){
    const out = { textId: null, sentences: {} };
    if(!jsonText) return out;
    let parsed = null;
    try{ parsed = JSON.parse(jsonText); }catch(e){ return out; }
    if(!parsed || typeof parsed !== 'object') return out;
    out.textId = parsed.textId || null;

    Object.entries(parsed.sentences || {}).forEach(([id, rec])=>{
      if(!rec || typeof rec !== 'object') return;
      if(parsed.version === 2){
        out.sentences[id] = {
          text: rec.text || '',
          tokens: Array.isArray(rec.tokens)
            ? rec.tokens.map(t => {
                const tok = { form: t.form || '', mb: t.mb || '', gl: t.gl || '' };
                // `autoRule` (2026-08-08) — optional, present only on a token
                // a learned rule (e.g. affix-onset-nasalization) auto-committed
                // rather than the user confirming it directly. Absent on every
                // pre-existing token and on anything the user has since
                // touched (setGlossToken clears it on any manual write) — a
                // pure provenance marker, never itself consulted to decide
                // what a token MEANS, only how it's displayed/audited.
                if(t.autoRule) tok.autoRule = t.autoRule;
                return tok;
              })
            : []
        };
      } else {
        // v1: parallel arrays of token forms and word-level glosses
        const forms = Array.isArray(rec.tokens) ? rec.tokens : [];
        const glosses = Array.isArray(rec.glosses) ? rec.glosses : [];
        out.sentences[id] = {
          text: rec.text || '',
          tokens: forms.map((f, i) => ({
            form: f,
            mb: (glosses[i] && glosses[i].trim()) ? f : '',
            gl: glosses[i] || ''
          }))
        };
      }
    });
    return out;
  };

  SuiteCore.buildGlossSidecarJson = function(data){
    return JSON.stringify({
      version: 2,
      textId: data.textId,
      sentences: data.sentences
    }, null, 2);
  };

  // A gloss token carries NO real content — and so must neither count as
  // "glossed" (which would suppress fresh suggestions) nor be persisted —
  // when it has no gloss AND its morpheme line is empty or merely the
  // unsegmented surface word. That bare-word state is only ever the
  // editor's starting placeholder for manual segmentation; committing or
  // saving it would silently mark the token done. A real segmentation
  // (mb differs from the whole word) or any gloss makes it non-empty.
  SuiteCore.glossTokenIsEmpty = function(t){
    if(!t) return true;
    const g = (t.gl || '').trim();
    if(g) return false;
    const m = (t.mb || '').trim();
    if(!m) return true;
    return m.toLowerCase() === SuiteCore.stripEdgePunct(t.form || '').toLowerCase();
  };

  /* ---------- canonical morpheme notation ---------- */

  // Parses a morpheme line (compact, canonical, or mixed) into an ordered
  // list of { form, marker, role } where role is 'prefix' | 'suffix' |
  // 'root' | null (unresolved). Explicit notation is a hard constraint:
  // a space-separated unit ending in -/=/~ is prefix material ("bo-",
  // "koo~"), one starting with -/=/~ is suffix material ("-mu-n" = two
  // suffixes, "~a" a reduplicant), a bare unit with no internal separators
  // is an explicit root. Compact runs ("bo-tö") yield unresolved roles for
  // the cascade to settle.
  //
  // "~" (2026-08-06) marks a reduplicant the same structural way "-"/"="
  // already mark an affix/clitic — added here, alongside them, rather than
  // as a special case elsewhere, after a real bug: typing "kë ~ë" (root +
  // suffixing reduplicant) rendered as "kë-~ë" with no gloss. Before this
  // fix, neither the leading/trailing tests nor the split regex knew about
  // "~", so "~ë" fell all the way through to the LAST branch
  // (`!leading && !trailing && parts.length === 1`) and was wrongly forced
  // to role:'root' — then canonicalizeMorphLine's "adjacent roots compound"
  // rule glued it onto the real root with a bare hyphen, exactly the
  // reported output. Reduplication was already correctly wired everywhere
  // ELSE (classifyReduplicantToken, resolveMorphGlossLive) — this was the
  // one remaining place still only checking for "-"/"=".
  SuiteCore.parseMorphLine = function(mb){
    const morphs = [];
    (mb || '').trim().split(/\s+/).filter(Boolean).forEach(unit=>{
      const leading = /^[-=~]/.test(unit);
      const trailing = /[-=~]$/.test(unit);
      const marker = unit.includes('~') ? '~' : (unit.includes('=') ? '=' : '-');
      const parts = unit.split(/[-=~]+/).map(x => x.trim()).filter(Boolean);
      if(!parts.length) return;
      let role = null;
      if(leading && !trailing) role = 'suffix';
      else if(trailing && !leading) role = 'prefix';
      else if(!leading && !trailing && parts.length === 1) role = 'root';
      // leading AND trailing ("-x-"/"~x~"), or a compact multi-part unit: unresolved
      parts.forEach(p => morphs.push({ form: p, marker, role: (parts.length === 1 || role === 'suffix' || role === 'prefix') ? role : null }));
    });
    return morphs;
  };

  // Resolves root-vs-affix for every morph and renders standard notation:
  // prefixes "bo-", root bare, suffixes "-ta", space-separated. Direction
  // is DERIVED from position relative to the root, never remembered per
  // morph — which is what makes ambifixes free: an affix before the root
  // is a prefix in that word, after it a suffix, same morpheme either way.
  //
  // Root resolution cascade (strongest first):
  //   1. explicit notation in what was typed (respected absolutely);
  //   2. the gloss line, when its part count aligns: lowercase gloss =
  //      root candidate, caps-only gloss = affix;
  //   3. per-morpheme role memory (root/affix counts from previously
  //      confirmed canonical lines);
  //   4. edge-rule fallback: assume the FIRST morph is the root (suffixes
  //      are the cross-linguistically commoner affixation) — flagged as
  //      guessed so the tool can show it as provisional.
  // Returns { mb, gl, guessed } — gl reformatted to mirror the morpheme
  // grouping when alignable, otherwise passed through untouched.
  SuiteCore.canonicalizeMorphLine = function(mb, gl, memory, lexIndex){
    const morphs = SuiteCore.parseMorphLine(mb);
    if(!morphs.length) return { mb: (mb || '').trim(), gl: gl || '', guessed: false };

    const glossParts = SuiteCore.splitMorphs(gl || '');
    const glossAligned = glossParts.length === morphs.length;
    let guessed = false;

    // score root candidacy for unresolved morphs — the lexicon's curated
    // `type` is the strongest signal after explicit typing (it's a decided
    // fact, not an observation), then gloss case, then derived role counts
    const rootScore = morphs.map((m, i)=>{
      if(m.role === 'root') return Infinity;
      if(m.role === 'prefix' || m.role === 'suffix') return -Infinity;
      let score = 0;
      if(lexIndex){
        const entry = SuiteCore.lexiconFindMorph(lexIndex, m.form);
        if(entry) score += (entry.type === 'root') ? 3 : -3;
      }
      if(glossAligned){
        score += SuiteCore.isGrammaticalGloss(glossParts[i]) ? -2 : 2;
      }
      if(memory && memory.roles && memory.roles.has(m.form.toLowerCase())){
        const r = memory.roles.get(m.form.toLowerCase());
        if(r.root > r.affix) score += 1;
        else if(r.affix > r.root) score -= 1;
      }
      return score;
    });

    // pick the root: any explicit root wins; else best-scoring positive;
    // else by elimination (every OTHER morph is a known affix, so the
    // remaining one must be the root — bo-gata with bo a known affix is
    // confidently "bo- gata" even though gata itself is unknown); else
    // fall back to first morph, flagged as guessed
    let rootIdx = rootScore.findIndex(s => s === Infinity);
    if(rootIdx === -1){
      let best = -Infinity;
      rootScore.forEach((s, i)=>{ if(s > best){ best = s; rootIdx = i; } });
      if(best <= 0){
        const maxIdxs = [];
        rootScore.forEach((s, i)=>{ if(s === best) maxIdxs.push(i); });
        const othersAllNegative = rootScore.every((s, i) => i === maxIdxs[0] || s < 0);
        if(maxIdxs.length === 1 && othersAllNegative && best > -Infinity){
          rootIdx = maxIdxs[0]; // unique by elimination — confident
        } else {
          rootIdx = maxIdxs[0] !== undefined ? maxIdxs[0] : 0;
          guessed = true;
        }
      }
      if(best === -Infinity){ rootIdx = 0; guessed = true; }
    }

    // assign roles by position relative to the root
    morphs.forEach((m, i)=>{
      if(m.role) return;
      m.role = (i < rootIdx) ? 'prefix' : (i > rootIdx) ? 'suffix' : 'root';
    });
    // additional root candidates (compounds): a morph after rootIdx whose
    // score was also strongly positive stays a root rather than becoming a
    // suffix — adjacent roots render as a compact compound
    morphs.forEach((m, i)=>{
      if(i !== rootIdx && rootScore[i] !== -Infinity && rootScore[i] >= 2 && rootScore[i] !== Infinity){
        m.role = 'root';
      }
    });

    const renderUnit = (m, part)=>{
      if(m.role === 'prefix') return SuiteCore.stripOwnMarker(part, m.marker) + m.marker;
      if(m.role === 'suffix') return m.marker + SuiteCore.stripOwnMarker(part, m.marker);
      return part;
    };
    // adjacent roots join compactly (compound); everything else spaced
    const mbUnits = [];
    const glUnits = [];
    morphs.forEach((m, i)=>{
      const glossPart = glossAligned ? glossParts[i] : null;
      if(m.role === 'root' && i > 0 && morphs[i-1].role === 'root'){
        mbUnits[mbUnits.length - 1] += '-' + m.form;
        if(glossAligned) glUnits[glUnits.length - 1] += '-' + glossPart;
      } else {
        mbUnits.push(renderUnit(m, m.form));
        if(glossAligned) glUnits.push(renderUnit(m, glossPart));
      }
    });

    return {
      mb: mbUnits.join(' '),
      gl: glossAligned ? glUnits.join(' ') : (gl || ''),
      guessed
    };
  };

  // Re-renders a gloss line from a canonical morpheme line and a list of
  // per-morpheme gloss strings, reattaching each morph's boundary marker
  // in the right place (prefix "1SG-", suffix "-ACC"). Used to display a
  // gloss line in a different language: keep the segmentation, swap each
  // morpheme's gloss for its equivalent in the target language. If the
  // counts don't line up, falls back to a plain hyphen join.
  SuiteCore.reglossLine = function(mb, glossParts){
    const morphs = SuiteCore.parseMorphLine(mb);
    if(!morphs.length || morphs.length !== glossParts.length) return glossParts.join('-');
    const units = [];
    morphs.forEach((m, i)=>{
      const g = glossParts[i];
      if(m.role === 'root' && i > 0 && morphs[i-1].role === 'root'){
        units[units.length - 1] += '-' + g;         // compound: join to previous root
      } else if(m.role === 'prefix'){
        units.push(SuiteCore.stripOwnMarker(g, m.marker) + m.marker);
      } else if(m.role === 'suffix'){
        units.push(m.marker + SuiteCore.stripOwnMarker(g, m.marker));
      } else {
        units.push(g);
      }
    });
    return units.join(' ');
  };

  /* ---------- autogloss memory (deterministic first pass) ---------- */

  // The first stage of the design-doc §6 suggester: pure lookup memory
  // built bottom-up from the user's OWN already-confirmed glosses across
  // the corpus — no upfront grammar, exactly the OWL.java instinct.
  //   words:  formKey -> best-known { mb, gl } (by frequency)
  //   morphs: morph   -> best-known gloss     (by frequency)
  // Morph pairs are only learned from tokens whose mb and gl part counts
  // align — a misaligned gloss teaches nothing rather than teaching noise.
  // `ipaInventory` (optional, 2026-08-05) is passed straight through to
  // rememberGloss/mbMatchesForm so an accepted IPA-recognized analysis
  // (mb in orthography, form in raw IPA) is learned normally rather than
  // being treated as a corrupted record.
  SuiteCore.buildGlossMemory = function(glossSidecars, ipaInventory){
    const words = new Map();   // key -> Map("mb gl" -> {mb, gl, count})
    const morphs = new Map();  // morphKey -> Map(gloss -> count)
    const roles = new Map();   // morphKey -> {root: n, affix: n}
    (glossSidecars || []).forEach(sc=>{
      Object.values(sc.sentences || {}).forEach(rec=>{
        (rec.tokens || []).forEach(t=>{
          if(!t.gl || !t.gl.trim()) return;
          SuiteCore.rememberGloss({words, morphs, roles}, t.form, t.mb, t.gl, ipaInventory);
        });
      });
    });
    return { words, morphs, roles };
  };

  SuiteCore.rememberGloss = function(memory, form, mb, gl, ipaInventory){
    const key = SuiteCore.formKey(form);
    if(!key || !gl || !gl.trim()) return;
    const useMb = (mb && mb.trim()) ? mb.trim() : form;

    // A token's own analysis has to actually describe the word it's
    // attached to — OR describe its IPA-to-orthography conversion, when an
    // ipaInventory is available (a legitimate accepted IPA-recognized
    // analysis, not a corrupted record; see mbMatchesForm's own comment).
    // If neither holds, the record really is corrupted — don't learn
    // ANYTHING from it, word-level or morph-level, same as the
    // misaligned-mb/gl skip just below.
    if(!SuiteCore.mbMatchesForm(useMb, form, ipaInventory)) return;

    // A gloss line has to have exactly as many hyphen-separated parts as
    // the morpheme line — otherwise the record can't correspond to any
    // valid analysis at all (e.g. mb "emo- te", two morphs, paired with a
    // three-part gloss "PERFORM- 1SG- LNK": that's not "two morphs, one
    // of them ambiguous," it's a garbled record). Checked BEFORE the
    // word-level combo is learned, not just the morph-level loop below —
    // otherwise a self-inconsistent record still taught a bogus whole-word
    // analysis even though it could never teach a morph-level one.
    const mParts = SuiteCore.splitMorphs(useMb);
    const gParts = SuiteCore.splitMorphs(gl);
    if(!mParts.length || mParts.length !== gParts.length) return;

    // "?" marks a gloss slot the user hasn't filled yet (from a partial
    // suggestion). A gloss line containing one is incomplete knowledge:
    // don't learn the word-level combo at all, and skip the "?" slots at
    // morph level — placeholders must never teach themselves into memory.
    if(!gl.includes('?')){
      const combo = useMb + ' ' + gl.trim();
      if(!memory.words.has(key)) memory.words.set(key, new Map());
      const combos = memory.words.get(key);
      if(!combos.has(combo)) combos.set(combo, { mb: useMb, gl: gl.trim(), count: 0 });
      combos.get(combo).count++;
    }

    mParts.forEach((m, i)=>{
      if(gParts[i] === '?') return;
      const mKey = m.toLowerCase();
      if(!memory.morphs.has(mKey)) memory.morphs.set(mKey, new Map());
      const g = memory.morphs.get(mKey);
      g.set(gParts[i], (g.get(gParts[i]) || 0) + 1);
    });

    // Role memory: learned only from EXPLICIT notation (a canonical
    // line's markers), never from guesses. Note what's counted: ROOT-ness
    // vs AFFIX-ness, not direction — direction is positional per word.
    // That's exactly why ambifixes need no special handling: "bo- tö"
    // here and "kaka -bo" elsewhere both just count "bo: affix", and each
    // occurrence renders from its own position relative to its root.
    if(memory.roles){
      SuiteCore.parseMorphLine(useMb).forEach(m=>{
        if(!m.role) return;
        const rKey = m.form.toLowerCase();
        if(!memory.roles.has(rKey)) memory.roles.set(rKey, { root: 0, affix: 0 });
        const r = memory.roles.get(rKey);
        if(m.role === 'root') r.root++;
        else r.affix++;
      });
    }
  };

  // ALL remembered analyses for a surface form, most frequent first.
  // A word can legitimately have several: "botö" may be glossed
  // unsegmented as "I" in one context and as "bo- tö" / "1SG- pronoun"
  // in another — both are real choices, so both are offered.
  SuiteCore.suggestAllForForm = function(memory, form){
    const key = SuiteCore.formKey(form);
    if(!key || !memory.words.has(key)) return [];
    return Array.from(memory.words.get(key).values())
      .sort((a, b) => b.count - a.count)
      .map(r => ({ mb: r.mb, gl: r.gl }));
  };

  // Most frequent remembered analysis for a surface form, or null.
  SuiteCore.suggestForForm = function(memory, form){
    const all = SuiteCore.suggestAllForForm(memory, form);
    return all.length ? all[0] : null;
  };

  // Gloss suggestion for a typed morpheme breakdown. PARTIAL suggestions
  // are allowed: known morphs get their best gloss, unknown ones get an
  // explicit "?" placeholder — segmenting "kewë-mo" where only -mo is
  // known still usefully suggests "?-1SG" rather than nothing. Returns
  // null only when NO morph is known. "?" is never learned back into
  // memory (see rememberGloss), so placeholders can't teach themselves.
  SuiteCore.suggestGlossForMorphs = function(memory, mb){
    const parts = SuiteCore.splitMorphs(mb);
    if(!parts.length) return null;
    let known = 0;
    const glosses = parts.map(m=>{
      const g = memory.morphs.get(m.toLowerCase());
      if(!g || !g.size) return '?';
      let best = null, bestN = 0;
      g.forEach((n, gloss)=>{ if(n > bestN){ bestN = n; best = gloss; } });
      known++;
      return best;
    });
    return known ? glosses.join('-') : null;
  };

  /* ---------- lexicon (curated layer) ---------- */

  // The lexicon is the CURATED counterpart to the derived gloss memory:
  // human decisions no corpus scan could recover. The defining example is
  // allomorphy — that "bo" and "mo" are the same 1SG morpheme is a fact
  // someone decided, so it lives here, in a file, authoritative. Format is
  // JSON Lines (one entry per line: appendable, greppable, diffable),
  // per the design doc.
  //
  // Entry shape (v1):
  //   id          lx-… (permanent, same ID discipline as texts/sentences)
  //   form        citation form
  //   type        'root' | 'affix' | 'clitic' — deliberately NOT
  //               prefix/suffix: direction is positional per word (the
  //               ambifix insight), so it isn't a lexical fact
  //   glossOptions  ordered primary glosses, default first — a morpheme
  //                 can mean several things (töno = with / to / about);
  //                 the user chooses per token, mirroring how a word can
  //                 have several segmentations. gloss-line output and the
  //                 suggester default to glossOptions[0].
  //   glossesByLang { language: [ordered glosses] } — same, per language,
  //                 for non-English audiences and dictionary views
  //   allomorphs  all surface variants, citation form included
  //   pos         part of speech, free text
  //   definitions { language label: prose definition }
  //   notes       free text
  //
  // In memory, normalizeLexEntry also exposes `gloss` (= glossOptions[0])
  // and `glosses` (= {lang: glossesByLang[lang][0]}) as read-only
  // conveniences so single-gloss consumers stay simple; these are DERIVED
  // and never serialized (serializeLexEntry omits them), so the option
  // lists remain the one source of truth even for someone hand-editing
  // the file.
  SuiteCore.LEXICON_FILE = 'lexicon.jsonl';

  function cleanStrList(v){
    if(Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if(typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  }
  function cleanStrListMap(v){
    const out = {};
    if(v && typeof v === 'object'){
      Object.entries(v).forEach(([k, val])=>{
        const list = cleanStrList(val);
        if(list.length) out[k] = list;
      });
    }
    return out;
  }

  SuiteCore.normalizeLexEntry = function(e){
    // gloss options: prefer new glossOptions, else migrate legacy `gloss`
    const glossOptions = e.glossOptions ? cleanStrList(e.glossOptions) : cleanStrList(e.gloss);
    // per-language options: prefer new glossesByLang, else migrate legacy
    // `glosses` ({lang: string}) into {lang: [string]}
    const glossesByLang = Object.keys(e.glossesByLang || {}).length
      ? cleanStrListMap(e.glossesByLang)
      : cleanStrListMap(e.glosses);
    const glosses = {};
    Object.entries(glossesByLang).forEach(([lang, arr]) => { glosses[lang] = arr[0]; });
    // NFC-normalize the matching-critical fields (form, allomorphs) so a
    // lexicon file saved in a different Unicode normalization than the
    // texts still matches — otherwise a single morph like "më" (composed
    // vs. decomposed diacritic) silently fails to match and its whole
    // segmentation collapses.
    const form = SuiteCore.nfc((e.form || '').trim());
    return {
      id: e.id || SuiteCore.newId('lx'),
      form: form,
      type: (e.type === 'affix' || e.type === 'clitic' || e.type === 'redup' || e.type === 'infix' || e.type === 'stemAlt') ? e.type : 'root',
      // Reduplicant template key (e.g. "~V", "CV~"), populated only for
      // type:'redup' entries — see SuiteCore.classifyReduplicantToken.
      // Kept as its own field (not reused from `form`) so a hand-edited
      // lexicon.jsonl can't accidentally desync the two.
      // type:'infix' entries need no separate template field — an infix is
      // a literal, invariant string (e.g. "um"), so `form` IS its own key,
      // same as a root or affix. See SuiteCore.buildInfixIndex.
      template: e.template ? SuiteCore.nfc(String(e.template).trim()) : '',
      glossOptions: glossOptions,
      glossesByLang: glossesByLang,
      gloss: glossOptions[0] || '',        // derived convenience (not serialized)
      glosses: glosses,                    // derived convenience (not serialized)
      allomorphs: Array.isArray(e.allomorphs) && e.allomorphs.length
        ? e.allomorphs.map(a => SuiteCore.nfc(String(a).trim())).filter(Boolean)
        : (form ? [form] : []),
      // Grammatical stem alternation (2026-08-09), populated only for
      // type:'stemAlt' entries — see SuiteCore.buildStemAltIndex. Distinct
      // from `allomorphs`: an allomorph is a different pronunciation of
      // the SAME meaning (Wao's dä/nä, both just "3SG.F"); a stem
      // alternant is a different SURFACE FORM that carries its OWN
      // distinct grammatical value (Mayan-style xuka="eat" in COMPLETIVE
      // vs. xuk'a="eat" in INCOMPLETIVE — the stem itself, not a separate
      // affix, is what conveys aspect). `gloss`/`glossOptions` above hold
      // the shared base meaning ("eat"); each alternant here pairs one
      // attested shape with the specific tag that shape conveys. More than
      // one alternant can legitimately share the same tag (plain
      // phonological micro-variation WITHIN one grammatical cell — e.g. a
      // COMP form attested as both "uke" and "uka") — that's not an error,
      // just two curated facts instead of one.
      alternants: Array.isArray(e.alternants)
        ? e.alternants
            .map(a => ({
              form: SuiteCore.nfc(String((a && a.form) || '').trim()),
              tag: String((a && a.tag) || '').trim()
            }))
            .filter(a => a.form && a.tag)
        : [],
      pos: e.pos || '',
      definitions: (e.definitions && typeof e.definitions === 'object') ? e.definitions : {},
      notes: e.notes || '',
      // Semantic domain tags — e.g. a word elicited for "tooth" carries
      // its whole ancestor trail (Person, Body, Head, Tooth), not just
      // the leaf domain, since a filter for any of those should surface
      // it. Curated (a human/Elicit session decided this word belongs
      // here), not derived — nothing else could recover which domain a
      // word was collected under. Order is not meaningful; duplicates
      // are never stored (Elicit/Lexicon both dedupe on write).
      domains: Array.isArray(e.domains)
        ? Array.from(new Set(e.domains.map(d => String(d || '').trim()).filter(Boolean)))
        : [],
      // Curated (only a human can know this — nothing about the form
      // itself reliably marks it as borrowed): excluded by default from
      // Analyze's Phonology tab, since a loanword's sounds don't belong in
      // a native phoneme inventory or minimal-pairs analysis. Analyze
      // offers an explicit "include loanwords" toggle for anyone who does
      // want to see borrowed sounds (e.g. describing an emerging contrast).
      loanword: !!e.loanword
    };
  };

  // The on-disk shape: option lists are authoritative; the derived
  // `gloss`/`glosses` conveniences are dropped so the file has one source
  // of truth. Empty collections are omitted to keep lines tidy.
  SuiteCore.serializeLexEntry = function(e){
    const out = { id: e.id, form: e.form, type: e.type };
    if(e.template) out.template = e.template;
    if(e.glossOptions && e.glossOptions.length) out.glossOptions = e.glossOptions;
    if(e.glossesByLang && Object.keys(e.glossesByLang).length) out.glossesByLang = e.glossesByLang;
    if(e.allomorphs && e.allomorphs.length) out.allomorphs = e.allomorphs;
    if(e.alternants && e.alternants.length) out.alternants = e.alternants;
    if(e.pos) out.pos = e.pos;
    if(e.definitions && Object.keys(e.definitions).length) out.definitions = e.definitions;
    if(e.notes) out.notes = e.notes;
    if(e.domains && e.domains.length) out.domains = e.domains;
    if(e.loanword) out.loanword = true;
    return out;
  };

  /* ================= allophone equivalence (phonemicization) =================
     A digraph list (SuiteCore.segmentIntoGraphemes) answers "how do I chop
     a word into segments" — it does NOT answer "which segments are actually
     the same phoneme." Those are different questions: Wao's "ng" is
     correctly one segment for tokenization, but it is NOT a phoneme of its
     own — it is a prenasalized allophone of /g/. This layer sits on top of
     segmentation: a flat map from an attested raw segment to the phoneme
     label it belongs to (e.g. {"ng":"g", "nk":"k", "nt":"t", "mp":"p"}).
     A segment absent from the map is its own phoneme (identity) — this
     keeps the common case (most segments ARE their own phoneme) free of
     any entry. Project-wide, curated in Writer alongside the digraph list,
     read-only in Analyze's Phonology tab. */

  // Text format: comma-separated "raw:phoneme" pairs, e.g. "nt:t, nk:k,
  // ng:g, mp:p" — same flat, forgiving style as the digraph list's
  // comma-separated text, rather than a nested structure that would need
  // its own editor UI.
  // `raw` (the segment key) is NFC-normalized on parse — it gets compared
  // later against segments straight out of segmentIntoGraphemes (already
  // NFC), and a mismatched normalization here would silently break the
  // lookup below exactly the way it would in segmentIntoGraphemes itself.
  SuiteCore.parseAllophoneMap = function(text){
    const map = {};
    (text || '').split(',').forEach(pair=>{
      const parts = pair.split(':');
      if(parts.length !== 2) return;
      const raw = SuiteCore.nfc(parts[0].trim());
      const phoneme = SuiteCore.nfc(parts[1].trim());
      if(raw && phoneme) map[raw] = phoneme;
    });
    return map;
  };

  SuiteCore.serializeAllophoneMap = function(map){
    return Object.entries(map || {}).map(([raw, phoneme]) => raw + ':' + phoneme).join(', ');
  };

  // The phoneme a raw segment counts as — itself, unless the allophone map
  // says otherwise. `segment` is re-normalized defensively: the map's own
  // keys are normalized at parse time, but this guards against a settings
  // file written by an older, unfixed version (or hand-edited) where they
  // might not be.
  SuiteCore.phonemeOf = function(segment, allophoneMap){
    const key = SuiteCore.nfc(segment);
    if(allophoneMap && Object.prototype.hasOwnProperty.call(allophoneMap, key)) return allophoneMap[key];
    return segment;
  };

  /* ================= vowel / consonant classification =================
     Heuristic, overridable per project — used to sort Analyze's Phonology
     inventory into two groups, and (should a chart view build on it later)
     as the top-level split any consonant/vowel chart starts from. There is
     no reliable way to derive place/manner-of-articulation from a written
     symbol, but the vowel/consonant split itself usually IS recoverable:
     strip diacritics (NFD) and check whether the base letter is a/e/i/o/u.
     That's correct for Wao (a,ä,e,ë,i,ï,o,ö,u are all vowels; everything
     else, including "ng"/"ñ"/"y", is a consonant) and for any other
     orthography built on the same convention. `overrides` exists for the
     cases it gets wrong — e.g. a semivowel spelled with a vowel letter, or
     a symbol the heuristic can't parse at all — curated in Writer
     alongside the digraph and allophone lists, same comma-pair text style. */
  SuiteCore.isLikelyVowel = function(segment){
    const base = (segment || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /^[aeiouAEIOU]/.test(base);
  };

  SuiteCore.classifyPhoneme = function(segment, overrides){
    const key = SuiteCore.nfc(segment);
    if(overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    return SuiteCore.isLikelyVowel(segment) ? 'vowel' : 'consonant';
  };

  /* ================= reduplication (2026-08-05) =================
     Cross-linguistically, reduplication copies either a single vowel
     ("~a") or a whole syllable/CV shape ("~ta", "~CVC", …) — the SAME
     mechanism should cover both rather than treating "vowel reduplication"
     as its own special case. The abstraction is a C/V skeleton of the
     copied material ("a" -> "V", "ta" -> "CV"), built from this project's
     OWN grapheme list and vowel/consonant classification
     (segmentIntoGraphemes + classifyPhoneme) rather than a hardcoded
     Latin-vowel set — that's what makes "V" correctly cover Wao's
     nasalized vowels (ã, õ, ẽ, ĩ, which decompose to a plain vowel letter
     under NFD) and what makes a digraph or long vowel (ng, ää) count as
     ONE skeleton slot, matching how the rest of the phonology tooling
     already treats them. Skeletons are looked up per-project (graphemes,
     phonemeClassOverrides), never hardcoded. */
  SuiteCore.cvSkeleton = function(word, graphemes, phonemeClassOverrides){
    const segs = SuiteCore.segmentIntoGraphemes(word, graphemes || []);
    return segs.map(seg => SuiteCore.classifyPhoneme(seg, phonemeClassOverrides) === 'vowel' ? 'V' : 'C').join('');
  };

  // A reduplicant token carries its copied material with a leading and/or
  // trailing "~", the same convention "-"/"=" already use for affix/clitic
  // boundaries: "~a" = suffixing reduplicant (copies backward, the token
  // attaches after its base — Wao's confirmed case, "a -ta ~a"), "koo~" =
  // prefixing reduplicant, "~o~" = an infixing reduplicant fused into one
  // token (not yet attested in this corpus, included for completeness —
  // OWL.java's "ro~o~ka" case). Returns null for anything that isn't
  // reduplicant-shaped, including a bare "~"/"~~" with no copied material.
  // templateKey keeps the "~" marker(s) so prefix/suffix/infix stay
  // distinct — SuiteCore.formKey would strip them and collapse "~V" and
  // "V~" to the same key, which is exactly wrong here.
  SuiteCore.classifyReduplicantToken = function(token, graphemes, phonemeClassOverrides){
    const t = SuiteCore.nfc(token || '');
    if(t.length < 2) return null;
    const leading = t[0] === '~';
    const trailing = t[t.length - 1] === '~';
    if(!leading && !trailing) return null;
    let copied, position;
    if(leading && trailing){
      if(t.length <= 2) return null;
      copied = t.slice(1, -1); position = 'infix';
    } else if(leading){
      copied = t.slice(1); position = 'suffix';
    } else {
      copied = t.slice(0, -1); position = 'prefix';
    }
    if(!copied) return null;
    const skeleton = SuiteCore.cvSkeleton(copied, graphemes, phonemeClassOverrides);
    if(!skeleton) return null;
    const templateKey = position === 'infix' ? ('~' + skeleton + '~')
      : position === 'suffix' ? ('~' + skeleton)
      : (skeleton + '~');
    return { position, templateKey, copied };
  };

  // True if `str` is ALREADY an abstract template key ("~V", "CV~", "~CV~")
  // rather than a concrete typed example ("~a", "koo"). A curated redup
  // entry's `form` is normalized to its template key on save (Lexicon's
  // fieldChanged, 2026-08-06) — reopening it for editing shows that
  // abstract form back in the Form field, so callers that resolve "whatever
  // is currently typed" into a template need to recognize this shape too,
  // not just run it back through classifyReduplicantToken (which would
  // misclassify "V"/"C" as literal graphemes instead of recognizing them as
  // already-resolved skeleton symbols).
  SuiteCore.isReduplicantTemplateKey = function(str){
    return /^(~[CV]+|[CV]+~|~[CV]+~)$/.test(str || '');
  };

  // Reduplicant lexicon index: keyed by the literal template string (e.g.
  // "~V", "CV~", "~CV~"), NOT run through formKey/buildLexiconIndex — see
  // classifyReduplicantToken's comment on why formKey is the wrong
  // normalization here. Only entries with type 'redup' and a non-empty
  // template participate.
  SuiteCore.buildReduplicantIndex = function(entries){
    const byKey = new Map();
    (entries || []).forEach(e=>{
      if(e.type !== 'redup' || !e.template) return;
      const key = e.template;
      if(!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(e);
    });
    return byKey;
  };

  // The default gloss for a reduplicant token (e.g. "~a"), or null if the
  // token isn't reduplicant-shaped or its template isn't curated yet.
  // `lang` (2026-08-06) mirrors lexiconGlossOptionsFor's own signature —
  // a redup entry can carry per-language glosses (glossesByLang) same as
  // any other lexicon entry, needed for deriveGlossForToken's
  // other-language gloss-line view to render a reduplicant correctly
  // instead of silently falling back to the primary-language gloss.
  SuiteCore.reduplicantGlossFor = function(index, token, graphemes, phonemeClassOverrides, lang){
    const info = SuiteCore.classifyReduplicantToken(token, graphemes, phonemeClassOverrides);
    if(!info) return null;
    const entries = index && index.get(info.templateKey);
    if(!entries || !entries.length) return null;
    const entry = entries[0];
    if(lang && entry.glossesByLang && entry.glossesByLang[lang] && entry.glossesByLang[lang].length){
      return entry.glossesByLang[lang][0];
    }
    const opts = entry.glossOptions || (entry.gloss ? [entry.gloss] : []);
    return opts.length ? opts[0] : null;
  };

  // Automatic reduplication detection for an UNSEGMENTED surface word
  // (2026-08-06) — closes a real gap: everything above this point only
  // handles a token once a human has ALREADY typed "kë ~ë" by hand. The
  // automatic whole-word suggester (segmentByLexicon) has no concept of
  // "~" at all, so a word like "këë" — root "kë" ("eat") plus its own
  // final vowel copied — gets offered purely as an ACCIDENTAL two-root
  // compound ("kë- -ë" / "eat-take") whenever the copied vowel also
  // happens to spell some unrelated curated root ("ë" = "take"/"get" in
  // this project). Reported directly: "the homophony should not be a
  // problem since ~V is a reduplication always... it shouldn't even be
  // suggesting it in this location."
  //
  // The key check that makes this safe rather than a guess: TRUE
  // reduplication means the copied material is IDENTICAL to the segment(s)
  // immediately adjacent to it in the base — not just "the word happens to
  // end in a vowel." So this only fires when that identity actually holds
  // (segs[-1] literally equals segs[-2] for a "~V" template, etc.), which
  // is exactly what makes "këë" (kë + ë, an echo) a real match while an
  // unrelated word that merely ends in a vowel is not. Only tries
  // TEMPLATES THE PROJECT HAS ALREADY CURATED (redupIndex) — same
  // derived-from-curated-data discipline as segmentByLexicon itself; nothing
  // is invented for a template no one has taught yet. Infixing reduplicants
  // ("~x~") are skipped — geometrically more work to locate inside a word,
  // and not attested in any project so far.
  //
  // Returns an array (usually 0 or 1 entries) of {templateKey, position,
  // root, copy} — `root` and `copy` are surface substrings, case preserved.
  //
  // Tries TWO segmentations, not just one — a real ambiguity this project's
  // own data surfaced: a "V" (single-vowel) copy right after a root ending
  // in the SAME vowel produces exactly the doubled-letter spelling this
  // project already reserves for vowel LENGTH ("ëë" is configured as one
  // long-vowel grapheme). Under the normal digraph-greedy segmentation,
  // "këë" tokenizes as ["k","ëë"] — one long vowel, not two copies of a
  // short one — so the copy-identity check never even gets to compare two
  // equal segments. The doubled-letter length convention and the
  // "reduplicate the final vowel" convention are two unrelated facts about
  // this orthography that happen to collide in spelling; a second pass
  // that specifically excludes any digraph made of one letter repeated
  // (aa, ëë, öö, …) — letting THOSE stretches fall back to one-codepoint-
  // per-segment — lets the identity check see "k","ë","ë" instead, without
  // touching how digraphs are segmented anywhere else in the suite.
  SuiteCore.detectReduplication = function(form, graphemes, phonemeClassOverrides, redupIndex){
    if(!redupIndex || !redupIndex.size) return [];
    const cleanForm = SuiteCore.stripEdgePunct(SuiteCore.nfc(form));
    const graphemeList = graphemes || [];
    const doubledLetterDigraphs = graphemeList.filter(g => g.length === 2 && g[0] === g[1]);
    const segmentationsToTry = [SuiteCore.segmentIntoGraphemes(cleanForm, graphemeList)];
    if(doubledLetterDigraphs.length){
      const altGraphemes = graphemeList.filter(g => !doubledLetterDigraphs.includes(g));
      segmentationsToTry.push(SuiteCore.segmentIntoGraphemes(cleanForm, altGraphemes));
    }

    const matches = [];
    const seen = new Set();
    segmentationsToTry.forEach(segs=>{
      if(segs.length < 2) return;
      redupIndex.forEach((entries, templateKey)=>{
        if(!entries || !entries.length) return;
        const isSuffix = templateKey.startsWith('~') && !templateKey.endsWith('~');
        const isPrefix = templateKey.endsWith('~') && !templateKey.startsWith('~');
        if(!isSuffix && !isPrefix) return; // infix: not attempted here
        const skeleton = isSuffix ? templateKey.slice(1) : templateKey.slice(0, -1);
        const copyLen = skeleton.length;
        if(!copyLen || segs.length < copyLen * 2) return;
        let match = null;
        if(isSuffix){
          const tail = segs.slice(segs.length - copyLen);
          const preceding = segs.slice(segs.length - 2 * copyLen, segs.length - copyLen);
          if(tail.join('').toLowerCase() === preceding.join('').toLowerCase()){
            match = { templateKey, position: 'suffix', root: segs.slice(0, segs.length - copyLen).join(''), copy: tail.join('') };
          }
        } else {
          const head = segs.slice(0, copyLen);
          const following = segs.slice(copyLen, copyLen * 2);
          if(head.join('').toLowerCase() === following.join('').toLowerCase()){
            match = { templateKey, position: 'prefix', root: segs.slice(copyLen).join(''), copy: head.join('') };
          }
        }
        if(match){
          const dedupeKey = match.templateKey + '|' + match.position + '|' + match.root + '|' + match.copy;
          if(!seen.has(dedupeKey)){ seen.add(dedupeKey); matches.push(match); }
        }
      });
    });
    return matches;
  };

  /* ================= infixes =================
     An infix is marked inline within a single surface token, angle
     brackets around the infixed material at its position in the stem:
     "b<um>ili" — the stem is what's OUTSIDE the brackets, concatenated
     ("bili"), the infix is what's INSIDE ("um"). This mirrors OWL.java's
     own convention (INFIX_PATTERN there), kept unchanged since it's
     already a Leipzig-adjacent standard for infixes and there's no reason
     to invent a different one. Unlike reduplication's abstract "~"-marked
     template (an infix's copied material is drawn from the base itself),
     an infix is a literal, INVARIANT string curated once — "um" always
     glosses the same way wherever it turns up — so there's no CV-skeleton
     abstraction step here: the infix's own spelling IS its lexicon key. */

  // b<um>ili -> { stem:"bili", infix:"um", before:"b", after:"ili" }.
  // Returns null for a token with no matched "<...>" pair, or an empty
  // bracket/empty stem (an infix with nothing before or after it isn't an
  // infix — that's just the bare bracketed string itself).
  SuiteCore.INFIX_PATTERN = /^(.*?)<([^<>]+)>(.*)$/;
  SuiteCore.parseInfixToken = function(token){
    const t = SuiteCore.nfc(token || '');
    const m = SuiteCore.INFIX_PATTERN.exec(t);
    if(!m) return null;
    const infix = m[2];
    const stem = m[1] + m[3];
    if(!infix || !stem) return null;
    return { stem, infix, before: m[1], after: m[3] };
  };

  // Infix lexicon index: keyed the same way buildLexiconIndex keys plain
  // morphs (formKey — NFC, edge-punctuation-stripped, lowercased) — over
  // BOTH form and allomorphs, same as buildLexiconIndex, since an infix can
  // have its own phonologically-conditioned allomorphs same as any other
  // morpheme (e.g. an infix surfacing as "um" in one environment and "in"
  // in another, both the same morpheme). Unlike a reduplicant template
  // ("~V"), an infix's own spelling carries no marker character formKey
  // would corrupt, so it's safe to key this exactly like the plain
  // lexicon — which is what lets ordinary lexiconFindMorph/lexiconGlossFor/
  // lexiconGlossOptionsFor work against this index directly, with no
  // infix-specific lookup helper needed. Only entries with type 'infix'
  // participate (kept in their own Map, not merged into buildLexiconIndex's,
  // for the same reason redup gets its own — see buildLexiconIndex's
  // comment).
  SuiteCore.buildInfixIndex = function(entries){
    const byKey = new Map();
    (entries || []).forEach(e=>{
      if(e.type !== 'infix') return;
      const keys = new Set([e.form, ...(e.allomorphs || [])].map(SuiteCore.formKey).filter(Boolean));
      keys.forEach(key=>{
        if(!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(e);
      });
    });
    return byKey;
  };

  // The default gloss for an infixed token (e.g. "b<um>ili"), or null if
  // the token isn't infix-shaped, its stem isn't a curated lexicon entry,
  // or its infix isn't curated yet. Unlike a reduplicant (whose "stem" is
  // always a separate token elsewhere in the sentence, glossed
  // independently), an infix's stem is FUSED into the same token as the
  // infix — so this resolves BOTH halves itself: stem via the plain
  // lexicon (lexIndex), infix via the infix lexicon (infixIndex). Both are
  // formKey-keyed, so lexiconGlossFor's existing per-language fallback
  // logic is reused as-is for each half rather than duplicated here.
  SuiteCore.infixGlossFor = function(infixIndex, lexIndex, token, lang){
    const info = SuiteCore.parseInfixToken(token);
    if(!info) return null;
    const stemGloss = SuiteCore.lexiconGlossFor(lexIndex, info.stem, lang);
    if(!stemGloss) return null;
    const infGloss = SuiteCore.lexiconGlossFor(infixIndex, info.infix, lang);
    if(!infGloss) return null;
    return stemGloss + '<' + infGloss + '>';
  };

  /* ================= stem alternation (2026-08-09) =================
     Grammatical stem alternation — a stem's own shape changes to convey a
     grammatical value (aspect, in the motivating real data: xuka="eat" in
     COMPLETIVE vs. xuk'a="eat" in INCOMPLETIVE), as opposed to Wao's
     onset-nasalization case where the shape varies but the MEANING never
     does. Deliberately excluded from `allomorphs`/`buildLexiconIndex` (see
     that function's own comment) for exactly that reason: an allomorph
     lookup returns one shared gloss no matter which shape matched; a stem
     alternant's whole reason for existing is that the matched shape
     determines part of the gloss. Kept in its own index, same pattern as
     redup/infix, rather than teaching the general lexicon path a second,
     conditional notion of "gloss." No auto-apply/confidence-scoring layer
     here (unlike onset nasalization) — a curated `type:'stemAlt'` entry's
     `alternants` list is asserted fact, entered by a human who already
     knows the paradigm; there's nothing to discover or confirm against a
     corpus the way a phonologically-conditioned rule needs to be. */

  // formKey(alternant surface form) -> [{entry, tag}, …]. An array per key
  // (not a single value) for the same reason buildLexiconIndex/
  // buildInfixIndex keep arrays — a surface form COULD collide across two
  // different stemAlt entries, or (deliberately allowed, see the entry
  // schema comment) the same entry can list the identical form twice under
  // different curation passes; first-match resolution (stemAltGlossFor)
  // mirrors lexiconFindMorph's own "first match, homograph disambiguation
  // is a further-refinement, not a v1 requirement" stance.
  SuiteCore.buildStemAltIndex = function(entries){
    const byKey = new Map();
    (entries || []).forEach(e=>{
      if(e.type !== 'stemAlt') return;
      (e.alternants || []).forEach(alt=>{
        const key = SuiteCore.formKey(alt.form);
        if(!key) return;
        if(!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ entry: e, tag: alt.tag });
      });
    });
    return byKey;
  };

  // The assembled gloss for a specific attested stem-alternant shape, e.g.
  // stemAltGlossFor(idx, "xuka") -> "eat.COMP" — the entry's own base
  // meaning joined to the tag THIS shape specifically carries, with "."
  // (never "/" — a deliberate suite-wide convention, not a per-project
  // setting: "/" already means "either gloss applies" elsewhere in this
  // suite's own Leipzig-style output, e.g. a polysemous root's glossOptions
  // joined for display, so reusing it here for an unrelated relationship —
  // "this specific shape has this specific value" — would be genuinely
  // ambiguous, not just a style preference). Returns null if the token
  // isn't a known alternant of any curated entry, or the bare base gloss if
  // an entry is curated with no gloss text at all yet (nothing to append
  // the tag onto meaningfully).
  SuiteCore.stemAltGlossFor = function(stemAltIndex, token, lang){
    const key = SuiteCore.formKey(token);
    if(!key || !stemAltIndex || !stemAltIndex.has(key)) return null;
    const hit = stemAltIndex.get(key)[0];
    const e = hit.entry;
    const base = (lang && e.glossesByLang && e.glossesByLang[lang] && e.glossesByLang[lang].length)
      ? e.glossesByLang[lang][0]
      : (e.glossOptions[0] || '');
    if(!base) return null;
    return hit.tag ? (base + '.' + hit.tag) : base;
  };

  // Automatic infix detection for an UNSEGMENTED surface word — mirrors
  // detectReduplication's role: the automatic whole-word suggester has no
  // concept of "<...>" at all, so an infixed word is otherwise only
  // recognized once a human has already typed "b<um>ili" by hand. Unlike
  // reduplication (whose copied material only ever needs to match an
  // adjacent stretch of the SAME word), an infix is a literal, curated
  // string that could coincidentally occur inside an unrelated root — so
  // this requires BOTH (1) the infix is attested as a strictly interior
  // substring (never word-initial or word-final — OWL.java's own safety
  // rule for exactly this reason), AND (2) the reassembled stem (the word
  // with that substring excised) is ITSELF a known root in the plain
  // lexicon. That second check is stricter than OWL.java's — which had a
  // bare substring scan with nothing to rule out an accidental interior
  // match — and follows the same derived-from-curated-data discipline
  // segmentByLexicon and detectReduplication already use elsewhere: nothing
  // is invented for a stem no one has curated. Returns an array (usually 0
  // or 1 entries) of {infix, stem, before, after} — case preserved.
  SuiteCore.detectInfix = function(form, infixIndex, lexIndex){
    if(!infixIndex || !infixIndex.size) return [];
    const cleanForm = SuiteCore.stripEdgePunct(SuiteCore.nfc(form));
    const w = cleanForm.toLowerCase();
    const matches = [];
    const seen = new Set();
    infixIndex.forEach((entries, inf)=>{
      if(!entries || !entries.length || !inf) return;
      let pos = 0;
      while((pos = w.indexOf(inf, pos)) !== -1){
        if(pos > 0 && pos + inf.length < w.length){
          const before = cleanForm.slice(0, pos);
          const after = cleanForm.slice(pos + inf.length);
          const stem = before + after;
          if(lexIndex && SuiteCore.lexiconFindMorph(lexIndex, stem)){
            const dedupeKey = inf + '|' + stem;
            if(!seen.has(dedupeKey)){ seen.add(dedupeKey); matches.push({ infix: inf, stem, before, after }); }
          }
        }
        pos++;
      }
    });
    return matches;
  };

  /* ================= learned affix rules: onset nasalization (2026-08-08) =================
     The first slice of "fuller autogloss" (§6/§0 item 7) — reduplication and
     infixes were already learned from curated lexicon shapes; this is the
     next piece: an affix's OWN allomorphs are currently a flat, hand-typed
     list with no notion of WHY a given shape appears, so the segmenter can
     recognize a shape once someone has typed it (or added it to the
     lexicon) but can never predict an unattested one, no matter how
     regular the pattern. Grounded directly in this project's own curated
     lexicon: at least 19 different affixes show the exact same alternation
     — a plain oral onset (t/k/d/g/b/y…) versus a nasalized or prenasalized
     counterpart (nt/nk/n/ng/m/ñ…) — which is exactly the kind of
     across-many-affixes regularity a RULE should capture once, rather than
     re-teaching per affix. Deliberately scoped to just this one pattern for
     now (not a general-purpose conditioning-environment learner) — see the
     design-doc entry for why.

     Discovery reuses the SAME curated data every other IPA/phonology
     feature in this suite already draws on — `phonemeFeatures`'s `orality`
     axis (already marking ä/ë/ï/ö as nasal vowels vs. a/e/i/o oral, and
     m/n/ñ as nasal consonants vs. oral stops) — as the sole classifier, so
     no letter-correspondence table is hardcoded here; the correspondence
     is discovered per-project from whatever's actually curated. */

  // Aligns two allomorph strings by their longest common SUFFIX, returning
  // the differing HEAD material on each side plus the shared tail — e.g.
  // ("te","nte") -> {headA:"", headB:"n", tail:"te"}; ("dä","nä") ->
  // {headA:"d", headB:"n", tail:"ä"}. Returns null when there's no shared
  // tail at all, or the heads are identical (not a real alternation) --
  // most cross-pairs of an entry's allomorph list simply won't align
  // cleanly, which is expected and fine.
  SuiteCore.alignAllomorphHeads = function(a, b){
    let i = a.length, j = b.length;
    while(i > 0 && j > 0 && a[i-1] === b[j-1]){ i--; j--; }
    const tail = a.slice(i), headA = a.slice(0, i), headB = b.slice(0, j);
    if(!tail || headA === headB) return null;
    return { headA, headB, tail };
  };

  // Does the B side of an aligned pair look like a NASALIZED version of the
  // A side, purely by checking each head's own final segment's curated
  // `orality` feature (never a hardcoded letter list)? Two shapes: an
  // inserted nasal onset where A had none ("" -> "n"/"m", prenasalization),
  // or A's onset replacing an oral segment with a nasal one at the same
  // juncture ("d" -> "n", "b" -> "m", "g" -> "ng", "y" -> "ñ", full
  // nasalization/spirantization) — both are the same underlying process
  // (nasal spread) just landing on a stop vs. being realized as a cluster.
  SuiteCore.headLooksNasalized = function(headA, headB, phonemeFeatures, graphemes){
    const lastFeat = head => {
      if(!head) return null;
      const segs = SuiteCore.segmentIntoGraphemes(head, graphemes || []);
      return (phonemeFeatures || {})[SuiteCore.nfc(segs[segs.length - 1])] || null;
    };
    const fa = lastFeat(headA), fb = lastFeat(headB);
    if(!headA && headB) return !!(fb && fb.orality === 'nasal');
    if(headA && headB && fa && fb) return fa.orality !== 'nasal' && fb.orality === 'nasal';
    return false;
  };

  // Scans every curated affix entry with 2+ allomorphs and buckets each one
  // showing a nasalized/plain alternation into `nasalForms`/`plainForms`
  // sets, keyed by "<form>:<gloss>" (an entry's own citation form + its
  // primary gloss — stable enough to key a rule by, and human-readable in
  // any report/UI). An entry can and often does contribute more than one
  // pairwise correspondence (e.g. a 5-allomorph entry) — all of them fold
  // into the same two sets for that entry, since it's one rule per entry,
  // not one per pair. An entry with no allomorphs fitting this shape at all
  // contributes nothing (most root entries, and plenty of affixes, won't).
  SuiteCore.buildAffixNasalizationRules = function(lexEntries, phonemeFeatures, graphemes){
    const rules = new Map(); // key -> {gloss, entryForm, nasalForms:Set, plainForms:Set}
    (lexEntries || []).forEach(e=>{
      if(e.type !== 'affix' || !Array.isArray(e.allomorphs) || e.allomorphs.length < 2) return;
      const gloss = (e.glossOptions && e.glossOptions[0]) || e.gloss || '';
      if(!gloss) return;
      const forms = e.allomorphs;
      for(let x = 0; x < forms.length; x++){
        for(let y = 0; y < forms.length; y++){
          if(x === y) continue;
          const pair = SuiteCore.alignAllomorphHeads(forms[x], forms[y]);
          if(!pair) continue;
          if(!SuiteCore.headLooksNasalized(pair.headA, pair.headB, phonemeFeatures, graphemes)) continue;
          const key = e.form + ':' + gloss;
          if(!rules.has(key)) rules.set(key, { gloss, entryForm: e.form, nasalForms: new Set(), plainForms: new Set() });
          const r = rules.get(key);
          r.plainForms.add(SuiteCore.nfc(forms[x]).toLowerCase());
          r.nasalForms.add(SuiteCore.nfc(forms[y]).toLowerCase());
        }
      }
    });
    return rules;
  };

  // Classifies the phonological environment immediately before a suffix —
  // the last grapheme of the PRECEDING MORPH in the same word (Wao/this
  // suite's affixes are all suffixing within a word, never separate
  // clitics needing a cross-word lookahead) — as 'nasal' or 'oral' via the
  // same curated `orality` feature, or null if that segment has no curated
  // feature entry at all (unknown, not evidence either way).
  SuiteCore.classifyPrecedingEnvironment = function(prevMorph, phonemeFeatures, graphemes){
    if(!prevMorph) return null;
    const segs = SuiteCore.segmentIntoGraphemes(SuiteCore.nfc(prevMorph), graphemes || []);
    const feat = (phonemeFeatures || {})[SuiteCore.nfc(segs[segs.length - 1])];
    if(!feat) return null;
    return feat.orality === 'nasal' ? 'nasal' : 'oral';
  };

  // Checks a discovered rule set against every REAL glossed token across the
  // folder's `.gloss.json` sidecars — the actual confidence/exception
  // computation, never trusting the lexicon pairing alone (a curated
  // allomorph list says a shape IS attested somewhere; it says nothing
  // about whether environment reliably predicts it). For every affix rule,
  // tallies a 2x2 table (nasal/oral environment x nasal/plain form used)
  // from real occurrences, then applies the agreed threshold for
  // auto-apply eligibility: real contrastive evidence on BOTH sides (>=2
  // instances each) and ZERO exceptions (100% agreement) — a single
  // lopsided or thin sample (e.g. one attested case) never qualifies no
  // matter how "clean" its lone data point looks, and any genuine
  // counter-example present in today's corpus disqualifies the whole
  // entry rather than being averaged away. Returns a Map keyed the same as
  // `rules`, each entry `{gloss, stats:{nasalEnv:{nasalForm,plainForm},
  // oralEnv:{nasalForm,plainForm}}, qualifies, exceptions:[{textName,
  // sentenceId, word, mb, gl, morph}]}` — exceptions are kept, not
  // discarded, so a report can show exactly what didn't fit.
  SuiteCore.evaluateAffixNasalizationRules = function(rules, glossSidecarsWithNames, phonemeFeatures, graphemes){
    const stats = new Map();
    rules.forEach((r, key) => stats.set(key, {
      gloss: r.gloss,
      nasalEnv: { nasalForm: 0, plainForm: 0 },
      oralEnv: { nasalForm: 0, plainForm: 0 },
      exceptions: []
    }));
    (glossSidecarsWithNames || []).forEach(({ textName, sidecar }) => {
      Object.entries((sidecar && sidecar.sentences) || {}).forEach(([sentenceId, rec]) => {
        (rec.tokens || []).forEach(tok=>{
          if(!tok.mb || !tok.gl) return;
          const mParts = SuiteCore.splitMorphs(tok.mb);
          const gParts = SuiteCore.splitMorphs(tok.gl);
          if(!mParts.length || mParts.length !== gParts.length) return;
          for(let i = 1; i < mParts.length; i++){ // i=0 has no preceding in-word morph
            const m = SuiteCore.nfc(mParts[i]).toLowerCase();
            const g = gParts[i];
            for(const [key, r] of rules.entries()){
              if(r.gloss !== g) continue;
              let form = null;
              if(r.nasalForms.has(m)) form = 'nasalForm';
              else if(r.plainForms.has(m)) form = 'plainForm';
              else continue;
              const env = SuiteCore.classifyPrecedingEnvironment(mParts[i-1], phonemeFeatures, graphemes);
              if(!env) continue;
              const st = stats.get(key);
              st[env === 'nasal' ? 'nasalEnv' : 'oralEnv'][form]++;
              const expected = (env === 'nasal') ? 'nasalForm' : 'plainForm';
              if(form !== expected){
                st.exceptions.push({ textName, sentenceId, word: tok.form, mb: tok.mb, gl: tok.gl, morph: m, env });
              }
              break; // matched one rule, don't double-count against another
            }
          }
        });
      });
    });
    stats.forEach(st=>{
      const a = st.nasalEnv, b = st.oralEnv;
      const hasContrast = (a.nasalForm + a.plainForm) >= 2 && (b.nasalForm + b.plainForm) >= 2;
      const total = a.nasalForm + a.plainForm + b.nasalForm + b.plainForm;
      st.qualifies = hasContrast && total >= 4 && st.exceptions.length === 0;
    });
    return stats;
  };

  // Predicts the surface shape a QUALIFYING rule's affix should take in a
  // given environment — used both to recognize a not-yet-curated shape
  // during segmentation and to explain/preview a rule in a report. Prefers
  // an already-attested shape from the rule's own known sets (most
  // reliable — it's real, curated data); only synthesizes a brand-new shape
  // by re-applying the discovered head/tail transform when nothing already
  // known fits, which is the genuinely-novel-allomorph case this whole
  // mechanism exists for. Returns null if there's not enough information to
  // construct anything (no known pair to derive a transform from).
  SuiteCore.predictAffixNasalization = function(rule, envIsNasal){
    if(!rule) return null;
    const knownSet = envIsNasal ? rule.nasalForms : rule.plainForms;
    if(knownSet && knownSet.size) return Array.from(knownSet)[0]; // already-attested, most reliable
    // No known shape on the requested side for THIS specific entry — by
    // construction, a rule that actually QUALIFIES (evaluateAffixNasalizationRules)
    // always has both sides populated (that's what "real contrast on both
    // sides" means), so this branch is only reachable for a rule that
    // hasn't qualified yet. Deliberately does NOT guess a transform from
    // OTHER affixes' correspondences here — every entry's own head/tail
    // shape is different (insertion for some, full substitution for
    // others, at different places of articulation), and inventing a shape
    // with no supporting evidence for this specific morpheme would violate
    // this project's "never invent unsupported curated-shaped data" rule
    // (§61). Honest "not enough information yet" beats a plausible-looking
    // wrong guess.
    return null;
  };

  /* ================= IPA-style consonant/vowel chart =================
     A phoneme's articulatory features (place, manner, voicing, height,
     backness, roundedness, nasality, length, …) can't be derived from its
     spelling the way vowel/consonant status can — there's no heuristic for
     "which column is ñ in." This is a fully curated layer, and — per the
     2026-08-04 redesign — an OPEN one: a phoneme maps to an arbitrary
     {featureName: value} dict, not a fixed pair of slots. `p` might carry
     {place: bilabial, manner: plosive, voicing: voiceless}; `ĩ` might carry
     {height: close, backness: front, nasality: nasal}. A phoneme absent
     from the map, or missing a particular feature, is simply uncategorized
     for whichever chart axis needs that feature — nothing is guessed or
     silently dropped, so this is adoptable one phoneme/feature at a time.
     Edited via a real modal in Writer (not a single text prompt — an open,
     growing feature set doesn't fit comfortably on one line), which reads
     and writes this structure directly as JS objects; no text parser is
     needed for it the way the flatter digraph/allophone/class lists have. */
  // 'coronal' grouped at the same rank as 'alveolar' (a synonym pair, same
  // mechanism as the height/roundness fix above) — a project may want to
  // collapse alveolar/palatal/etc. into one "coronal" natural-class column
  // rather than separate ones, and that column belongs centrally between
  // bilabial and velar, not sorted to the end as an unrecognized term.
  SuiteCore.IPA_CONSONANT_PLACES = ['bilabial','labiodental','dental',['alveolar','coronal'],'postalveolar','retroflex','palatal','velar','uvular','pharyngeal','glottal'];
  // 'nasal' deliberately excluded here (2026-08-04) — nasality is now its
  // own cross-cutting "orality" feature (see IPA_ORALITY below), the same
  // way voicing already cross-cuts manner rather than being folded into
  // it. A nasal stop like /m/ is manner:plosive + orality:nasal, not a
  // separate manner value — this is what lets a chart put oral and nasal
  // stops in the same "plosive" row, split by orality, instead of nasal
  // consonants living in a manner value nothing else shares. Approximant
  // ordered last per the standard IPA chart layout (oral obstruents/
  // sonorants first, approximants at the bottom).
  SuiteCore.IPA_CONSONANT_MANNERS = ['plosive','affricate','fricative','trill','tap','lateral','approximant'];
  // Each rank position is an array of synonyms (technical IPA term plus the
  // common pedagogical term), not a single string — a project describing
  // heights as "high/mid/low" (very common) only matched "mid" against a
  // close/open-only list, so "high" and "low" fell through to the
  // unranked/alphabetical tail and rows came out "mid, high, low" instead
  // of "high, mid, low". ipaRank below knows how to rank against either a
  // flat string list or one with these synonym groups.
  SuiteCore.IPA_VOWEL_HEIGHTS = [['close','high'], ['close-mid','near-close'], ['mid'], ['open-mid','near-open'], ['open','low']];
  SuiteCore.IPA_VOWEL_BACKNESS = ['front','central','back'];
  SuiteCore.IPA_VOICING = ['voiceless','voiced'];
  // Same synonym-group treatment for the common "round/unround" spelling
  // alongside "rounded/unrounded".
  SuiteCore.IPA_ROUNDING = [['unrounded','unround'], ['rounded','round']];
  SuiteCore.IPA_ORALITY = ['oral','nasal']; // oral ranked above nasal, per the standard chart layout
  SuiteCore.IPA_TENSENESS = ['tense','lax'];
  SuiteCore.IPA_LENGTH = ['short','long']; // short ranked before long, e.g. for a vowel-length feature

  // The feature classes assumed to apply to every phoneme of a given class,
  // shown as permanent (always-visible, non-removable) slots in Writer's
  // phoneme-features modal so a user doesn't have to remember or retype
  // them — "others could be added" beyond these via the existing free-form
  // "+ add feature" row, which is unchanged.
  SuiteCore.STANDARD_CONSONANT_FEATURES = ['manner', 'place', 'voicing', 'orality'];
  SuiteCore.STANDARD_VOWEL_FEATURES = ['height', 'backness', 'frontness', 'roundness', 'tense'];

  // Ranks a label within a canonical IPA ordering (case-insensitive); a
  // label not on the list sorts after every known term, alphabetically
  // among itself — so a chart with a nonstandard label still renders
  // (just pushed to the edge) instead of failing or guessing where it goes.
  // A list entry may be a single string OR an array of synonyms sharing
  // one rank (e.g. ['close','high']) — matches either shape.
  SuiteCore.ipaRank = function(list, label){
    const v = (label || '').trim().toLowerCase();
    const idx = list.findIndex(entry => Array.isArray(entry) ? entry.includes(v) : entry === v);
    return idx === -1 ? list.length : idx;
  };

  // Maps a feature AXIS NAME (e.g. "place", "orality") to its canonical
  // value-ordering list, if it has one — shared by buildIpaChart's row/col/
  // split ordering so all three axes recognize the same vocabulary instead
  // of three separately-hand-written ternary chains. An axis name with no
  // canonical list (a custom feature, or "frontness"/"tense" which have no
  // fixed IPA-standard sequence the way place/manner do) falls back to
  // alphabetical via ipaRank's own empty-list handling.
  SuiteCore.canonicalListForFeature = function(name){
    switch((name || '').trim().toLowerCase()){
      case 'manner': return SuiteCore.IPA_CONSONANT_MANNERS;
      case 'place': return SuiteCore.IPA_CONSONANT_PLACES;
      case 'height': return SuiteCore.IPA_VOWEL_HEIGHTS;
      case 'backness': return SuiteCore.IPA_VOWEL_BACKNESS;
      case 'voicing': return SuiteCore.IPA_VOICING;
      case 'roundness': case 'roundedness': return SuiteCore.IPA_ROUNDING;
      case 'orality': return SuiteCore.IPA_ORALITY;
      case 'tense': case 'tenseness': return SuiteCore.IPA_TENSENESS;
      case 'length': return SuiteCore.IPA_LENGTH;
      default: return [];
    }
  };

  // Resolves a raw curated feature VALUE (e.g. "high", "round") to its
  // canonical representative within whichever list canonicalListForFeature
  // returns for that axis (e.g. "close", "rounded") — the synonym-group
  // lookup ipaRank already does for sorting, reused here so a project's own
  // pedagogical terminology (high/mid/low, round/unround) still resolves
  // correctly when deriving an IPA symbol below, not just when ordering a
  // chart. Returns null for an empty or unrecognized value — deriveIPA
  // treats that as "nothing to render," never a guess.
  SuiteCore.canonicalizeFeatureValue = function(featureName, value){
    const list = SuiteCore.canonicalListForFeature(featureName);
    const v = (value || '').trim().toLowerCase();
    if(!v || !list.length) return null;
    const entry = list.find(e => Array.isArray(e) ? e.includes(v) : e === v);
    if(!entry) return null;
    return Array.isArray(entry) ? entry[0] : entry;
  };

  // Standard IPA base symbols, keyed by the canonical representative values
  // above — covers the common pulmonic-consonant and vowel-chart cells;
  // an unlisted manner/place/height/backness combination (no standard IPA
  // symbol exists, or this table simply doesn't cover an exotic one) is
  // left absent on purpose rather than guessed at.
  const IPA_CONSONANT_TABLE = {
    plosive: {
      bilabial: {voiceless:'p', voiced:'b'},
      labiodental: {voiceless:'p̪', voiced:'b̪'},
      dental: {voiceless:'t̪', voiced:'d̪'},
      alveolar: {voiceless:'t', voiced:'d'},
      retroflex: {voiceless:'ʈ', voiced:'ɖ'},
      palatal: {voiceless:'c', voiced:'ɟ'},
      velar: {voiceless:'k', voiced:'g'},
      uvular: {voiceless:'q', voiced:'ɢ'},
      glottal: {voiceless:'ʔ'},
    },
    affricate: {
      bilabial: {voiceless:'p͡ɸ', voiced:'b͡β'},
      alveolar: {voiceless:'t͡s', voiced:'d͡z'},
      postalveolar: {voiceless:'t͡ʃ', voiced:'d͡ʒ'},
      retroflex: {voiceless:'ʈ͡ʂ', voiced:'ɖ͡ʐ'},
      palatal: {voiceless:'c͡ç', voiced:'ɟ͡ʝ'},
      velar: {voiceless:'k͡x', voiced:'g͡ɣ'},
    },
    fricative: {
      bilabial: {voiceless:'ɸ', voiced:'β'},
      labiodental: {voiceless:'f', voiced:'v'},
      dental: {voiceless:'θ', voiced:'ð'},
      alveolar: {voiceless:'s', voiced:'z'},
      postalveolar: {voiceless:'ʃ', voiced:'ʒ'},
      retroflex: {voiceless:'ʂ', voiced:'ʐ'},
      palatal: {voiceless:'ç', voiced:'ʝ'},
      velar: {voiceless:'x', voiced:'ɣ'},
      uvular: {voiceless:'χ', voiced:'ʁ'},
      pharyngeal: {voiceless:'ħ', voiced:'ʕ'},
      glottal: {voiceless:'h', voiced:'ɦ'},
    },
    trill: {
      bilabial: {voiced:'ʙ', voiceless:'ʙ̥'},
      alveolar: {voiced:'r', voiceless:'r̥'},
      uvular: {voiced:'ʀ', voiceless:'ʀ̥'},
    },
    tap: {
      alveolar: {voiced:'ɾ', voiceless:'ɾ̥'},
      retroflex: {voiced:'ɽ', voiceless:'ɽ̥'},
    },
    lateral: {
      alveolar: {voiced:'l', voiceless:'l̥'},
      retroflex: {voiced:'ɭ'},
      palatal: {voiced:'ʎ'},
      velar: {voiced:'ʟ'},
    },
    approximant: {
      bilabial: {voiced:'w'}, // labial-velar in practice — the overwhelmingly common cross-linguistic case
      labiodental: {voiced:'ʋ'},
      alveolar: {voiced:'ɹ'},
      retroflex: {voiced:'ɻ'},
      palatal: {voiced:'j'},
      velar: {voiced:'ɰ'},
    },
  };
  // Nasal stops get their own dedicated symbols on the real IPA chart
  // rather than a diacritic over the oral series — this suite models
  // orality as cross-cutting manner (see the 2026-08-04 orality-axis
  // entry), so "plosive + nasal orality" is what routes here.
  const IPA_NASAL_TABLE = {
    bilabial:'m', labiodental:'ɱ', dental:'n̪', alveolar:'n',
    retroflex:'ɳ', palatal:'ɲ', velar:'ŋ', uvular:'ɴ',
  };
  const IPA_VOWEL_TABLE = {
    close: {
      front: {unrounded:'i', rounded:'y'},
      central: {unrounded:'ɨ', rounded:'ʉ'},
      back: {unrounded:'ɯ', rounded:'u'},
    },
    'close-mid': {
      front: {unrounded:'e', rounded:'ø'},
      central: {unrounded:'ɘ', rounded:'ɵ'},
      back: {unrounded:'ɤ', rounded:'o'},
    },
    // A project using a common 3-height vowel system (high/mid/low) means
    // the ordinary close-mid vowels by "mid" (Spanish e/o, for instance,
    // are conventionally close-mid, not the rare, diacritic-marked "true
    // mid" vowel) — so "mid" renders identically to "close-mid" here,
    // except in the central column where schwa is the standard choice.
    // Verified against this project's own real data: Wao's e/o (height:
    // "mid", never "close-mid"/"open-mid") now derive as plain e/o rather
    // than the misleadingly narrow e̞/o̞.
    mid: {
      front: {unrounded:'e', rounded:'ø'},
      central: {unrounded:'ə', rounded:'ɵ'},
      back: {unrounded:'ɤ', rounded:'o'},
    },
    'open-mid': {
      front: {unrounded:'ɛ', rounded:'œ'},
      central: {unrounded:'ɜ', rounded:'ɞ'},
      back: {unrounded:'ʌ', rounded:'ɔ'},
    },
    open: {
      // Central-unrounded uses plain 'a' rather than the diaeresis-marked
      // 'ä' (a common IPA convention for "centralized a", but not the only
      // one, and not what most descriptive linguists reach for by default
      // when a language simply has one plain low-central vowel with no
      // front/back contrast at that height) — fixed 2026-08-05 after real
      // project data showed it producing a wrong-looking symbol AND, worse,
      // stacking a second diacritic on top of an already-nasalized vowel
      // at the same height/backness (a genuinely nasalized central-a was
      // rendering as base 'ä' + combining tilde, i.e. two diacritics doing
      // the work of one). See resolveIPA below for the general fix: this
      // table is only ever a DEFAULT now, overridable per phoneme.
      front: {unrounded:'a', rounded:'ɶ'},
      central: {unrounded:'a'},
      back: {unrounded:'ɑ', rounded:'ɒ'},
    },
  };

  // Derives a phoneme's standard IPA symbol from its already-curated
  // feature bundle — the same manner/place/voicing/orality (consonants) or
  // height/backness/roundness/orality/length (vowels) already entered for
  // the chart. A phoneme's IPA transcription is, in the standard
  // feature-based view of phonology, just a fixed rendering of that same
  // bundle, so it's derived here rather than being a second field to
  // hand-type and keep in sync with the features — the same derived-vs-
  // curated rule as everything else (§4b). Missing or unrecognized
  // features (an incomplete phoneme, or a value this table doesn't cover)
  // return null rather than a guessed symbol.
  SuiteCore.deriveIPA = function(features, isVowel){
    if(!features) return null;
    const cf = (name) => SuiteCore.canonicalizeFeatureValue(name, features[name]);
    const orality = cf('orality');
    const length = cf('length');
    let base = null;
    if(isVowel){
      const height = cf('height'), backness = cf('backness'), roundness = cf('roundness');
      if(!height || !backness || !roundness) return null;
      const row = IPA_VOWEL_TABLE[height] && IPA_VOWEL_TABLE[height][backness];
      base = row ? (row[roundness === 'rounded' ? 'rounded' : 'unrounded'] || null) : null;
    }
    let usedDedicatedNasalSymbol = false;
    if(!isVowel){
      const manner = cf('manner'), place = cf('place'), voicing = cf('voicing');
      if(!manner || !place) return null;
      if(orality === 'nasal' && manner === 'plosive'){
        base = IPA_NASAL_TABLE[place] || null;
        usedDedicatedNasalSymbol = true;
      } else {
        const cell = IPA_CONSONANT_TABLE[manner] && IPA_CONSONANT_TABLE[manner][place];
        base = cell ? (cell[voicing === 'voiced' ? 'voiced' : 'voiceless'] || cell.voiced || cell.voiceless || null) : null;
      }
    }
    if(!base) return null;
    let out = base;
    // Nasalization: a dedicated nasal-stop symbol (m/n/ŋ…) already carries
    // nasality on its own — everything else that's nasal (nasal vowels,
    // but also nasalized approximants/fricatives, which real languages do
    // have, and which this project's own data uses for ẅ/ñ) gets the
    // combining tilde instead of silently losing that feature.
    if(orality === 'nasal' && !usedDedicatedNasalSymbol) out += '̃';
    if(length === 'long') out += 'ː'; // IPA length mark
    return out.normalize('NFC');
  };

  // Resolves the IPA symbol actually shown for a phoneme: a curated
  // per-project override if the user has set one, otherwise the
  // feature-derived default from deriveIPA above.
  //
  // Why this exists (2026-08-05): deriveIPA's table encodes ONE common
  // convention per feature-cell, but IPA notation for a given feature
  // bundle is not always a single, universally-agreed symbol — different
  // linguistic traditions, and different individual linguists working on
  // the same language, legitimately choose different symbols for the same
  // phoneme (e.g. plain 'a' vs. centralized 'ä' for a language's one
  // low-central vowel; a dedicated nasal-vowel diacritic vs. a project's
  // own preferred notation). That means the letter-to-IPA correspondence
  // is, like the letter-to-meaning correspondence for a morpheme, a
  // PROJECT-SPECIFIC ANALYTICAL DECISION — something the user decides, not
  // something with one correct algorithmic answer — so it belongs in the
  // derived-vs-curated split as an override-with-a-computed-default, the
  // same pattern already used for phonemeClass (auto-classified, but
  // correctable) rather than being either purely derived or purely
  // hand-typed from scratch every time.
  //
  // `ipaOverrides` is the optional {segment: ipaString} map (this project's
  // `phonemeIPA` settings field); an entry only exists there once a user
  // has actually typed something in the IPA field, so clearing that field
  // back to empty is exactly "go back to the derived default" — there's no
  // separate reset control needed.
  SuiteCore.resolveIPA = function(seg, features, isVowel, ipaOverrides){
    if(ipaOverrides && Object.prototype.hasOwnProperty.call(ipaOverrides, seg)){
      const override = (ipaOverrides[seg] || '').trim();
      if(override) return override.normalize('NFC');
    }
    return SuiteCore.deriveIPA(features, isVowel);
  };

  // Builds a lookup from a phoneme's resolved IPA symbol (SuiteCore.
  // resolveIPA — curated override if the project has set one, else
  // deriveIPA's feature-based default) back to that phoneme's own
  // orthographic label — the machinery behind recognizing a raw
  // IPA-spelled corpus word as the same word as an orthography-curated
  // lexicon entry (the "IPA vs. orthography" design, 2026-08-05 entries
  // above: a linguist's direct IPA transcription and a community-authored
  // practical-orthography spelling both legitimately coexist in the
  // corpus, as-written — this inventory is only ever used for LOOKUP,
  // never to rewrite either spelling).
  //
  // Longest-symbol-first, the same discipline segmentIntoGraphemes already
  // uses for multi-character orthographic segments, since a resolved IPA
  // symbol can itself be more than one Unicode codepoint (a nasalized long
  // vowel is base letter + combining tilde + length mark).
  SuiteCore.buildIPAInventory = function(phonemeFeatures, ipaOverrides, phonemeClassOverrides){
    const phonemeOfIPA = new Map();
    const symbols = [];
    if(phonemeFeatures){
      Object.keys(phonemeFeatures).forEach(seg=>{
        const isVowel = SuiteCore.classifyPhoneme(seg, phonemeClassOverrides) === 'vowel';
        const ipa = SuiteCore.resolveIPA(seg, phonemeFeatures[seg], isVowel, ipaOverrides);
        // First phoneme to claim a symbol wins — a genuine collision (two
        // distinct phonemes resolving to the identical IPA symbol) is a
        // data question the user should resolve with an override, not
        // something this lookup should crash over or silently double-map.
        if(!ipa || phonemeOfIPA.has(ipa)) return;
        phonemeOfIPA.set(ipa, seg);
        symbols.push(ipa);
      });
    }
    symbols.sort((a, b) => b.length - a.length);
    return { symbols, phonemeOfIPA };
  };

  // Greedy longest-match segmentation of a word against a resolved IPA
  // symbol inventory (see buildIPAInventory above) — the IPA-side
  // counterpart to segmentIntoGraphemes. Unlike that function, this does
  // NOT fall back to one-codepoint-per-segment when a position doesn't
  // match: a position with no recognized IPA symbol means the word isn't
  // (fully) written in this project's IPA inventory — a caller needs to
  // know "this word isn't IPA" as sharply as "this word IS IPA," not get
  // back a partial, misleading segmentation.
  SuiteCore.segmentIntoIPA = function(word, ipaInventory){
    if(!ipaInventory || !ipaInventory.symbols.length) return null;
    const w = SuiteCore.nfc(word || '');
    if(!w) return null;
    const out = [];
    let i = 0;
    while(i < w.length){
      const hit = ipaInventory.symbols.find(sym => w.startsWith(sym, i));
      if(!hit) return null;
      out.push(hit);
      i += hit.length;
    }
    return out;
  };

  // Converts an IPA-spelled word to its orthographic equivalent, purely
  // for LOOKUP — never used to rewrite stored corpus text, since both an
  // IPA transcription and an orthography spelling are legitimate,
  // as-written data (see above). A phoneme's own label IS its orthographic
  // spelling by construction (phonemeFeatures is keyed by orthographic
  // segments), so this is just segmentIntoIPA followed by a reverse
  // lookup — no separate orthography table to build or maintain. Returns
  // null if the word can't be fully decomposed into recognized IPA
  // symbols (not IPA, or it uses a phoneme with no features curated yet).
  SuiteCore.ipaWordToOrthography = function(word, ipaInventory){
    const segs = SuiteCore.segmentIntoIPA(word, ipaInventory);
    if(!segs) return null;
    return segs.map(s => ipaInventory.phonemeOfIPA.get(s)).join('');
  };

  // The reverse direction (2026-08-05): renders an ORTHOGRAPHIC word in
  // IPA, for DISPLAY purposes — Glosser's text/segment-line convention
  // toggle, and a lexicon entry's derived IPA field (answers "can I work
  // retrospectively with the IPA features?": yes, this is recomputed from
  // the CURRENT phonemeFeatures/overrides every time it's shown, so every
  // existing entry gets an accurate IPA rendering the moment its letters
  // are curated — no batch migration of lexicon.jsonl needed, ever).
  //
  // Deliberately LENIENT, unlike segmentIntoIPA/ipaWordToOrthography: a
  // grapheme with no curated phonemeFeatures entry (or an incomplete one)
  // renders as itself rather than failing the whole word — a caller here
  // wants a best-effort transcription to look at, not a strict lookup key
  // (that's what segmentIntoIPA is for). Returns {text, complete} —
  // `complete` is false if any grapheme fell back unconverted, so a
  // caller can flag a partial result if it wants to.
  SuiteCore.orthographyWordToIPA = function(word, graphemes, phonemeFeatures, ipaOverrides, phonemeClassOverrides){
    const segs = SuiteCore.segmentIntoGraphemes(word, graphemes || []);
    let complete = true;
    const out = segs.map(seg=>{
      const feats = phonemeFeatures ? phonemeFeatures[seg] : null;
      if(!feats){ complete = false; return seg; }
      const isVowel = SuiteCore.classifyPhoneme(seg, phonemeClassOverrides) === 'vowel';
      const ipa = SuiteCore.resolveIPA(seg, feats, isVowel, ipaOverrides);
      if(!ipa){ complete = false; return seg; }
      return ipa;
    });
    return { text: out.join('').normalize('NFC'), complete };
  };

  // Renders one word in whichever convention the caller asks for
  // ('ipa'|'orth'), auto-detecting which convention the word is ALREADY
  // in first — a stored form can legitimately be either one (that's the
  // whole point of the IPA/orthography design), so this never blindly
  // applies a conversion that would just be a no-op or, worse, garble an
  // already-correct spelling. `ctx` is {graphemes, phonemeFeatures,
  // ipaOverrides, phonemeClassOverrides, ipaInventory} — the same five
  // pieces every caller already has on hand. Used for DISPLAY ONLY, never
  // to rewrite stored text/mb.
  SuiteCore.renderWordAs = function(word, target, ctx){
    if(!word) return word;
    ctx = ctx || {};
    const alreadyIPA = ctx.ipaInventory && !!SuiteCore.segmentIntoIPA(word, ctx.ipaInventory);
    if(target === 'ipa'){
      if(alreadyIPA) return word;
      return SuiteCore.orthographyWordToIPA(word, ctx.graphemes, ctx.phonemeFeatures, ctx.ipaOverrides, ctx.phonemeClassOverrides).text;
    }
    // target === 'orth'
    if(!alreadyIPA) return word;
    const orth = ctx.ipaInventory ? SuiteCore.ipaWordToOrthography(word, ctx.ipaInventory) : null;
    return orth || word;
  };

  // Same idea as renderWordAs, but for a whole morpheme-break LINE
  // ("yewẽmõ -ngã") — converts each hyphen/space-separated morph piece
  // independently and reassembles with the original boundary characters
  // untouched, the same regex-replace-in-place discipline
  // refreshableGloss already uses so spacing/hyphenation is never
  // reshaped, only the morph text itself.
  SuiteCore.renderMbLineAs = function(mb, target, ctx){
    if(!mb) return mb;
    return mb.replace(/[^\s\-=]+/g, tok => SuiteCore.renderWordAs(tok, target, ctx));
  };

  // One-time, self-healing migration for phonemeFeatures data written by
  // the ORIGINAL two-slot IPA dialog (pre-2026-08-04), which stored every
  // phoneme's two axis values under the literal keys "row" and "col" —
  // meaningless labels once the modal displays open, named features, and
  // invisible to buildIpaChart's canonical-order logic (which only
  // recognizes 'manner'/'place'/'height'/'backness'/'voicing'/'roundedness'
  // by name, so a literal "row"/"col" silently fell back to alphabetical
  // sorting). A blind position-based rename (row->manner, col->place) would
  // actually corrupt real data here: the old dialog let a user put ANY
  // distinguishing value in either slot, and real projects used "row" for
  // voicing on some phonemes (p/t/b: voiceless/voiced) and manner on others
  // (k: plosive) — so this instead recognizes each value against the
  // canonical IPA vocabularies and renames the key to whichever axis that
  // value actually belongs to, falling back to the row/col-implied default
  // (manner/place for a consonant, height/backness for a vowel) only when
  // the value isn't a recognized term. Mutates `featuresMap` in place;
  // returns true if anything changed, so a caller that owns the settings
  // file knows to re-save.
  SuiteCore.classifyLegacyAxisValue = function(value, isVowel){
    const v = (value || '').trim().toLowerCase();
    const inList = (list) => list.some(x => Array.isArray(x) ? x.includes(v) : x.toLowerCase() === v);
    if(inList(SuiteCore.IPA_VOICING)) return 'voicing';
    if(inList(SuiteCore.IPA_ROUNDING)) return 'roundness';
    if(inList(SuiteCore.IPA_ORALITY)) return 'orality';
    if(isVowel){
      if(inList(SuiteCore.IPA_VOWEL_HEIGHTS)) return 'height';
      if(inList(SuiteCore.IPA_VOWEL_BACKNESS)) return 'backness';
    } else {
      if(inList(SuiteCore.IPA_CONSONANT_MANNERS)) return 'manner';
      if(inList(SuiteCore.IPA_CONSONANT_PLACES)) return 'place';
    }
    return null;
  };

  SuiteCore.migrateLegacyRowColFeatures = function(featuresMap, classifyFn){
    let changed = false;
    Object.keys(featuresMap || {}).forEach(seg=>{
      const f = featuresMap[seg];
      if(!f || (!('row' in f) && !('col' in f))) return;
      const isVowel = classifyFn(seg) === 'vowel';
      ['row', 'col'].forEach(legacyKey=>{
        if(!(legacyKey in f)) return;
        const value = f[legacyKey];
        const guessed = SuiteCore.classifyLegacyAxisValue(value, isVowel);
        const fallback = legacyKey === 'row' ? (isVowel ? 'height' : 'manner') : (isVowel ? 'backness' : 'place');
        const target = guessed || fallback;
        delete f[legacyKey];
        if(!(target in f)) f[target] = value; // never clobber a genuinely-named feature already present
        changed = true;
      });
    });
    return changed;
  };

  /* ================= shared phoneme inventory =================
     Segments every attested surface form (citation form + allomorphs) of
     every given lexicon entry with the project's digraph list, folds each
     raw segment onto its phoneme via the allophone map, and tallies a
     frequency inventory — the exact computation Analyze's Phonology tab
     needs for its own display, and that Writer's phoneme-feature editor
     also needs just to know which phonemes actually exist to assign
     features to. Factored here (rather than duplicated in both tools) so
     the two can never quietly disagree about what "the inventory" is.
     Entirely derived, never persisted — callers are responsible for any
     entry-level filtering (e.g. excluding loanwords) before calling this,
     since that policy differs by use case. */
  SuiteCore.buildPhonemeInventory = function(entries, graphemes, allophones){
    const inventory = new Map(); // phoneme -> {count, forms:Set(<=8 example words), spellings:Set(raw segment spellings attested)}
    const surfaceForms = [];     // flat list of every entry's every attested form, PHONEMICIZED

    (entries || []).forEach(e=>{
      const glossLabel = (e.glossOptions && e.glossOptions[0]) || e.gloss || '';
      const label = e.form + (glossLabel ? ' ‘' + glossLabel + '’' : '');
      const forms = Array.from(new Set([e.form, ...(e.allomorphs || [])].filter(Boolean)));
      forms.forEach(form=>{
        const rawSegments = SuiteCore.segmentIntoGraphemes(form, graphemes);
        const phonemes = rawSegments.map(seg=>{
          const phoneme = SuiteCore.phonemeOf(seg, allophones);
          if(!inventory.has(phoneme)) inventory.set(phoneme, { count: 0, forms: new Set(), spellings: new Set() });
          const rec = inventory.get(phoneme);
          rec.count++;
          if(rec.forms.size < 8) rec.forms.add(form);
          rec.spellings.add(seg);
          return phoneme;
        });
        // Minimal pairs and every other downstream comparison run on
        // `phonemes`, never `rawSegments` — a raw allophone spelling
        // should never surface in a "contrast" once mapped onto its
        // phoneme.
        //
        // `isCitation` (2026-08-06): true only for the entry's own `form`,
        // false for every allomorph. A minimal pair is supposed to show
        // that swapping ONE PHONEME changes the WORD — allomorphs are the
        // opposite claim (the SAME morpheme surfacing differently), so
        // "möno" vs. its own allomorph "mono" was showing up as if it were
        // a contrast between two words, when it's actually one word
        // varying. The pre-existing `entryId` guard in findMinimalPairs
        // only catches two ALLOMORPHS OF THE SAME ENTRY being compared to
        // each other — it doesn't stop an allomorph of entry A from being
        // compared against entry B's citation form (or another entry's
        // allomorph), which is just as much not-a-contrast. Callers doing
        // minimal-pairs analysis should filter to `isCitation` forms only;
        // the phoneme inventory/frequency counts below intentionally keep
        // counting every attested allomorph too — more attestations is a
        // better frequency picture, a different question from "is this
        // pair contrastive."
        surfaceForms.push({ form, segments: phonemes, entryId: e.id, entryLabel: label, isCitation: form === e.form });
      });
    });

    return { inventory, surfaceForms };
  };

  SuiteCore.parsePhonemeClassMap = function(text){
    const map = {};
    (text || '').split(',').forEach(pair=>{
      const parts = pair.split(':');
      if(parts.length !== 2) return;
      const seg = SuiteCore.nfc(parts[0].trim());
      const cls = parts[1].trim().toLowerCase();
      if(seg && (cls === 'vowel' || cls === 'consonant')) map[seg] = cls;
    });
    return map;
  };

  SuiteCore.serializePhonemeClassMap = function(map){
    return Object.entries(map || {}).map(([seg, cls]) => seg + ':' + cls).join(', ');
  };

  // All gloss options for a morph in a given language, most-preferred
  // first — falls back to the primary options when that language has none.
  // Empty array if the lexicon doesn't know the morph.
  SuiteCore.lexiconGlossOptionsFor = function(index, morph, lang){
    const entry = SuiteCore.lexiconFindMorph(index, morph);
    if(!entry) return [];
    if(lang && entry.glossesByLang && entry.glossesByLang[lang] && entry.glossesByLang[lang].length){
      return entry.glossesByLang[lang].slice();
    }
    return (entry.glossOptions || []).slice();
  };

  // The single default gloss for a morph (first option), or null.
  SuiteCore.lexiconGlossFor = function(index, morph, lang){
    const opts = SuiteCore.lexiconGlossOptionsFor(index, morph, lang);
    return opts.length ? opts[0] : null;
  };

  SuiteCore.parseLexiconJsonl = function(text){
    const entries = [];
    (text || '').split('\n').forEach(line=>{
      line = line.trim();
      if(!line) return;
      try{
        const parsed = JSON.parse(line);
        if(parsed && typeof parsed === 'object') entries.push(SuiteCore.normalizeLexEntry(parsed));
      }catch(e){ /* one bad line loses one entry, never the file */ }
    });
    return entries;
  };

  SuiteCore.buildLexiconJsonl = function(entries){
    return (entries || []).map(e => JSON.stringify(SuiteCore.serializeLexEntry(e))).join('\n')
      + (entries && entries.length ? '\n' : '');
  };

  // Rejected analyses: a small persisted "don't suggest this again" list,
  // corpus-wide (like the lexicon, not per-text) since the suggestions it
  // suppresses — a lexicon-derived segmentation, or a corpus-memory
  // combination — are themselves recomputed fresh from the whole corpus,
  // not stored per text. Keyed by formKey(word) -> the exact {mb, gl}
  // pairs explicitly rejected for that word. Deliberately narrow: rejecting
  // one wrong candidate (e.g. "ñowo-kë"/"now-eat") doesn't block a
  // DIFFERENT hypothesis for the same word from being offered later — only
  // that exact pairing is suppressed. This exists because clearing a token
  // back to its bare unsegmented form is indistinguishable, in both memory
  // and on disk, from a token nobody has looked at yet (glossTokenIsEmpty
  // treats both as empty) — so without a separate durable "no, not that"
  // record, the same wrong suggestion just comes back on the next render.
  SuiteCore.REJECTED_FILE = 'rejected-analyses.json';

  // Composite membership key for a {mb, gl} pair. Uses a NUL control
  // character as the delimiter (never appears in typed morpheme/gloss
  // text) rather than a space, since mb/gl themselves routinely contain
  // spaces ("ñowo -kë").
  function rejectedKey(mb, gl){ return (mb || '').trim() + ' ' + (gl || '').trim(); }

  SuiteCore.parseRejectedAnalyses = function(text){
    const map = new Map();
    try{
      const obj = JSON.parse(text || '{}');
      Object.entries(obj || {}).forEach(([key, list])=>{
        const set = new Set((list || []).map(p => rejectedKey(p.mb, p.gl)));
        if(set.size) map.set(key, set);
      });
    }catch(e){ /* missing/corrupt file — start empty rather than crash */ }
    return map;
  };

  SuiteCore.serializeRejectedAnalyses = function(map){
    const obj = {};
    (map || new Map()).forEach((set, key)=>{
      const list = Array.from(set).map(s=>{
        const i = s.indexOf(' ');
        return { mb: s.slice(0, i), gl: s.slice(i + 1) };
      });
      if(list.length) obj[key] = list;
    });
    return JSON.stringify(obj, null, 2);
  };

  SuiteCore.isAnalysisRejected = function(map, formKey, mb, gl){
    const set = map && map.get(formKey);
    if(!set) return false;
    return set.has(rejectedKey(mb, gl));
  };

  SuiteCore.rejectAnalysis = function(map, formKey, mb, gl){
    if(!formKey) return;
    if(!map.has(formKey)) map.set(formKey, new Set());
    map.get(formKey).add(rejectedKey(mb, gl));
  };

  SuiteCore.unrejectAnalysis = function(map, formKey, mb, gl){
    const set = map && map.get(formKey);
    if(!set) return;
    set.delete(rejectedKey(mb, gl));
    if(!set.size) map.delete(formKey);
  };

  // Allomorph-aware lookup index: every allomorph of every entry maps to
  // its entry, so "bo" and "mo" both resolve to the one 1SG morpheme.
  // Keys are formKey-normalized (edge punctuation stripped, lowercased).
  // type:'redup' entries are excluded — formKey strips the "~" marker that
  // makes a reduplicant template meaningful (see
  // classifyReduplicantToken's comment), so they'd collide here under the
  // wrong key. They live in buildReduplicantIndex instead.
  // type:'infix' entries are also excluded (2026-08-07) — an infix's
  // `form` is a bare morpheme string like "um" with no marker of its own,
  // so formKey wouldn't corrupt it the way it does a redup template, but
  // mixing it into the plain lexicon would still be wrong: a whole-word
  // lookup for a word that happens to equal a curated infix string (or an
  // allomorph clash) has no business resolving to the infix entry. They
  // live in buildInfixIndex instead.
  // type:'stemAlt' entries are also excluded (2026-08-09) — for the same
  // underlying reason as redup/infix, just a different mechanism: this
  // index resolves a matched form straight to `entry.glossOptions[0]`,
  // which for a stemAlt entry is only the entry's shared BASE meaning
  // ("eat"), not the grammatically-specific gloss a given attested
  // alternant actually carries ("eat.COMP" vs "eat.ICOMP"). Looking a
  // stemAlt entry up here would silently return the wrong (under-specified,
  // and sometimes outright wrong-aspect) gloss regardless of which shape
  // was actually typed. They live in buildStemAltIndex instead.
  SuiteCore.buildLexiconIndex = function(entries){
    const byKey = new Map();
    (entries || []).forEach(e=>{
      if(e.type === 'redup' || e.type === 'infix' || e.type === 'stemAlt') return;
      const keys = new Set([e.form, ...e.allomorphs].map(SuiteCore.formKey).filter(Boolean));
      keys.forEach(k=>{
        if(!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(e);
      });
    });
    return byKey;
  };

  // Lexicon-first morph lookup: returns the entry (first match) or null.
  // NOTE: a surface form can legitimately have MULTIPLE lexicon entries —
  // true homographs, e.g. Wao "ke" is a root ('do') AND two unrelated bound
  // affixes ('-ke' FUT.IRR, '-ke' LIMIT). This function is for callers that
  // only need one representative entry (e.g. a simple gloss lookup); when
  // the distinction between homograph senses matters, use
  // lexiconFindAllMorphs instead and disambiguate explicitly.
  SuiteCore.lexiconFindMorph = function(index, morph){
    const key = SuiteCore.formKey(morph);
    if(!key || !index.has(key)) return null;
    return index.get(key)[0];
  };

  // All lexicon entries sharing a surface form/allomorph (its full homograph
  // set), or [] if the lexicon doesn't know the morph at all.
  SuiteCore.lexiconFindAllMorphs = function(index, morph){
    const key = SuiteCore.formKey(morph);
    if(!key || !index.has(key)) return [];
    return index.get(key);
  };

  // Diagnostic: explains why a word does or doesn't segment against the
  // lexicon. Returns the word's exact characters (with Unicode codepoints,
  // so homoglyphs / hidden characters / normalization issues become
  // visible) and, at every position, which lexicon morphemes match there.
  // This is the "why isn't this glossing?" tool — no guessing, just the
  // raw truth of what the matcher sees.
  SuiteCore.explainWord = function(index, form){
    const s = SuiteCore.stripEdgePunct(SuiteCore.nfc(form));
    const chars = Array.from(s).map(ch => ({
      ch,
      cp: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    }));
    const n = s.length;
    const matchesByPos = [];
    for(let pos = 0; pos < n; pos++){
      const matches = [];
      index.forEach((entries, k)=>{
        const len = k.length;
        if(!len || pos + len > n) return;
        if(s.substr(pos, len).toLowerCase() === k){
          // Show EVERY homograph sense at this key, not just one — a
          // surface form can have multiple genuinely different lexicon
          // entries (e.g. Wao "ta" root "leave" vs. "-ta" affix PST.REC).
          entries.forEach(entry=>{
            matches.push({
              morph: k, len,
              gloss: (entry.glossOptions && entry.glossOptions[0]) || entry.gloss || '',
              type: entry.type
            });
          });
        }
      });
      matches.sort((a, b) => b.len - a.len);
      matchesByPos.push({ pos, matches });
    }
    return { form: s, chars, matchesByPos, segmentations: SuiteCore.segmentByLexicon(index, form) };
  };

  // Segments a surface word into a sequence of KNOWN lexicon morphemes and
  // returns each full segmentation as a canonical { mb, gl } analysis. This
  // is the durable counterpart to corpus-derived word analyses: because bo
  // and tö are curated lexicon entries, "botö" can always be offered as
  // "bo- tö / 1SG- pronoun" even if no glossed text currently contains that
  // analysis. Only multi-morph splits are returned (a whole-word match is
  // the unsegmented case, handled elsewhere). Bounded so an ambiguous or
  // long word can't blow up: caps on result count, morph count, and word
  // length. Matches are case-insensitive; the mb preserves surface case.
  SuiteCore.segmentByLexicon = function(index, form, opts){
    opts = opts || {};
    // Bugfix (2026-08-07): this was 4. `search()` below is a depth-first
    // walk that returns as soon as it has collected `maxResults` full
    // segmentations — and `matchesAt` always tries a position's homograph
    // senses in the SAME fixed order every time (whichever entry sorts
    // first at that key, in practice the lexicon file's own entry order,
    // since ties in `len` are otherwise stable). For a word with more than
    // one ambiguous position, that means the search can commit to the
    // FIRST-tried sense at an early position and never backtrack to its
    // other sense at all, because it already satisfied the cap by varying
    // only later positions first — a real, reported case, not a hypothetical
    // one: "mönkebiïmpa" (mö -nke -bi -ï -mpa, "sleep-FUT.IRR-2SG-UG-DECL")
    // has FOUR ambiguous morphs (mö: sleep root / 1nSG affix; nke: FUT.IRR /
    // LIMIT senses on one affix entry; bi: 2SG affix / "drink" root; ï: "be"
    // root / UG affix), and with the old cap of 4 every single generated
    // candidate used mö's AFFIX sense — its ROOT sense ("sleep," the
    // correct reading here) was never generated at all, at any position in
    // the list, because the search always exhausted 4 results by varying
    // nke/bi/ï first and stopped before ever backtracking that far up the
    // tree. Confirmed directly: this word's correct combination first
    // becomes reachable once the cap passes 6 (i.e. needs >=7); 10 was
    // chosen as a default with a bit of margin above that boundary rather
    // than the bare minimum, since a slightly different real word could
    // need one or two more. This doesn't fully solve arbitrarily-ambiguous
    // words in principle (any fixed cap can still be exceeded by enough
    // simultaneous homographs, and raising it is a genuine trade-off — a
    // word containing several very short, separately-curated forms as
    // substrings, e.g. "apenekebo" also matching lexicon "a"/"e"/"de"/"ne"
    // at various positions, now surfaces noticeably more low-quality
    // candidates deep in the ⇄ cycler than it used to, alongside the
    // correct reading which — reassuringly — still sorts first, since
    // `matchesAt` already tries the longest match at each position before
    // falling back to shorter ones), but it comfortably covers realistic
    // multi-homograph words the same way `maxGlossVariants` already accepts
    // a bounded cap rather than guaranteeing every combination — see the
    // design doc entry for the full case and this trade-off.
    const maxResults = opts.maxResults || 10;
    const maxMorphs = opts.maxMorphs || 6;
    const maxLen = opts.maxLen || 32;
    const maxGlossVariants = opts.maxGlossVariants || 6;
    if(!index || !index.size) return [];
    const s = SuiteCore.stripEdgePunct(SuiteCore.nfc(form));
    const n = s.length;
    if(!n || n > maxLen) return [];

    // allomorph keys grouped by length, for prefix matching at a position
    const results = [];
    function matchesAt(pos){
      const out = [];
      index.forEach((entries, k)=>{
        const len = k.length;
        if(!len || pos + len > n) return;
        if(s.substr(pos, len).toLowerCase() !== k) return;
        // One candidate per HOMOGRAPH SENSE at this key, not just the first
        // entry — a surface form can have multiple genuinely different
        // lexicon entries (e.g. Wao "ta" root "leave" vs. "-ta" affix
        // PST.REC). All senses are offered here; telling them apart is left
        // to the human via the ⇄ cycler, same as any other ambiguity —
        // there's no per-entry positional filter, since the shapes those
        // constraints take vary too much morpheme to morpheme to fit one
        // general field (see design doc).
        entries.forEach(entry=>{
          out.push({ len, entry, key: k });
        });
      });
      out.sort((a, b) => b.len - a.len); // longer morphs first (deterministic)
      return out;
    }
    function search(pos, acc){
      if(results.length >= maxResults || acc.length > maxMorphs) return;
      if(pos === n){
        // A segmentation needs at least one ROOT morph to be a valid word —
        // bound affixes/clitics can't stand alone or stack on each other
        // with nothing to attach to. Without this, two curated affixes
        // whose forms happen to concatenate into an unrelated real word
        // (e.g. "de" IN + "e" PERFORM spelling "dee", when "dee" actually
        // means "nothing" and has nothing to do with either) get offered
        // as a spurious analysis just because both pieces are separately
        // known morphemes.
        if(acc.length >= 2 && acc.some(x => x.entry.type === 'root')) results.push(acc.slice());
        return;
      }
      for(const m of matchesAt(pos)){
        acc.push({ morph: m.key, entry: m.entry });
        search(pos + m.len, acc);
        acc.pop();
        if(results.length >= maxResults) return;
      }
    }
    search(0, []);

    const out = [];
    results.forEach(seq=>{
      // Use the matched lexicon key (the allomorph as curated, lowercase)
      // for each morph — NOT the surface slice — so sentence-initial
      // capitalization ("Botö") doesn't leak into the morpheme line, which
      // stays "bo- tö" as it is in the lexicon.
      //
      // Each slot's root-vs-affix ROLE is already known for certain here
      // (it's exactly seq[i].entry.type) — so it's marked explicitly with
      // the standard hyphen notation (bare = root, "x-" = prefix, "-x" =
      // suffix) BEFORE handing off to canonicalizeMorphLine, rather than
      // joining everything with bare hyphens and letting it re-derive roles
      // from scratch. That re-derivation falls back to a lexicon lookup
      // that only sees ONE entry per surface key — which would silently
      // undo the very homograph disambiguation this search just did, since
      // e.g. "ke" resolved here as the FUT.IRR affix and "ke" resolved as
      // the "do" root render as the identical bare string otherwise.
      const rootIdxs = [];
      seq.forEach((x, i)=>{ if(x.entry.type === 'root') rootIdxs.push(i); });
      const firstRoot = rootIdxs.length ? rootIdxs[0] : -1;
      const mark = (text, i)=>{
        if(seq[i].entry.type === 'root') return text;
        return (firstRoot === -1 || i < firstRoot) ? (text + '-') : ('-' + text);
      };
      const markedMb = seq.map((x, i) => mark(x.morph, i)).join(' ');

      // A morph's own lexicon entry can be POLYSEMOUS — one root, several
      // senses (e.g. "eñe" = hear / know / understand) — rather than
      // silently always defaulting to glossOptions[0], expand every sense
      // of every morph in this segmentation into its own candidate, so a
      // word like "eñekedänïmpa" (eñe -ke -dänï -mpa) can be picked as
      // "know" instead of being stuck on "hear" with no alternative. Capped
      // (maxGlossVariants) since more than one polysemous morph in the same
      // word multiplies combinations.
      let glossCombos = [[]];
      for(const x of seq){
        if(glossCombos.length >= maxGlossVariants) break;
        const senseOpts = (x.entry.glossOptions && x.entry.glossOptions.length) ? x.entry.glossOptions : [x.entry.gloss || '?'];
        const next = [];
        for(const combo of glossCombos){
          for(const sense of senseOpts){
            next.push(combo.concat([sense]));
            if(next.length >= maxGlossVariants) break;
          }
          if(next.length >= maxGlossVariants) break;
        }
        glossCombos = next;
      }

      glossCombos.forEach(senses=>{
        const markedGl = seq.map((x, i) => mark(senses[i], i)).join(' ');
        // canonicalize using the lexicon's morpheme types (no corpus memory)
        const res = SuiteCore.canonicalizeMorphLine(markedMb, markedGl, null, index);
        out.push({ mb: res.mb, gl: res.gl || markedGl });
      });
    });
    return out;
  };

  /* ---------- Patterns sidecar (curated general function/argument tagging) ----------

     "Patterns" (placeholder name, 2026-08-08) replaces Reference Tracker v1's
     narrow chain/mention/realization model with full support for the
     four-function theory in `My Linguistic Theory.md`: every tagged ELEMENT
     (a whole token, a specific morpheme inside one token, or a multi-token
     span) carries a SET of function tags — referent, predicate, modifier,
     linguistic, and/or any number of user-defined custom functions — since
     the same word can genuinely be more than one at once (the user's own
     examples: a referent that's also a modifier, a predicate that's also a
     referent). This is a deliberate, explicit redesign, not an incremental
     add-on: the user was clear that referent CHAINS (coreference grouping)
     and the old zero/new/given/fullNP/other realization tags are BOTH
     dropped entirely, not migrated — a referent's only curated property now
     is its dependency (independent / sentence-dependent / text-dependent).
     Old `<text>.reftrack.json` sidecars are simply never read by this tool
     again; it reads/writes `<text>.patterns.json` instead, starting empty
     for every text (per explicit instruction to wipe and start fresh, even
     for the one real in-progress file that had 41 mentions across 4 chains).

     Predicate/modifier/linguistic/custom functions all work through ONE
     general LINK mechanism (`role`-tagged: argument/modifies/affects/custom)
     rather than each getting its own bespoke shape — this is what keeps the
     schema from repeating the lexicon's removed `boundary` field mistake
     (one bespoke field per phenomenon doesn't scale; §1). A predicate's
     argument count, its core-vs-non-core breakdown, a modifier's target(s),
     a linguistic element's affected target(s), and a custom function's
     linked element(s) are all DERIVED by reading the links table — never a
     separately-curated redundant field — same derived-vs-curated discipline
     as `analyzeMentions` before it (now removed along with chains). */

  SuiteCore.patternsSidecarName = function(txtName){ return txtName.replace(/\.txt$/i, '.patterns.json'); };
  SuiteCore.PATTERNS_FUNCTIONS_FILE = 'patterns.functions.json';

  /* ================= Scope-based schema (2026-08-09 rewrite) =================
     Replaces the flat five-function schema entirely (referent/predicate/
     modifier/linguistic/speechAct as independent booleans on one element).
     Grew out of a long theory discussion converging on: functions aren't a
     flat list, they're organized by SCOPE, and only two of the four original
     communicative functions — Reference and Modification — actually recur at
     every scope. Predication and Linguistic are inherently token-bound.
     Speech Act is a genuinely separate utterance-only function alongside
     Reference/Modification, not a fifth peer of the original four. Direct
     quote from the design conversation: "Utterance-level = SA choice... and
     if there are any utterance modifications. Context-level = Reference
     (within sentence, other sentence, no antecedent) and Modifier.
     Token-level = Reference, Predicate (with arguments), Modification (with
     what is being modified), and Linguistic."

     A single word or morpheme can legitimately carry tags at MORE THAN ONE
     scope at once — confirmed directly ("Multiple tagging of a token based
     on scope is expected and I think an advantage"). E.g. a bare agreement
     suffix that's the sole exponent of a dropped argument is tagged once at
     Token scope (it's the predicate's argument) and again at Context scope
     (it's also a reference needing its own resolution, linked or exophoric).
     So scope is a property of each ELEMENT, not a partition of the corpus —
     the same token position can host one token-scope element and one
     context-scope element simultaneously, each independently tagged.

     Token-scope functions are semantically meant to be mutually exclusive
     per element (the decision procedure in the theory doc walks a token to
     exactly one answer) — but this is deliberately NOT hard-enforced yet
     ("I don't want to close it down until I see how it works"). `fn` is a
     single value, not independent booleans, which nudges toward one choice
     without blocking a second element from being created at the same
     position if a real case demands it. */
  const PATTERNS_SCOPES = ['utterance', 'token', 'context'];
  const PATTERNS_UTTERANCE_FNS = ['speechAct', 'modification'];
  const PATTERNS_TOKEN_FNS = ['referent', 'predicate', 'modifier', 'linguistic', 'custom'];
  const PATTERNS_CONTEXT_FNS = ['reference', 'modifier', 'custom'];
  const PATTERNS_FNS_BY_SCOPE = { utterance: PATTERNS_UTTERANCE_FNS, token: PATTERNS_TOKEN_FNS, context: PATTERNS_CONTEXT_FNS };

  const PATTERNS_LINK_ROLES = ['argument', 'modifies', 'affects', 'custom', 'corefers', 'contrasts'];
  const PATTERNS_ARG_TAGS = ['grammatical', 'semantic', 'pragmatic'];
  const PATTERNS_SPEECH_ACTS = ['interrogative', 'declarative', 'imperative'];
  const PATTERNS_SPEECH_ACT_TYPES = PATTERNS_SPEECH_ACTS.concat(['custom']);
  // Utterance-level Modification kinds — TAME (tense/aspect/mood/
  // evidentiality), adverbials, and polarity, per the sketch. Each instance
  // is its own element (a clause can be past-tense AND negated AND
  // evidential at once — these are independent flags, not a single choice),
  // implicitly scoped to "the whole utterance" — unlike Token-level
  // Modification, an utterance-modification element never needs its own
  // target link, since there's only one possible target.
  const PATTERNS_MOD_KINDS = ['tame', 'adverbial', 'polarity', 'custom'];
  // Context-level resolution state. Deliberately four-valued, not a boolean
  // link/no-link: "pending" (not yet analyzed), "exophoric" (analyzed, and
  // specifically found to have NO linguistic antecedent — resolved from the
  // situational/extralinguistic context instead, e.g. pointing at someone
  // visible but never mentioned), and "understood" (2026-08-10: analyzed,
  // and the referent is recoverable from general/world knowledge or implicit
  // shared understanding rather than from any specific antecedent word OR
  // the immediate situational context — e.g. an understood-but-unstated
  // participant) must all stay distinguishable from each other and from "not
  // yet checked," or a later distance-by-form study can't tell them apart.
  // "linked" means an antecedent/contrast-target element has actually been
  // chosen (see the 'corefers'/'contrasts' link roles above).
  const PATTERNS_RESOLUTIONS = ['linked', 'exophoric', 'understood', 'pending'];
  // Removed (2026-08-10): a Token-scope Referent's `dependency` sub-tag
  // (independent / sentence-dependent / context-dependent), per direct
  // feedback that it shouldn't exist as a sub-choice under Referent. It was
  // also genuinely redundant with the 3-scope architecture itself: whether a
  // referent needs something beyond its own clause is now just a question of
  // whether that SAME token ALSO carries an Utterance- or Context-scope tag
  // (multi-scope tagging, already a first-class feature), not a separate
  // hand-picked classification living on the Token-scope element. Same
  // "don't keep an ad hoc field that duplicates what the architecture
  // already expresses" call as the earlier `boundary` field removal from the
  // lexicon schema. No migration needed — every real corpus's .patterns.json
  // was already wiped clean for the scope-based rewrite before this field
  // ever had real data in it.

  SuiteCore.PATTERNS_SCOPES = PATTERNS_SCOPES;
  SuiteCore.PATTERNS_FNS_BY_SCOPE = PATTERNS_FNS_BY_SCOPE;
  SuiteCore.PATTERNS_LINK_ROLES = PATTERNS_LINK_ROLES;
  SuiteCore.PATTERNS_ARG_TAGS = PATTERNS_ARG_TAGS;
  SuiteCore.PATTERNS_SPEECH_ACTS = PATTERNS_SPEECH_ACTS;
  SuiteCore.PATTERNS_SPEECH_ACT_TYPES = PATTERNS_SPEECH_ACT_TYPES;
  SuiteCore.PATTERNS_MOD_KINDS = PATTERNS_MOD_KINDS;
  SuiteCore.PATTERNS_RESOLUTIONS = PATTERNS_RESOLUTIONS;

  // One taggable unit. `tokens`/`morphIndex` are unchanged from the original
  // schema (see the historical comment this replaced): one or more token
  // indices in document order, with `morphIndex` picking a specific mb/gl
  // slot when `tokens.length === 1`.
  //
  // Every OTHER field is scope-gated: `scope` picks which of the three
  // function inventories applies, `fn` must be a member of that inventory
  // (or null — a freshly-created, not-yet-tagged element), and the
  // remaining fields (speechActType, modKind, resolution, ...)
  // are only ever populated when `scope`+`fn` actually calls for them —
  // reading a field that doesn't apply to the current scope/fn combination
  // always returns null, so a stale value from a prior scope/fn change (via
  // setScope/setFn, see reftrack_standalone.html) can never leak through.
  SuiteCore.normalizePatternsElement = function(e){
    const tokens = Array.isArray(e.tokens) && e.tokens.length
      ? e.tokens.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0)
      : (Number.isInteger(e.tokenIndex) ? [e.tokenIndex] : []);
    const scope = PATTERNS_SCOPES.includes(e.scope) ? e.scope : 'token';
    const validFns = PATTERNS_FNS_BY_SCOPE[scope];
    const fn = validFns.includes(e.fn) ? e.fn : null;

    const saType = (scope === 'utterance' && fn === 'speechAct' && PATTERNS_SPEECH_ACT_TYPES.includes(e.speechActType)) ? e.speechActType : null;
    const modKind = (scope === 'utterance' && fn === 'modification' && PATTERNS_MOD_KINDS.includes(e.modKind)) ? e.modKind : null;
    const isContextLinkable = scope === 'context' && (fn === 'reference' || fn === 'modifier');
    const resolution = isContextLinkable ? (PATTERNS_RESOLUTIONS.includes(e.resolution) ? e.resolution : 'pending') : null;

    return {
      id: e.id || SuiteCore.newId('pe'),
      sentenceId: e.sentenceId || null,
      tokens,
      morphIndex: (tokens.length === 1 && Number.isInteger(e.morphIndex)) ? e.morphIndex : null,
      scope,
      fn,
      customFunctionId: (fn === 'custom') ? (e.customFunctionId || null) : null,
      speechActType: saType,
      speechActCustomLabel: saType === 'custom' ? String(e.speechActCustomLabel || '').trim() : '',
      modKind,
      modCustomLabel: modKind === 'custom' ? String(e.modCustomLabel || '').trim() : '',
      resolution,
      note: e.note || ''
    };
  };
  // Display label for a Speech-Act-tagged element — the enum name itself, or
  // the user's own typed text when speechActType === 'custom'. Centralized
  // here so every consumer (rail list, Overview, badges) shows the identical
  // label. Takes the ELEMENT now (not a nested sub-object), since speechAct
  // fields live flat on the element under the new schema.
  SuiteCore.speechActLabel = function(e){
    if(!e || e.fn !== 'speechAct') return '';
    if(!e.speechActType) return 'type not set';
    return e.speechActType === 'custom' ? (e.speechActCustomLabel || 'custom') : e.speechActType;
  };
  // Same pattern for an utterance-Modification element's kind label.
  SuiteCore.modificationLabel = function(e){
    if(!e || e.fn !== 'modification') return '';
    if(!e.modKind) return 'kind not set';
    return e.modKind === 'custom' ? (e.modCustomLabel || 'custom') : e.modKind;
  };

  // A directed link between two elements. `role` says what kind of relation
  // it is; `coreness`/`tags` only ever apply to an `argument` link (per the
  // user's explicit choice, both core AND non-core arguments get the
  // grammatical/semantic/pragmatic tag-set, non-exclusive — an argument can
  // be any combination of the three). `customFunctionId` only applies to a
  // `custom` link, pointing at the specific registry entry (see below) this
  // link belongs to — one element can have several custom-function links
  // under different registry ids at once.
  SuiteCore.normalizePatternsLink = function(l){
    const role = PATTERNS_LINK_ROLES.includes(l.role) ? l.role : 'argument';
    return {
      id: l.id || SuiteCore.newId('pl'),
      role,
      customFunctionId: role === 'custom' ? (l.customFunctionId || null) : null,
      fromId: l.fromId || null,
      toId: l.toId || null,
      coreness: (role === 'argument' && (l.coreness === 'core' || l.coreness === 'nonCore')) ? l.coreness : null,
      tags: role === 'argument'
        ? (Array.isArray(l.tags) ? l.tags.filter(t => PATTERNS_ARG_TAGS.includes(t)) : [])
        : []
    };
  };

  SuiteCore.parsePatternsSidecar = function(jsonText){
    const out = { textId: null, elements: [], links: [] };
    if(!jsonText) return out;
    let parsed = null;
    try{ parsed = JSON.parse(jsonText); }catch(e){ return out; }
    if(!parsed || typeof parsed !== 'object') return out;
    out.textId = parsed.textId || null;
    out.elements = Array.isArray(parsed.elements) ? parsed.elements.map(SuiteCore.normalizePatternsElement) : [];
    out.links = Array.isArray(parsed.links) ? parsed.links.map(SuiteCore.normalizePatternsLink) : [];
    return out;
  };

  SuiteCore.buildPatternsSidecarJson = function(data){
    return JSON.stringify({
      version: 1,
      textId: data.textId,
      elements: data.elements,
      links: data.links
    }, null, 2);
  };

  // The shared, PROJECT-WIDE registry of user-defined custom functions —
  // deliberately its own small file, same reasoning as lexicon.jsonl: a
  // custom function ("Topic", "Focus," whatever a linguist wants to name) is
  // defined ONCE and referenced by id from every text's own .patterns.json,
  // rather than retyped per occurrence — that's what makes "list every
  // element carrying a given custom function" a clean lookup by id instead
  // of a fuzzy text match across files.
  SuiteCore.parsePatternsFunctionsRegistry = function(jsonText){
    const out = { customFunctions: [], customSpeechActTypes: [] };
    if(!jsonText) return out;
    let parsed = null;
    try{ parsed = JSON.parse(jsonText); }catch(e){ return out; }
    if(!parsed || typeof parsed !== 'object') return out;
    // `scope` (2026-08-09) — a custom function is now offerable at Token OR
    // Context scope (Utterance scope has its own inline free-text custom
    // escape hatches on Speech Act and Modification instead, since those are
    // closed-ish typological categories rather than open lists of named
    // phenomena the way Token/Context custom functions are). Defaults to
    // 'token' for any legacy entry with no scope recorded.
    out.customFunctions = Array.isArray(parsed.customFunctions)
      ? parsed.customFunctions
          .map(f => ({
            id: f.id || SuiteCore.newId('pf'),
            name: String(f.name || '').trim(),
            notes: f.notes || '',
            scope: (f.scope === 'context') ? 'context' : 'token'
          }))
          .filter(f => f.name)
      : [];
    // Custom speech-act TYPES (2026-08-08) — a lightweight, project-wide list
    // of remembered custom labels (e.g. "Exclamative", "Optative"), requested
    // directly: "I need a way to quick tag by speech act type (including any
    // custom ones a user chooses to create)." Deliberately NOT a strict
    // foreign-key registry like customFunctions: an element's own
    // functions.speechAct.customLabel stays plain free text (unchanged
    // schema, no migration), and this list exists purely so the quick-tag
    // dropdown can offer a previously-used custom label again instead of
    // retyping it — matched by name text, not by this list's id.
    out.customSpeechActTypes = Array.isArray(parsed.customSpeechActTypes)
      ? parsed.customSpeechActTypes
          .map(f => ({ id: f.id || SuiteCore.newId('pst'), name: String(f.name || '').trim() }))
          .filter(f => f.name)
      : [];
    return out;
  };
  SuiteCore.buildPatternsFunctionsRegistryJson = function(data){
    return JSON.stringify({ version: 1, customFunctions: data.customFunctions, customSpeechActTypes: data.customSpeechActTypes || [] }, null, 2);
  };

  /* ---- derived views: recomputed fresh from elements+links every time, never stored ---- */

  // Every argument link whose fromId is this predicate element's id,
  // resolved to {link, argument (the argument element)}. A predicate's
  // argument count and its core/non-core split are just this list's
  // length/filter — never separately curated fields.
  //
  // Ordering (2026-08-08): "the order of arguments should always be core,
  // non-core (not the order it was labeled). If there is a core argument
  // closer to the predicate... this should be listed before core arguments
  // farther away." Sorted here, once, at the derivation point, so every
  // consumer (currently just the Predicates rail list) automatically gets
  // the same order rather than needing to re-sort — coreness first (core
  // before not-yet-classified before non-core), then, within a coreness
  // tier, proximity to the predicate's own anchor. Proximity is the token-
  // index gap between the predicate's and argument's anchors — zero when
  // they share a token (a fused argument-marking morpheme in the very same
  // word as the predicate root counts as "attached to it"), one for an
  // adjacent word, and so on; a cross-sentence link (not the normal case,
  // but not disallowed) sorts last within its tier rather than crashing.
  SuiteCore.patternsPredicateArguments = function(predicateElId, elements, links){
    const byId = new Map((elements || []).map(e => [e.id, e]));
    const predicateEl = byId.get(predicateElId);
    const pairs = (links || [])
      .filter(l => l.role === 'argument' && l.fromId === predicateElId)
      .map(l => ({ link: l, argument: byId.get(l.toId) || null }))
      .filter(x => x.argument);

    const corenessRank = c => c === 'core' ? 0 : (c === 'nonCore' ? 2 : 1);
    const distanceToPredicate = (arg) => {
      if(!predicateEl || arg.sentenceId !== predicateEl.sentenceId) return Infinity;
      let min = Infinity;
      (predicateEl.tokens || []).forEach(pt => (arg.tokens || []).forEach(at => {
        const d = Math.abs(pt - at);
        if(d < min) min = d;
      }));
      return min;
    };
    pairs.sort((a, b) => {
      const rc = corenessRank(a.link.coreness) - corenessRank(b.link.coreness);
      if(rc !== 0) return rc;
      return distanceToPredicate(a.argument) - distanceToPredicate(b.argument);
    });
    return pairs;
  };

  // Every element a modifier/linguistic/custom-function element links to via
  // the given role (and, for 'custom', the given registry id) — the general
  // form of "what does this belong to / what does this affect" for those
  // three function types.
  SuiteCore.patternsLinkedTargets = function(fromElId, role, links, elements, customFunctionId){
    const byId = new Map((elements || []).map(e => [e.id, e]));
    return (links || [])
      .filter(l => l.fromId === fromElId && l.role === role && (role !== 'custom' || l.customFunctionId === customFunctionId))
      .map(l => byId.get(l.toId))
      .filter(Boolean);
  };

  // Which Speech-Act-tagged span (if any) a given token position falls
  // inside — "narrowest containing span wins" so a differently-typed
  // embedded clause (e.g. an embedded question inside a declarative matrix
  // clause) resolves to its OWN speech act, not its enclosing clause's.
  // Directly requested (2026-08-08): "speech act needs to be a tag on a user
  // selected string... which may be part of a sentenceID" plus the follow-up
  // confirming narrowest-containing-span as the resolution rule for nested
  // clauses. Only same-sentence spans are considered — a speech act, unlike
  // an argument link, never crosses a sentence boundary.
  // Updated for the 2026-08-09 scope-based schema: a Speech-Act-tagged
  // element is now identified by scope==='utterance' && fn==='speechAct'
  // (previously `functions.speechAct` truthy on the old flat schema).
  SuiteCore.narrowestSpeechActAt = function(sentenceId, tokenIndex, elements){
    let best = null;
    (elements || []).forEach(e=>{
      if(e.scope !== 'utterance' || e.fn !== 'speechAct') return;
      if(e.sentenceId !== sentenceId) return;
      if(!e.tokens.includes(tokenIndex)) return;
      if(!best || e.tokens.length < best.tokens.length) best = e;
    });
    return best;
  };

  // Document order for elements: by sentence position (per sentenceOrder,
  // the id list in reading order — the .txt file is the ordering source,
  // same as everywhere else in the suite), then by first token index. An
  // element whose sentenceId no longer exists in the text sorts last rather
  // than crashing, so a stale element is visible, not silently dropped.
  SuiteCore.orderPatternsElements = function(elements, sentenceOrder){
    const posOf = new Map((sentenceOrder || []).map((id, i) => [id, i]));
    return (elements || []).slice().sort((a, b)=>{
      const pa = posOf.has(a.sentenceId) ? posOf.get(a.sentenceId) : Infinity;
      const pb = posOf.has(b.sentenceId) ? posOf.get(b.sentenceId) : Infinity;
      if(pa !== pb) return pa - pb;
      return (a.tokens[0] || 0) - (b.tokens[0] || 0);
    });
  };

  /* ---- Patterns Overview: cross-text typological summaries (2026-08-08) ----
     ⚑ STALE as of the 2026-08-09 scope-based schema rewrite. Every function
     in this section still reads the OLD flat `e.functions.X` shape (fn.
     speechAct, fn.predicate, fn.referent, ...), which no longer exists on a
     normalized element (see normalizePatternsElement above — elements now
     carry `scope`/`fn`/`speechActType`/`dependency`/etc. as flat fields).
     Overview mode is disabled in reftrack_standalone.html for this rewrite
     rather than ported function-by-function in the same pass — deliberate
     descoping, not an oversight, since the immediate goal was the scope-
     switched TAGGING interface, not the cross-tabulation reports built on
     top of the old tagging model. These functions are left in place,
     unmodified, as a reference for what the eventual Overview-v2 report set
     should probably still cover (predicate/argument order, modifier-target
     order, referent position by dependency, valency, clause complexity,
     tagging summary) — but none of them should be called against
     new-schema data without being rewritten first; they will silently
     return empty/wrong results (reading `undefined.speechAct` etc.) rather
     than throwing, since JS lets you read a property off `undefined`... no,
     rather off a missing key on the plain object `e` returns `undefined`
     for `e.functions`, then `.speechAct` off `undefined` DOES throw — so in
     practice these will error loudly if invoked, which is safer than
     silently wrong output.
     Requested directly (original scope, now superseded by the above):
     "an overview of the patterns marked should be provided" covering (1)
     predicate/core-argument order ("something like word order SVO but we
     are using predicate and Core 1, etc."), (2) modifier-to-target order,
     and (3) referent sentence-position by dependency type. Each function
     below is a pure per-TEXT fact extractor — it takes one text's already-
     loaded elements/links (plus, for referents, a sentence-length lookup)
     and returns one small fact object per relevant tagged instance.
     Patterns' Overview page (in reftrack_standalone.html) calls these once
     per text in the folder and tallies the returned facts
     into corpus-wide percentage tables — the aggregation/display is UI
     concern, kept out of suite-core, but the FACTS themselves (what order,
     what position) are a derived-data computation general enough to belong
     here, same reasoning as patternsPredicateArguments's own ordering. */

  // One fact per predicate that has at least one CORE argument anchored in
  // the SAME sentence (a cross-sentence argument link is allowed by the
  // schema but has no meaningful linear order, so it's excluded from the
  // order string entirely — not just sorted last, since it wouldn't belong in
  // "Predicate Arg1 Arg2" at all). Core arguments are numbered Arg1, Arg2...
  // in the same coreness-then-proximity order patternsPredicateArguments
  // already establishes (Arg1 = closest core argument to the predicate);
  // every non-core argument is labeled "NonCore" (never individually
  // numbered, per direct instruction), but each occurrence still gets its own
  // slot in the order string — collapsing repeats would hide a real
  // word-order fact (e.g. two non-core obliques flanking the predicate).
  SuiteCore.patternsPredicateOrderFacts = function(elements, links){
    const facts = [];
    (elements || []).filter(e => e.functions.predicate).forEach(pred=>{
      const args = SuiteCore.patternsPredicateArguments(pred.id, elements, links)
        .filter(a => a.argument.sentenceId === pred.sentenceId);
      if(!args.length) return;
      // `morphIdx` is the tie-breaker for two slots that share the same
      // TOKEN — the fused-argument case (e.g. a predicate root at morph 0
      // and its own argument-marking suffix at morph 1, in the very same
      // word), where tokenStart alone can't tell which comes first. A
      // whole-word/whole-span element (morphIndex null) has no sub-token
      // position of its own; it's treated as starting at that token's first
      // morpheme (-1, sorting before any explicit morph index) since it
      // spans from there. Without this, two same-token slots fell back to
      // Array.prototype.sort's stable "original insertion order" instead of
      // their real morpheme order — which happened to be backwards for a
      // root-then-suffix word, producing "NonCore Arg1 Predicate Arg2" for a
      // real sentence whose actual morpheme order is root-first (Predicate
      // before its own fused Arg1).
      const morphIdxOf = (el) => el.morphIndex == null ? -1 : el.morphIndex;
      let coreN = 0;
      const slots = args.map(a=>{
        if(a.link.coreness === 'core'){ coreN++; return { label: 'Arg' + coreN, tokenStart: a.argument.tokens[0], morphIdx: morphIdxOf(a.argument) }; }
        return { label: 'NonCore', tokenStart: a.argument.tokens[0], morphIdx: morphIdxOf(a.argument) };
      });
      if(!slots.some(s => s.label.indexOf('Arg') === 0)) return; // no core argument — not a "core pattern" instance
      slots.push({ label: 'Predicate', tokenStart: pred.tokens[0], morphIdx: morphIdxOf(pred) });
      slots.sort((a, b) => (a.tokenStart - b.tokenStart) || (a.morphIdx - b.morphIdx));
      // Speech-act cross-reference (2026-08-08): "we have to cross-reference
      // the position of any referent, predicate, argument, or modifier by
      // speech act type" — resolved via the predicate's own narrowest
      // containing speech-act span, so a word-order-only language's fronting
      // pattern shows up bucketed by which act triggered it (e.g. Arg1
      // fronting specifically under interrogative), not just corpus-wide.
      const sa = SuiteCore.narrowestSpeechActAt(pred.sentenceId, pred.tokens[0], elements);
      facts.push({
        predicateId: pred.id, sentenceId: pred.sentenceId, order: slots.map(s => s.label).join(' '),
        speechActType: sa ? sa.functions.speechAct.type : null,
        speechActLabel: sa ? SuiteCore.speechActLabel(sa.functions.speechAct) : null
      });
    });
    return facts;
  };

  // One fact per modifier that has a same-sentence 'modifies' target:
  // whether the modifier's own token span precedes, follows, or shares a
  // token with (the fused/attached case) its target. A modifier linked to
  // more than one target (unusual, but not disallowed) is judged against
  // only the first — document-order — target, since "the pattern of a
  // modifier in relation to the thing it modifies" is inherently a one-to-one
  // relation in the typical case.
  // General "does X precede, follow, or fuse with (share a token with) its
  // own linked target" classifier (2026-08-08) — factored out of what was
  // originally a Modifier-only function, since Linguistic elements (via
  // 'affects') and Custom-function elements (via 'custom' + a registry id)
  // need the exact same relation, just against a different function/role.
  // `sourceFilterFn(e)` picks which elements are candidates (e.g. "has
  // functions.modifier"); `role`/`customFunctionId` are passed straight
  // through to `patternsLinkedTargets`. A source linked to more than one
  // target (unusual, but not disallowed) is judged against only the first —
  // document-order — target, since this relation is inherently one-to-one in
  // the typical case.
  SuiteCore.patternsTargetOrderFacts = function(elements, links, sourceFilterFn, role, customFunctionId){
    const facts = [];
    (elements || []).filter(sourceFilterFn).forEach(src=>{
      const targets = SuiteCore.patternsLinkedTargets(src.id, role, links, elements, customFunctionId)
        .filter(t => t.sentenceId === src.sentenceId);
      if(!targets.length) return;
      const t = targets[0];
      let order;
      if((src.tokens || []).some(ti => (t.tokens || []).includes(ti))) order = 'same-token';
      else order = src.tokens[0] < t.tokens[0] ? 'before' : 'after';
      // Same speech-act cross-reference as patternsPredicateOrderFacts, kept
      // here in the shared helper so Modifier order (and any future
      // Linguistic/Custom order consumer) gets it automatically too.
      const sa = SuiteCore.narrowestSpeechActAt(src.sentenceId, src.tokens[0], elements);
      facts.push({
        sourceId: src.id, sentenceId: src.sentenceId, role, customFunctionId: customFunctionId || null, order,
        speechActType: sa ? sa.functions.speechAct.type : null,
        speechActLabel: sa ? SuiteCore.speechActLabel(sa.functions.speechAct) : null
      });
    });
    return facts;
  };

  // Kept as its own named function (rather than requiring every caller to
  // pass a filter/role) since Modifier order was the original, already-
  // documented feature; it's now a thin wrapper over the general form above.
  SuiteCore.patternsModifierOrderFacts = function(elements, links){
    const facts = SuiteCore.patternsTargetOrderFacts(elements, links, e => e.functions.modifier, 'modifies', null);
    return facts.map(f => ({ modifierId: f.sourceId, sentenceId: f.sentenceId, order: f.order, speechActType: f.speechActType, speechActLabel: f.speechActLabel }));
  };

  // One fact per referent that has a set dependency: its position within its
  // OWN sentence. 'initial' if its span's first token is the sentence's first
  // token, 'final' if its span's last token is the sentence's last token,
  // 'medial' otherwise. A one-word sentence (both true at once) counts as
  // 'initial' — an arbitrary but consistent tie-break. `sentenceLength(id)` is
  // a caller-supplied lookup (that text's own gloss.json token counts) since
  // Patterns doesn't keep every text's sentence data resident at once.
  SuiteCore.patternsReferentPositionFacts = function(elements, sentenceLength){
    const facts = [];
    (elements || []).filter(e => e.functions.referent && e.functions.referent.dependency).forEach(ref=>{
      const len = sentenceLength(ref.sentenceId);
      if(!len) return;
      const first = ref.tokens[0], last = ref.tokens[ref.tokens.length - 1];
      let position;
      if(first === 0) position = 'initial';
      else if(last === len - 1) position = 'final';
      else position = 'medial';
      const sa = SuiteCore.narrowestSpeechActAt(ref.sentenceId, first, elements);
      facts.push({
        referentId: ref.id, sentenceId: ref.sentenceId, dependency: ref.functions.referent.dependency, position,
        speechActType: sa ? sa.functions.speechAct.type : null,
        speechActLabel: sa ? SuiteCore.speechActLabel(sa.functions.speechAct) : null
      });
    });
    return facts;
  };

  // One fact per argument LINK (2026-08-08, requested directly: "an overview
  // of Argument type (Semantic, Grammatical, Pragmatic) in relation to the
  // predicate and the sentence position"), describing where that argument
  // sits relative to its OWN predicate (before/after/same-token — the fused
  // case, same classification `patternsModifierOrderFacts` already uses) and
  // where it sits within its own sentence (initial/medial/final, the same
  // classification `patternsReferentPositionFacts` already uses). An
  // argument link with no grammatical/semantic/pragmatic tag set at all gets
  // the pseudo-tag `'untagged'` rather than being dropped, so an overview
  // consumer can see how much of the corpus isn't classified yet; a link
  // that DOES carry more than one tag (the schema allows all three at once)
  // produces one fact per tag it carries, not one fact total — each tag is
  // an independent property of the argument, not a mutually exclusive
  // category, so a grammatical+semantic argument should count toward both.
  SuiteCore.patternsArgumentTypeFacts = function(elements, links, sentenceLength){
    const byId = new Map((elements || []).map(e => [e.id, e]));
    const facts = [];
    (links || []).filter(l => l.role === 'argument').forEach(l=>{
      const pred = byId.get(l.fromId);
      const arg = byId.get(l.toId);
      if(!pred || !arg) return;
      const tags = (l.tags && l.tags.length) ? l.tags : ['untagged'];

      let predicateOrder = null;
      if(arg.sentenceId === pred.sentenceId){
        if((arg.tokens || []).some(ti => (pred.tokens || []).includes(ti))) predicateOrder = 'same-token';
        else predicateOrder = arg.tokens[0] < pred.tokens[0] ? 'before' : 'after';
      }

      let sentPosition = null;
      const len = sentenceLength(arg.sentenceId);
      if(len){
        const first = arg.tokens[0], last = arg.tokens[arg.tokens.length - 1];
        sentPosition = first === 0 ? 'initial' : (last === len - 1 ? 'final' : 'medial');
      }

      tags.forEach(tag=>{
        facts.push({ linkId: l.id, argumentId: arg.id, predicateId: pred.id, sentenceId: arg.sentenceId, tag, predicateOrder, sentPosition });
      });
    });
    return facts;
  };

  // One fact per sentence that has at least one tagged predicate (2026-08-08,
  // requested directly: "Simple clause = one predicate in a sentence,
  // Complex clause = 2+ predicates in a sentence"), classifying it as
  // 'simple' or 'complex' by its own predicate count. A sentence with ZERO
  // tagged predicates isn't a clause-complexity data point at all yet (there's
  // nothing to classify), so — same discipline as every other fact function
  // here — it's left out rather than force-classified as anything.
  SuiteCore.patternsClauseComplexityFacts = function(elements){
    const bySentence = new Map();
    (elements || []).filter(e => e.functions.predicate).forEach(e=>{
      if(!bySentence.has(e.sentenceId)) bySentence.set(e.sentenceId, []);
      bySentence.get(e.sentenceId).push(e);
    });
    const facts = [];
    bySentence.forEach((preds, sentenceId)=>{
      facts.push({
        sentenceId,
        predicateCount: preds.length,
        complexity: preds.length >= 2 ? 'complex' : 'simple',
        predicateIds: preds.map(p => p.id)
      });
    });
    return facts;
  };

  /* =============================================================
     Elicit — Rapid Word Collection prompt-list parsing

     RWC-style vocabulary elicitation lists (e.g. the SIL Rapid Word
     Collection domain lists) are plain markdown, but two real
     examples in hand already disagree on the exact punctuation:
     one numbers questions "1.  text" and gives seed words as a
     blockquote ("> word, word"); a hand-translated copy numbers
     them "(1) text" and gives seed words as one or more bullet
     lines ("•\tword, word"), sometimes several bullet segments
     packed onto one line. Headings also sit at different depths
     between the two (domains start at H1 in one, H2 in the other).
     None of that is meaningful — it's just how two different
     editors typed the same methodology — so the parser normalizes
     on structure (a heading is a domain, a numbered line is a
     question, whatever comes after is seed/reference text) rather
     than on any one file's exact punctuation. This is deliberately
     read-only reference material: nothing here writes back to the
     source .md file, ever.
     ============================================================= */

  const RWC_HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const RWC_QUESTION_RE = /^(?:(\d+)\.\s+|\((\d+)\)\s*)(.*)$/;
  const RWC_ANSWER_RE = /^(?:>|•)\s?(.*)$/;

  // A domain's description (when it has one) is always prose — "Use
  // this domain for words related to..." — which is reliably several
  // words long. A handful of "Other word lists" domains (Swadesh List,
  // Fluent Forever, Master Spanish Vocab) have NO description at all
  // and go straight into a bare word-per-line list instead ("actor",
  // "yo", ...), so the very first plain line can't always be assumed
  // to be a description just because nothing else has been seen yet.
  // Real descriptions in both source files run 6+ words; the shortest
  // bare list entries are 1-2 words — this threshold sits well inside
  // that gap. A genuinely short one-line description in some future
  // uploaded list could misfire past this check; that's an accepted
  // heuristic limit, not a silent one (it would just show up as domain
  // question #1 instead of a description, same graceful degradation
  // as everywhere else this parser normalizes on structure).
  const RWC_MIN_DESCRIPTION_WORDS = 4;
  function looksLikeDescription(line){
    return line.split(/\s+/).filter(Boolean).length >= RWC_MIN_DESCRIPTION_WORDS;
  }

  // One seed/reference line can itself contain several bullet-marked
  // segments run together ("• word → gloss • word → gloss"); split
  // those back into separate fragments so they render as distinct
  // reference chips instead of one run-on line.
  function splitSeedFragments(line){
    return line.split('•').map(s => s.trim()).filter(Boolean);
  }

  // Parses RWC-style markdown into a domain tree. Each node:
  // { level, title, description, questions: [{num, text, seedLines}], children: [] }
  // A virtual root (level 0) holds top-level domains as children so
  // callers never special-case "no heading yet".
  SuiteCore.parseRwcList = function(text){
    const root = { level: 0, title: '', description: '', questions: [], children: [] };
    const stack = [root];
    let currentQuestion = null;

    (text || '').replace(/\r\n/g, '\n').split('\n').forEach(raw=>{
      const line = raw.trim();
      if(!line) return;

      const h = line.match(RWC_HEADING_RE);
      if(h){
        const level = h[1].length;
        while(stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
        const node = { level, title: h[2].trim(), description: '', questions: [], children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
        currentQuestion = null;
        return;
      }

      const q = line.match(RWC_QUESTION_RE);
      if(q){
        currentQuestion = { num: q[1] || q[2] || '', text: (q[3] || '').trim(), seedLines: [] };
        stack[stack.length - 1].questions.push(currentQuestion);
        return;
      }

      const a = line.match(RWC_ANSWER_RE);
      if(a){
        const frags = splitSeedFragments(a[1]);
        if(currentQuestion) currentQuestion.seedLines.push(...frags);
        return;
      }

      // Plain text, no marker at all. Three cases:
      //  1. A question is already open — trailing context folded onto
      //     it so nothing typed in the source file is lost.
      //  2. No question has been pushed yet for this domain, its
      //     description slot is still empty, AND this line reads like
      //     prose (looksLikeDescription) — this is the domain's one
      //     description line, same as every normal domain.
      //  3. Otherwise — no question open, and either the description
      //     is already committed OR this domain never had a real
      //     prose description to begin with (a *flat wordlist domain*:
      //     "Other word lists" sections like Swadesh List, Fluent
      //     Forever, Master Spanish Vocab, some of which skip the
      //     description line entirely and start directly with a bare
      //     word like "actor"/"yo") — this line is itself a one-word
      //     prompt, so it becomes its own synthetic question. Once the
      //     first plain line for a domain has been consumed (whichever
      //     way), `node.questions.length === 0 && !node.description`
      //     can never be true again for it, so a later long-ish entry
      //     several words into the list can never retroactively get
      //     mistaken for the description. currentQuestion is
      //     deliberately NOT left open afterward, so the *next* bare
      //     line starts a new question of its own rather than being
      //     swallowed as a "seed line" of this one (which is what
      //     silently mangled these sections before this fix: the
      //     entire 200-word Swadesh list collapsed into one run-on
      //     description string).
      if(currentQuestion) currentQuestion.seedLines.push(line);
      else{
        const node = stack[stack.length - 1];
        if(node.questions.length === 0 && !node.description && looksLikeDescription(line)){
          node.description = line;
        }else{
          node.questions.push({ num: String(node.questions.length + 1), text: line, seedLines: [] });
        }
      }
    });

    return root.children;
  };

  // Flattens a parsed domain tree into an ordered list of
  // { path: [titles...], node } — every domain node, in document
  // order, with its full ancestor trail. Used for sidebar
  // navigation/search and for counting questions across a list.
  SuiteCore.flattenRwcDomains = function(domains){
    const out = [];
    function walk(node, path){
      const here = path.concat([node.title]);
      out.push({ path: here, node });
      (node.children || []).forEach(child => walk(child, here));
    }
    (domains || []).forEach(d => walk(d, []));
    return out;
  };

  // Total question count across an entire parsed list (all domains,
  // recursively) — a simple size indicator for the sidebar.
  SuiteCore.countRwcQuestions = function(domains){
    let n = 0;
    SuiteCore.flattenRwcDomains(domains).forEach(({node}) => { n += (node.questions || []).length; });
    return n;
  };

  /* ---------- sentence/TAM elicitation questionnaires ---------- */

  // Sentence/TAM questionnaire format: a plain .md file, hand-editable —
  // deliberately the same kind of file the vocabulary prompt lists use
  // (RWCLISTS.md/VocabListas.md), so a user who already knows how to edit
  // one knows how to edit the other. Convention, reusing parseRwcList's
  // own "heading / numbered line / trailing lines" shape:
  //   - a heading (any # depth) starts a new SECTION. A section with 2+
  //     numbered items is a narrative sequence (its items are meant to be
  //     elicited in order); a section with exactly 1 item, or no heading
  //     at all, is just standalone prompts — this is derived from the
  //     item count, never a separate marker the user has to remember.
  //   - "1. text", "1) text", or "(1) text" starts a new prompt item —
  //     the sentence/phrase to elicit a translation of.
  //   - any other non-blank line: before the section's first item, it's
  //     folded into that section's heading (its own descriptive line,
  //     e.g. a narrative's framing quote — same convention parseRwcList
  //     uses for a domain's one-line description); after an item, it's
  //     that item's context (a '>' blockquote prefix is accepted and
  //     stripped, but not required — plain lines work too, since the
  //     point of this format is to be easy to type by hand).
  // Each returned item: { num, context, prompt, seq }, matching the shape
  // Elicit's questionnaire UI already expects — num is just this file's
  // running 1-based position (unique, never meaningful outside progress
  // bookkeeping); seq is null or { id, header, position, total } for one
  // item in a multi-item section, position/total 0-based/absolute.
  SuiteCore.parseSentencePromptMd = function(text){
    const lines = (text || '').split(/\r?\n/);
    const sections = [];
    let current = { title: null, description: '', items: [] };
    function flushCurrent(){
      if(current.title !== null || current.items.length) sections.push(current);
    }
    // Pandoc span decoration (e.g. Word-import "underline" formatting saved
    // as markdown wraps a whole passage in `[...]{.underline}`) can land its
    // opening "[" directly against a list marker with no space — "1.[ Él
    // RECOLECTA..." — and its closing "]{.underline}" at the tail of
    // whatever line the passage happens to end on. Neither is meaningful
    // prompt content, but the bracket is real regex-relevant text: with a
    // strict `\s+` after the marker, "1.[ ..." plain doesn't match the
    // numbered-item pattern at all, silently swallowing that ENTIRE item
    // into the PRECEDING item's context and shifting every item number
    // after it by one — a real, confirmed bug (2026-08-06), not a one-off.
    // Stripped defensively on every line, not just matched numbered ones,
    // since the closing half can land on a context line just as easily.
    function stripPandocSpanMarks(s){
      return s.replace(/\]\{[^}]*\}\s*$/, '').replace(/^\[/, '');
    }
    lines.forEach(raw=>{
      const line = stripPandocSpanMarks(raw.replace(/\s+$/, ''));
      if(!line.trim()) return; // blank line — pure separator
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if(heading){
        flushCurrent();
        current = { title: heading[1].trim(), description: '', items: [] };
        return;
      }
      const numbered = line.match(/^\s*(?:\(\d+\)|\d+[.)])\s*(.*)$/);
      if(numbered){
        current.items.push({ prompt: numbered[1].trim(), contextLines: [] });
        return;
      }
      const plain = line.replace(/^>\s?/, '');
      if(current.items.length === 0){
        current.description = current.description ? current.description + '\n' + plain : plain;
      }else{
        current.items[current.items.length - 1].contextLines.push(plain);
      }
    });
    flushCurrent();

    const items = [];
    let counter = 0;
    sections.forEach((sec, secIdx)=>{
      const isSequence = sec.title && sec.items.length > 1;
      const header = sec.title ? (sec.description ? sec.title + '\n' + sec.description : sec.title) : '';
      sec.items.forEach((it, i)=>{
        counter++;
        items.push({
          num: String(counter),
          prompt: it.prompt,
          context: it.contextLines.join('\n'),
          seq: isSequence ? { id: 'sec' + secIdx, header, position: i, total: sec.items.length } : null
        });
      });
    });
    return { items: items.filter(it => it.prompt) };
  };

  global.SuiteCore = SuiteCore;
})(typeof window !== 'undefined' ? window : globalThis);
